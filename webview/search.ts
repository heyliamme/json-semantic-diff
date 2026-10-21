// Find in the comparison. It searches the comparison itself rather than the page, so it
// also finds what is folded, hidden by "Changes only", or not built yet (rows far off
// screen aren't in the DOM).
import { compilePattern, matches, type DNode, type JV, type Seg } from '../src/core';

export type Scope = 'both' | 'l' | 'r';

export interface Query {
  text: string;
  caseSensitive: boolean;
  regex: boolean;
  scope: Scope;
}

export interface Hit {
  node: DNode;
  side: 'l' | 'r';
}

export interface Found {
  hits: Hit[];
  /** The query is a path pattern (`$.items[*].price`): whole lines match, not text. */
  pathMode: boolean;
  /** For highlighting text matches in a line; undefined in path mode. */
  pattern?: RegExp;
  error?: string;
  /** More matches than shown. */
  capped: boolean;
}

const LIMIT = 10_000;

/**
 * Whether anything inside a value that prints as one block (added, removed, a change of
 * type) matches: such a block is one node in the comparison, so it is one hit.
 */
function inside(v: JV, segs: Seg[], hit: (key: string | undefined, value: JV, segs: Seg[]) => boolean, key?: string): boolean {
  if (hit(key, v, segs)) return true;
  if (v.t === 'o') return v.keys.some((k) => inside(v.map.get(k)!, [...segs, k], hit, k));
  if (v.t === 'a') return v.items.some((x, i) => inside(x, [...segs, i], hit));
  return false;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function scalarText(v: JV): string | undefined {
  switch (v.t) {
    case 's': return v.v;
    case 'n': return v.raw;
    case 'b': return String(v.v);
    case 'z': return 'null';
    default: return undefined;
  }
}

export function search(root: DNode, q: Query): Found {
  const none: Found = { hits: [], pathMode: false, capped: false };
  const text = q.text;
  if (!text.trim()) return none;
  const sides: ('l' | 'r')[] = q.scope === 'both' ? ['l', 'r'] : [q.scope];
  const hits: Hit[] = [];
  let capped = false;

  // A path pattern: $.a.b, $.items[*].price, $..id
  if (text.trim().startsWith('$')) {
    const p = compilePattern(text.trim());
    if (!p) return { ...none, pathMode: true, error: 'Not a valid path' };
    const walk = (n: DNode) => {
      if (hits.length >= LIMIT) return void (capped = true);
      for (const s of sides) {
        const v = n[s];
        if (!v) continue;
        if (n.kids ? matches(p, n.segs) : inside(v, n.segs, (_k, _v, segs) => matches(p, segs))) hits.push({ node: n, side: s });
      }
      n.kids?.forEach(walk);
    };
    walk(root);
    return { hits, pathMode: true, capped };
  }

  let pattern: RegExp;
  try {
    pattern = new RegExp(q.regex ? text : escapeRe(text), q.caseSensitive ? 'g' : 'gi');
  } catch {
    return { ...none, error: 'Not a valid regular expression' };
  }
  const test = (s: string) => {
    pattern.lastIndex = 0;
    return pattern.test(s);
  };
  const walk = (n: DNode) => {
    if (hits.length >= LIMIT) return void (capped = true);
    for (const s of sides) {
      const v = n[s];
      if (!v) continue;
      const own = (key: string | undefined, x: JV) => {
        const value = scalarText(x);
        return (key !== undefined && test(key)) || (value !== undefined && test(value));
      };
      if (n.kids ? own(n.key, v) : inside(v, n.segs, (k, x, segs) => own(segs === n.segs ? n.key : k, x))) hits.push({ node: n, side: s });
    }
    n.kids?.forEach(walk);
  };
  walk(root);
  return { hits, pathMode: false, pattern, capped };
}

/** Wraps every match of `pattern` in the text under `el` in <mark class="hit">. */
export function highlight(el: Element, pattern: RegExp) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (!(n.parentElement?.closest('.badge, .fold, .ln, .ind'))) texts.push(n as Text);
  for (const t of texts) {
    const s = t.data;
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    let last = 0;
    const parts: (string | HTMLElement)[] = [];
    while ((m = pattern.exec(s))) {
      if (!m[0].length) {
        pattern.lastIndex++;
        continue;
      }
      if (m.index > last) parts.push(s.slice(last, m.index));
      const mark = document.createElement('mark');
      mark.className = 'hit';
      mark.textContent = m[0];
      parts.push(mark);
      last = m.index + m[0].length;
    }
    if (!parts.length) continue;
    if (last < s.length) parts.push(s.slice(last));
    t.replaceWith(...parts);
  }
}
