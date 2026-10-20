// Turns a diff tree into aligned rows: one row per printed line, with a blank cell on the
// side that has no counterpart, so both columns always line up.
import { mergeOrder, type Change, type DNode, type JV } from '../src/core';

export type RowKind = 'eq' | 'chg' | 'add' | 'del' | 'ign' | 'in' | 'mv' | 'gap';

export interface Cell {
  /** Indent depth. */
  d: number;
  h: string;
  /** Printed line number; 0 for rows that stand for something hidden. */
  n: number;
  /** Source line; -2 for a printed line with no source position (closing brackets), -1 for rows that stand for hidden content. */
  src: number;
  /** Source column of the value, for going to it. */
  col?: number;
  /** The file line number to show: the source line, where this row starts one. */
  ln?: number;
}

export interface Row {
  l?: Cell;
  r?: Cell;
  k: RowKind;
  path: string;
  node?: DNode;
  /** Index of the change that starts on this row. */
  ch?: number;
  /** Twisty: the path to fold or unfold. */
  fold?: string;
  open?: boolean;
  /** A run of unchanged siblings hidden in "changes only" mode. */
  gap?: string;
}

export interface RenderState {
  collapsed: Set<string>;
  expanded: Set<string>;
  gapsOpen: Set<string>;
  changesOnly: boolean;
  foldThreshold: number;
  changeIndex: Map<DNode, number>;
}

type Container = Extract<JV, { t: 'o' | 'a' }>;
type Half = 'l' | 'r';
/** One entry in the printed order of a container's children. */
interface Tok {
  kid: DNode;
  /** A moved item is printed twice: where it was (left only) and where it is (right only). */
  half?: Half;
}

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const punc = (s: string) => `<span class="p">${s}</span>`;
const comma = (on: boolean) => (on ? punc(',') : '');
const keyHtml = (k: string) => `<span class="k">${esc(JSON.stringify(k))}</span>${punc(': ')}`;
const badge = (text: string, cls = '') => `<span class="badge ${cls}">${text}</span>`;
const isContainer = (v: JV): v is Container => v.t === 'o' || v.t === 'a';

export function scalarHtml(v: JV, mark?: 'all' | [number, number]): string {
  const m = (s: string) => (mark === 'all' ? `<mark>${s}</mark>` : s);
  switch (v.t) {
    case 's': {
      if (Array.isArray(mark)) {
        const [a, b] = mark;
        const q = (s: string) => esc(JSON.stringify(s).slice(1, -1));
        const mid = a < b ? `<mark>${q(v.v.slice(a, b))}</mark>` : '';
        return `<span class="s">"${q(v.v.slice(0, a))}${mid}${q(v.v.slice(b))}"</span>`;
      }
      return `<span class="s">${m(esc(JSON.stringify(v.v)))}</span>`;
    }
    case 'n': return `<span class="n">${m(esc(v.raw))}</span>`;
    case 'b': return `<span class="b">${m(String(v.v))}</span>`;
    case 'z': return `<span class="z">${m('null')}</span>`;
    default: return '';
  }
}

/** The differing middle of two strings, as [start, endA] and [start, endB]. */
export function strSpan(a: string, b: string): [[number, number], [number, number]] {
  let p = 0;
  const max = Math.min(a.length, b.length);
  while (p < max && a[p] === b[p]) p++;
  // Never split a surrogate pair (emoji and other astral characters).
  const low = (c: number) => c >= 0xdc00 && c <= 0xdfff;
  if (p > 0 && p < max && low(a.charCodeAt(p))) p--;
  let s = 0;
  while (s < max - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  if (s > 0 && low(a.charCodeAt(a.length - s))) s--;
  // Little in common: mark the whole value rather than scattered letters.
  if ((p + s) * 2 < max) return [
    [0, a.length],
    [0, b.length],
  ];
  return [
    [p, a.length - s],
    [p, b.length - s],
  ];
}

const lineMemo = new WeakMap<JV, number>();
export function lineCount(v: JV): number {
  if (!isContainer(v)) return 1;
  let n = lineMemo.get(v);
  if (n !== undefined) return n;
  const kids = v.t === 'o' ? v.keys.map((k) => v.map.get(k)!) : v.items;
  n = kids.length ? 2 + kids.reduce((s, x) => s + lineCount(x), 0) : 1;
  lineMemo.set(v, n);
  return n;
}

export function countChanges(n: DNode): number {
  let c = n.moved ? 1 : 0;
  if (n.kids) for (const k of n.kids) c += countChanges(k);
  else if (n.st === 'chg' || n.st === 'add' || n.st === 'del') c++;
  return c;
}

export class Builder {
  rows: Row[] = [];
  private ln = { l: 0, r: 0 };
  private lastSrc = { l: 0, r: 0 };
  /** The largest file line number shown, to size the gutter. */
  maxLine = 0;

  constructor(private s: RenderState) {}

  /** `hideL` / `hideR`: lines this row stands for beyond its own, so numbers stay the same whatever is folded. */
  private push(row: Row, hideL = 0, hideR = 0) {
    if (row.l && row.l.src !== -1) row.l.n = ++this.ln.l;
    if (row.r && row.r.src !== -1) row.r.n = ++this.ln.r;
    // Show a file line number once per line: a minified file numbers only its first row.
    for (const side of ['l', 'r'] as const) {
      const c = row[side];
      if (c && c.src > 0 && c.src !== this.lastSrc[side]) {
        c.ln = c.src;
        this.lastSrc[side] = c.src;
        if (c.src > this.maxLine) this.maxLine = c.src;
      }
    }
    this.ln.l += hideL;
    this.ln.r += hideR;
    this.rows.push(row);
  }

  private print(v: JV, d: number, prefix: string, trailing: boolean, out: Cell[] = []): Cell[] {
    if (!isContainer(v)) {
      out.push({ d, h: prefix + scalarHtml(v) + comma(trailing), n: 0, src: v.line, col: v.col });
      return out;
    }
    const [o, c] = v.t === 'o' ? ['{', '}'] : ['[', ']'];
    const emb = v.emb ? badge('JSON in a string', 'emb') : '';
    const kids: [string, JV][] = v.t === 'o' ? v.keys.map((k) => [keyHtml(k), v.map.get(k)!]) : v.items.map((x) => ['', x]);
    if (!kids.length) {
      out.push({ d, h: prefix + punc(o + c) + comma(trailing) + emb, n: 0, src: v.line, col: v.col });
      return out;
    }
    out.push({ d, h: prefix + punc(o) + emb, n: 0, src: v.line, col: v.col });
    kids.forEach(([k, x], i) => this.print(x, d + 1, k, i < kids.length - 1, out));
    out.push({ d, h: punc(c) + comma(trailing), n: 0, src: -2 });
    return out;
  }

  private folded(n: DNode, d: number): boolean {
    if (this.s.collapsed.has(n.path)) return true;
    if (d === 0 || n.st !== 'eq' || this.s.expanded.has(n.path)) return false;
    return lineCount(n.l!) > this.s.foldThreshold;
  }

  node(n: DNode, d: number, cL: boolean, cR: boolean) {
    const key = n.key !== undefined ? keyHtml(n.key) : '';
    const ch = this.s.changeIndex.get(n);
    const moved = n.moved ? badge('moved', 'mv') : '';

    if (n.kids && n.l && n.r && isContainer(n.l) && isContainer(n.r)) {
      const l = n.l;
      const r = n.r;
      const [o, c] = l.t === 'o' ? ['{', '}'] : ['[', ']'];
      const kind: RowKind = n.moved ? 'mv' : n.st === 'eq' ? 'eq' : 'in';
      const extra = (v: Container) =>
        (v.emb ? badge('JSON in a string', n.wrapped ? 'wrap' : 'emb') : '') + moved + (n.matchKey ? badge(`by ${esc(n.matchKey)}`, 'mk') : '');

      if (!n.kids.length) {
        this.push({ l: { d, h: key + punc(o + c) + comma(cL) + extra(l), n: 0, src: l.line, col: l.col }, r: { d, h: key + punc(o + c) + comma(cR) + extra(r), n: 0, src: r.line, col: r.col }, k: kind, path: n.path, node: n, ch });
        return;
      }
      if (this.folded(n, d)) {
        const unit = l.t === 'o' ? 'keys' : 'items';
        const inside = countChanges(n);
        const sum = (v: Container) =>
          `<span class="fold">${v.t === 'o' ? v.keys.length : v.items.length} ${unit}${inside ? ` · ${inside} change${inside > 1 ? 's' : ''}` : ''}</span>`;
        this.push({
          l: { d, h: key + punc(o) + sum(l) + punc(c) + comma(cL) + extra(l), n: 0, src: l.line, col: l.col },
          r: { d, h: key + punc(o) + sum(r) + punc(c) + comma(cR) + extra(r), n: 0, src: r.line, col: r.col },
          k: inside ? 'in' : kind,
          path: n.path, node: n,
          ch,
          fold: n.path,
          open: false,
        }, lineCount(l) - 1, lineCount(r) - 1);
        return;
      }
      this.push({
        l: { d, h: key + punc(o) + extra(l), n: 0, src: l.line, col: l.col },
        r: { d, h: key + punc(o) + extra(r), n: 0, src: r.line, col: r.col },
        k: kind,
        path: n.path, node: n,
        ch,
        fold: n.path,
        open: true,
      });
      const toks = this.order(n);
      const has = (t: Tok, side: Half) => (t.half ? t.half === side : !!t.kid[side]);
      let lastL = -1;
      let lastR = -1;
      toks.forEach((t, i) => {
        if (has(t, 'l')) lastL = i;
        if (has(t, 'r')) lastR = i;
      });
      const emit = (t: Tok, i: number) => {
        if (t.half) this.half(t.kid, d + 1, t.half, t.half === 'l' ? i < lastL : i < lastR, true);
        else this.node(t.kid, d + 1, i < lastL, i < lastR);
      };
      const quiet = (t: Tok) => !t.half && t.kid.st === 'eq' && !t.kid.moved;
      for (let i = 0; i < toks.length; ) {
        if (this.s.changesOnly && quiet(toks[i])) {
          let j = i;
          while (j < toks.length && quiet(toks[j])) j++;
          const id = `${n.path}#${i}`;
          if ((j - i >= 2 || toks[i].kid.kids) && !this.s.gapsOpen.has(id)) {
            const unit = l.t === 'o' ? (j - i === 1 ? 'property' : 'properties') : j - i === 1 ? 'item' : 'items';
            const h = `<span class="gapt">${j - i} unchanged ${unit}</span>`;
            let hideL = 0;
            let hideR = 0;
            for (let x = i; x < j; x++) {
              hideL += toks[x].kid.l ? lineCount(toks[x].kid.l!) : 0;
              hideR += toks[x].kid.r ? lineCount(toks[x].kid.r!) : 0;
            }
            this.push({ l: { d: d + 1, h, n: 0, src: -1 }, r: { d: d + 1, h, n: 0, src: -1 }, k: 'gap', path: n.path, node: n, gap: id }, hideL, hideR);
          } else for (let x = i; x < j; x++) emit(toks[x], x);
          i = j;
          continue;
        }
        emit(toks[i], i);
        i++;
      }
      this.push({ l: { d, h: punc(c) + comma(cL), n: 0, src: -2 }, r: { d, h: punc(c) + comma(cR), n: 0, src: -2 }, k: kind === 'mv' ? 'in' : kind, path: n.path, node: n });
      return;
    }

    // A leaf: a scalar, a one-sided value, a change of type, or an ignored subtree.
    const L = n.l ? this.print(n.l, d, key, cL) : [];
    const R = n.r ? this.print(n.r, d, key, cR) : [];
    if (L[0]) L[0].h = this.marked(n, 'l', key, cL) ?? L[0].h;
    if (R[0]) R[0].h = this.marked(n, 'r', key, cR) ?? R[0].h;
    if (n.st === 'ign') {
      const tag = badge('ignored', 'ign');
      if (L[0]) L[0].h += tag;
      if (R[0]) R[0].h += tag;
    }
    if (n.moved) {
      if (L[0]) L[0].h += moved;
      if (R[0]) R[0].h += moved;
    }
    const k: RowKind = n.moved && n.st === 'eq' ? 'mv' : n.st;
    for (let i = 0; i < Math.max(L.length, R.length); i++) {
      this.push({ l: L[i], r: R[i], k, path: n.path, node: n, ch: i === 0 ? ch : undefined });
    }
  }

  /** A changed scalar with its differing part marked, or undefined. */
  private marked(n: DNode, side: Half, key: string, trailing: boolean): string | undefined {
    if (n.st !== 'chg' || !n.l || !n.r || isContainer(n.l) || isContainer(n.r)) return undefined;
    let mark: 'all' | [number, number] = 'all';
    if (n.l.t === 's' && n.r.t === 's') mark = strSpan(n.l.v, n.r.v)[side === 'l' ? 0 : 1];
    return key + scalarHtml(n[side]!, mark) + comma(trailing);
  }

  /**
   * Children in printed order. Without moves that is the diff's own order. With moves,
   * left-only entries follow the left document and right-only entries the right one, so
   * each column still reads as its own document.
   */
  private order(n: DNode): Tok[] {
    const kids = n.kids!;
    if (!kids.some((k) => k.moved)) return kids.map((kid) => ({ kid }));
    const both = new Map<DNode, Tok>();
    for (const k of kids) if (k.l && k.r && !k.moved) both.set(k, { kid: k });
    const seq = (side: Half) =>
      kids
        .filter((k) => k[side])
        .sort((a, b) => (side === 'l' ? a.li! - b.li! : a.ri! - b.ri!))
        .map((k) => both.get(k) ?? (k.l && k.r ? { kid: k, half: side } : { kid: k }));
    return mergeOrder(seq('l'), seq('r'));
  }

  /** One side of a moved item, with its own changes marked on that side. */
  private half(n: DNode, d: number, side: Half, trailing: boolean, top: boolean) {
    const v = n[side]!;
    const key = n.key !== undefined ? keyHtml(n.key) : '';
    const tag = top ? badge(n.li === n.ri ? 'moved' : side === 'l' ? `moved to index ${n.ri}` : `moved from index ${n.li}`, 'mv') : '';
    // Each change starts on one row: removals and moves on the left, the rest on the right.
    const owns = top ? side === 'l' : n.st === 'del' || n.moved ? side === 'l' : side === 'r';
    const ch = owns ? this.s.changeIndex.get(n) : undefined;
    const put = (cell: Cell, k: RowKind, c?: number) => this.push(side === 'l' ? { l: cell, k, path: n.path, node: n, ch: c } : { r: cell, k, path: n.path, node: n, ch: c });
    if (n.kids && n.l && n.r && isContainer(n.l) && isContainer(n.r)) {
      const cv = v as Container;
      const [o, c] = cv.t === 'o' ? ['{', '}'] : ['[', ']'];
      const kids = n.kids.filter((k) => k[side]);
      if (cv.t === 'a') kids.sort((a, b) => (side === 'l' ? a.li! - b.li! : a.ri! - b.ri!));
      put({ d, h: key + punc(kids.length ? o : o + c) + (kids.length ? '' : comma(trailing)) + tag, n: 0, src: v.line, col: v.col }, 'mv', ch);
      if (!kids.length) return;
      kids.forEach((k, i) => this.half(k, d + 1, side, i < kids.length - 1, false));
      put({ d, h: punc(c) + comma(trailing), n: 0, src: -2 }, 'mv');
      return;
    }
    const cells = this.print(v, d, key, trailing);
    cells[0].h = (this.marked(n, side, key, trailing) ?? cells[0].h) + tag;
    const changed = side === 'l' ? n.st === 'chg' || n.st === 'del' : n.st === 'chg' || n.st === 'add';
    const k: RowKind = n.st === 'ign' ? 'ign' : changed ? (side === 'l' ? 'del' : 'add') : 'mv';
    cells.forEach((cell, i) => put(cell, k, i === 0 ? ch : undefined));
  }
}

/** Changes in the order they print, top to bottom (moved items print in two places). */
export function inPrintOrder(root: DNode, list: Change[]): Change[] {
  const b = new Builder({ collapsed: new Set(), expanded: new Set(), gapsOpen: new Set(), changesOnly: false, foldThreshold: Infinity, changeIndex: new Map(list.map((c, i) => [c.node, i])) });
  b.node(root, 0, false, false);
  const order = b.rows.filter((r) => r.ch !== undefined).map((r) => r.ch!);
  return order.length === list.length ? order.map((i) => list[i]) : list;
}

