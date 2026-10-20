import { canonNumber, formatCanon } from './parse';

/** An array item matched by a property, e.g. the container with `"name": "app"`. */
export interface Keyed {
  key: string;
  /** The property's value as JSON text, numbers in canonical spelling. */
  id: string;
}

export type Seg = string | number | Keyed;

const PLAIN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export function formatPath(segs: readonly Seg[]): string {
  let out = '$';
  for (const s of segs) {
    if (typeof s === 'object') out += `[${PLAIN.test(s.key) ? s.key : JSON.stringify(s.key)}=${s.id}]`;
    else if (typeof s === 'number') out += `[${s}]`;
    else if (PLAIN.test(s)) out += `.${s}`;
    else out += `[${JSON.stringify(s)}]`;
  }
  return out;
}

// Ignore patterns:
//   $.meta.updatedAt      anchored at the root
//   updatedAt             any property with that name, at any depth
//   items[*].etag         `*` / `[*]` matches one segment, `**` any number of them
//   $["a key"][0]         brackets for awkward keys and indices
//   containers[name="app"]  the array item whose `name` is "app"
type PSeg = { any: true } | { deep: true } | { name: string } | { index: number } | { keyed: Keyed };

/** `"app"` → `"app"`, `1.0` → `1`: the id spelling used in paths. */
export function idText(text: string): string | undefined {
  const t = text.trim();
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(t)) return formatCanon(canonNumber(t));
  if (t === 'true' || t === 'false') return t;
  try {
    const v = JSON.parse(t.startsWith("'") ? '"' + t.slice(1, -1).replace(/"/g, '\\"') + '"' : t);
    return typeof v === 'string' ? JSON.stringify(v) : undefined;
  } catch {
    return undefined;
  }
}

export interface PathPattern {
  segs: PSeg[];
  source: string;
}

export function compilePattern(src: string): PathPattern | undefined {
  const s = src.trim();
  if (!s) return undefined;
  const segs: PSeg[] = [];
  let i = 0;
  // `$` anchors at the root only on its own or before . or [, so `$oid` is a key name.
  if (s[0] === '$' && (s.length === 1 || s[1] === '.' || s[1] === '[')) i = 1;
  else segs.push({ deep: true });
  const name = /[^.[\]]+/y;
  while (i < s.length) {
    if (s.startsWith('**', i) || s.startsWith('.**', i) || s.startsWith('..', i)) {
      // `..` is JSONPath's "any depth", the same as `**.`
      i += s.startsWith('..', i) ? 2 : s[i] === '.' ? 3 : 2;
      segs.push({ deep: true });
    } else if (s[i] === '[') {
      let j = i + 1;
      while (s[j] === ' ') j++;
      const q = s[j];
      let body: string;
      if (q === '"' || q === "'") {
        // A quoted key: find its closing quote past any escapes, then decode it as JSON.
        let k = j + 1;
        while (k < s.length && s[k] !== q) k += s[k] === '\\' ? 2 : 1;
        if (k >= s.length) return undefined;
        let raw = s.slice(j + 1, k);
        if (q === "'") raw = raw.replace(/\\'/g, "'").replace(/"/g, '\\"');
        try {
          body = JSON.parse(`"${raw}"`);
        } catch {
          return undefined;
        }
        j = k + 1;
        while (s[j] === ' ') j++;
        if (s[j] !== ']') return undefined;
        segs.push({ name: body });
        i = j + 1;
        continue;
      }
      // key=value: scan past a quoted value, which may contain ].
      const kv = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*/.exec(s.slice(j));
      if (kv) {
        let k = j + kv[0].length;
        const vq = s[k];
        if (vq === '"' || vq === "'") {
          k++;
          while (k < s.length && s[k] !== vq) k += s[k] === '\\' ? 2 : 1;
          k++;
        } else while (k < s.length && s[k] !== ']') k++;
        const id = idText(s.slice(j + kv[0].length, k));
        while (s[k] === ' ') k++;
        if (id === undefined || s[k] !== ']') return undefined;
        segs.push({ keyed: { key: kv[1], id } });
        i = k + 1;
        continue;
      }
      const end = s.indexOf(']', i);
      if (end < 0) return undefined;
      body = s.slice(i + 1, end).trim();
      i = end + 1;
      if (body === '*') segs.push({ any: true });
      else if (/^\d+$/.test(body)) segs.push({ index: +body });
      else segs.push({ name: body });
    } else {
      if (s[i] === '.') i++;
      name.lastIndex = i;
      const m = name.exec(s);
      if (!m) {
        if (i >= s.length) break;
        return undefined;
      }
      i += m[0].length;
      segs.push(m[0] === '*' ? { any: true } : { name: m[0] });
    }
  }
  // `**.**` is the same as `**`.
  const merged = segs.filter((x, i) => !('deep' in x && i > 0 && 'deep' in segs[i - 1]));
  return { segs: merged, source: src.trim() };
}

export function matches(p: PathPattern, path: readonly Seg[]): boolean {
  // Memoised over (pattern position, path position): linear in their product, however
  // many ** the pattern has.
  const w = path.length + 1;
  const memo = new Int8Array((p.segs.length + 1) * w);
  const go = (a: number, b: number): boolean => {
    const k = a * w + b;
    if (memo[k]) return memo[k] === 1;
    let ok: boolean;
    if (a === p.segs.length) ok = b === path.length;
    else {
      const ps = p.segs[a];
      if ('deep' in ps) ok = go(a + 1, b) || (b < path.length && go(a, b + 1));
      else if (b === path.length) ok = false;
      else {
        const s = path[b];
        if ('any' in ps) ok = go(a + 1, b + 1);
        else if ('index' in ps) ok = s === ps.index && go(a + 1, b + 1);
        else if ('keyed' in ps) ok = typeof s === 'object' && s.key === ps.keyed.key && s.id === ps.keyed.id && go(a + 1, b + 1);
        else ok = typeof s !== 'object' && String(s) === ps.name && go(a + 1, b + 1);
      }
    }
    memo[k] = ok ? 1 : 2;
    return ok;
  };
  return go(0, 0);
}
