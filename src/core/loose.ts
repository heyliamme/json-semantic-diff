// What people paste is often JSON once removed: a JSON document inside a string, an
// escaped copy out of a log line, JSON Lines, or a payload with log text around it.
// These are read as the JSON they contain, with a note saying what was done.
//
// A document that starts like JSON and has a syntax error is never "rescued" by picking
// a fragment of it: it reports the error, so a typo can't silently change what is compared.
import { relines } from './diff';
import { parse, parseAll, type JV, type ParseResult } from './parse';

const MAX_UNWRAP = 3;
const MAX_STARTS = 8;
const MAX_ENDS = 8;

const nextOpen = (text: string, from: number) => {
  const i = text.slice(from).search(/[{[]/);
  return i < 0 ? -1 : from + i;
};
/** Blank out text but keep line breaks, so line and column numbers still match. */
const blank = (s: string) => s.replace(/[^\n]/g, ' ');

export function parseLoose(text: string): ParseResult {
  const first = parse(text);
  if (first.value) return unwrap(first);
  const err = first.error!;
  const lead = text.replace(/^\ufeff/, '').trimStart()[0];

  // A complete value followed by more: JSON Lines, or a value with text after it.
  if (err.trailingAt !== undefined) {
    const all = parseAll(text);
    if (all && all.length > 1) {
      return { value: { t: 'a', items: all, line: all[0].line }, warnings: first.warnings, notes: [`Read ${all.length} JSON lines as an array`] };
    }
    // "[200] {...}": the value at the start may just be a prefix of a larger one.
    const found = largest(text);
    if (found && (found.end + 1 - found.at > err.trailingAt || (found.at >= err.trailingAt && err.trailingAt <= 32))) return found.result;
    // What follows looks like more JSON (an extra bracket, a comma, another value):
    // that's a syntax error, not text to skip.
    if (/^[,:}\]{["]/.test(text.slice(err.trailingAt))) return first;
    // A lone number or word followed by text is a log line, not JSON ("2026-10-20 …").
    const res = parse(text.slice(0, err.trailingAt) + blank(text.slice(err.trailingAt)));
    if (res.value && (res.value.t === 'o' || res.value.t === 'a')) return withNote(unwrap(res), 'Skipped the text after the JSON');
    if (found) return found.result;
  }

  // {\"a\":1} — escaped, without the surrounding quotes.
  if (/\\"/.test(text)) {
    const t = text.trim();
    const quoted = t.startsWith('"') && t.endsWith('"') ? t : `"${t}"`;
    const res = parse(quoted.replace(/\r?\n/g, '\\n'));
    if (res.value?.t === 's') {
      const inner = unwrap({ value: res.value, warnings: [] });
      if (inner.value && inner.value.t !== 's') return { ...inner, notes: ['Unescaped'] };
    }
  }

  // Looks like JSON but isn't valid: report the error rather than read a fragment.
  // Except a log tag such as "[INFO]" or "[2026-10-20 08:12]" in front of the JSON.
  const tag = /^\s*\[[^[\]{}"]*\]/.test(text.replace(/^\ufeff/, ''));
  if ((lead === '{' || lead === '[' || lead === '"') && !tag) return first;

  // INFO [main] response: {...} (12 ms)
  return largest(text)?.result ?? first;
}

/**
 * The largest object or array somewhere in the text that parses on its own, or a quoted
 * string in the text that holds one (an escaped payload in a log line).
 */
function largest(text: string): { result: ParseResult; at: number; end: number } | undefined {
  let best: { res: ParseResult; at: number; end: number } | undefined;
  // "...": a JSON string literal whose content is JSON.
  for (let at = text.search(/"[{[]/), starts = 0; at >= 0 && starts < MAX_STARTS; starts++) {
    let k = at + 1;
    while (k < text.length && text[k] !== '"' && text[k] !== '\n') k += text[k] === '\\' ? 2 : 1;
    if (text[k] === '"') {
      const res = parse(blank(text.slice(0, at)) + text.slice(at, k + 1) + blank(text.slice(k + 1)));
      const inner = res.value?.t === 's' ? unwrap(res) : undefined;
      if (inner?.value && inner.value.t !== 's' && (!best || k - at > best.end - best.at)) best = { res: { ...inner, notes: undefined }, at, end: k };
    }
    const next = text.slice(k + 1).search(/"[{[]/);
    at = next < 0 ? -1 : k + 1 + next;
  }
  let starts = 0;
  for (let at = text.search(/[{[]/); at >= 0 && starts < MAX_STARTS; at = nextOpen(text, at + 1), starts++) {
    if (best && at <= best.end) continue; // inside the one already found
    const close = text[at] === '{' ? '}' : ']';
    let tries = 0;
    for (let end = text.lastIndexOf(close); end > at && tries < MAX_ENDS; end = text.lastIndexOf(close, end - 1), tries++) {
      if (best && end - at <= best.end - best.at) break;
      const res = parse(blank(text.slice(0, at)) + text.slice(at, end + 1) + blank(text.slice(end + 1)));
      if (!res.value) continue;
      best = { res, at, end };
      break;
    }
  }
  if (!best) return undefined;
  const skipped = [text.slice(0, best.at).trim() && 'before', text.slice(best.end + 1).trim() && 'after'].filter(Boolean).join(' and ');
  return { result: withNote(unwrap(best.res), `Skipped the text ${skipped} the JSON`), at: best.at, end: best.end };
}

function withNote(res: ParseResult, note: string): ParseResult {
  return { ...res, notes: [note, ...(res.notes ?? [])] };
}

/** A document that is a string holding JSON becomes that JSON, up to a few levels deep. */
function unwrap(res: ParseResult): ParseResult {
  let v: JV | undefined = res.value;
  let n = 0;
  while (v && v.t === 's' && n < MAX_UNWRAP) {
    const s = v.v.trim();
    if (!/^[{["]/.test(s)) break;
    const inner = parse(v.v, 1, { strict: true });
    if (!inner.value) break;
    v = relines(inner.value, v.line, v.col);
    n++;
  }
  if (!n) return res;
  return { value: v, warnings: res.warnings, notes: [n === 1 ? 'Unwrapped a JSON string' : `Unwrapped ${n} levels of JSON strings`] };
}
