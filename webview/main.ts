import { changes, compilePattern, diff, formatPath, parseLoose, prettyText, type Change, type DNode, type JV, type ParseResult, type Seg } from '../src/core';
import type { FromWebview, Side, SideData, ToWebview, ViewOptions } from '../src/protocol';
import { Builder, esc, inPrintOrder, strSpan, type Row } from './render';

declare function acquireVsCodeApi(): { postMessage(m: FromWebview): void; setState(s: unknown): void };
const vscode = acquireVsCodeApi();
const post = (m: FromWebview) => vscode.postMessage(m);

interface SideState {
  data: SideData;
  text: string;
  parsed: ParseResult;
  edited: boolean;
}

type Toggle = 'ignoreArrayOrder' | 'parseNestedJson' | 'nullEqualsMissing' | 'changesOnly';

const SIDES: Side[] = ['left', 'right'];
/** Rows are built in blocks of this many, and only blocks near the viewport hold DOM. */
const CHUNK = 200;
/** Estimated row height, for blocks that aren't built yet. */
const ROW_PX = 19;
/** The change list shows this many at first. */
const LIST_PAGE = 500;

let opts: ViewOptions | undefined;
let sides: Record<Side, SideState> | undefined;
/** Patterns added in this view and not yet saved to settings. */
let sessionIgnores: string[] = [];
let root: DNode | undefined;
/** Set when the comparison itself threw. */
let failure: string | undefined;
/** Differences hidden by ignore paths or null = missing. */
let ignored = 0;
let list: Change[] = [];
let rows: Row[] = [];
let cur = -1;
/** Row index where each change starts. */
let chRow: number[] = [];
let listLimit = LIST_PAGE;
const filled = new Set<number>();
let selectedRow = -1;
/** The selected line's path, so the selection survives re-rendering. */
let selectedPath: string | undefined;
let editing = false;
let showList = false;
/** Toggles flipped in this view; settings changes leave them alone. */
const flipped = new Set<Toggle>();
const view = { collapsed: new Set<string>(), expanded: new Set<string>(), gapsOpen: new Set<string>() };

const icon = (name: string) => `<span class="codicon codicon-${name}" aria-hidden="true"></span>`;
const toggle = (opt: Toggle, label: string, title: string) =>
  `<button class="tog" data-opt="${opt}" aria-pressed="false" title="${title}">${label}</button>`;

const app = document.getElementById('app')!;
app.innerHTML = `
<header class="bar">
  <div class="stats" id="stats"></div>
  <div class="nav">
    <button id="prev" class="icon" title="Previous change (Shift+F7 or P)" aria-label="Previous change">${icon('arrow-up')}</button>
    <span id="pos" class="pos"></span>
    <button id="next" class="icon" title="Next change (F7 or N)" aria-label="Next change">${icon('arrow-down')}</button>
  </div>
  <div class="toggles" role="group" aria-label="Comparison options">
    ${toggle('ignoreArrayOrder', 'Ignore array order', 'Treat arrays as sets: reordered items are not a change')}
    ${toggle('parseNestedJson', 'JSON in strings', 'Compare strings that contain JSON as the JSON inside them')}
    ${toggle('nullEqualsMissing', 'null = missing', 'A property set to null equals a missing property')}
    ${toggle('changesOnly', 'Changes only', 'Hide unchanged properties and items')}
  </div>
  <div class="actions">
    <button id="toggleList" aria-pressed="false" title="List every change">${icon('list-flat')}<span class="t">Changes</span></button>
    <button id="edit" aria-pressed="false" title="Edit both sides here (the files are not changed)">${icon('edit')}<span class="t">Edit</span></button>
    <button id="swap" class="icon" title="Swap sides" aria-label="Swap sides">${icon('arrow-swap')}</button>
    <button id="textDiff" class="icon" title="Open both sides, normalized (sorted keys, same layout), in the text diff editor" aria-label="Open as normalized text diff">${icon('diff')}</button>
    <button id="copy" class="icon" title="Copy the list of changes as Markdown" aria-label="Copy summary">${icon('copy')}</button>
  </div>
</header>
<div class="ignores" id="ignores" hidden></div>
<div class="editors" id="editors" hidden>
  <div class="ed">
    <textarea id="ed-left" spellcheck="false" aria-label="Left document" placeholder="Paste or type JSON (left)"></textarea>
    <button class="fmt" data-format="left" title="Lay out with indentation, keeping key order. One-line JSON is laid out as you paste it.">Format</button>
  </div>
  <div class="ed">
    <textarea id="ed-right" spellcheck="false" aria-label="Right document" placeholder="Paste or type JSON (right)"></textarea>
    <button class="fmt" data-format="right" title="Lay out with indentation, keeping key order. One-line JSON is laid out as you paste it.">Format</button>
  </div>
</div>
<div class="body">
  <div class="diff">
    <div class="heads" id="heads"></div>
    <main id="rows" tabindex="0" role="listbox" aria-label="Side-by-side comparison. Up and Down move between lines, Left and Right fold, F7 goes to the next change."></main>
  </div>
  <aside id="list" hidden aria-label="Changes"></aside>
</div>
<footer id="status"></footer>
<div id="announce" class="sr-only" aria-live="polite"></div>`;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const rowsEl = $('rows');

// --- state ---------------------------------------------------------------------------

function setSide(side: Side, data: SideData) {
  const parsed = parseLoose(data.text);
  if (!sides) sides = {} as Record<Side, SideState>;
  sides[side] = { data, text: data.text, parsed, edited: false };
  const ed = $<HTMLTextAreaElement>(`ed-${side}`);
  if (ed.value !== data.text) ed.value = data.text;
}

/** Lets the host reopen this comparison after a window reload. */
function saveState() {
  if (!sides) return;
  // Text typed or edited here is kept as is (up to a size); the host reads back the rest.
  const keep = (s: SideState) =>
    s.edited ? { label: s.data.label, detail: s.data.detail, text: s.text.length <= 5_000_000 ? s.text : '' } : s.data.restore;
  vscode.setState({ left: keep(sides.left), right: keep(sides.right) });
}

function recompute() {
  if (!sides || !opts) return;
  saveState();
  const l = sides.left.parsed.value;
  const r = sides.right.parsed.value;
  failure = undefined;
  try {
    root = l && r ? diff(l, r, { ...opts, ignorePaths: [...opts.ignorePaths, ...sessionIgnores] }) : undefined;
    list = root ? changes(root) : [];
    // Only moves print out of tree order; skip the second pass otherwise.
    if (root && list.some((c) => c.kind === 'moved')) list = inPrintOrder(root, list);
    listLimit = LIST_PAGE;
  } catch (e) {
    root = undefined;
    list = [];
    failure = e instanceof RangeError ? 'These documents are too large or too deeply nested to compare here.' : `The comparison failed: ${e instanceof Error ? e.message : String(e)}`;
  }
  ignored = root ? countIgnored(root) : 0;
  if (cur >= list.length) cur = list.length - 1;
  render();
}

// --- rendering -----------------------------------------------------------------------

function render() {
  if (!sides || !opts) return;
  document.body.classList.toggle('nodiff', !root);
  renderHeads();
  renderStats();
  renderIgnores();
  if (!root) return renderProblems();

  const anchor = takeAnchor();
  const changeIndex = new Map<DNode, number>();
  list.forEach((c, i) => changeIndex.set(c.node, i));
  const b = new Builder({ ...view, changesOnly: opts.changesOnly, foldThreshold: opts.foldThreshold, changeIndex });
  b.node(root, 0, false, false);
  rows = b.rows;
  rowsEl.style.setProperty('--lnw', `${Math.max(3, String(b.maxLine).length) + 1}ch`);
  chRow = [];
  rows.forEach((r, i) => {
    if (r.ch !== undefined) chRow[r.ch] = i;
  });

  // Empty blocks of the estimated height; the observer fills those that come near.
  const top = rowsEl.scrollTop;
  observer.disconnect();
  filled.clear();
  const parts: string[] = [];
  for (let k = 0; k * CHUNK < rows.length; k++) parts.push(`<div class="blk" role="none" data-b="${k}" style="height:${Math.min(CHUNK, rows.length - k * CHUNK) * ROW_PX}px"></div>`);
  rowsEl.innerHTML = parts.join('');
  rowsEl.scrollTop = top;
  // Fill what's on screen now, so the view never flashes empty.
  const first = Math.floor(top / (CHUNK * ROW_PX));
  for (let k = Math.max(0, first - 1); k <= first + 2; k++) fill(k);
  rowsEl.querySelectorAll('.blk').forEach((el) => observer.observe(el));
  restoreAnchor(anchor);
  markCurrent(false);
  // The selection follows its path; rows may have moved.
  const again = selectedPath === undefined ? -1 : rows.findIndex((r) => r.path === selectedPath && !r.gap);
  if (again >= 0) select(again, false);
  else clearSelection();
  renderList();
}

/** A row to keep in place across a re-render: the one acted on, else the first on screen. */
let pinned: { path: string; offset: number } | undefined;

function rowTop(el: HTMLElement) {
  return el.getBoundingClientRect().top - rowsEl.getBoundingClientRect().top;
}

function takeAnchor(): { path: string; offset: number } | undefined {
  if (pinned) {
    const a = pinned;
    pinned = undefined;
    return a;
  }
  const box = rowsEl.getBoundingClientRect();
  if (!rows.length || !box.height) return undefined;
  const hit = document.elementFromPoint(box.left + box.width / 4, box.top + 4)?.closest<HTMLElement>('.row');
  if (!hit) return undefined;
  const r = rows[+hit.dataset.i!];
  return r ? { path: r.path, offset: rowTop(hit) } : undefined;
}

function restoreAnchor(a: { path: string; offset: number } | undefined) {
  if (!a) return;
  const i = rows.findIndex((r) => r.path === a.path);
  const el = i >= 0 ? rowEl(i) : null;
  if (!el) return;
  rowsEl.scrollTop += rowTop(el) - a.offset;
  const first = Math.floor(rowsEl.scrollTop / (CHUNK * ROW_PX));
  for (let k = Math.max(0, first - 1); k <= first + 2; k++) fill(k);
}

/** Keeps a row where it is on screen through the next render. */
function pin(i: number) {
  const el = rowEl(i);
  if (el) pinned = { path: rows[i].path, offset: rowTop(el) };
}

function blockEl(k: number) {
  return rowsEl.querySelector<HTMLElement>(`.blk[data-b="${k}"]`);
}

function fill(k: number) {
  if (filled.has(k)) return;
  const el = blockEl(k);
  if (!el) return;
  let h = '';
  for (let j = k * CHUNK; j < Math.min((k + 1) * CHUNK, rows.length); j++) h += rowHtml(rows[j], j);
  el.innerHTML = h;
  el.style.height = '';
  filled.add(k);
  if (cur >= 0 && chRow[cur] !== undefined && Math.floor(chRow[cur] / CHUNK) === k) markCurrent(false);
  if (selectedRow >= 0 && Math.floor(selectedRow / CHUNK) === k) el.querySelector(`.row[data-i="${selectedRow}"]`)?.classList.add('sel');
}

/** Releases a block far from the viewport, keeping its height so scrolling doesn't jump. */
function empty(k: number) {
  const el = blockEl(k);
  if (!el || !filled.has(k)) return;
  el.style.height = `${el.offsetHeight}px`;
  el.innerHTML = '';
  filled.delete(k);
}

const observer = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      const k = +(e.target as HTMLElement).dataset.b!;
      if (e.isIntersecting) fill(k);
      else empty(k);
    }
  },
  { root: rowsEl, rootMargin: '2000px 0px' },
);

/** The element of row i, building its block if needed. */
function rowEl(i: number) {
  if (i < 0 || i >= rows.length) return null;
  fill(Math.floor(i / CHUNK));
  return rowsEl.querySelector<HTMLElement>(`.row[data-i="${i}"]`);
}

/** The marker in front of a line, so changes don't rely on colour alone. */
function indicator(r: Row, side: 'l' | 'r'): string {
  if (r.k === 'mv') return '&#8597;';
  if (side === 'l' && (r.k === 'del' || r.k === 'chg')) return '&minus;';
  if (side === 'r' && (r.k === 'add' || r.k === 'chg')) return '+';
  return '';
}

function rowHtml(r: Row, i: number): string {
  const cell = (c: Row['l'], side: 'l' | 'r') => {
    if (!c) return `<div class="c ${side} fill"></div>`;
    const tw = r.fold
      ? `<button class="tw${r.open ? ' open' : ''}" tabindex="-1" data-fold="${esc(r.fold)}" aria-expanded="${!!r.open}" aria-label="${r.open ? 'Fold' : 'Unfold'} ${esc(r.path)}"></button>`
      : '';
    const ln = r.k === 'in' ? `<span class="ln" title="Contains changes">${c.ln || ''}</span>` : `<span class="ln">${c.ln || ''}</span>`;
    return `<div class="c ${side}"><span class="ind" aria-hidden="true">${indicator(r, side)}</span>${ln}<span class="tx" style="--d:${c.d}">${tw}${c.h}</span></div>`;
  };
  const cls = `row k-${r.k}${r.ch !== undefined ? ' ch' : ''}${r.gap ? ' gap' : ''}${!r.open && r.fold ? ' folded' : ''}`;
  return `<div class="${cls}" id="row-${i}" role="option" aria-selected="false" data-i="${i}"${r.ch !== undefined ? ` data-ch="${r.ch}"` : ''}>${cell(r.l, 'l')}${cell(r.r, 'r')}</div>`;
}

function renderHeads() {
  const head = (side: Side) => {
    const s = sides![side];
    const name = side === 'left' ? 'left' : 'right';
    const warn = s.parsed.warnings.length ? `<span class="warn" title="${esc(s.parsed.warnings.join('\n'))}">&#9888; ${s.parsed.warnings.length}</span>` : '';
    const edited = s.edited ? ' <span class="edited">edited</span>' : '';
    const notes = (s.parsed.notes ?? []).map((n) => `<span class="note" title="${esc(n)}">${esc(n)}</span>`).join('');
    const detail = s.data.detail && s.data.detail !== s.data.label ? s.data.detail : '';
    return `<div class="head ${side === 'left' ? 'l' : 'r'}">
      <div class="name"><span class="label" title="${esc(s.data.detail ?? s.data.label)}">${esc(s.data.label)}</span>${edited}${notes}${warn}</div>
      <div class="detail">${esc(detail)}</div>
      <div class="side-actions"><button data-paste="${side}" title="Replace the ${name} side with the clipboard" aria-label="Paste the clipboard into the ${name} side">Paste</button><button data-pick="${side}" title="Choose a file, an open editor or the clipboard" aria-label="Change the ${name} side…">Change…</button></div>
    </div>`;
  };
  $('heads').innerHTML = head('left') + head('right');
}

function renderStats() {
  const el = $('stats');
  for (const id of ['prev', 'next', 'copy', 'textDiff']) $<HTMLButtonElement>(id).disabled = !root;
  if (!root) {
    el.innerHTML = '';
    $('pos').textContent = '';
    return;
  }
  const n = count();
  const hidden = ignored ? `<span class="ignored" title="Differences under ignored paths, shown dimmed">${ignored} ignored</span>` : '';
  if (!list.length) {
    el.innerHTML = ignored ? `<span class="same partial">No differences counted</span>${hidden}` : `<span class="same">&#10003; No semantic differences</span>`;
  } else {
    const stat = (k: keyof typeof n, sym: string, word: string) =>
      n[k] ? `<span class="stat ${k}" title="${n[k]} ${word}">${sym}${n[k]} <span class="w">${word}</span></span>` : '';
    el.innerHTML = stat('chg', '~', 'changed') + stat('add', '+', 'added') + stat('del', '&minus;', 'removed') + stat('moved', '&#8597;', 'moved') + hidden;
  }
  $('pos').textContent = list.length ? `${cur >= 0 ? cur + 1 : '–'} / ${list.length}` : '';
  $<HTMLButtonElement>('prev').disabled = $<HTMLButtonElement>('next').disabled = !list.length;
}

function renderIgnores() {
  const el = $('ignores');
  const all = [...opts!.ignorePaths.map((p) => ({ p, saved: true })), ...sessionIgnores.map((p) => ({ p, saved: false }))];
  el.hidden = !all.length;
  if (!all.length) {
    el.innerHTML = '';
    return;
  }
  el.innerHTML =
    `<span class="lbl">Ignoring</span>` +
    all
      .map(({ p, saved }) =>
        !compilePattern(p)
          ? `<span class="chip invalid" title="Not a valid path pattern, so it is not applied. See jsonSemanticDiff.ignorePaths.">${esc(p)}</span>`
          : saved
          ? `<span class="chip saved" title="From settings: jsonSemanticDiff.ignorePaths">${esc(p)}</span>`
          : `<span class="chip">${esc(p)}<button data-unignore="${esc(p)}" aria-label="Stop ignoring ${esc(p)}">&times;</button></span>`,
      )
      .join('') +
    (sessionIgnores.length ? `<button id="saveIgnores" class="link">Save to settings</button>` : '');
}

function renderProblems() {
  rows = [];
  list = [];
  $('status').innerHTML = '';
  if (failure) {
    rowsEl.innerHTML = `<div class="problems"><div class="problem bad">${esc(failure)}</div></div>`;
    renderList();
    return;
  }
  const box = (side: Side) => {
    const s = sides![side];
    const name = side === 'left' ? 'Left' : 'Right';
    const e = s.parsed.error;
    if (!e) return `<div class="problem ok">${name}: valid JSON</div>`;
    if (!s.text.trim())
      return `<div class="problem empty"><b>${name} is empty.</b> ${
        editing ? 'Type or paste JSON in the box above, or use' : 'Use <em>Edit</em> to type JSON, or'
      } <em>Paste</em> / <em>Change…</em> to load the clipboard or a file.</div>`;
    const lines = s.text.split('\n');
    const from = Math.max(0, e.line - 3);
    const snippet = lines
      .slice(from, e.line)
      .map((t, i) => `${String(from + i + 1).padStart(5)} | ${t}`)
      .join('\n');
    const caret = ' '.repeat(8 + e.col - 1) + '^';
    return `<div class="problem bad"><b>${name}: line ${e.line}, column ${e.col}.</b> ${esc(e.message)} <button class="link" data-goto-error="${side}">Show in the editor</button><pre>${esc(snippet)}\n${caret}</pre></div>`;
  };
  rowsEl.innerHTML = `<div class="problems">${box('left')}${box('right')}</div>`;
  renderList();
}

function countIgnored(n: DNode): number {
  if (n.st === 'ign') return 1;
  let c = 0;
  if (n.kids) for (const k of n.kids) c += countIgnored(k);
  return c;
}

function count() {
  const n = { chg: 0, add: 0, del: 0, moved: 0 };
  for (const c of list) for (const k of [c.kind, ...(c.also ?? [])]) n[k === 'wrap' ? 'chg' : k]++;
  return n;
}

const ID_KEYS = ['id', '_id', 'uuid', 'key', 'name'];

/** A short form of a value. An object shows its id, if it has one. */
function preview(v: JV | undefined, max = 60): string {
  if (v?.t === 'o') {
    const k = ID_KEYS.find((k) => {
      const x = v.map.get(k);
      return x && x.t !== 'o' && x.t !== 'a';
    });
    if (k) return `{${JSON.stringify(k)}: ${preview(v.map.get(k), 30)}, …}`;
  }
  return shortValue(v, max);
}

/** Both sides of a changed string, cut around the part that differs. */
function previewPair(l: JV | undefined, r: JV | undefined, max = 60): [string, string] {
  if (l?.t !== 's' || r?.t !== 's' || (JSON.stringify(l.v).length <= max && JSON.stringify(r.v).length <= max)) return [preview(l, max), preview(r, max)];
  const [[a], [b]] = strSpan(l.v, r.v);
  const cut = (s: string, at: number) => {
    const from = Math.max(0, at - 20);
    const part = s.slice(from, from + max - 4);
    return (from > 0 ? '"…' : '"') + JSON.stringify(part).slice(1, -1) + (from + part.length < s.length ? '…"' : '"');
  };
  return [cut(l.v, a), cut(r.v, b)];
}

function wrapText(n: DNode) {
  const kind = n.l!.t === 'o' ? 'object' : 'array';
  return n.wrapped === 'l' ? `JSON string → ${kind}` : `${kind} → JSON string`;
}

function shortValue(v: JV | undefined, max: number): string {
  if (!v) return '';
  if (v.t === 'o') return `{${v.keys.length} ${v.keys.length === 1 ? 'key' : 'keys'}}`;
  if (v.t === 'a') return `[${v.items.length} ${v.items.length === 1 ? 'item' : 'items'}]`;
  const s = v.t === 's' ? JSON.stringify(v.v) : v.t === 'n' ? v.raw : v.t === 'b' ? String(v.v) : 'null';
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

const KIND_WORD = { chg: 'changed', add: 'added', del: 'removed', moved: 'moved', wrap: 'changed' };

/** One line about a change, for the list, the summary and screen readers. */
function describe(c: Change, max = 60): string {
  if (c.also?.length) return [c.kind, ...c.also].map((k) => describe({ ...c, kind: k, also: undefined }, max)).join('; ');
  const n = c.node;
  if (c.kind === 'chg') return previewPair(n.l, n.r, max).join(' → ');
  if (c.kind === 'add') return preview(n.r, max);
  if (c.kind === 'del') return preview(n.l, max);
  if (c.kind === 'wrap') return wrapText(n);
  // Same index, different neighbours: the items around it moved.
  return n.li === n.ri ? 'order changed around it' : `index ${n.li} → ${n.ri}`;
}

function renderList() {
  const el = $('list');
  el.hidden = !showList;
  $('toggleList').classList.toggle('on', showList);
  $('toggleList').setAttribute('aria-pressed', String(showList));
  if (!showList) return;
  if (!list.length) {
    el.innerHTML = `<div class="empty">No changes.</div>`;
    return;
  }
  const sym = { chg: '~', add: '+', del: '&minus;', moved: '&#8597;', wrap: '~' };
  el.innerHTML =
    list
      .slice(0, listLimit)
      .map(
      (c, i) =>
        `<button class="item ${c.kind}${i === cur ? ' cur' : ''}" data-go="${i}" aria-label="${KIND_WORD[c.kind]} ${esc(c.path)}: ${esc(describe(c))}"><span class="sym" aria-hidden="true">${sym[c.kind]}</span><span class="path">${esc(c.path)}</span><span class="val">${esc(describe(c))}</span></button>`,
    )
      .join('') + (list.length > listLimit ? `<button class="more" data-more="1">Show ${Math.min(LIST_PAGE, list.length - listLimit)} more of ${list.length - listLimit}</button>` : '');
}

// --- navigation ----------------------------------------------------------------------

function isUnder(path: string, parent: string) {
  return path === parent || path.startsWith(parent + '.') || path.startsWith(parent + '[');
}

function go(i: number) {
  if (!list.length) return;
  cur = (i + list.length) % list.length;
  if (chRow[cur] === undefined) {
    // Inside something folded: unfold its ancestors.
    const path = list[cur].path;
    for (const p of [...view.collapsed]) if (isUnder(path, p)) view.collapsed.delete(p);
    render();
  }
  markCurrent(true);
  if (chRow[cur] !== undefined) select(chRow[cur], false);
  renderStats();
  if (showList && cur >= listLimit) {
    listLimit = cur + LIST_PAGE;
    renderList();
  }
  markListCurrent();
  const c = list[cur];
  $('announce').textContent = `Change ${cur + 1} of ${list.length}, ${KIND_WORD[c.kind]}: ${c.path}, ${describe(c)}`;
}

function markCurrent(scroll: boolean) {
  rowsEl.querySelectorAll('.row.cur').forEach((e) => e.classList.remove('cur'));
  if (cur < 0 || chRow[cur] === undefined) return;
  const el = rowEl(chRow[cur]);
  if (!el) return;
  el.classList.add('cur');
  if (scroll) el.scrollIntoView({ block: 'center' });
}

function markListCurrent() {
  const listEl = $('list');
  listEl.querySelector('.item.cur')?.classList.remove('cur');
  const item = listEl.querySelector(`[data-go="${cur}"]`);
  item?.classList.add('cur');
  item?.scrollIntoView({ block: 'nearest' });
}

const plain = (h: string) => {
  const d = document.createElement('div');
  d.innerHTML = h;
  return d.textContent ?? '';
};

function rowLabel(r: Row): string {
  const kind = { eq: '', in: 'contains changes', chg: 'changed', add: 'added', del: 'removed', ign: 'ignored', mv: 'moved', gap: '' }[r.k];
  const l = r.l ? plain(r.l.h) : '';
  const rt = r.r ? plain(r.r.h) : '';
  const text = r.gap ? `${l}, press Enter to show` : l && rt && l !== rt ? `left ${l}, right ${rt}` : l || rt;
  return [kind, text].filter(Boolean).join(': ');
}

function clearSelection() {
  rowsEl.querySelector('.row.sel')?.classList.remove('sel');
  selectedRow = -1;
  selectedPath = undefined;
  $('status').innerHTML = '';
  rowsEl.removeAttribute('aria-activedescendant');
}

function select(i: number, scroll = true) {
  const old = rowsEl.querySelector('.row.sel');
  old?.classList.remove('sel');
  old?.setAttribute('aria-selected', 'false');
  selectedRow = i;
  const r = rows[i];
  const status = $('status');
  if (!r) return clearSelection();
  selectedPath = r.path;
  const el = rowEl(i);
  if (el) {
    el.classList.add('sel');
    el.setAttribute('aria-selected', 'true');
    el.setAttribute('aria-label', rowLabel(r));
    rowsEl.setAttribute('aria-activedescendant', el.id);
    if (scroll) el.scrollIntoView({ block: 'nearest' });
  }
  const segs = r.node?.segs ?? [];
  const exact = patternOf(segs, false);
  const every = patternOf(segs, true);
  const canIgnore = r.path !== '$' && !r.gap;
  status.innerHTML =
    `<code class="path">${esc(r.path)}</code><button data-act="copyPath">Copy path</button>` +
    (canIgnore ? `<button data-act="ignore" data-pattern="${esc(exact)}" title="Ignore differences under ${esc(exact)}">Ignore this path</button>` : '') +
    (canIgnore && every !== exact ? `<button data-act="ignore" data-pattern="${esc(every)}" title="Ignore differences under ${esc(every)}">Ignore in every item</button>` : '');
}

// --- events --------------------------------------------------------------------------

function toggleFold(r: Row, open?: boolean) {
  const p = r.fold!;
  pin(rows.indexOf(r));
  const wantOpen = open ?? !r.open;
  if (wantOpen === !!r.open) return;
  if (!wantOpen) {
    view.collapsed.add(p);
    view.expanded.delete(p);
  } else {
    view.collapsed.delete(p);
    view.expanded.add(p);
  }
  render();
}

/** Opens what a row stands for: a folded object, or a run of hidden lines. */
function activate(r: Row) {
  if (r.fold && !r.open) toggleFold(r, true);
  else if (r.gap) {
    pin(rows.indexOf(r));
    view.gapsOpen.add(r.gap);
    render();
  }
}

rowsEl.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const tw = t.closest<HTMLElement>('[data-fold]');
  const rowEl = t.closest<HTMLElement>('.row');
  if (!rowEl) return;
  const i = +rowEl.dataset.i!;
  const r = rows[i];
  selectedRow = i;
  if (tw) return toggleFold(r);
  if ((r.fold && !r.open) || r.gap) return activate(r);
  if (r.ch !== undefined) {
    cur = r.ch;
    markCurrent(false);
    renderStats();
    markListCurrent();
  }
  select(i, false);
});

rowsEl.addEventListener('dblclick', (e) => {
  const t = e.target as HTMLElement;
  const c = t.closest<HTMLElement>('.c');
  const rowEl = t.closest<HTMLElement>('.row');
  if (!c || !rowEl || !sides) return;
  const side: Side = c.classList.contains('l') ? 'left' : 'right';
  const cell = rows[+rowEl.dataset.i!][side === 'left' ? 'l' : 'r'];
  if (cell && cell.src > 0 && sides[side].data.canReveal && !sides[side].edited) post({ type: 'reveal', side, line: cell.src, col: cell.col ?? 1 });
});

rowsEl.addEventListener('keydown', (e) => {
  if (!rows.length || e.ctrlKey || e.metaKey || e.altKey) return;
  const r = rows[selectedRow];
  const page = Math.max(1, Math.floor(rowsEl.clientHeight / 22) - 1);
  const move = { ArrowDown: 1, ArrowUp: -1, PageDown: page, PageUp: -page, Home: -Infinity, End: Infinity }[e.key];
  if (move !== undefined) {
    e.preventDefault();
    const from = selectedRow < 0 ? (move > 0 ? -1 : rows.length) : selectedRow;
    select(Math.max(0, Math.min(rows.length - 1, from + move)));
  } else if (!r) return;
  else if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    activate(r);
  } else if (e.key === 'ArrowLeft' && r.fold && r.open) {
    e.preventDefault();
    toggleFold(r, false);
  } else if (e.key === 'ArrowRight' && r.fold && !r.open) {
    e.preventDefault();
    toggleFold(r, true);
  }
});

document.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const btn = t.closest<HTMLElement>('button');
  if (!btn || !sides || !opts) return;
  if (btn.dataset.paste) post({ type: 'paste', side: btn.dataset.paste as Side });
  else if (btn.dataset.pick) post({ type: 'pick', side: btn.dataset.pick as Side });
  else if (btn.dataset.go) go(+btn.dataset.go);
  else if (btn.dataset.format) {
    const side = btn.dataset.format as Side;
    if (!formatSide(side)) {
      $('announce').textContent = `The ${side} side isn't valid JSON yet, so it can't be laid out.`;
      btn.classList.add('shake');
      setTimeout(() => btn.classList.remove('shake'), 400);
    }
  }
  else if (btn.dataset.more) {
    listLimit += LIST_PAGE;
    renderList();
  }
  else if (btn.dataset.unignore) {
    sessionIgnores = sessionIgnores.filter((p) => p !== btn.dataset.unignore);
    recompute();
  } else if (btn.id === 'saveIgnores') {
    post({ type: 'saveIgnore', patterns: sessionIgnores });
    // The settings change comes back as an `options` message carrying them.
  } else if (btn.dataset.gotoError) {
    const side = btn.dataset.gotoError as Side;
    const e = sides[side].parsed.error;
    if (!e) return;
    setEditing(true);
    const ta = $<HTMLTextAreaElement>(`ed-${side}`);
    const lines = ta.value.split('\n');
    const at = lines.slice(0, e.line - 1).reduce((n, l) => n + l.length + 1, 0) + e.col - 1;
    ta.focus();
    ta.setSelectionRange(at, Math.min(at + 1, ta.value.length));
  } else if (btn.dataset.act === 'copyPath' && rows[selectedRow]) {
    post({ type: 'copy', text: rows[selectedRow].path, what: 'path' });
  } else if (btn.dataset.act === 'ignore' && btn.dataset.pattern) {
    const p = btn.dataset.pattern;
    if (compilePattern(p) && !sessionIgnores.includes(p) && !opts.ignorePaths.includes(p)) sessionIgnores.push(p);
    clearSelection();
    recompute();
  }
});

$('next').onclick = () => go(cur + 1);
$('prev').onclick = () => go(cur < 0 ? -1 : cur - 1);
$('toggleList').onclick = () => {
  showList = !showList;
  renderList();
  markCurrent(true);
};
$('edit').onclick = () => setEditing(!editing);
$('swap').onclick = () => {
  if (!sides) return;
  sides = { left: sides.right, right: sides.left };
  $<HTMLTextAreaElement>('ed-left').value = sides.left.text;
  $<HTMLTextAreaElement>('ed-right').value = sides.right.text;
  view.collapsed.clear();
  post({ type: 'swap' });
  recompute();
};
$('textDiff').onclick = () => sides && opts && post({ type: 'textDiff', left: sides.left.text, right: sides.right.text, options: opts });
$('copy').onclick = () => sides && root && post({ type: 'copy', text: summary(), what: `${list.length} change${list.length === 1 ? '' : 's'}` });

document.querySelectorAll<HTMLButtonElement>('[data-opt]').forEach((btn) => {
  btn.onclick = () => {
    if (!opts) return;
    const opt = btn.dataset.opt as Toggle;
    opts[opt] = !opts[opt];
    flipped.add(opt);
    syncToggles();
    if (opt === 'changesOnly') {
      if (cur >= 0 && chRow[cur] !== undefined) pin(chRow[cur]);
      render();
    }
    else {
      view.collapsed.clear();
      recompute();
    }
  };
});

function setEditing(on: boolean) {
  editing = on;
  $('editors').hidden = !on;
  $('edit').classList.toggle('on', on);
  $('edit').setAttribute('aria-pressed', String(on));
  if (on) $<HTMLTextAreaElement>('ed-left').focus();
}

/** Takes what's in a side's box as that side's document. */
function applyEdit(side: Side) {
  if (!sides) return;
  const s = sides[side];
  s.text = $<HTMLTextAreaElement>(`ed-${side}`).value;
  s.parsed = parseLoose(s.text);
  s.edited = true;
  recompute();
}

/**
 * Lays out a side's box with indentation, reading it as loosely as the comparison does
 * (so an escaped or wrapped document comes out as the JSON inside). False if it doesn't parse.
 */
function formatSide(side: Side): boolean {
  const ed = $<HTMLTextAreaElement>(`ed-${side}`);
  const res = parseLoose(ed.value);
  if (!res.value) return false;
  const text = prettyText(res.value);
  if (text !== ed.value) {
    ed.value = text;
    applyEdit(side);
  }
  return true;
}

for (const side of SIDES) {
  let timer: ReturnType<typeof setTimeout>;
  const ed = $<HTMLTextAreaElement>(`ed-${side}`);
  ed.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => applyEdit(side), 200);
  });
  // Pasting a one-line document (an API response, a log payload) lays it out at once.
  ed.addEventListener('paste', () => {
    setTimeout(() => {
      const v = ed.value.trim();
      if (v.length > 2 && !v.includes('\n')) {
        clearTimeout(timer);
        formatSide(side);
      }
    }, 0);
  });
}

document.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement;
  const typing = t.tagName === 'TEXTAREA' || (t instanceof HTMLInputElement && t.type !== 'checkbox' && t.type !== 'button');
  if (e.key === 'F7') {
    e.preventDefault();
    go(e.shiftKey ? (cur < 0 ? -1 : cur - 1) : cur + 1);
  } else if (!typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
    if (e.key === 'n' || e.key === 'j') go(cur + 1);
    else if (e.key === 'p' || e.key === 'k') go(cur < 0 ? -1 : cur - 1);
  }
});

/** An ignore pattern for a path; with `every`, indices become [*] (the same property in every item). */
function patternOf(segs: readonly Seg[], every: boolean): string {
  return '$' + segs.map((x) => (typeof x !== 'string' && every ? '[*]' : formatPath([x]).slice(1))).join('');
}

function summary(): string {
  const n = count();
  const counts = [n.chg && `${n.chg} changed`, n.add && `${n.add} added`, n.del && `${n.del} removed`, n.moved && `${n.moved} moved`].filter(Boolean).join(', ');
  const md = (s: string) => '`' + s.replace(/`/g, "'").replace(/[\r\n]+/g, ' ') + '`';
  const head = `${md(sides!.left.data.label)} ↔ ${md(sides!.right.data.label)}: ${counts || 'no semantic differences'}${ignored ? ` (${ignored} ignored)` : ''}`;
  const lines = list.map((c) => {
    const nd = c.node;
    if (c.kind === 'chg') {
      const [a, b] = previewPair(nd.l, nd.r, 120);
      return `- ${md(c.path)}: ${md(a)} → ${md(b)}`;
    }
    if (c.kind === 'wrap') return `- ${md(c.path)}: ${wrapText(nd)}`;
    if (c.kind === 'add') return `- ${md(c.path)}: added ${md(preview(nd.r, 120))}`;
    if (c.kind === 'del') return `- ${md(c.path)}: removed ${md(preview(nd.l, 120))}`;
    return nd.li === nd.ri ? `- ${md(c.path)}: order changed around it` : `- ${md(c.path)}: moved from index ${nd.li} to ${nd.ri}`;
  });
  return [head, '', ...lines].join('\n') + '\n';
}

// --- host messages -------------------------------------------------------------------

function syncToggles() {
  document.querySelectorAll<HTMLButtonElement>('[data-opt]').forEach((btn) => {
    const on = !!opts?.[btn.dataset.opt as Toggle];
    btn.setAttribute('aria-pressed', String(on));
    btn.classList.toggle('on', on);
  });
}

window.addEventListener('message', (e: MessageEvent<ToWebview>) => {
  const m = e.data;
  if (m.type === 'init') {
    opts = m.options;
    setSide('left', m.left);
    setSide('right', m.right);
    syncToggles();
    if (!m.left.text.trim() && !m.right.text.trim()) setEditing(true);
    recompute();
  } else if (m.type === 'side') {
    setSide(m.side, m.data);
    recompute();
  } else if (m.type === 'options') {
    // Keep the toggles the user flipped here; take everything else from settings.
    const next = { ...m.options };
    for (const t of flipped) next[t] = opts![t];
    opts = next;
    sessionIgnores = sessionIgnores.filter((p) => !opts!.ignorePaths.includes(p));
    syncToggles();
    recompute();
  }
});

post({ type: 'ready' });
