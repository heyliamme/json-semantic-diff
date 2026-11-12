// Rows for comparing plain text: one row per line, lines matched the way array items are
// (longest common run, moves), and changed lines marked word by word.
import { diff, splitLines, wordDiff, type DNode, type JV } from '../src/core';
import { esc, piecesHtml, printOrder, type Cell, type Row, type RowKind } from './render';

/** Unchanged lines kept around each change in "changes only". */
const CONTEXT = 2;

export interface TextDoc {
  /** Each line as written. */
  raw: string[];
}

export interface TextOptions {
  ignoreWhitespace: boolean;
}

/** Compares two texts line by line. */
export function diffText(a: string, b: string, o: TextOptions): { root: DNode; left: TextDoc; right: TextDoc } {
  const left = { raw: splitLines(a) };
  const right = { raw: splitLines(b) };
  const norm = (s: string) => (o.ignoreWhitespace ? s.trim().replace(/\s+/g, ' ') : s);
  const lines = (d: TextDoc): JV => ({ t: 'a', line: 1, items: d.raw.map((s, i) => ({ t: 's', v: norm(s), line: i + 1 })) });
  const root = diff(lines(left), lines(right), { arrayMatchKeys: [], ignoreArrayOrder: false, parseNestedJson: false, nullEqualsMissing: false, ignorePaths: [], textLines: true });
  return { root, left, right };
}

/** "line 12", or "line 12 → 14" when a line sits at different places on the two sides. */
export function lineLabel(n: DNode): string {
  const l = n.li !== undefined ? n.li + 1 : undefined;
  const r = n.ri !== undefined ? n.ri + 1 : undefined;
  if (l !== undefined && r !== undefined) return l === r ? `line ${l}` : `line ${l} → ${r}`;
  return l !== undefined ? `left line ${l}` : `right line ${r}`;
}

export interface TextRowState {
  changesOnly: boolean;
  /** Whitespace differences inside a changed line aren't marked. */
  ignoreWhitespace?: boolean;
  changeIndex: Map<DNode, number>;
  gapsOpen: Set<string>;
  /** A node path that must stay visible (the current search hit). */
  reveal?: string;
}

export function textRows(root: DNode, left: TextDoc, right: TextDoc, s: TextRowState): { rows: Row[]; maxLine: number } {
  const rows: Row[] = [];
  const count = { l: 0, r: 0 };
  const cell = (side: 'l' | 'r', i: number, h: string): Cell => ({ d: 0, h, n: ++count[side], src: i + 1, ln: i + 1, col: 1 });
  const plain = (doc: TextDoc, i: number) => esc(doc.raw[i]) || ' ';
  const toks = printOrder(root);

  const emit = (t: (typeof toks)[number]) => {
    const n = t.kid;
    const ch = s.changeIndex.get(n);
    const base = { path: n.path, node: n };
    // A moved line shows where it was (left) and where it went (right); if it was also
    // edited, each half marks its own side's changes.
    if (t.half) {
      const side = t.half;
      const edited = n.st === 'chg';
      let h = side === 'l' ? plain(left, n.li!) : plain(right, n.ri!);
      if (edited) h = piecesHtml(linePieces(left.raw[n.li!], right.raw[n.ri!], !!s.ignoreWhitespace)[side === 'l' ? 0 : 1], (x) => x) || ' ';
      const what = edited ? 'moved and changed' : 'moved';
      const tag = `<span class="badge mv">${side === 'l' ? `${what}: now line ${n.ri! + 1}` : `${what}: was line ${n.li! + 1}`}</span>`;
      const k: RowKind = edited ? (side === 'l' ? 'del' : 'add') : 'mv';
      if (side === 'l') rows.push({ ...base, l: cell('l', n.li!, h + tag), k, ch });
      else rows.push({ ...base, r: cell('r', n.ri!, h + tag), k });
      return;
    }
    if (n.li !== undefined && n.ri !== undefined) {
      let lh = plain(left, n.li);
      let rh = plain(right, n.ri);
      let k: RowKind = 'eq';
      if (n.st === 'chg') {
        const [lp, rp] = linePieces(left.raw[n.li], right.raw[n.ri], !!s.ignoreWhitespace);
        lh = piecesHtml(lp, (x) => x) || ' ';
        rh = piecesHtml(rp, (x) => x) || ' ';
        k = 'chg';
      }
      rows.push({ ...base, l: cell('l', n.li, lh), r: cell('r', n.ri, rh), k, ch });
    } else if (n.li !== undefined) rows.push({ ...base, l: cell('l', n.li, plain(left, n.li)), k: 'del', ch });
    else rows.push({ ...base, r: cell('r', n.ri!, plain(right, n.ri!)), k: 'add', ch });
  };

  const quiet = (t: (typeof toks)[number]) => !t.half && t.kid.st === 'eq' && !t.kid.moved && t.kid.path !== s.reveal;
  for (let i = 0; i < toks.length; ) {
    if (s.changesOnly && quiet(toks[i])) {
      let j = i;
      while (j < toks.length && quiet(toks[j])) j++;
      // Keep a little context next to changes; hide the middle of long unchanged runs.
      const head = i === 0 ? 0 : CONTEXT;
      const tail = j === toks.length ? 0 : CONTEXT;
      const id = `text#${i}`;
      if (j - i > head + tail + 1 && !s.gapsOpen.has(id)) {
        for (let x = i; x < i + head; x++) emit(toks[x]);
        const hidden = j - i - head - tail;
        const h = `<span class="gapt">${hidden} unchanged line${hidden === 1 ? '' : 's'}</span>`;
        rows.push({ l: { d: 0, h, n: 0, src: -1 }, r: { d: 0, h, n: 0, src: -1 }, k: 'gap', path: root.path, node: root, gap: id });
        for (let x = j - tail; x < j; x++) emit(toks[x]);
      } else for (let x = i; x < j; x++) emit(toks[x]);
      i = j;
      continue;
    }
    emit(toks[i]);
    i++;
  }
  return { rows, maxLine: Math.max(left.raw.length, right.raw.length) };
}

/** The two lines marked word by word; with ignoreWhitespace, spacing changes aren't marked. */
export function linePieces(a: string, b: string, ignoreWhitespace: boolean) {
  const pieces = wordDiff(a, b);
  if (ignoreWhitespace) for (const side of pieces) for (const p of side) if (!p.text.trim()) p.changed = false;
  return pieces;
}

