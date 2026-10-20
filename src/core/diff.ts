import { formatCanon, parse, type JV } from './parse';
import { compilePattern, formatPath, matches, type PathPattern, type Seg } from './path';

export interface DiffOptions {
  /** Treat every array as a set: reordering is not a change. */
  ignoreArrayOrder: boolean;
  /** Strings that hold JSON (`"{\"a\":1}"`) are compared as the JSON inside them. */
  parseNestedJson: boolean;
  /** `{"a": null}` equals `{}`. */
  nullEqualsMissing: boolean;
  /** Properties that identify array items, tried in order: `[{id:1},{id:2}]`. */
  arrayMatchKeys: string[];
  /** Paths whose differences are shown but not counted. */
  ignorePaths: string[];
}

export const DEFAULT_OPTIONS: DiffOptions = {
  ignoreArrayOrder: false,
  parseNestedJson: true,
  nullEqualsMissing: false,
  arrayMatchKeys: ['id', '_id', 'uuid', 'key', 'name'],
  ignorePaths: [],
};

/** eq: identical · chg: both present, different · add/del: one side only · ign: different but ignored */
export type Status = 'eq' | 'chg' | 'add' | 'del' | 'ign';

export interface DNode {
  st: Status;
  path: string;
  /** Property name, when the parent is an object. */
  key?: string;
  /** Item positions, when the parent is an array. */
  li?: number;
  ri?: number;
  l?: JV;
  r?: JV;
  /** Present when both sides are objects, or both are arrays. */
  kids?: DNode[];
  /** An array item whose position changed relative to the items around it. */
  moved?: boolean;
  /** For arrays: the property items were matched by. */
  matchKey?: string;
  /** Path segments, for building ignore patterns. */
  segs: Seg[];
  /** One side is JSON held in a string, the other the value itself. */
  wrapped?: 'l' | 'r';
}

export type ChangeKind = 'chg' | 'add' | 'del' | 'moved' | 'wrap';

export interface Change {
  kind: ChangeKind;
  /** More that happened to the same node: moved and changed, say. */
  also?: ChangeKind[];
  path: string;
  node: DNode;
}

export function isChange(n: DNode) {
  return n.st === 'chg' || n.st === 'add' || n.st === 'del' || !!n.moved || !!n.wrapped;
}

export function diff(l: JV, r: JV, options: Partial<DiffOptions> = {}): DNode {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  if (opts.parseNestedJson) {
    l = expandNested(l);
    r = expandNested(r);
  }
  return new Differ(opts).node(l, r, []);
}

/** Leaf-level changes in document order. Containers only count when they moved. */
export function changes(root: DNode): Change[] {
  const out: Change[] = [];
  // One entry per node, so each change has one place to go to.
  const walk = (n: DNode) => {
    const kinds: ChangeKind[] = [];
    if (n.moved) kinds.push('moved');
    if (n.wrapped) kinds.push('wrap');
    if (!n.kids && (n.st === 'chg' || n.st === 'add' || n.st === 'del')) kinds.push(n.st);
    if (kinds.length) out.push(kinds.length > 1 ? { kind: kinds[0], also: kinds.slice(1), path: n.path, node: n } : { kind: kinds[0], path: n.path, node: n });
    if (n.kids) n.kids.forEach(walk);
  };
  walk(root);
  return out;
}

/** Replace strings that contain a JSON object or array by that value, marked `emb`. */
export function expandNested(v: JV): JV {
  if (v.t === 's') {
    const s = v.v.trim();
    if (s.length < 2 || !((s[0] === '{' && s.endsWith('}')) || (s[0] === '[' && s.endsWith(']')))) return v;
    const res = parse(v.v, 1, { strict: true });
    if (!res.value || (res.value.t !== 'o' && res.value.t !== 'a')) return v;
    const inner = relines(expandNested(res.value), v.line, v.col);
    (inner as { emb?: boolean }).emb = true;
    return inner;
  }
  if (v.t === 'o') {
    let changed = false;
    const map = new Map<string, JV>();
    for (const k of v.keys) {
      const x = v.map.get(k)!;
      const y = expandNested(x);
      changed ||= x !== y;
      map.set(k, y);
    }
    return changed ? { ...v, map } : v;
  }
  if (v.t === 'a') {
    const items = v.items.map(expandNested);
    return items.some((y, i) => y !== v.items[i]) ? { ...v, items } : v;
  }
  return v;
}

/** Values parsed out of a string all point at the string's own line. */
export function relines(v: JV, line: number, col?: number): JV {
  if (v.t === 'o') {
    const map = new Map<string, JV>();
    for (const k of v.keys) map.set(k, relines(v.map.get(k)!, line, col));
    return { ...v, map, line, col };
  }
  if (v.t === 'a') return { ...v, items: v.items.map((x) => relines(x, line, col)), line, col };
  return { ...v, line, col };
}

// ---------------------------------------------------------------------------------------

export function cyrb53(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** Stable identity of a value under the options: key order and number spelling never matter. */
export class Hasher {
  private cache = new WeakMap<JV, string>();
  constructor(private opts: Pick<DiffOptions, 'ignoreArrayOrder' | 'nullEqualsMissing'>) {}

  of(v: JV): string {
    let h = this.cache.get(v);
    if (h !== undefined) return h;
    switch (v.t) {
      // Length-prefixed, so a string can't pass for a run of array items.
      case 's': h = v.v.length < 24 ? `s${v.v.length}:${v.v}` : 'S' + cyrb53(v.v) + cyrb53(v.v, 1); break;
      case 'n': h = 'n' + v.canon; break;
      case 'b': h = v.v ? 'T' : 'F'; break;
      case 'z': h = 'z'; break;
      case 'o': {
        const parts: string[] = [];
        for (const k of [...v.keys].sort()) {
          const x = v.map.get(k)!;
          if (this.opts.nullEqualsMissing && x.t === 'z') continue;
          const hx = this.of(x);
          parts.push(`${k.length}:${k}${hx.length}:${hx}`);
        }
        h = 'o' + cyrb53(parts.join(''));
        break;
      }
      case 'a': {
        const parts = v.items.map((x) => this.of(x));
        if (this.opts.ignoreArrayOrder) parts.sort();
        h = 'a' + cyrb53(parts.map((p) => `${p.length}:${p}`).join(''));
        break;
      }
    }
    if ((v.t === 'o' || v.t === 'a') && v.emb) h = 'E' + h;
    this.cache.set(v, h);
    return h;
  }
}

/**
 * Left order, with right-only entries slotted in after their nearest right-hand
 * predecessor and after any left-only entries that follow it, so a removal reads before
 * the addition that replaces it.
 */
export function mergeOrder<T>(left: readonly T[], right: readonly T[]): T[] {
  const inLeft = new Set(left);
  const inRight = new Set(right);
  const head: T[] = [];
  const after = new Map<T, T[]>();
  let prev: T | undefined;
  let seen = false;
  for (const x of right) {
    if (inLeft.has(x)) {
      prev = x;
      seen = true;
    } else if (!seen) head.push(x);
    else {
      let list = after.get(prev as T);
      if (!list) after.set(prev as T, (list = []));
      list.push(x);
    }
  }
  const out: T[] = [];
  let pending = head;
  for (const x of left) {
    if (inRight.has(x) && pending.length) {
      out.push(...pending);
      pending = [];
    }
    out.push(x);
    const list = after.get(x);
    if (list) pending = pending.concat(list);
  }
  out.push(...pending);
  return out;
}

/**
 * Matching positions of a shortest edit script between a[a0..a1) and b[b0..b1)
 * (Myers 1986), or undefined if it needs more than maxEdits edits.
 */
export function myers(a: string[], b: string[], a0: number, a1: number, b0: number, b1: number, maxEdits: number): [number, number][] | undefined {
  const n = a1 - a0;
  const m = b1 - b0;
  const max = Math.min(n + m, maxEdits);
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice(off - d - 1, off + d + 2)); // v[k] for k in [-d-1, d+1]
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[a0 + x] === b[b0 + y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        // Walk back through the saved rows, collecting the diagonal (matching) runs.
        const out: [number, number][] = [];
        let cx = n;
        let cy = m;
        for (let e = d; e >= 0; e--) {
          const row = trace[e];
          const at = (kk: number) => row[kk + e + 1];
          const ck = cx - cy;
          const pk = ck === -e || (ck !== e && at(ck - 1) < at(ck + 1)) ? ck + 1 : ck - 1;
          const px = e === 0 ? 0 : at(pk);
          const py = px - pk;
          while (cx > px && cy > py && cx > 0 && cy > 0) out.push([a0 + --cx, b0 + --cy]);
          cx = px;
          cy = py;
        }
        return out.reverse();
      }
    }
  }
  return undefined;
}

/** Indices (into seq) of one longest strictly increasing subsequence. */
function lisIndices(seq: number[]): Set<number> {
  const tails: number[] = [];
  const prev = new Array<number>(seq.length).fill(-1);
  for (let i = 0; i < seq.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (seq[tails[mid]] < seq[i]) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1];
    tails[lo] = i;
  }
  const keep = new Set<number>();
  for (let k = tails.length ? tails[tails.length - 1] : -1; k >= 0; k = prev[k]) keep.add(k);
  return keep;
}

interface Pair {
  li?: number;
  ri?: number;
  moved?: boolean;
}

const LCS_LIMIT = 4_000_000;
/** Myers' diff gives up past this many insertions and deletions. */
const MYERS_MAX_EDITS = 2000;
/** Over PAIR_LIMIT, a removed item is compared with added items this close in position. */
const PAIR_WINDOW = 64;
const PAIR_LIMIT = 250_000;
const MIN_SIMILARITY = 0.3;
/** Stricter, for pairing items whose identity says they differ, or that sit far apart. */
const RENAME_SIMILARITY = 0.55;

class Differ {
  private h: Hasher;
  private patterns: PathPattern[];

  constructor(private opts: DiffOptions) {
    this.h = new Hasher(opts);
    this.patterns = opts.ignorePaths.map(compilePattern).filter((p): p is PathPattern => !!p);
  }

  private ignored(segs: Seg[]) {
    return this.patterns.length > 0 && this.patterns.some((p) => matches(p, segs));
  }

  node(l: JV | undefined, r: JV | undefined, segs: Seg[], key?: string, li?: number, ri?: number): DNode {
    const n: DNode = { st: 'eq', path: formatPath(segs), segs, l, r };
    if (key !== undefined) n.key = key;
    if (li !== undefined) n.li = li;
    if (ri !== undefined) n.ri = ri;
    const ignored = this.ignored(segs);
    if (!l || !r) {
      const only = (l ?? r)!;
      // With nullEqualsMissing a lone null is simply equal; it isn't hidden or ignored.
      if (this.opts.nullEqualsMissing && only.t === 'z' && key !== undefined) n.st = 'eq';
      else if (ignored) n.st = 'ign';
      else n.st = l ? 'del' : 'add';
      return n;
    }
    // Hashes pair things up; a string's equality is decided by its value.
    const same = this.h.of(l) === this.h.of(r) && (l.t !== 's' || r.t !== 's' || l.v === r.v);
    if (ignored) {
      n.st = same ? 'eq' : 'ign';
      if (!same) return n;
    }
    if ((l.t === 'o' || l.t === 'a') && l.t === r.t && !l.emb !== !(r as typeof l).emb && !ignored) n.wrapped = l.emb ? 'l' : 'r';
    if (l.t === 'o' && r.t === 'o') {
      n.kids = mergeOrder(l.keys, r.keys).map((k) => this.node(l.map.get(k), r.map.get(k), [...segs, k], k));
    } else if (l.t === 'a' && r.t === 'a') {
      const { pairs, matchKey } = this.matchItems(l.items, r.items);
      if (matchKey) n.matchKey = matchKey;
      n.kids = pairs.map((p) => {
        const kid = this.node(
          p.li !== undefined ? l.items[p.li] : undefined,
          p.ri !== undefined ? r.items[p.ri] : undefined,
          [...segs, this.itemSeg(l.items, r.items, p, matchKey)],
          undefined,
          p.li,
          p.ri,
        );
        if (p.moved && !this.opts.ignoreArrayOrder) kid.moved = true;
        return kid;
      });
    } else {
      n.st = same ? 'eq' : 'chg';
      return n;
    }
    if (!ignored) n.st = n.wrapped || n.kids.some(isChange) ? 'chg' : 'eq';
    return n;
  }

  /**
   * The path segment of an array item: its match key when the array has one
   * (`[name="app"]`), else its index on the right side, or on the left if it was removed.
   */
  private itemSeg(L: JV[], R: JV[], p: Pair, matchKey?: string): Seg {
    if (matchKey) {
      const item = (p.ri !== undefined ? R[p.ri] : L[p.li!]) as Extract<JV, { t: 'o' }>;
      const v = item.map.get(matchKey);
      if (v && v.t === 's') return { key: matchKey, id: JSON.stringify(v.v) };
      if (v && v.t === 'n') return { key: matchKey, id: formatCanon(v.canon) };
      if (v && v.t === 'b') return { key: matchKey, id: String(v.v) };
    }
    return p.ri ?? p.li!;
  }

  // --- arrays ----------------------------------------------------------------------------

  private matchItems(L: JV[], R: JV[]): { pairs: Pair[]; matchKey?: string } {
    const matchKey = this.identityKey(L, R);
    if (matchKey) return { pairs: this.byKey(L, R, matchKey), matchKey };
    if (this.opts.ignoreArrayOrder) return { pairs: this.unordered(L, R) };
    return { pairs: this.ordered(L, R) };
  }

  /** The first configured property that is a scalar, present and unique in every item on both sides. */
  private identityKey(L: JV[], R: JV[]): string | undefined {
    if (!L.length || !R.length) return undefined;
    outer: for (const key of this.opts.arrayMatchKeys) {
      const ids: Set<string>[] = [];
      for (const side of [L, R]) {
        const seen = new Set<string>();
        for (const it of side) {
          if (it.t !== 'o') return undefined;
          const v = it.map.get(key);
          if (!v || v.t === 'o' || v.t === 'a' || v.t === 'z') continue outer;
          const h = this.h.of(v);
          if (seen.has(h)) continue outer;
          seen.add(h);
        }
        ids.push(seen);
      }
      for (const id of ids[0]) if (ids[1].has(id)) return key;
    }
    return undefined;
  }

  private byKey(L: JV[], R: JV[], key: string): Pair[] {
    const id = (v: JV) => this.h.of((v as Extract<JV, { t: 'o' }>).map.get(key)!);
    const rightAt = new Map<string, number>();
    R.forEach((v, i) => rightAt.set(id(v), i));
    const byLeft = new Map<number, Pair>();
    const byRight = new Map<number, Pair>();
    const link = (p: Pair) => {
      byLeft.set(p.li!, p);
      byRight.set(p.ri!, p);
    };
    L.forEach((v, li) => {
      const ri = rightAt.get(id(v));
      if (ri !== undefined) link({ li, ri });
    });
    // An item whose key itself changed (a renamed "name") still pairs up if the rest is close.
    const dels = L.map((_, i) => i).filter((i) => !byLeft.has(i));
    const adds = R.map((_, i) => i).filter((i) => !byRight.has(i));
    for (const p of this.pairUp(L, R, dels, adds, false, RENAME_SIMILARITY)) if (p.li !== undefined && p.ri !== undefined) link(p);
    const leftSeq = L.map((_, li) => byLeft.get(li) ?? { li });
    this.markMoves(leftSeq);
    return mergeOrder(
      leftSeq,
      R.map((_, ri) => byRight.get(ri) ?? { ri }),
    );
  }

  private markMoves(leftSeq: Pair[]) {
    const matched = leftSeq.filter((p) => p.li !== undefined && p.ri !== undefined);
    // Run backwards so ties keep the earlier items in place and flag the later ones,
    // e.g. [a, b] -> [b, a] reads as "b moved up", not "a moved down".
    const back = lisIndices(matched.map((p) => -p.ri!).reverse());
    const keep = new Set([...back].map((i) => matched.length - 1 - i));
    matched.forEach((p, i) => {
      if (!keep.has(i)) p.moved = true;
    });
  }

  private unordered(L: JV[], R: JV[]): Pair[] {
    const buckets = new Map<string, number[]>();
    R.forEach((v, ri) => {
      const h = this.h.of(v);
      const b = buckets.get(h);
      if (b) b.push(ri);
      else buckets.set(h, [ri]);
    });
    const byRight = new Map<number, Pair>();
    const leftSeq: Pair[] = [];
    const dels: number[] = [];
    L.forEach((v, li) => {
      const ri = buckets.get(this.h.of(v))?.shift();
      if (ri === undefined) return dels.push(li);
      const p = { li, ri };
      byRight.set(ri, p);
      leftSeq.push(p);
    });
    const adds = R.map((_, ri) => ri).filter((ri) => !byRight.has(ri));
    const rest = this.pairUp(L, R, dels, adds, false);
    // Rebuild both orders with the leftovers in their own places.
    const leftTok = new Map<number, Pair>();
    for (const p of [...leftSeq, ...rest]) if (p.li !== undefined) leftTok.set(p.li, p);
    for (const p of rest) if (p.ri !== undefined) byRight.set(p.ri, p);
    return mergeOrder(
      L.map((_, li) => leftTok.get(li)!),
      R.map((_, ri) => byRight.get(ri)!),
    );
  }

  private ordered(L: JV[], R: JV[]): Pair[] {
    const hl = L.map((v) => this.h.of(v));
    const hr = R.map((v) => this.h.of(v));
    let pre = 0;
    while (pre < L.length && pre < R.length && hl[pre] === hr[pre]) pre++;
    let suf = 0;
    while (suf < L.length - pre && suf < R.length - pre && hl[L.length - 1 - suf] === hr[R.length - 1 - suf]) suf++;

    // Longest common subsequence of the middle; everything else is a gap.
    const kept: Pair[] = [];
    for (let i = 0; i < pre; i++) kept.push({ li: i, ri: i });
    const gaps: { dels: number[]; adds: number[] }[] = [];
    let i = pre;
    let j = pre;
    const gapUntil = (li: number, ri: number) => {
      const g = { dels: [] as number[], adds: [] as number[] };
      while (i < li) g.dels.push(i++);
      while (j < ri) g.adds.push(j++);
      if (g.dels.length || g.adds.length) gaps.push(g);
    };
    for (const [li, ri] of this.common(hl, hr, pre, L.length - suf, pre, R.length - suf)) {
      gapUntil(li, ri);
      kept.push({ li: i++, ri: j++ });
    }
    gapUntil(L.length - suf, R.length - suf);
    for (let k = 0; k < suf; k++) kept.push({ li: L.length - suf + k, ri: R.length - suf + k });

    // An item removed in one place and added unchanged in another moved.
    const free = new Map<string, number[]>();
    for (const g of gaps) for (const ri of g.adds) (free.get(hr[ri]) ?? free.set(hr[ri], []).get(hr[ri])!).push(ri);
    const movedTo = new Map<number, number>();
    const takenRight = new Set<number>();
    for (const g of gaps)
      for (const li of g.dels) {
        const ri = free.get(hl[li])?.shift();
        if (ri === undefined) continue;
        movedTo.set(li, ri);
        takenRight.add(ri);
      }

    const pairs: Pair[] = [...kept];
    for (const [li, ri] of movedTo) pairs.push({ li, ri, moved: true });
    const singles: Pair[] = [];
    for (const g of gaps)
      for (const p of this.pairUp(L, R, g.dels.filter((li) => !movedTo.has(li)), g.adds.filter((ri) => !takenRight.has(ri)), true))
        (p.li !== undefined && p.ri !== undefined ? pairs : singles).push(p);
    // An item that moved to another gap and changed on the way.
    const far = this.pairUp(
      L,
      R,
      singles.filter((p) => p.ri === undefined).map((p) => p.li!),
      singles.filter((p) => p.li === undefined).map((p) => p.ri!),
      false,
      RENAME_SIMILARITY,
    );
    for (const p of far) pairs.push(p);
    // Whatever keeps its relative order isn't moved; the rest is. (Also guards the case
    // where the LCS was approximated and missed some in-order matches.)
    const matched = pairs.filter((p) => p.li !== undefined && p.ri !== undefined).sort((a, b) => a.li! - b.li!);
    for (const p of matched) p.moved = false;
    this.markMoves(matched);

    const byLeft = new Map<number, Pair>();
    const byRight = new Map<number, Pair>();
    for (const p of pairs) {
      if (p.li !== undefined) byLeft.set(p.li, p);
      if (p.ri !== undefined) byRight.set(p.ri, p);
    }
    return mergeOrder(
      L.map((_, li) => byLeft.get(li)!),
      R.map((_, ri) => byRight.get(ri)!),
    );
  }

  /**
   * Matching positions of a longest common subsequence of hl[a0..a1) and hr[b0..b1).
   * Exact (dynamic programming) when the area is small; otherwise patience diff: anchor
   * on items that occur once on each side, then recurse between the anchors.
   */
  private common(hl: string[], hr: string[], a0: number, a1: number, b0: number, b1: number): [number, number][] {
    const out: [number, number][] = [];
    while (a0 < a1 && b0 < b1 && hl[a0] === hr[b0]) out.push([a0++, b0++]);
    const tail: [number, number][] = [];
    while (a0 < a1 && b0 < b1 && hl[a1 - 1] === hr[b1 - 1]) tail.unshift([--a1, --b1]);
    const n = a1 - a0;
    const m = b1 - b0;
    if (n > 0 && m > 0 && n * m <= LCS_LIMIT) {
      // dp[i][j] = LCS length of hl[a0+i..] and hr[b0+j..]
      const w = m + 1;
      const dp = new Uint32Array((n + 1) * w);
      for (let i = n - 1; i >= 0; i--)
        for (let j = m - 1; j >= 0; j--)
          dp[i * w + j] = hl[a0 + i] === hr[b0 + j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
      let i = 0;
      let j = 0;
      while (i < n && j < m) {
        if (hl[a0 + i] === hr[b0 + j]) out.push([a0 + i++, b0 + j++]);
        else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++;
        else j++;
      }
    } else if (n > 0 && m > 0) {
      const count = new Map<string, [number, number, number]>(); // hash -> [left count, right count, left index]
      for (let i = a0; i < a1; i++) {
        const c = count.get(hl[i]);
        if (c) c[0]++;
        else count.set(hl[i], [1, 0, i]);
      }
      const unique: [number, number][] = [];
      for (let j = b0; j < b1; j++) {
        const c = count.get(hr[j]);
        if (c) c[1]++;
      }
      for (let j = b0; j < b1; j++) {
        const c = count.get(hr[j]);
        if (c && c[0] === 1 && c[1] === 1) unique.push([c[2], j]);
      }
      unique.sort((x, y) => x[0] - y[0]);
      const keep = lisIndices(unique.map((u) => u[1]));
      const anchors = unique.filter((_, k) => keep.has(k)).sort((x, y) => x[0] - y[0]);
      // Appending in loops: spreading 100k pairs into push() overflows the stack.
      const add = (pairs: [number, number][]) => {
        for (const p of pairs) out.push(p);
      };
      let pi = a0;
      let pj = b0;
      for (const [ai, aj] of anchors) {
        add(this.common(hl, hr, pi, ai, pj, aj));
        out.push([ai, aj]);
        pi = ai + 1;
        pj = aj + 1;
      }
      if (anchors.length) add(this.common(hl, hr, pi, a1, pj, b1));
      // Nothing unique to anchor on (e.g. many repeated values): Myers' diff, which is
      // cheap when the two sides differ in few places.
      else add(myers(hl, hr, a0, a1, b0, b1, MYERS_MAX_EDITS) ?? []);
    }
    for (const p of tail) out.push(p);
    return out;
  }

  /**
   * Turn a run of removed and added items into modifications where that reads better:
   * containers pair with their most similar counterpart, and in ordered arrays scalars
   * pair up by position.
   */
  private pairUp(L: JV[], R: JV[], dels: number[], adds: number[], ordered: boolean, minSimilarity = MIN_SIMILARITY): Pair[] {
    const pairOf = new Map<number, Pair>(); // by left index
    const usedRight = new Set<number>();
    const container = (v: JV) => v.t === 'o' || v.t === 'a';
    // Score candidate pairs, then take them best first, so an item can't take the
    // counterpart of another that matches it better. Ties go to the closer position.
    const cands: [number, number, number, number][] = []; // score, distance, li, ri
    const consider = (k: number, q: number) => {
      const a = L[dels[k]];
      const b = R[adds[q]];
      if (!container(a) || b.t !== a.t) return;
      const sc = this.similarity(a, b);
      if (sc > minSimilarity) cands.push([sc, Math.abs(q - (k * adds.length) / Math.max(1, dels.length)), dels[k], adds[q]]);
    };
    if (dels.length * adds.length > PAIR_LIMIT) {
      // Too many to compare every pair: compare each removed item with the added items
      // near the same relative position.
      for (let k = 0; k < dels.length; k++) {
        const centre = Math.round((k * adds.length) / Math.max(1, dels.length));
        for (let q = Math.max(0, centre - PAIR_WINDOW); q < Math.min(adds.length, centre + PAIR_WINDOW); q++) consider(k, q);
      }
    } else for (let k = 0; k < dels.length; k++) for (let q = 0; q < adds.length; q++) consider(k, q);
    cands.sort((x, y) => y[0] - x[0] || x[1] - y[1]);
    for (const [, , li, ri] of cands) {
      if (pairOf.has(li) || usedRight.has(ri)) continue;
      usedRight.add(ri);
      pairOf.set(li, { li, ri });
    }
    // One item replaced by one of the same kind, in place: that's a modification.
    if (ordered && dels.length === 1 && adds.length === 1 && !pairOf.size && L[dels[0]].t === R[adds[0]].t) {
      return [{ li: dels[0], ri: adds[0] }];
    }
    if (ordered) {
      const ls = dels.filter((li) => !pairOf.has(li) && !container(L[li]));
      const rs = adds.filter((ri) => !usedRight.has(ri) && !container(R[ri]));
      for (let k = 0; k < Math.min(ls.length, rs.length); k++) {
        usedRight.add(rs[k]);
        pairOf.set(ls[k], { li: ls[k], ri: rs[k] });
      }
    }
    if (ordered) {
      // Pairs must not cross, or the right column would no longer read in its own order.
      const sorted = [...pairOf.values()].sort((a, b) => a.li! - b.li!);
      const keep = lisIndices(sorted.map((p) => p.ri!));
      sorted.forEach((p, i) => {
        if (!keep.has(i)) pairOf.delete(p.li!);
      });
    }
    const byRight = new Map<number, Pair>();
    for (const p of pairOf.values()) byRight.set(p.ri!, p);
    return mergeOrder(
      dels.map((li) => pairOf.get(li) ?? { li }),
      adds.map((ri) => byRight.get(ri) ?? { ri }),
    );
  }

  private similarity(a: JV, b: JV): number {
    if (a.t === 'o' && b.t === 'o') {
      const union = new Set([...a.keys, ...b.keys]).size;
      if (!union) return 1;
      let score = 0;
      for (const k of a.keys) {
        const y = b.map.get(k);
        if (!y) continue;
        const x = a.map.get(k)!;
        score += this.h.of(x) === this.h.of(y) ? 1 : x.t === y.t ? 0.25 : 0.1;
      }
      return score / union;
    }
    if (a.t === 'a' && b.t === 'a') {
      const max = Math.max(a.items.length, b.items.length);
      if (!max) return 1;
      const counts = new Map<string, number>();
      for (const x of a.items) counts.set(this.h.of(x), (counts.get(this.h.of(x)) ?? 0) + 1);
      let common = 0;
      for (const y of b.items) {
        const c = counts.get(this.h.of(y));
        if (c) {
          common++;
          counts.set(this.h.of(y), c - 1);
        }
      }
      return common / max;
    }
    return this.h.of(a) === this.h.of(b) ? 1 : 0;
  }
}
