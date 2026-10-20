import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { canonicalText, diff, expandNested, parseLoose } from './core';
import type { FromWebview, Restore, Side, SideData, ToWebview, ViewOptions } from './protocol';

/** Where one side's JSON comes from. */
export interface Source {
  label: string;
  detail?: string;
  text: string;
  /** Set when the text lives in a document: enables go-to-line and live updates. */
  uri?: vscode.Uri;
  /** Line in the document where `text` starts (0 unless it's a selection). */
  lineOffset?: number;
  /** Follow edits to the document. Off for selections and fixed revisions. */
  live?: boolean;
  /** This side is that file as of HEAD (re-read from git after a reload). */
  head?: vscode.Uri;
}

/** A file's content at HEAD, through the built-in Git extension. */
export async function readHead(target: vscode.Uri, label: string, patient = false): Promise<string> {
  if (!vscode.workspace.isTrusted) throw new Error('Compare with HEAD needs a trusted workspace: Git doesn\'t run in Restricted Mode.');
  const git = vscode.extensions.getExtension('vscode.git');
  if (!git) throw new Error('the built-in Git extension is disabled.');
  const api = (git.isActive ? git.exports : await git.activate()).getAPI(1);
  let repo = api.getRepository(target);
  // Right after a window reload Git is still discovering repositories: give it a moment.
  for (let waited = 0; !repo && api.state !== 'initialized' && waited < 10_000; waited += 250) {
    await new Promise((r) => setTimeout(r, 250));
    repo = api.getRepository(target);
  }
  for (let waited = 0; patient && !repo && waited < 3_000; waited += 250) {
    await new Promise((r) => setTimeout(r, 250));
    repo = api.getRepository(target);
  }
  if (!repo) throw new Error(`${label} is not in a Git repository.`);
  try {
    return await repo.show('HEAD', target.fsPath);
  } catch {
    throw new Error(`${label} is not in HEAD yet (new file?).`);
  }
}

const CONTENT_SCHEME = 'json-semantic-diff';
const texts = new Map<string, string>();

export function registerContentProvider(): vscode.Disposable {
  return vscode.workspace.registerTextDocumentContentProvider(CONTENT_SCHEME, {
    provideTextDocumentContent: (uri) => texts.get(uri.toString()) ?? '',
  });
}

export function readOptions(): ViewOptions {
  const c = vscode.workspace.getConfiguration('jsonSemanticDiff');
  // Settings files can hold anything; keep only values of the right type.
  const strings = (key: string, fallback: string[]) => {
    const v = c.get<unknown>(key);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : fallback;
  };
  const bool = (key: string, fallback: boolean) => {
    const v = c.get<unknown>(key);
    return typeof v === 'boolean' ? v : fallback;
  };
  const fold = c.get<unknown>('foldUnchangedAfterLines');
  return {
    ignoreArrayOrder: bool('ignoreArrayOrder', false),
    parseNestedJson: bool('parseNestedJson', true),
    nullEqualsMissing: bool('nullEqualsMissing', false),
    arrayMatchKeys: strings('arrayMatchKeys', ['id', '_id', 'uuid', 'key', 'name']),
    ignorePaths: strings('ignorePaths', []),
    changesOnly: bool('changesOnly', false),
    foldThreshold: typeof fold === 'number' && Number.isFinite(fold) && fold >= 0 ? fold : 40,
  };
}

export class DiffPanel {
  private static seq = 0;
  private panel: vscode.WebviewPanel;
  private sides: Record<Side, Source>;
  private disposables: vscode.Disposable[] = [];
  private timers: Partial<Record<Side, ReturnType<typeof setTimeout>>> = {};
  /** Normalized documents this panel opened in the text diff editor. */
  private shown: string[] = [];

  static open(extensionUri: vscode.Uri, left: Source, right: Source) {
    return new DiffPanel(extensionUri, left, right);
  }

  /** Reopens a comparison after a window reload, re-reading sides that live in files. */
  static async revive(extensionUri: vscode.Uri, panel: vscode.WebviewPanel, state: unknown) {
    const saved = (state ?? {}) as { left?: Restore; right?: Restore };
    const side = async (r: Restore | undefined, fallback: string): Promise<Source> => {
      if (!r) return { label: fallback, text: '' };
      const uri = r.uri ? vscode.Uri.parse(r.uri) : undefined;
      const lost = { label: `${r.label} (couldn't reopen)`, detail: r.detail, text: '' };
      try {
        if (r.text !== undefined) return { label: r.label, detail: r.detail, text: r.text, uri, lineOffset: r.lineOffset, live: false };
        if (r.head) {
          const head = vscode.Uri.parse(r.head);
          return { label: r.label, detail: r.detail, text: await readHead(head, r.label, true), head };
        }
        if (uri) {
          // A file follows its document again; a fixed revision (git:) is read once.
          const src = await sourceFromUri(uri);
          return r.live ? src : { ...src, label: r.label, detail: r.detail, live: false };
        }
      } catch {
        return lost;
      }
      return lost;
    };
    return new DiffPanel(extensionUri, await side(saved.left, 'Left'), await side(saved.right, 'Right'), panel);
  }

  private constructor(
    private extensionUri: vscode.Uri,
    left: Source,
    right: Source,
    existing?: vscode.WebviewPanel,
  ) {
    this.sides = { left, right };
    const options = {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist')],
    };
    this.panel = existing ?? vscode.window.createWebviewPanel('jsonSemanticDiff', this.title(), vscode.ViewColumn.Active, options);
    if (existing) {
      existing.webview.options = options;
      existing.title = this.title();
    }
    this.panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'icon.png');
    this.panel.webview.html = this.html();
    this.panel.webview.onDidReceiveMessage((m: FromWebview) => this.onMessage(m), null, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    vscode.workspace.onDidChangeTextDocument((e) => this.onDocument(e.document), null, this.disposables);
    vscode.workspace.onDidChangeConfiguration(
      (e) => e.affectsConfiguration('jsonSemanticDiff') && this.post({ type: 'options', options: readOptions() }),
      null,
      this.disposables,
    );
    for (const side of ['left', 'right'] as const) this.watchFile(side);
  }

  private title() {
    const { left, right } = this.sides;
    return left.label === right.label ? left.label : `${left.label} ↔ ${right.label}`;
  }

  private data(s: Source): SideData {
    // What can be read back (a file, a git revision, HEAD) is; anything else keeps its text.
    const readable = (s.uri && (s.live || s.lineOffset === undefined)) || s.head;
    const restore: Restore = {
      label: s.label,
      detail: s.detail,
      uri: s.uri?.toString(),
      head: s.head?.toString(),
      lineOffset: s.lineOffset,
      live: s.live,
      text: readable ? undefined : s.text.length <= 5_000_000 ? s.text : undefined,
    };
    return { label: s.label, detail: s.detail, text: s.text, canReveal: !!s.uri, restore };
  }

  private post(m: ToWebview) {
    this.panel.webview.postMessage(m);
  }

  private onDocument(doc: vscode.TextDocument) {
    for (const side of ['left', 'right'] as const) {
      const s = this.sides[side];
      if (!s.live || s.uri?.toString() !== doc.uri.toString()) continue;
      clearTimeout(this.timers[side]);
      this.timers[side] = setTimeout(() => {
        s.text = doc.getText();
        this.post({ type: 'side', side, data: this.data(s) });
      }, 250);
    }
  }

  /** Files changed on disk by something else (a build, git checkout) while not open. */
  private watchFile(side: Side) {
    const s = this.sides[side];
    if (!s.live || s.uri?.scheme !== 'file') return;
    const uri = s.uri;
    const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.joinPath(uri, '..'), uri.path.split('/').pop()!));
    w.onDidChange(async () => {
      if (vscode.workspace.textDocuments.some((d) => d.uri.toString() === uri.toString())) return;
      if (this.sides[side] !== s) return;
      s.text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
      this.post({ type: 'side', side, data: this.data(s) });
    });
    this.disposables.push(w);
  }

  private async onMessage(m: FromWebview) {
    switch (m.type) {
      case 'ready':
        this.post({ type: 'init', left: this.data(this.sides.left), right: this.data(this.sides.right), options: readOptions() });
        break;
      case 'reveal': {
        const s = this.sides[m.side];
        if (!s.uri) return;
        const line = Math.max(0, m.line - 1 + (s.lineOffset ?? 0));
        const open = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === s.uri!.toString());
        const doc = await vscode.workspace.openTextDocument(s.uri);
        const col = Math.max(0, m.col - 1);
        const range = new vscode.Range(line, col, line, col);
        await vscode.window.showTextDocument(doc, { viewColumn: open?.viewColumn ?? vscode.ViewColumn.Beside, selection: range, preserveFocus: false });
        break;
      }
      case 'textDiff':
        try {
          await this.openTextDiff(m.left, m.right, m.options);
        } catch (e) {
          vscode.window.showErrorMessage(`JSON Semantic Diff: couldn't open the text diff (${e instanceof Error ? e.message : String(e)}).`);
        }
        break;
      case 'copy':
        await vscode.env.clipboard.writeText(m.text);
        vscode.window.setStatusBarMessage(`$(check) Copied ${m.what}`, 2500);
        break;
      case 'paste': {
        const text = await vscode.env.clipboard.readText();
        this.replace(m.side, { label: 'Clipboard', text });
        break;
      }
      case 'pick': {
        const src = await pickSource(`Choose the ${m.side} side`);
        if (src) this.replace(m.side, src);
        break;
      }
      case 'swap':
        this.sides = { left: this.sides.right, right: this.sides.left };
        this.panel.title = this.title();
        break;
      case 'saveIgnore': {
        const c = vscode.workspace.getConfiguration('jsonSemanticDiff');
        const target = vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
        // Add to what that target holds, not the merged value (which includes user settings).
        const info = c.inspect<unknown>('ignorePaths');
        const held = target === vscode.ConfigurationTarget.Workspace ? info?.workspaceValue : info?.globalValue;
        const current = Array.isArray(held) ? held.filter((x): x is string => typeof x === 'string') : [];
        await c.update('ignorePaths', [...new Set([...current, ...m.patterns])], target);
        vscode.window.setStatusBarMessage(
          `$(check) Saved to ${target === vscode.ConfigurationTarget.Workspace ? 'workspace' : 'user'} settings: jsonSemanticDiff.ignorePaths`,
          3500,
        );
        break;
      }
    }
  }

  private replace(side: Side, src: Source) {
    this.sides[side] = src;
    this.panel.title = this.title();
    this.watchFile(side);
    this.post({ type: 'side', side, data: this.data(src) });
  }

  private async openTextDiff(left: string, right: string, options: ViewOptions | Parameters<typeof diff>[2]) {
    const opts = { ignoreArrayOrder: !!options?.ignoreArrayOrder, nullEqualsMissing: !!options?.nullEqualsMissing };
    const canon = (text: string) => {
      const res = parseLoose(text);
      if (!res.value) return undefined;
      return canonicalText(options?.parseNestedJson ? expandNested(res.value) : res.value, opts);
    };
    const l = canon(left);
    const r = canon(right);
    if (l === undefined || r === undefined) {
      vscode.window.showWarningMessage('Fix the JSON syntax error first; the text diff needs both sides to parse.');
      return;
    }
    const id = ++DiffPanel.seq;
    const name = (s: Source) => s.label.replace(/[\\/:*?"<>|]/g, '_');
    const lu = vscode.Uri.from({ scheme: CONTENT_SCHEME, path: `/${id}/left/${name(this.sides.left)}.json` });
    const ru = vscode.Uri.from({ scheme: CONTENT_SCHEME, path: `/${id}/right/${name(this.sides.right)}.json` });
    texts.set(lu.toString(), l);
    texts.set(ru.toString(), r);
    this.shown.push(lu.toString(), ru.toString());
    await vscode.commands.executeCommand('vscode.diff', lu, ru, `${this.title()} (normalized)`, { viewColumn: vscode.ViewColumn.Beside });
  }

  private html() {
    const w = this.panel.webview;
    const nonce = randomBytes(16).toString('hex');
    const js = w.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js'));
    const css = w.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.css'));
    const icons = w.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'codicon.css'));
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${w.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${icons}">
<link rel="stylesheet" href="${css}">
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }

  dispose() {
    for (const t of Object.values(this.timers)) clearTimeout(t);
    for (const u of this.shown) texts.delete(u);
    for (const d of this.disposables.splice(0)) d.dispose();
    this.panel.dispose();
  }
}

// ---------------------------------------------------------------------------------------

const JSON_LANGS = new Set(['json', 'jsonc', 'json5', 'jsonl', 'snippets']);

export async function sourceFromUri(uri: vscode.Uri): Promise<Source> {
  const doc = await vscode.workspace.openTextDocument(uri);
  return sourceFromDocument(doc);
}

export function sourceFromDocument(doc: vscode.TextDocument): Source {
  return {
    label: doc.isUntitled ? doc.uri.path : doc.uri.path.split('/').pop()!,
    detail: doc.isUntitled ? undefined : vscode.workspace.asRelativePath(doc.uri),
    text: doc.getText(),
    uri: doc.uri,
    live: true,
  };
}

/** The selection when there is one, else the whole document. */
export function sourceFromEditor(editor: vscode.TextEditor): Source {
  const sel = editor.selection;
  const base = sourceFromDocument(editor.document);
  const doc = editor.document;
  const all = new vscode.Range(0, 0, doc.lineCount - 1, doc.lineAt(doc.lineCount - 1).text.length);
  if (sel.isEmpty || sel.contains(all)) return base;
  const start = sel.start.line + 1;
  // A selection that ends at the start of a line (Ctrl+L, Shift+Down) doesn't include it.
  const end = sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line : sel.end.line + 1;
  return {
    ...base,
    label: `${base.label} (selection)`,
    detail: `${base.detail ?? base.label}, ${start === end ? `line ${start}` : `lines ${start}–${end}`}`,
    text: ' '.repeat(sel.start.character) + editor.document.getText(sel),
    lineOffset: sel.start.line,
    live: false,
  };
}

export async function pickSource(title: string, exclude?: vscode.Uri): Promise<Source | undefined> {
  type Item = vscode.QuickPickItem & { run?: () => Promise<Source | undefined> | Source | undefined };
  const isJson = (d: vscode.TextDocument) => JSON_LANGS.has(d.languageId) || /\.(json[c5l]?|geojson|har)$/i.test(d.uri.path);
  // Documents in open tabs only: textDocuments also holds files other extensions loaded.
  const inTabs = new Set<string>();
  for (const g of vscode.window.tabGroups.all)
    for (const t of g.tabs) if (t.input instanceof vscode.TabInputText) inTabs.add(t.input.uri.toString());
  const docs = vscode.workspace.textDocuments.filter(
    (d) => inTabs.has(d.uri.toString()) && isJson(d) && !['output', 'vscode-userdata', CONTENT_SCHEME].includes(d.uri.scheme) && d.uri.toString() !== exclude?.toString(),
  );
  const name = (u: vscode.Uri) => u.path.split('/').pop()!;
  const where = (u: vscode.Uri) => {
    const rel = vscode.workspace.asRelativePath(u);
    return rel === name(u) ? undefined : rel;
  };
  const clip = (await vscode.env.clipboard.readText()).replace(/\s+/g, ' ').trim();
  const items: Item[] = [];
  if (docs.length) items.push({ label: 'Open editors', kind: vscode.QuickPickItemKind.Separator });
  for (const d of docs)
    items.push({
      label: `$(json) ${d.isUntitled ? d.uri.path : name(d.uri)}`,
      description: d.isUntitled ? 'unsaved' : where(d.uri),
      run: () => sourceFromDocument(d),
    });
  items.push(
    { label: '', kind: vscode.QuickPickItemKind.Separator },
    { label: '$(clippy) Clipboard', description: clip ? (clip.length > 60 ? clip.slice(0, 59) + '…' : clip) : 'empty', run: async () => ({ label: 'Clipboard', text: await vscode.env.clipboard.readText() }) },
    {
      label: '$(folder-opened) Browse…',
      run: async () => {
        const picked = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { JSON: ['json', 'jsonc', 'json5', 'jsonl', 'geojson', 'har', 'map'], 'All files': ['*'] } });
        return picked?.[0] ? sourceFromUri(picked[0]) : undefined;
      },
    },
    { label: '$(new-file) Empty (paste or type)', run: () => ({ label: 'Untitled', text: '' }) },
  );
  // JSON files in the workspace that aren't open.
  if (vscode.workspace.workspaceFolders?.length) {
    const open = new Set(docs.map((d) => d.uri.toString()));
    const found = await vscode.workspace.findFiles('**/*.{json,jsonc,json5,jsonl,geojson,har}', '**/{node_modules,.git}/**', 200);
    const files = found.filter((u) => !open.has(u.toString()) && u.toString() !== exclude?.toString()).sort((a, b) => a.path.localeCompare(b.path));
    if (files.length) items.push({ label: 'Workspace', kind: vscode.QuickPickItemKind.Separator });
    for (const u of files) items.push({ label: `$(file) ${name(u)}`, description: where(u), run: () => sourceFromUri(u) });
  }
  const pick = await vscode.window.showQuickPick(items, { title, placeHolder: 'An open file, the clipboard, or a file in the workspace', matchOnDescription: true });
  return pick?.run?.();
}
