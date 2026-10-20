import * as vscode from 'vscode';
import { DiffPanel, pickSource, readHead, registerContentProvider, sourceFromDocument, sourceFromEditor, sourceFromUri, type Source } from './panel';

let selected: vscode.Uri | undefined;

/** `23e29a0971e9…` → `23e29a09`, as VS Code's own diff tabs show commits. */
const shortRef = (r: string) => (r === '~' || r === '' ? 'Index' : r.replace(/^([0-9a-f]{8})[0-9a-f]{32}$/, '$1'));

export function activate(context: vscode.ExtensionContext) {
  const open = (left: Source, right: Source) => DiffPanel.open(context.extensionUri, left, right);
  const fail = (e: unknown) => vscode.window.showErrorMessage(`JSON Semantic Diff: ${e instanceof Error ? e.message : String(e)}`);
  const command = (id: string, fn: (...args: any[]) => unknown) =>
    vscode.commands.registerCommand(id, async (...args: any[]) => {
      try {
        await fn(...args);
      } catch (e) {
        fail(e);
      }
    });

  /** The editor a command acts on: the one it was invoked from, else the active one. */
  const current = async (uri?: vscode.Uri): Promise<Source | undefined> => {
    const editor = vscode.window.activeTextEditor;
    if (uri instanceof vscode.Uri && editor?.document.uri.toString() !== uri.toString()) return sourceFromUri(uri);
    if (editor) return sourceFromEditor(editor);
    if (uri instanceof vscode.Uri) return sourceFromUri(uri);
    vscode.window.showInformationMessage('Open a JSON file first.');
    return undefined;
  };

  const isFile = async (uri: vscode.Uri) => {
    try {
      return ((await vscode.workspace.fs.stat(uri)).type & vscode.FileType.Directory) === 0;
    } catch {
      return true; // let opening it report the problem
    }
  };

  context.subscriptions.push(
    registerContentProvider(),

    vscode.window.registerWebviewPanelSerializer('jsonSemanticDiff', {
      deserializeWebviewPanel: async (panel, state) => {
        await DiffPanel.revive(context.extensionUri, panel, state);
      },
    }),

    command('jsonSemanticDiff.new', () => open({ label: 'Left', text: '' }, { label: 'Right', text: '' })),

    command('jsonSemanticDiff.compareSelected', async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
      const files = uris?.length ? uris : uri ? [uri] : [];
      if (files.length !== 2) {
        vscode.window.showInformationMessage('Select exactly two files in the Explorer, then choose “Compare as JSON”.');
        return;
      }
      if (!(await isFile(files[0])) || !(await isFile(files[1]))) {
        vscode.window.showInformationMessage('Select two files, not folders.');
        return;
      }
      open(await sourceFromUri(files[0]), await sourceFromUri(files[1]));
    }),

    command('jsonSemanticDiff.selectForCompare', async (uri?: vscode.Uri) => {
      const pick = uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor?.document.uri;
      if (!pick) {
        vscode.window.showInformationMessage('Open a JSON file, or right-click one in the Explorer, to select it for comparing.');
        return;
      }
      selected = pick;
      await vscode.commands.executeCommand('setContext', 'jsonSemanticDiff.hasSelection', true);
    }),

    command('jsonSemanticDiff.compareWithSelected', async (uri?: vscode.Uri) => {
      const right = await current(uri);
      if (!selected || !right) return;
      open(await sourceFromUri(selected), right);
    }),

    command('jsonSemanticDiff.compareWithClipboard', async (uri?: vscode.Uri) => {
      const left = await current(uri);
      if (!left) return;
      open(left, { label: 'Clipboard', text: await vscode.env.clipboard.readText() });
    }),

    command('jsonSemanticDiff.compareWith', async (uri?: vscode.Uri) => {
      const left = await current(uri);
      if (!left) return;
      const right = await pickSource(`Compare ${left.label} with…`, left.uri);
      if (right) open(left, right);
    }),

    command('jsonSemanticDiff.compareWithHead', async (uri?: vscode.Uri) => {
      // Always the whole file: HEAD has nothing that matches a selection.
      const editor = vscode.window.activeTextEditor;
      const target = uri instanceof vscode.Uri ? uri : editor?.document.uri;
      if (!target) {
        vscode.window.showInformationMessage('Open a JSON file first.');
        return;
      }
      const right = editor?.document.uri.toString() === target.toString() ? sourceFromDocument(editor.document) : await sourceFromUri(target);
      const text = await readHead(target, right.label);
      const name = target.path.split('/').pop()!;
      open({ label: `${name} (HEAD)`, detail: `${vscode.workspace.asRelativePath(target)} at HEAD`, text, head: target }, right);
    }),

    command('jsonSemanticDiff.fromDiffEditor', async () => {
      const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
      const input = tab?.input;
      if (!(input instanceof vscode.TabInputTextDiff)) {
        vscode.window.showInformationMessage('Open a diff editor first, for example a changed JSON file in Source Control.');
        return;
      }
      const [left, right] = await Promise.all([sourceFromUri(input.original), sourceFromUri(input.modified)]);
      const ref = (u: vscode.Uri) => (u.scheme === 'git' ? (JSON.parse(u.query || '{}').ref as string | undefined) : undefined);
      const lr = ref(input.original);
      const rr = ref(input.modified);
      if (lr !== undefined) left.label += ` (${shortRef(lr)})`;
      if (rr !== undefined) right.label += ` (${shortRef(rr)})`;
      // git: documents: show the file's workspace path and which version.
      for (const [s, u, r] of [
        [left, input.original, lr],
        [right, input.modified, rr],
      ] as const)
        if (u.scheme === 'git' && r !== undefined) s.detail = `${vscode.workspace.asRelativePath(u.with({ scheme: 'file', query: '' }))} at ${shortRef(r)}`;
      // Other diffs (Compare with Saved, extensions' own schemes): take the names VS Code shows.
      const shown = tab!.label.split(' ↔ ');
      if (left.label === right.label && shown.length === 2 && shown[0] !== shown[1]) {
        left.label = shown[0];
        right.label = shown[1];
      } else if (left.label === right.label) left.label += ' (original)';
      for (const [s, u] of [
        [left, input.original],
        [right, input.modified],
      ] as const) {
        if (u.scheme !== 'file') s.live = false;
        if (u.scheme !== 'file' && u.scheme !== 'git' && u.scheme !== 'untitled') s.detail = undefined;
      }
      open(left, right);
    }),
  );
}

export function deactivate() {}
