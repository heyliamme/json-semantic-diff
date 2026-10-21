import { formatCanon, type JV } from './parse';
import { Hasher, type DiffOptions } from './diff';

/**
 * One fixed spelling of a document: keys sorted, two-space indent, and with
 * `ignoreArrayOrder` arrays sorted too. Two semantically equal documents print the same,
 * which is what makes the plain text diff editor useful on them.
 */
export function canonicalText(v: JV, opts: Pick<DiffOptions, 'ignoreArrayOrder' | 'nullEqualsMissing'>): string {
  const h = new Hasher(opts);
  const out: string[] = [];
  const write = (x: JV, indent: string): string => {
    switch (x.t) {
      case 's': return JSON.stringify(x.v);
      case 'n': return formatCanon(x.canon);
      case 'b': return String(x.v);
      case 'z': return 'null';
      case 'o': {
        const keys = [...x.keys].sort().filter((k) => !(opts.nullEqualsMissing && x.map.get(k)!.t === 'z'));
        if (!keys.length) return '{}';
        const inner = indent + '  ';
        return `{\n${keys.map((k) => `${inner}${JSON.stringify(k)}: ${write(x.map.get(k)!, inner)}`).join(',\n')}\n${indent}}`;
      }
      case 'a': {
        if (!x.items.length) return '[]';
        let items = x.items;
        if (opts.ignoreArrayOrder) items = [...items].sort((a, b) => (h.of(a) < h.of(b) ? -1 : h.of(a) > h.of(b) ? 1 : 0));
        const inner = indent + '  ';
        return `[\n${items.map((y) => inner + write(y, inner)).join(',\n')}\n${indent}]`;
      }
    }
  };
  out.push(write(v, ''));
  return out.join('') + '\n';
}

const JSON_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

/**
 * The document laid out with two-space indents, as written otherwise: key order kept,
 * numbers spelled as in the source (unless they aren't valid JSON, like `.5`).
 * For tidying what someone pasted, not for comparing.
 */
export function prettyText(v: JV): string {
  const write = (x: JV, indent: string): string => {
    switch (x.t) {
      case 's': return JSON.stringify(x.v);
      case 'n': return JSON_NUMBER.test(x.raw) ? x.raw : formatCanon(x.canon);
      case 'b': return String(x.v);
      case 'z': return 'null';
      case 'o': {
        if (!x.keys.length) return '{}';
        const inner = indent + '  ';
        return `{\n${x.keys.map((k) => `${inner}${JSON.stringify(k)}: ${write(x.map.get(k)!, inner)}`).join(',\n')}\n${indent}}`;
      }
      case 'a': {
        if (!x.items.length) return '[]';
        const inner = indent + '  ';
        return `[\n${x.items.map((y) => inner + write(y, inner)).join(',\n')}\n${indent}]`;
      }
    }
  };
  return write(v, '') + '\n';
}
