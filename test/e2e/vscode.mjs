// Drives a real VS Code through the Chrome DevTools Protocol: an isolated profile, run
// headless, with the extension installed from a .vsix. Reaches into webviews (out-of-process
// iframes) by auto-attaching to them.
import { execFileSync, spawn } from 'child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'fs';
import path from 'path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(fn, { timeout = 10000, interval = 150, what = 'condition' } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(interval);
  }
  throw new Error(`Timed out waiting for ${what}${last instanceof Error ? `: ${last.message}` : ''}`);
}

// Linux only: VS Code runs headless through Chromium's ozone "headless" platform.
// VSCODE_CLI / VSCODE_BIN override where to find the `code` CLI and the app binary.
function codeBinary() {
  if (process.env.VSCODE_BIN) return { cli: process.env.VSCODE_CLI || 'code', app: process.env.VSCODE_BIN };
  const cli = realpathSync(process.env.VSCODE_CLI || execFileSync('which', ['code'], { encoding: 'utf8' }).trim());
  // /usr/share/code/bin/code -> /usr/share/code/code (the Electron app itself)
  const app = path.resolve(path.dirname(cli), '..', 'code');
  return { cli, app };
}

export class VSCode {
  constructor(root) {
    this.root = root;
    this.ud = path.join(root, 'user-data');
    this.ext = path.join(root, 'extensions');
    this.port = 9300 + Math.floor(Math.random() * 600);
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    this.contexts = new Map(); // `${sessionId}:${contextId}` -> { sessionId, contextId }
    this.pageErrors = []; // uncaught exceptions and console.error from webviews
  }

  static env() {
    const env = { ...process.env };
    // Set when running inside VS Code's own terminal: it would start the app as plain node.
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.VSCODE_IPC_HOOK;
    delete env.VSCODE_IPC_HOOK_CLI;
    return env;
  }

  install(vsix, settings) {
    mkdirSync(path.join(this.ud, 'User'), { recursive: true });
    writeFileSync(path.join(this.ud, 'User', 'settings.json'), JSON.stringify(settings, null, 2));
    const { cli } = codeBinary();
    execFileSync(cli, ['--user-data-dir', this.ud, '--extensions-dir', this.ext, '--install-extension', vsix, '--force'], { env: VSCode.env(), stdio: 'ignore' });
  }

  async launch(folder) {
    const { app } = codeBinary();
    this.proc = spawn(
      app,
      ['--ozone-platform=headless', '--log=trace', `--remote-debugging-port=${this.port}`, `--user-data-dir=${this.ud}`, `--extensions-dir=${this.ext}`, '--disable-gpu', '--new-window', folder],
      { env: VSCode.env(), stdio: 'ignore', detached: true },
    );
    const page = await waitFor(
      async () => {
        const targets = await (await fetch(`http://127.0.0.1:${this.port}/json`)).json();
        return targets.find((t) => t.type === 'page' && t.url.includes('workbench'));
      },
      { timeout: 30000, what: 'the workbench' },
    );
    this.ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r, j) => ((this.ws.onopen = r), (this.ws.onerror = j)));
    this.ws.onmessage = (e) => this.onMessage(JSON.parse(e.data));
    await this.send('Runtime.enable');
    await this.send('Page.enable');
    await this.autoAttach();
    await this.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
    await waitFor(() => this.eval('!!document.querySelector(".monaco-workbench .part.statusbar")'), { timeout: 30000, what: 'workbench to render' });
  }

  async autoAttach(sessionId) {
    await this.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId);
  }

  onMessage(m) {
    if (m.id && this.pending.has(m.id)) {
      const { resolve, reject } = this.pending.get(m.id);
      this.pending.delete(m.id);
      if (m.error) reject(new Error(`${m.error.message}`));
      else resolve(m.result);
      return;
    }
    if (m.method === 'Target.attachedToTarget') {
      const sid = m.params.sessionId;
      this.send('Runtime.enable', {}, sid).catch(() => {});
      this.autoAttach(sid).catch(() => {});
    }
    if (m.method === 'Runtime.executionContextCreated' && m.sessionId) {
      this.contexts.set(`${m.sessionId}:${m.params.context.id}`, { sessionId: m.sessionId, contextId: m.params.context.id });
    }
    if (m.sessionId && m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      this.pageErrors.push(`${new Date().toISOString().slice(11, 23)} ${d.exception?.description ?? d.text}`.slice(0, 600));
    }
    if (m.sessionId && m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      this.pageErrors.push(`${new Date().toISOString().slice(11, 23)} console.error ${m.params.args.map((a) => a.value ?? a.description).join(' ')}`.slice(0, 600));
    }
    if (m.method === 'Runtime.executionContextDestroyed' && m.sessionId) this.contexts.delete(`${m.sessionId}:${m.params.executionContextId}`);
    if (m.method === 'Runtime.executionContextsCleared' && m.sessionId) for (const k of [...this.contexts.keys()]) if (k.startsWith(m.sessionId + ':')) this.contexts.delete(k);
    for (const l of this.listeners) l(m);
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(msg));
    });
  }

  /** Evaluates in the workbench page, or in a webview context. Never hangs: 20s at most. */
  async eval(expression, ctx) {
    const params = { expression, returnByValue: true, awaitPromise: true };
    if (ctx) params.contextId = ctx.contextId;
    const r = await Promise.race([
      this.send('Runtime.evaluate', params, ctx?.sessionId),
      sleep(20000).then(() => {
        throw new Error(`evaluation timed out: ${expression.slice(-80)}`);
      }),
    ]);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }

  /** The comparison webview whose column heads contain `label` (any, when omitted). */
  async webview(label = '', timeout = 15000) {
    return waitFor(
      async () => {
        for (const ctx of this.contexts.values()) {
          try {
            const ok = await this.eval(`!!document.getElementById('rows') && document.getElementById('heads').textContent.includes(${JSON.stringify(label)}) && document.visibilityState === 'visible'`, ctx);
            if (ok) return ctx;
          } catch {
            /* context went away */
          }
        }
        return null;
      },
      { timeout, what: `comparison webview (${label || 'any'})` },
    );
  }

  async key(key, { ctrl = false, shift = false, alt = false } = {}) {
    const modifiers = (alt ? 1 : 0) | (ctrl ? 2 : 0) | (shift ? 8 : 0);
    const codes = { Enter: 13, Escape: 27, ArrowDown: 40, ArrowUp: 38, ArrowRight: 39, ArrowLeft: 37, Home: 36, End: 35, Tab: 9, Delete: 46, F1: 112, F7: 118 };
    const vk = codes[key] ?? key.toUpperCase().charCodeAt(0);
    const code = codes[key] ? key : `Key${key.toUpperCase()}`;
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers, windowsVirtualKeyCode: vk, text: key === 'Enter' ? '\r' : undefined });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers, windowsVirtualKeyCode: vk });
  }

  async type(text) {
    await this.send('Input.insertText', { text });
  }

  async quickInputVisible() {
    return this.eval(`(() => { const w = document.querySelector('.quick-input-widget'); return !!w && w.style.display !== 'none' && w.offsetParent !== null; })()`);
  }

  async quickInputValue() {
    return this.eval(`document.querySelector('.quick-input-widget .quick-input-box input')?.value ?? ''`);
  }

  /** Runs a command through the command palette, by its title. */
  async command(title) {
    // Never type while another quick input is still open: the text would land in an editor.
    if (await this.quickInputVisible()) await this.key('Escape');
    await waitFor(async () => !(await this.quickInputVisible()), { what: 'quick input to close' });
    await this.key('F1');
    await waitFor(async () => (await this.quickInputVisible()) && (await this.quickInputValue()).startsWith('>'), { what: 'command palette' });
    await this.type(title);
    await sleep(500);
    await this.key('Enter');
    await waitFor(async () => !(await this.quickInputVisible()), { what: 'command palette to close' });
    await sleep(400);
  }

  /** A real mouse click at the centre of the element the expression returns. */
  async clickElement(expr, button = 'left') {
    const box = await waitFor(() => this.eval(`(() => { const e = ${expr}; if (!e) return null; const r = e.getBoundingClientRect(); return r.width ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`), { what: 'element to click' });
    for (const type of ['mousePressed', 'mouseReleased']) await this.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button, clickCount: 1 });
    await sleep(200);
  }

  /** Closes an editor tab by its label, with a middle click (the close button only shows on hover). */
  async closeTab(label) {
    await this.clickElement(`[...document.querySelectorAll('.tabs-container .tab')].find((t) => t.textContent.includes(${JSON.stringify(label)}))`, 'middle');
    await waitFor(async () => !(await this.editorTabs()).some((t) => t.includes(label)), { what: `${label} tab to close` });
  }

  /** Brings an editor tab to the front by its label, and lets its contents settle (a webview resizes as it reappears). */
  async showTab(label) {
    await this.clickElement(`[...document.querySelectorAll('.tabs-container .tab')].find((t) => t.textContent.includes(${JSON.stringify(label)}))`);
    await sleep(800);
  }

  /** Answers an input box (or quick pick) that the extension opened. */
  async answerInput(text) {
    await waitFor(() => this.quickInputVisible(), { what: 'input box' });
    await this.eval(`(() => { const i = document.querySelector('.quick-input-widget .quick-input-box input'); i.focus(); i.select(); })()`);
    await this.type(text);
    await sleep(300);
    await this.key('Enter');
    await waitFor(async () => !(await this.quickInputVisible()), { what: 'input box to close' });
  }

  async pickQuickItem(label) {
    await waitFor(() => this.quickInputVisible(), { what: 'quick pick' });
    const ok = await waitFor(
      () =>
        this.eval(`(() => { const row = [...document.querySelectorAll('.quick-input-widget .monaco-list-row')].find((r) => (r.getAttribute('aria-label') || r.textContent).includes(${JSON.stringify(label)})); if (!row) return false; row.click(); return true; })()`),
      { what: `quick pick item ${label}` },
    );
    await sleep(300);
    return ok;
  }

  /** Clicks a button in a VS Code dialog (modal confirmation). */
  async dialogButton(label, timeout = 10000) {
    return waitFor(
      () =>
        this.eval(`(() => { const b = [...document.querySelectorAll('.monaco-dialog-box .monaco-button, .notifications-toasts .monaco-button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true; })()`),
      { timeout, what: `dialog button ${label}` },
    );
  }

  async notifications() {
    return this.eval(`[...document.querySelectorAll('.notifications-toasts .notification-list-item-message')].map((e) => e.textContent)`);
  }

  async clearNotifications() {
    await this.eval(`[...document.querySelectorAll('.notifications-toasts .codicon-notifications-clear, .notifications-toasts .codicon-close')].forEach((b) => b.click())`);
  }

  async editorTabs() {
    // One label per tab, from aria-label: .label-name drops the file extension ("queue" for queue.ts).
    return this.eval(`[...document.querySelectorAll('.tabs-container .tab')].map((t) => (t.getAttribute('aria-label') || '').split(',')[0].trim()).filter(Boolean)`);
  }

  async screenshot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(file, Buffer.from(r.data, 'base64'));
  }

  /** Stops VS Code and waits for it to exit, so its profile can be removed safely. */
  async close() {
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    if (!this.proc) return;
    const exited = new Promise((r) => this.proc.once('exit', r));
    try {
      process.kill(-this.proc.pid, 'SIGTERM');
    } catch {
      return;
    }
    await Promise.race([exited, sleep(10000)]);
    await sleep(500); // Chromium helpers flush their caches just after the main process goes
  }
}
