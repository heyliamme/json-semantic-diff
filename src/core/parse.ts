// A forgiving JSON reader. It accepts what people actually paste: comments, trailing
// commas, single-quoted strings and bare identifier keys (JS object literals, JSON5-ish
// config), and keeps numbers as their source text so 64-bit ids never lose precision.

export type JV =
  | { t: 'o'; keys: string[]; map: Map<string, JV>; line: number; col?: number; emb?: boolean }
  | { t: 'a'; items: JV[]; line: number; col?: number; emb?: boolean }
  | { t: 's'; v: string; line: number; col?: number }
  | { t: 'n'; raw: string; canon: string; line: number; col?: number }
  | { t: 'b'; v: boolean; line: number; col?: number }
  | { t: 'z'; line: number; col?: number };

export interface ParseError {
  message: string;
  line: number; // 1-based
  col: number; // 1-based
  /** Set when a complete value was read and something followed it: where that starts. */
  trailingAt?: number;
}

export interface ParseOptions {
  /** Plain JSON only: no comments, trailing commas, single quotes, bare words. */
  strict?: boolean;
}

export interface ParseResult {
  value?: JV;
  error?: ParseError;
  warnings: string[];
  /** How a loosely read input was interpreted (see parseLoose). */
  notes?: string[];
}

class Fail extends Error {
  constructor(message: string, readonly pos: number) {
    super(message);
  }
}

const IDENT_START = /[A-Za-z_$]/;
const IDENT = /[A-Za-z0-9_$]/;
const NUMBER = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
const STRICT_NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?(?![\d.])/y;

export function parse(text: string, baseLine = 1, options: ParseOptions = {}): ParseResult {
  const p = new Reader(text, baseLine, !!options.strict);
  let trailingAt: number | undefined;
  try {
    p.ws();
    if (p.i >= text.length) throw new Fail('Empty input', p.i);
    const value = p.value();
    p.ws();
    if (p.i < text.length) {
      trailingAt = p.i;
      throw new Fail('Unexpected content after the JSON value', p.i);
    }
    return { value, warnings: p.warnings };
  } catch (e) {
    if (!(e instanceof Fail)) throw e;
    const { line, col } = p.where(e.pos);
    return { error: { message: e.message, line, col, trailingAt }, warnings: p.warnings };
  }
}

/** JSON Lines: one value per line. Undefined unless every value parses and starts a line. */
export function parseAll(text: string): JV[] | undefined {
  const p = new Reader(text, 1, false);
  const out: JV[] = [];
  try {
    p.ws();
    let lastLine = 0;
    while (p.i < text.length) {
      const v = p.value();
      if (v.line === lastLine) return undefined;
      lastLine = p.where(p.i).line;
      out.push(v);
      p.ws();
    }
  } catch (e) {
    if (e instanceof Fail) return undefined;
    throw e;
  }
  return out;
}

/** Canonical form of a JSON number: `1`, `1.0`, `10e-1` and `0.1e1` all become `1e0`. */
export function canonNumber(raw: string): string {
  let s = raw;
  let neg = false;
  if (s[0] === '-' || s[0] === '+') {
    neg = s[0] === '-';
    s = s.slice(1);
  }
  // The exponent can have any number of digits, so it's a BigInt.
  let exp = 0n;
  const e = s.search(/[eE]/);
  if (e >= 0) {
    exp = BigInt(s.slice(e + 1).replace(/^\+/, ''));
    s = s.slice(0, e);
  }
  const dot = s.indexOf('.');
  let digits = s;
  if (dot >= 0) {
    digits = s.slice(0, dot) + s.slice(dot + 1);
    exp -= BigInt(s.length - dot - 1);
  }
  // Loops, not /0+$/: that regex is quadratic on a long run of zeros.
  let from = 0;
  while (from < digits.length && digits.charCodeAt(from) === 48) from++;
  let to = digits.length;
  while (to > from && digits.charCodeAt(to - 1) === 48) to--;
  if (from === to) return '0';
  const tz = digits.length - to;
  digits = digits.slice(from, to);
  return (neg ? '-' : '') + digits + 'e' + (exp + BigInt(tz));
}

/** Plain JSON spelling of a canonical number: `15e-1` → `1.5`, `1e30` → `1e+30`. */
export function formatCanon(canon: string): string {
  if (canon === '0') return '0';
  const neg = canon[0] === '-';
  const [digits, e] = (neg ? canon.slice(1) : canon).split('e');
  const point = BigInt(digits.length) + BigInt(e); // where the decimal point goes
  let out: string;
  if (point > 0n && point <= 21n) {
    const p = Number(point);
    out = p >= digits.length ? digits + '0'.repeat(p - digits.length) : digits.slice(0, p) + '.' + digits.slice(p);
  } else if (point <= 0n && point > -6n) out = '0.' + '0'.repeat(-Number(point)) + digits;
  else {
    const x = point - 1n;
    out = digits[0] + (digits.length > 1 ? '.' + digits.slice(1) : '') + 'e' + (x < 0n ? '-' : '+') + (x < 0n ? -x : x);
  }
  return (neg ? '-' : '') + out;
}

export const MAX_DEPTH = 1000;

class Reader {
  i = 0;
  private depth = 0;
  warnings: string[] = [];
  private nl: number[] = [];

  constructor(
    private s: string,
    private baseLine: number,
    private strict: boolean,
  ) {
    if (s.charCodeAt(0) === 0xfeff) this.i = 1;
    for (let k = 0; k < s.length; k++) if (s.charCodeAt(k) === 10) this.nl.push(k);
  }

  where(pos: number) {
    let lo = 0;
    let hi = this.nl.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.nl[mid] < pos) lo = mid + 1;
      else hi = mid;
    }
    const start = lo === 0 ? 0 : this.nl[lo - 1] + 1;
    return { line: lo + this.baseLine, col: pos - start + 1 };
  }

  private lineAt(pos: number) {
    return this.where(pos).line;
  }

  ws() {
    const s = this.s;
    for (;;) {
      const c = s.charCodeAt(this.i);
      if (c === 32 || c === 9 || c === 10 || c === 13 || c === 0xa0 || c === 0xfeff) this.i++;
      else if (c === 47 && this.strict) throw new Fail('Comments are not allowed here', this.i);
      else if (c === 47 && s[this.i + 1] === '/') {
        const end = s.indexOf('\n', this.i);
        this.i = end < 0 ? s.length : end + 1;
      } else if (c === 47 && s[this.i + 1] === '*') {
        const end = s.indexOf('*/', this.i + 2);
        if (end < 0) throw new Fail('Unterminated comment', this.i);
        this.i = end + 2;
      } else return;
    }
  }

  value(): JV {
    const { line, col } = this.where(this.i);
    const v = this.bare(line);
    v.col = col;
    return v;
  }

  private bare(line: number): JV {
    const c = this.s[this.i];
    if (c === '{' || c === '[') {
      if (++this.depth > MAX_DEPTH) throw new Fail(`Nested more than ${MAX_DEPTH} levels deep`, this.i);
      const v = c === '{' ? this.object(line) : this.array(line);
      this.depth--;
      return v;
    }
    if (c === '"' || (c === "'" && !this.strict)) return { t: 's', v: this.string(), line };
    if (c === '-' || c === '+' || c === '.' || (c >= '0' && c <= '9')) {
      const re = this.strict ? STRICT_NUMBER : NUMBER;
      re.lastIndex = this.i;
      const m = re.exec(this.s);
      if (!m) throw new Fail('Invalid number', this.i);
      this.i += m[0].length;
      return { t: 'n', raw: m[0], canon: canonNumber(m[0]), line };
    }
    if (c !== undefined && IDENT_START.test(c)) {
      const start = this.i;
      const word = this.ident();
      if (this.strict && word !== 'true' && word !== 'false' && word !== 'null') throw new Fail(`Unexpected word '${word}'`, start);
      if (word === 'true' || word === 'True') return { t: 'b', v: true, line };
      if (word === 'false' || word === 'False') return { t: 'b', v: false, line };
      if (word === 'null' || word === 'None' || word === 'undefined') return { t: 'z', line };
      throw new Fail(`Unexpected word '${word}'`, start);
    }
    if (c === undefined) throw new Fail('Unexpected end of input', this.i);
    throw new Fail(`Unexpected character '${c}'`, this.i);
  }

  private ident() {
    const start = this.i;
    while (this.i < this.s.length && IDENT.test(this.s[this.i])) this.i++;
    return this.s.slice(start, this.i);
  }

  private object(line: number): JV {
    this.i++;
    const keys: string[] = [];
    const map = new Map<string, JV>();
    this.ws();
    if (this.s[this.i] === '}') {
      this.i++;
      return { t: 'o', keys, map, line };
    }
    for (;;) {
      const c = this.s[this.i];
      const keyPos = this.i;
      let key: string;
      if (c === '"' || (c === "'" && !this.strict)) key = this.string();
      else if (this.strict) throw new Fail(c === undefined ? 'Unexpected end of input' : 'Expected a property name in double quotes', this.i);
      else if (c !== undefined && IDENT_START.test(c)) key = this.ident();
      else if (c !== undefined && c >= '0' && c <= '9') key = this.ident();
      else throw new Fail(c === undefined ? 'Unexpected end of input' : 'Expected a property name', this.i);
      this.ws();
      if (this.s[this.i] !== ':') throw new Fail("Expected ':' after the property name", this.i);
      this.i++;
      this.ws();
      const v = this.value();
      if (map.has(key)) this.warnings.push(`Duplicate key "${key}" on line ${this.lineAt(keyPos)}; the last one wins`);
      else keys.push(key);
      map.set(key, v);
      this.ws();
      const sep = this.s[this.i];
      if (sep === ',') {
        this.i++;
        this.ws();
        if (this.s[this.i] === '}') {
          if (this.strict) throw new Fail('Trailing comma', this.i);
          this.i++;
          break;
        }
      } else if (sep === '}') {
        this.i++;
        break;
      } else throw new Fail(sep === undefined ? 'Unexpected end of input, missing }' : "Expected ',' or '}'", this.i);
    }
    return { t: 'o', keys, map, line };
  }

  private array(line: number): JV {
    this.i++;
    const items: JV[] = [];
    this.ws();
    if (this.s[this.i] === ']') {
      this.i++;
      return { t: 'a', items, line };
    }
    for (;;) {
      items.push(this.value());
      this.ws();
      const sep = this.s[this.i];
      if (sep === ',') {
        this.i++;
        this.ws();
        if (this.s[this.i] === ']') {
          if (this.strict) throw new Fail('Trailing comma', this.i);
          this.i++;
          break;
        }
      } else if (sep === ']') {
        this.i++;
        break;
      } else throw new Fail(sep === undefined ? 'Unexpected end of input, missing ]' : "Expected ',' or ']'", this.i);
    }
    return { t: 'a', items, line };
  }

  private string(): string {
    const s = this.s;
    const q = s[this.i];
    const start = this.i;
    this.i++;
    let out = '';
    let run = this.i;
    for (;;) {
      if (this.i >= s.length) throw new Fail('Unterminated string', start);
      const c = s[this.i];
      if (c === q) {
        out += s.slice(run, this.i);
        this.i++;
        return out;
      }
      if (c === '\n') throw new Fail('Line break inside a string', this.i);
      if (c !== '\\') {
        this.i++;
        continue;
      }
      out += s.slice(run, this.i);
      const e = s[this.i + 1];
      this.i += 2;
      switch (e) {
        case '"': case "'": case '\\': case '/': out += e; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case 'n': out += '\n'; break;
        case 'r': out += '\r'; break;
        case 't': out += '\t'; break;
        case 'u': {
          const hex = s.slice(this.i, this.i + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Fail('Invalid \\u escape', this.i - 2);
          out += String.fromCharCode(parseInt(hex, 16));
          this.i += 4;
          break;
        }
        case '\n': break; // line continuation
        default:
          if (e === undefined) throw new Fail('Unterminated string', start);
          out += e;
      }
      run = this.i;
    }
  }
}
