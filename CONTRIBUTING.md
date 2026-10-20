# Contributing

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## Reporting a bug

Open an issue with the smallest pair of documents that shows the problem, what you
expected and what you saw. The output of **Copy summary** helps.

## Running from source

Node 22 or newer.

```bash
git clone https://github.com/heyliamme/json-semantic-diff
cd json-semantic-diff
npm install
npm run watch        # rebuilds dist/ on change
```

Then press `F5` in VS Code to start an Extension Development Host with the extension
loaded.

## Tests

```bash
npm test
```

- `test/core.test.mjs` covers the parser, the comparison rules and path patterns.
- `test/render.test.mjs` generates thousands of random document pairs and checks that
  each column of the side-by-side view reads back as its own document, that every change
  appears on exactly one line, and that "no changes" means the normalized documents are
  equal. `FUZZ_SEED=<n> npm test` tries other documents.

## End-to-end tests

`test/e2e/run.mjs` installs the packaged extension into a throwaway VS Code profile and
uses it as a person would: shortcuts, menus, quick picks, the clipboard, Git, every
button in the view. VS Code runs headless, so it doesn't take over your screen. Linux
only (it uses Chromium's headless mode), with `code` on your `PATH` (or set
`VSCODE_CLI` and `VSCODE_BIN`):

```bash
npm run test:e2e
```

Screenshots of failing steps land in the temporary folder it prints.

## Working on the view in a browser

```bash
npm run build
node harness/preview.mjs samples/order-v1.json samples/order-v2.json
google-chrome "file://$PWD/out/preview.html?theme=light&list=1"
```

## Layout

| Path | |
| --- | --- |
| `src/core/parse.ts` | The lenient parser |
| `src/core/diff.ts` | The comparison |
| `src/core/loose.ts` | Reading escaped JSON and JSON inside other text |
| `src/panel.ts` | The webview panel, sources and live updates |
| `src/extension.ts` | Commands |
| `webview/render.ts` | Turns a comparison into aligned rows |
| `webview/main.ts` | The view's UI |

## Pull requests

- Keep each PR to one change, and say why in the description.
- Run `npm run typecheck` and `npm test`.
- For UI changes, include screenshots in light and dark themes.

Maintainers: see [RELEASING.md](RELEASING.md) for how releases are published.

By contributing you agree that your contribution is licensed under the MIT license.
