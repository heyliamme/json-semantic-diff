// End-to-end: installs the packaged extension into a throwaway VS Code profile, opens a
// workspace of sample documents in a fresh git repository, and uses the extension the
// way a person would: shortcuts, menus, quick picks, the clipboard, git, and every
// control in the view. Linux, with `code` on PATH.
//
//   npm run package && node test/e2e/run.mjs [json-semantic-diff-x.y.z.vsix]
//   E2E_SHOTS=images node test/e2e/run.mjs   # also writes the README screenshots there
import { execFileSync } from 'child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { VSCode, waitFor } from './vscode.mjs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const vsix = path.resolve(process.argv[2] || `${pkg.name}-${pkg.version}.vsix`);
if (!existsSync(vsix)) throw new Error(`${vsix} not found: run npm run package first`);
const shotsFor = process.env.E2E_SHOTS ? path.resolve(process.env.E2E_SHOTS) : undefined;

const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'json-semantic-diff-e2e-')));
const ws = path.join(root, 'workspace');
const out = path.join(root, 'shots');
mkdirSync(ws);
mkdirSync(out);
for (const f of ['order-v1.json', 'order-v2.json']) copyFileSync(path.join('samples', f), path.join(ws, f));
writeFileSync(path.join(ws, 'config.json'), JSON.stringify({ name: 'service', port: 8080, features: ['a', 'b'], limits: { rps: 100 } }, null, 2) + '\n');
writeFileSync(path.join(root, 'gitconfig'), '[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n');
process.env.GIT_CONFIG_GLOBAL = path.join(root, 'gitconfig');
const git = (...a) => execFileSync('git', a, { cwd: ws, encoding: 'utf8' });
git('init', '-q');
git('add', '.');
git('commit', '-qm', 'samples');
// The working copy differs from HEAD: keys reordered and minified (no change), one value changed.
writeFileSync(path.join(ws, 'config.json'), '{"limits":{"rps":250},"features":["a","b"],"port":8080.0,"name":"service"}\n');

const settings = {
  'security.workspace.trust.enabled': false,
  'workbench.startupEditor': 'none',
  'workbench.colorTheme': 'Default Dark Modern',
  'window.restoreWindows': 'none',
  'git.openRepositoryInParentFolders': 'never',
  'extensions.autoUpdate': false,
  'telemetry.telemetryLevel': 'off',
  'chat.disableAIFeatures': true,
  'window.dialogStyle': 'custom',
  'workbench.tips.enabled': false,
  'editor.minimap.enabled': false,
  'editor.autoClosingQuotes': 'never',
  'editor.autoClosingBrackets': 'never',
  'editor.formatOnType': false,
};
const vs = new VSCode(root);
vs.install(vsix, settings);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const failed = [];
async function step(name, fn) {
  const t = Date.now();
  try {
    if (await vs.quickInputVisible().catch(() => false)) await vs.key('Escape');
    await fn();
    passed++;
    console.log(`  ✓ ${name} (${Date.now() - t} ms)`);
  } catch (e) {
    failed.push(name);
    const file = path.join(out, `${failed.length}-${name.replace(/\W+/g, '-')}.png`);
    await vs.screenshot(file).catch(() => {});
    console.log(`  ✗ ${name}\n      ${String(e.message).split('\n').join('\n      ')}\n      screenshot: ${file}`);
  }
}
const ok = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const eq = (a, b, what) => ok(JSON.stringify(a) === JSON.stringify(b), `${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

// In the webview.
const W = {
  stats: `[...document.getElementById('stats').children].map((e) => e.textContent.trim()).join(' ')`,
  pos: `document.getElementById('pos').textContent`,
  heads: `[...document.querySelectorAll('.head .label')].map((e) => e.textContent)`,
  notes: `[...document.querySelectorAll('.head .note')].map((e) => e.textContent)`,
  rows: `document.querySelectorAll('#rows .row').length`,
  click: (sel) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) throw new Error('not found: ' + ${JSON.stringify(sel)}); e.click(); return true; })()`,
  check: (opt, on) => `(() => { const b = document.querySelector('[data-opt="${opt}"]'); if ((b.getAttribute('aria-pressed') === 'true') !== ${on}) b.click(); return b.getAttribute('aria-pressed'); })()`,
  rowWithText: (text) => `[...document.querySelectorAll('#rows .row')].find((r) => r.textContent.includes(${JSON.stringify(text)}))`,
};
let ctx;
const w = (expr) => vs.eval(expr, ctx);
const until = (expr, what, timeout) => waitFor(() => w(expr), { what, timeout });

/** Moves keyboard focus out of a webview, back to the workbench. */
async function focusWorkbench() {
  // A real click: a webview holding focus would otherwise swallow the keys.
  await vs.clickElement(`document.querySelector('.part.sidebar .composite.title')`);
}
async function openFile(name) {
  if (await vs.quickInputVisible()) await vs.key('Escape');
  await focusWorkbench();
  await vs.key('p', { ctrl: true });
  await waitFor(() => vs.quickInputVisible(), { what: 'quick open' });
  await vs.type(name);
  await sleep(700);
  await vs.key('Enter');
  await waitFor(async () => (await vs.editorTabs()).some((t) => t.startsWith(name)), { what: `${name} to open` });
  await sleep(400);
  await focusEditor();
}
/** A real click into the active text editor, so typing and shortcuts land there. */
async function focusEditor() {
  await vs.clickElement(`document.querySelector('.editor-group-container.active .editor-instance .monaco-editor .view-lines')`);
  await sleep(150);
}
/** A screenshot of the editor area only, for the README. */
async function shotOfEditor(file) {
  const r = await vs.eval(`(() => { const b = document.querySelector('.part.editor').getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; })()`);
  const { data } = await vs.send('Page.captureScreenshot', { format: 'png', clip: { ...r, scale: 1 } });
  writeFileSync(file, Buffer.from(data, 'base64'));
}
async function closeAll() {
  await focusWorkbench();
  await vs.key('k', { ctrl: true });
  await vs.key('w', { ctrl: true });
  await waitFor(async () => (await vs.editorTabs()).length === 0, { what: 'editors to close' });
}
async function chord(key, mods = {}) {
  await vs.key('k', { ctrl: true });
  await vs.key(key, mods);
}
async function statusBarSelection() {
  return vs.eval(`document.querySelector('[id="status.editor.selection"]')?.textContent ?? ''`);
}
async function setClipboard(text) {
  // Through an untitled editor, as a user would: VS Code's own clipboard, not the page's.
  await focusWorkbench();
  await newUntitled();
  await vs.type(text);
  await vs.key('a', { ctrl: true });
  await vs.key('c', { ctrl: true });
  await sleep(200);
  await vs.command('View: Revert and Close Editor');
}
async function newUntitled() {
  await focusWorkbench();
  await vs.key('n', { ctrl: true });
  await waitFor(async () => (await vs.editorTabs()).some((t) => /^Untitled-\d+$/.test(t)), { what: 'untitled editor' });
  await sleep(300);
}
async function editorText() {
  return vs.eval(`[...document.querySelectorAll('.editor-instance .view-lines .view-line')].sort((a, b) => parseFloat(a.style.top) - parseFloat(b.style.top)).map((l) => l.textContent).join('\\n').replace(/\\u00a0/g, ' ')`);
}

try {
  console.log(`VS Code profile: ${root}`);
  await vs.launch(ws);
  await sleep(1500);

  await step('Ctrl+K J compares the current file with an open editor', async () => {
    await openFile('order-v2.json');
    await openFile('order-v1.json');
    await chord('j');
    await vs.pickQuickItem('order-v2.json');
    ctx = await vs.webview('order-v2.json');
    eq(await w(W.heads), ['order-v1.json', 'order-v2.json'], 'column heads');
    await until(`${W.stats}.includes('changed')`, 'stats');
    eq(await w(W.stats), '~7 changed +1 added −2 removed ↕2 moved', 'stats');
    ok((await vs.editorTabs()).some((t) => t.includes('order-v1.json ↔ order-v2.json')), 'panel title');
  });

  await step('number spelling, key order and minified layout are not changes', async () => {
    ok(!(await w(`[...document.querySelectorAll('#rows .row.k-chg')].some((r) => r.textContent.includes('total') || r.textContent.includes('orderId'))`)), 'total/orderId flagged');
    ok(await w(`!!${W.rowWithText('1.295e2')}`), 'right side keeps its own spelling');
  });

  await step('JSON inside a string is compared as JSON', async () => {
    ok(await w(`!!${W.rowWithText('"variant": "A"')}?.classList.contains('k-chg')`), 'nested change');
    ok(await w(`!!document.querySelector('.badge.emb')`), 'embedded badge');
  });

  await step('next / previous and F7 step through changes', async () => {
    await w(W.click('#next'));
    eq(await w(W.pos), '1 / 12', 'after next');
    await w(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F7', bubbles: true }))`);
    eq(await w(W.pos), '2 / 12', 'after F7');
    await w(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F7', shiftKey: true, bubbles: true }))`);
    eq(await w(W.pos), '1 / 12', 'after Shift+F7');
    await w(W.click('#prev'));
    eq(await w(W.pos), '12 / 12', 'wraps around');
    ok(await w(`!!document.querySelector('.row.cur')`), 'current row marked');
  });

  if (shotsFor) {
    mkdirSync(shotsFor, { recursive: true });
    await w(W.click('#next'));
    await w(`document.querySelector('#rows').scrollTop = 0`);
    await sleep(500);
    await shotOfEditor(path.join(shotsFor, 'overview-dark.png'));
  }

  await step('the change list jumps to a change', async () => {
    await w(W.click('#toggleList'));
    eq(await w(`document.querySelectorAll('#list .item').length`), 12, 'list items');
    await w(`[...document.querySelectorAll('#list .item')].find((b) => b.textContent.includes('$.shipping.eta')).click()`);
    ok(await w(`document.querySelector('.row.cur').textContent.includes('eta')`), 'jumped to eta');
    await w(W.click('#toggleList'));
    ok(await w(`document.getElementById('list').hidden`), 'list hidden');
  });

  await step('changes only hides unchanged content and gaps expand', async () => {
    const all = await w(W.rows);
    await w(W.check('changesOnly', true));
    const fewer = await w(W.rows);
    ok(fewer < all, `rows ${fewer} < ${all}`);
    await w(W.click('#rows .row.gap'));
    ok((await w(W.rows)) > fewer, 'gap expanded');
    await w(W.check('changesOnly', false));
    eq(await w(W.rows), all, 'rows restored');
  });

  await step('folding a container and unfolding it', async () => {
    const all = await w(W.rows);
    await w(`${W.rowWithText('"customer"')}.querySelector('.tw').click()`);
    eq(await w(W.rows), all - 4, 'rows once customer is folded');
    ok(await w(`${W.rowWithText('"customer"')}.textContent.includes('3 keys · 1 change')`), 'fold summary');
    await w(`${W.rowWithText('"customer"')}.click()`);
    eq(await w(W.rows), all, 'unfolded');
  });

  await step('keyboard: arrows select lines, Left/Right fold, Enter opens', async () => {
    await w(`document.getElementById('rows').focus()`);
    const key = (k) => w(`document.getElementById('rows').dispatchEvent(new KeyboardEvent('keydown', { key: '${k}', bubbles: true }))`);
    await key('Home');
    eq(await w(`document.querySelector('footer .path').textContent`), '$', 'first line selected');
    for (let i = 0; i < 3; i++) await key('ArrowDown');
    eq(await w(`document.querySelector('footer .path').textContent`), '$.customer', 'customer selected');
    ok(await w(`document.getElementById('rows').getAttribute('aria-activedescendant') === 'row-3'`), 'active descendant');
    const all = await w(W.rows);
    await key('ArrowLeft');
    eq(await w(W.rows), all - 4, 'folded with Left');
    await key('Enter');
    eq(await w(W.rows), all, 'opened with Enter');
    await w(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F7', bubbles: true }))`);
    ok((await w(`document.getElementById('announce').textContent`)).startsWith('Change '), 'announced');
  });

  await step('ignore array order removes the moves', async () => {
    await w(W.check('ignoreArrayOrder', true));
    eq(await w(W.stats), '~7 changed +1 added −2 removed', 'stats');
    await w(W.check('ignoreArrayOrder', false));
    eq(await w(W.stats), '~7 changed +1 added −2 removed ↕2 moved', 'stats');
  });

  await step('null = missing', async () => {
    await w(W.check('nullEqualsMissing', true));
    eq(await w(W.stats), '~7 changed +1 added −1 removed ↕2 moved', 'stats');
    await w(W.check('nullEqualsMissing', false));
  });

  await step('JSON in strings can be switched off', async () => {
    await w(W.check('parseNestedJson', false));
    ok(await w(`!!${W.rowWithText('"payload"')}?.classList.contains('k-chg')`), 'payload compared as a string');
    await w(W.check('parseNestedJson', true));
  });

  await step('click shows the path; ignore this path; save to settings', async () => {
    await w(`${W.rowWithText('"updatedAt"')}.querySelector('.c.r').click()`);
    eq(await w(`document.querySelector('footer .path').textContent`), '$.audit.updatedAt', 'path');
    await w(W.click('footer [data-act="ignore"]'));
    eq(await w(W.stats), '~6 changed +1 added −2 removed ↕2 moved 1 ignored', 'stats after ignore');
    ok(await w(`document.getElementById('ignores').textContent.includes('$.audit.updatedAt')`), 'chip');
    await w(W.click('#saveIgnores'));
    const file = path.join(ws, '.vscode', 'settings.json');
    await waitFor(() => existsSync(file) && readFileSync(file, 'utf8').includes('$.audit.updatedAt'), { what: 'workspace settings' });
    await until(`!document.querySelector('#ignores button[data-unignore]') && !!document.querySelector('#ignores .chip.saved')`, 'chip saved');
  });

  await step('copy path and copy summary reach the clipboard', async () => {
    await w(`${W.rowWithText('"tier"')}.querySelector('.c.r').click()`);
    await w(W.click('footer [data-act="copyPath"]'));
    await sleep(300);
    await newUntitled();
    await vs.key('v', { ctrl: true });
    await sleep(300);
    eq((await editorText()).trim(), '$.customer.tier', 'pasted path');
    await vs.command('View: Revert and Close Editor');
    await vs.showTab('order-v1.json ↔');
    ctx = await vs.webview('order-v2.json');
    await w(W.click('#copy'));
    await sleep(300);
    await newUntitled();
    await vs.key('v', { ctrl: true });
    await sleep(300);
    const md = await editorText();
    ok(md.startsWith('`order-v1.json` ↔ `order-v2.json`: 6 changed, 1 added, 2 removed, 2 moved (1 ignored)'), md.slice(0, 200));
    ok(md.includes('- `$.status`: `"pending"` → `"paid"`'), 'status line in summary');
    await vs.command('View: Revert and Close Editor');
    await vs.showTab('order-v1.json ↔');
    ctx = await vs.webview('order-v2.json');
  });

  await step('double-click opens the source at that line', async () => {
    await w(`${W.rowWithText('"status"')}.querySelector('.c.l .tx').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    await waitFor(async () => (await statusBarSelection()).includes('Ln 3,'), { what: 'cursor on line 3' });
    await vs.command('View: Close Editor'); // the file opened beside the comparison
    await vs.showTab('order-v1.json ↔');
    ctx = await vs.webview('order-v2.json');
  });

  await step('the view follows edits to the file', async () => {
    await openFile('order-v2.json');
    await vs.key('Home', { ctrl: true });
    await vs.key('ArrowRight');
    await vs.type('"live":true,');
    await vs.showTab('order-v1.json ↔');
    ctx = await vs.webview('order-v2.json');
    await until(`${W.stats}.includes('+2 added')`, 'added key to show up', 5000);
    await openFile('order-v2.json');
    await vs.key('z', { ctrl: true });
    await vs.key('s', { ctrl: true });
    await vs.showTab('order-v1.json ↔');
    ctx = await vs.webview('order-v2.json');
    await until(`${W.stats}.includes('+1 added')`, 'undo to show up', 5000);
  });

  await step('text diff opens the normalized documents', async () => {
    await w(W.click('#textDiff'));
    await waitFor(async () => (await vs.editorTabs()).some((t) => t.includes('(normalized)')), { what: 'normalized diff tab' });
    await vs.closeTab('(normalized)');
    await vs.showTab('order-v1.json ↔');
    ctx = await vs.webview('order-v2.json');
  });

  await step('swap sides', async () => {
    await w(W.click('#swap'));
    eq(await w(W.heads), ['order-v2.json', 'order-v1.json'], 'heads');
    eq(await w(W.stats), '~6 changed +2 added −1 removed ↕2 moved 1 ignored', 'stats');
    await w(W.click('#swap'));
  });

  await step('edit in place, with syntax errors reported by line', async () => {
    await w(W.click('#edit'));
    ok(await w(`!document.getElementById('editors').hidden`), 'editors shown');
    await w(`(() => { const t = document.getElementById('ed-right'); t.value = '{\\n  "a": 1\\n  "b": 2\\n}'; t.dispatchEvent(new Event('input')); })()`);
    await until(`!!document.querySelector('.problem.bad')`, 'error box');
    ok(await w(`document.querySelector('.problem.bad').textContent.includes('line 3, column 3')`), 'error position');
    await w(`(() => { const t = document.getElementById('ed-right'); t.value = 'INFO response: {"status": "pending", "orderId": 90071992547409931}'; t.dispatchEvent(new Event('input')); })()`);
    await until(`${W.stats}.includes('removed')`, 'diff after edit');
    eq(await w(W.notes), ['Skipped the text before the JSON'], 'note');
    ok(await w(`!!document.querySelector('.head.r .edited')`), 'edited tag');
    await w(W.click('#edit'));
  });

  await step('paste a side from the clipboard (escaped JSON)', async () => {
    await setClipboard(String.raw`{\"status\":\"paid\"}`);
    await vs.showTab('order-v1.json ↔');
    ctx = await vs.webview('order-v1.json');
    await w(W.click('[data-paste="right"]'));
    await until(`${JSON.stringify('Clipboard')} === ${W.heads}[1]`, 'right side replaced');
    eq(await w(W.notes), ['Unescaped'], 'note');
  });

  await step('Ctrl+K Shift+J compares the selection with the clipboard', async () => {
    await closeAll();
    await setClipboard('{"name": "Mai Tran", "email": "mai@example.com", "tier": "gold"}');
    await openFile('order-v1.json');
    await vs.key('g', { ctrl: true });
    await vs.type('4');
    await vs.key('Enter');
    await vs.key('l', { ctrl: true }); // select line 4: "customer": { ... },
    await chord('j', { shift: true });
    ctx = await vs.webview('order-v1.json (selection)');
    eq(await w(W.heads), ['order-v1.json (selection)', 'Clipboard'], 'heads');
    eq(await w(W.notes), ['Skipped the text before and after the JSON'], 'note');
    ok(await w(`document.querySelector('.head.l .detail').textContent.endsWith('line 4')`), 'one line selected');
    eq(await w(W.stats), '~1 changed', 'stats');
  });

  await step('a selection of the whole file compares the file itself', async () => {
    await closeAll();
    await setClipboard('{"name":"service","port":8080}');
    await openFile('config.json');
    await vs.key('a', { ctrl: true });
    await chord('j', { shift: true });
    ctx = await vs.webview('Clipboard');
    eq(await w(W.heads), ['config.json', 'Clipboard'], 'heads');
    eq(await w(W.stats), '−2 removed', 'stats');
  });

  await step('Compare JSON with HEAD', async () => {
    await closeAll();
    await openFile('config.json');
    await vs.key('Home', { ctrl: true });
    await vs.key('ArrowRight', { shift: true }); // a selection must not turn this into a fragment
    await vs.command('JSON Semantic Diff: Compare with HEAD');
    ctx = await vs.webview('config.json (HEAD)');
    eq(await w(W.heads), ['config.json (HEAD)', 'config.json'], 'heads');
    eq(await w(W.stats), '~1 changed', 'only rps changed');
    ok(await w(`${W.rowWithText('"rps"')}.classList.contains('k-chg')`), 'rps row');
  });

  await step('Ctrl+K J in a Source Control diff opens it semantically', async () => {
    await closeAll();
    await openFile('config.json');
    await vs.clickElement(`document.querySelector('.editor-group-container.active .editor-actions [aria-label^="Open Changes"]')`);
    await waitFor(async () => (await vs.eval(`!!document.querySelector('.editor-instance .monaco-diff-editor')`)), { what: 'diff editor' });
    await sleep(600);
    await vs.clickElement(`document.querySelector('.editor-group-container.active .monaco-diff-editor .editor.modified .view-lines')`);
    await chord('j');
    ctx = await vs.webview('config.json (Index)');
    eq(await w(W.stats), '~1 changed', 'stats');
  });

  await step('Select for compare, then Compare with Selected', async () => {
    await closeAll();
    await openFile('order-v1.json');
    await vs.command('JSON Semantic Diff: Select for JSON Compare');
    await openFile('config.json');
    await vs.command('JSON Semantic Diff: Compare as JSON with Selected');
    ctx = await vs.webview('order-v1.json');
    eq(await w(W.heads), ['order-v1.json', 'config.json'], 'heads');
  });

  await step('Ctrl+K Alt+J opens an empty comparison to paste into', async () => {
    await closeAll();
    await focusWorkbench();
    await chord('j', { alt: true });
    ctx = await vs.webview('Left');
    ok(await w(`!document.getElementById('editors').hidden`), 'editors open');
    ok(await w(`!!document.querySelector('.problem.empty')`), 'empty hint');
    await w(`(() => { for (const [id, v] of [['ed-left', '[1, 2, 3]'], ['ed-right', '[3, 1, 2]']]) { const t = document.getElementById(id); t.value = v; t.dispatchEvent(new Event('input')); } })()`);
    await until(`${W.stats}.includes('moved')`, 'diff');
    eq(await w(W.stats), '↕1 moved', 'stats');
    // Pasting one-line JSON lays it out; the Format button does the same on demand.
    await w(`(() => { const t = document.getElementById('ed-left'); t.value = '{"b":1,"a":[1,2]}'; t.dispatchEvent(new Event('paste')); })()`);
    await until(`document.getElementById('ed-left').value === '{\\n  "b": 1,\\n  "a": [\\n    1,\\n    2\\n  ]\\n}\\n'`, 'laid out on paste');
    await w(`(() => { const t = document.getElementById('ed-right'); t.value = "{a: 1, 'b': [true,]}"; t.dispatchEvent(new Event('input')); })()`);
    await w(W.click('[data-format="right"]'));
    eq(await w(`document.getElementById('ed-right').value`), '{\n  "a": 1,\n  "b": [\n    true\n  ]\n}\n', 'formatted right');
    await w(`(() => { const t = document.getElementById('ed-left'); t.value = '[1, 2, 3]'; t.dispatchEvent(new Event('input')); })()`);
    await sleep(400);
  });

  await step('Change… picks the clipboard for a side', async () => {
    await setClipboard('[1, 2, 3]');
    await vs.showTab('Left ↔ Right');
    ctx = await vs.webview('Left');
    await w(W.click('[data-pick="right"]'));
    await vs.pickQuickItem('Clipboard');
    await until(`${W.heads}[1] === 'Clipboard'`, 'right is clipboard');
    eq(await w(W.stats), '✓ No semantic differences', 'stats');
  });

  if (shotsFor) {
    await closeAll();
    await openFile('order-v2.json');
    await openFile('order-v1.json');
    await chord('j');
    await vs.pickQuickItem('order-v2.json');
    ctx = await vs.webview('order-v2.json');
    await w(W.check('changesOnly', true));
    await sleep(400);
    await shotOfEditor(path.join(shotsFor, 'changes-only-dark.png'));
    await w(W.check('changesOnly', false));
    const userSettings = path.join(root, 'user-data', 'User', 'settings.json');
    writeFileSync(userSettings, JSON.stringify({ ...settings, 'workbench.colorTheme': 'Default Light Modern' }, null, 2));
    await sleep(2000);
    await w(W.click('#toggleList'));
    for (let i = 0; i < 3; i++) await w(W.click('#next'));
    await w(`document.querySelector('#rows').scrollTop = 0`);
    await sleep(600);
    await shotOfEditor(path.join(shotsFor, 'list-light.png'));
  }

  await step('the title bar button opens an empty comparison', async () => {
    await openFile('config.json');
    const btn = `document.querySelector('.editor-group-container.active .editor-actions [aria-label^="New Empty Comparison"]')`;
    ok(await vs.eval(`!!${btn}`), 'button in the editor title');
    await vs.clickElement(btn);
    await waitFor(async () => (await vs.editorTabs()).some((t) => t.startsWith('Left ↔ Right')), { what: 'an empty comparison' });
    ctx = await vs.webview('Left');
    ok(await w(`!document.getElementById('editors').hidden`), 'paste boxes open');
  });

  await step('the comparison comes back after Reload Window', async () => {
    await closeAll();
    await openFile('order-v2.json');
    await openFile('order-v1.json');
    await chord('j');
    await vs.pickQuickItem('order-v2.json');
    ctx = await vs.webview('order-v2.json');
    await openFile('config.json');
    await vs.command('JSON Semantic Diff: Compare with HEAD');
    ctx = await vs.webview('config.json (HEAD)');
    await sleep(500);
    await focusWorkbench();
    vs.contexts.clear();
    await vs.command('Developer: Reload Window');
    await sleep(3000);
    await waitFor(() => vs.eval('!!document.querySelector(".monaco-workbench .part.statusbar")').catch(() => false), { timeout: 30000, what: 'workbench after reload' });
    await waitFor(async () => (await vs.editorTabs()).some((t) => t.includes('order-v1.json ↔ order-v2.json')), { timeout: 20000, what: 'restored tab' });
    await vs.showTab('order-v1.json ↔');
    ctx = await vs.webview('order-v2.json', 20000);
    await until(`${W.stats}.includes('changed')`, 'restored comparison');
    await vs.showTab('config.json (HEAD) ↔');
    ctx = await vs.webview('config.json (HEAD)', 20000);
    await until(`${W.stats} === '~1 changed'`, 'restored HEAD comparison');
  });

  await step('no errors in the webviews', async () => {
    eq(vs.pageErrors, [], 'page errors');
  });
} finally {
  await vs.close();
  console.log(`\n${passed} passed, ${failed.length} failed${failed.length ? `: ${failed.join('; ')}` : ''}`);
  console.log(`Profile and screenshots: ${root}`);
  process.exitCode = failed.length ? 1 : 0;
}
