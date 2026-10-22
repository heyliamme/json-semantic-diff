// Renders the real webview outside VS Code, for UI work and screenshots.
//
//   npm run build
//   node harness/preview.mjs samples/order-v1.json samples/order-v2.json
//   google-chrome --headless=new --window-size=1280,860 --screenshot=out/dark.png "file://$PWD/out/preview.html?theme=dark"
//
// Query parameters: theme=dark|light, list=1, changesOnly=1, order=1 (ignore array order),
// next=N (step to the Nth change), select=N (click row N), edit=1.
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [leftFile = 'samples/order-v1.json', rightFile = 'samples/order-v2.json'] = process.argv.slice(2);
const read = (f) => readFileSync(path.resolve(f), 'utf8');

const THEMES = {
  dark: `--vscode-font-family:-apple-system,"Segoe UI",Ubuntu,sans-serif;--vscode-font-size:13px;--vscode-foreground:#cccccc;--vscode-editor-foreground:#cccccc;--vscode-editor-background:#1f1f1f;--vscode-panel-border:#2b2b2b;--vscode-sideBar-background:#181818;--vscode-editorGroupHeader-tabsBackground:#181818;--vscode-list-hoverBackground:#2a2d2e;--vscode-list-inactiveSelectionBackground:#37373d;--vscode-input-background:#313131;--vscode-focusBorder:#0078d4;--vscode-descriptionForeground:#9d9d9d;--vscode-button-background:#0078d4;--vscode-button-foreground:#fff;--vscode-button-secondaryBackground:#313131;--vscode-button-secondaryHoverBackground:#3c3c3c;--vscode-button-secondaryForeground:#cccccc;--vscode-badge-background:#616161;--vscode-badge-foreground:#f8f8f8;--vscode-editor-font-family:"Cascadia Code","DejaVu Sans Mono",Menlo,monospace;--vscode-editor-font-size:13px;--vscode-editorLineNumber-foreground:#6e7681;--vscode-diffEditor-insertedLineBackground:rgba(155,185,85,.2);--vscode-diffEditor-removedLineBackground:rgba(255,0,0,.2);--vscode-diffEditor-insertedTextBackground:rgba(156,204,44,.3);--vscode-diffEditor-removedTextBackground:rgba(255,0,0,.4);--vscode-textLink-foreground:#4daafc;`,
  light: `--vscode-font-family:-apple-system,"Segoe UI",Ubuntu,sans-serif;--vscode-font-size:13px;--vscode-foreground:#3b3b3b;--vscode-editor-foreground:#3b3b3b;--vscode-editor-background:#ffffff;--vscode-panel-border:#e5e5e5;--vscode-sideBar-background:#f8f8f8;--vscode-editorGroupHeader-tabsBackground:#f8f8f8;--vscode-list-hoverBackground:#f2f2f2;--vscode-list-inactiveSelectionBackground:#e4e6f1;--vscode-input-background:#ffffff;--vscode-focusBorder:#005fb8;--vscode-descriptionForeground:#717171;--vscode-button-background:#005fb8;--vscode-button-foreground:#fff;--vscode-button-secondaryBackground:#e5e5e5;--vscode-button-secondaryHoverBackground:#cccccc;--vscode-button-secondaryForeground:#3b3b3b;--vscode-badge-background:#cccccc;--vscode-badge-foreground:#3b3b3b;--vscode-editor-font-family:"Cascadia Code","DejaVu Sans Mono",Menlo,monospace;--vscode-editor-font-size:13px;--vscode-editorLineNumber-foreground:#6e7681;--vscode-diffEditor-insertedLineBackground:rgba(155,185,85,.2);--vscode-diffEditor-removedLineBackground:rgba(255,0,0,.12);--vscode-diffEditor-insertedTextBackground:rgba(156,204,44,.4);--vscode-diffEditor-removedTextBackground:rgba(255,0,0,.25);--vscode-textLink-foreground:#005fb8;`,
};

const init = {
  type: 'init',
  left: { label: path.basename(leftFile), detail: leftFile, text: read(leftFile), canReveal: true },
  right: { label: path.basename(rightFile), detail: rightFile, text: read(rightFile), canReveal: true },
  options: {
    ignoreArrayOrder: false,
    parseNestedJson: true,
    nullEqualsMissing: false,
    arrayMatchKeys: ['id', '_id', 'uuid', 'key', 'name'],
    ignorePaths: [],
    changesOnly: false,
    foldThreshold: 40,
  },
};

const html = `<!doctype html><html><head><meta charset="utf-8">
<style>:root{${THEMES.dark}} :root.light{${THEMES.light}}</style>
<link rel="stylesheet" href="codicon.css">
<style>${read(path.join(root, 'dist/webview.css'))}</style></head>
<body><div id="app"></div>
<script>
const q = new URLSearchParams(location.search);
if (q.get('theme') === 'light') { document.documentElement.classList.add('light'); document.body.className = 'vscode-light'; }
else document.body.className = 'vscode-dark';
const init = ${JSON.stringify(init).replace(/</g, '\\u003c')};
window.acquireVsCodeApi = () => ({ setState: () => {}, getState: () => undefined, postMessage: (m) => {
  console.log('host <-', JSON.stringify(m).slice(0, 200));
  if (m.type === 'ready') setTimeout(() => {
    window.postMessage(init, '*');
    setTimeout(() => {
      const click = (el) => el && el.click();
      if (q.get('list')) click(document.getElementById('toggleList'));
      if (q.get('edit')) click(document.getElementById('edit'));
      if (q.get('order')) click(document.querySelector('[data-opt="ignoreArrayOrder"]'));
      if (q.get('changesOnly')) click(document.querySelector('[data-opt="changesOnly"]'));
      for (let i = 0; i < +(q.get('next') || 0); i++) click(document.getElementById('next'));
      if (q.get('select')) document.querySelector('.row[data-i="' + q.get('select') + '"] .c.r')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }, 30);
  });
}});
</script>
<script>${read(path.join(root, 'dist/webview.js'))}</script>
</body></html>`;

mkdirSync(path.join(root, 'out'), { recursive: true });
writeFileSync(path.join(root, 'out/preview.html'), html);
for (const f of ['codicon.css', 'codicon.ttf']) writeFileSync(path.join(root, 'out', f), readFileSync(path.join(root, 'dist', f)));
console.log(path.join(root, 'out/preview.html'));
