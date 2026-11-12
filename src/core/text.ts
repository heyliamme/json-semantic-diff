// Word-level comparison of two strings, refined to characters inside short changed
// words, for marking exactly what changed in a value or a line of text.
import { myers } from './diff';

export interface Piece {
  text: string;
  changed: boolean;
}

/** Fallback tokens: words (with their combining marks), runs of whitespace, single other characters. */
const TOKEN = /[\p{L}\p{N}\p{M}_]+|\s+|[^\p{L}\p{N}\p{M}_\s]/gu;

// Word and grapheme boundaries from Intl.Segmenter where there is one: it splits Chinese,
// Japanese and Thai into words and keeps "é", "👍🏿" and "👨‍👩‍👧" whole.
const Seg = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => { segment(s: string): Iterable<{ segment: string }> } }).Segmenter;
const wordSeg = Seg ? new Seg(undefined, { granularity: 'word' }) : undefined;
const graphemeSeg = Seg ? new Seg(undefined, { granularity: 'grapheme' }) : undefined;
/** Changed runs at most this long (in characters) are compared character by character. */
const REFINE = 48;
const MAX_EDITS = 2000;

export const tokens = (s: string): string[] => (wordSeg ? Array.from(wordSeg.segment(s), (x) => x.segment) : (s.match(TOKEN) ?? []));

function push(out: Piece[], text: string, changed: boolean) {
  if (!text) return;
  const last = out[out.length - 1];
  if (last && last.changed === changed) last.text += text;
  else out.push({ text, changed });
}

/** Characters as the reader sees them: "é", an emoji with its skin tone, a ZWJ family. */
const chars = (s: string) => (graphemeSeg ? Array.from(graphemeSeg.segment(s), (x) => x.segment) : Array.from(s));

/** The run as shared start, differing middle, shared end: cheap, for runs too long to refine. */
function trimmed(a: string, b: string, out: [Piece[], Piece[]]) {
  const ca = chars(a);
  const cb = chars(b);
  let p = 0;
  while (p < ca.length && p < cb.length && ca[p] === cb[p]) p++;
  let q = 0;
  while (q < ca.length - p && q < cb.length - p && ca[ca.length - 1 - q] === cb[cb.length - 1 - q]) q++;
  for (const [side, cs] of [[0, ca], [1, cb]] as const) {
    push(out[side], cs.slice(0, p).join(''), false);
    push(out[side], cs.slice(p, cs.length - q).join(''), true);
    push(out[side], cs.slice(cs.length - q).join(''), false);
  }
}

function compare(a: string[], b: string[], out: [Piece[], Piece[]], refine: boolean) {
  const pairs = myers(a, b, 0, a.length, 0, b.length, MAX_EDITS);
  if (!pairs) {
    push(out[0], a.join(''), true);
    push(out[1], b.join(''), true);
    return;
  }
  let i = 0;
  let j = 0;
  const gap = (ui: number, uj: number) => {
    const da = a.slice(i, ui).join('');
    const db = b.slice(j, uj).join('');
    if (refine && da && db && (da.length > REFINE || db.length > REFINE)) {
      // A long hash or token with a character off: mark just that, not the whole run.
      trimmed(da, db, out);
      return;
    }
    if (refine && da && db) {
      // Down to characters only for near-identical words (Rd → Road, a hash with one
      // character off); different words are marked whole.
      const sub: [Piece[], Piece[]] = [[], []];
      compare(chars(da), chars(db), sub, false);
      const kept = sub[0].filter((p) => !p.changed).reduce((n, p) => n + chars(p.text).length, 0);
      if (kept * 2 >= Math.max(chars(da).length, chars(db).length)) {
        for (const p of sub[0]) push(out[0], p.text, p.changed);
        for (const p of sub[1]) push(out[1], p.text, p.changed);
        return;
      }
    }
    push(out[0], da, true);
    push(out[1], db, true);
  };
  for (const [x, y] of pairs) {
    gap(x, y);
    push(out[0], a[x], false);
    push(out[1], b[y], false);
    i = x + 1;
    j = y + 1;
  }
  gap(a.length, b.length);
}

/**
 * The pieces of each string, marked where they differ. When the two have little in
 * common, each string is one changed piece rather than a scatter of marks.
 */
export function wordDiff(a: string, b: string): [Piece[], Piece[]] {
  if (a === b) return [[{ text: a, changed: false }], [{ text: b, changed: false }]];
  const out: [Piece[], Piece[]] = [[], []];
  compare(tokens(a), tokens(b), out, true);
  // Measured in characters as seen (an emoji with a skin tone is one), not code units.
  const same = out[0].filter((p) => !p.changed).reduce((n, p) => n + chars(p.text.trim()).length, 0);
  if (same * 3 < Math.min(chars(a.trim()).length, chars(b.trim()).length)) {
    return [a ? [{ text: a, changed: true }] : [], b ? [{ text: b, changed: true }] : []];
  }
  return out;
}

/** Lines of a text; a final line break doesn't make an extra empty line. */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}
