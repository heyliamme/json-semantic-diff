import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const c = require('../dist/core.js');

const P = (t) => {
  const r = c.parse(t);
  if (r.error) throw new Error(`${r.error.message} at ${r.error.line}:${r.error.col}`);
  return r.value;
};
/** "kind path" for every change, in order. */
const D = (a, b, opts) => c.changes(c.diff(P(a), P(b), opts)).map((x) => `${x.kind} ${x.path}`);

describe('parse', () => {
  it('reads strict JSON', () => {
    const v = P('{"a": [1, true, null, "x"], "b": {"c": -2.5e3}}');
    assert.equal(v.t, 'o');
    assert.deepEqual(v.keys, ['a', 'b']);
  });

  it('accepts comments, trailing commas, single quotes and bare keys', () => {
    const v = P(`// head
      { /* block */ a: 1, 'b': 'two', "c": [1, 2,], $d_1: null, }`);
    assert.deepEqual(v.keys, ['a', 'b', 'c', '$d_1']);
    assert.equal(v.map.get('b').v, 'two');
    assert.equal(v.map.get('c').items.length, 2);
  });

  it('accepts Python literals', () => {
    assert.deepEqual(D('[true, false, null]', '[True, False, None]'), []);
  });

  it('decodes escapes', () => {
    assert.equal(P(String.raw`"a\"b\\c\/d\n\té"`).v, 'a"b\\c/d\n\té');
    assert.equal(P(String.raw`'it\'s'`).v, "it's");
  });

  it('keeps big numbers exact', () => {
    assert.equal(P('90071992547409931').raw, '90071992547409931');
    assert.deepEqual(D('90071992547409931', '90071992547409932'), ['chg $']);
  });

  it('reports line and column of errors', () => {
    const r = c.parse('{\n  "a": 1\n  "b": 2\n}');
    assert.deepEqual([r.error.line, r.error.col], [3, 3]);
    assert.match(r.error.message, /Expected ','/);
    assert.equal(c.parse('').error.message, 'Empty input');
    assert.equal(c.parse('[1, 2').error.message, 'Unexpected end of input, missing ]');
    assert.equal(c.parse('"abc').error.message, 'Unterminated string');
    assert.equal(c.parse('{"a": 1} x').error.message, 'Unexpected content after the JSON value');
    assert.equal(c.parse('/* x').error.message, 'Unterminated comment');
  });

  it('warns about duplicate keys and keeps the last', () => {
    const r = c.parse('{"a": 1, "a": 2}');
    assert.equal(r.value.map.get('a').raw, '2');
    assert.equal(r.warnings.length, 1);
  });

  it('records source lines', () => {
    const v = P('{\n"a": 1,\n"b": {\n"c": 2}}');
    assert.equal(v.map.get('b').line, 3);
    assert.equal(v.map.get('b').map.get('c').line, 4);
  });

  it('skips a byte order mark', () => {
    assert.equal(P('﻿{"a":1}').t, 'o');
  });

  it('handles deep nesting without blowing the stack at sane depths', () => {
    const deep = '['.repeat(1000) + ']'.repeat(1000);
    assert.equal(P(deep).t, 'a');
  });
});

describe('numbers', () => {
  it('compares by value, not spelling', () => {
    for (const [a, b] of [['1', '1.0'], ['1e2', '100'], ['0.5', '5e-1'], ['-0', '0'], ['1.50', '1.5'], ['1E+2', '100.000'], ['0.0', '0e10']]) {
      assert.deepEqual(D(a, b), [], `${a} vs ${b}`);
    }
    assert.deepEqual(D('1', '1.0001'), ['chg $']);
    assert.deepEqual(D('1', '"1"'), ['chg $']);
  });
});

describe('objects', () => {
  it('ignores key order', () => {
    assert.deepEqual(D('{"a":1,"b":{"x":1,"y":2}}', '{"b":{"y":2,"x":1},"a":1}'), []);
  });
  it('finds changed, added and removed keys', () => {
    assert.deepEqual(D('{"a":1,"b":2,"c":3}', '{"a":1,"b":5,"d":4}'), ['chg $.b', 'del $.c', 'add $.d']);
  });
  it('reports a change of type as one change', () => {
    assert.deepEqual(D('{"a":{"x":1}}', '{"a":[1]}'), ['chg $.a']);
    assert.deepEqual(D('{"a":null}', '{"a":0}'), ['chg $.a']);
  });
  it('quotes awkward keys in paths', () => {
    assert.deepEqual(D('{"a b":1,"c.d":1}', '{"a b":2,"c.d":2}'), ['chg $["a b"]', 'chg $["c.d"]']);
  });
  it('nullEqualsMissing', () => {
    assert.deepEqual(D('{"a":1,"b":null}', '{"a":1}'), ['del $.b']);
    assert.deepEqual(D('{"a":1,"b":null}', '{"a":1}', { nullEqualsMissing: true }), []);
    assert.deepEqual(D('{"a":null}', '{"b":null}', { nullEqualsMissing: true }), []);
    assert.deepEqual(D('{"a":null}', '{"a":1}', { nullEqualsMissing: true }), ['chg $.a']);
  });
});

describe('arrays', () => {
  it('finds inserted and removed items in order', () => {
    assert.deepEqual(D('[1,2,3,4]', '[1,3,4,5]'), ['del $[1]', 'add $[3]']);
  });
  it('pairs a replaced scalar as a change', () => {
    assert.deepEqual(D('["a","b","c"]', '["a","x","c"]'), ['chg $[1]']);
  });
  it('pairs a modified object with its most similar counterpart', () => {
    assert.deepEqual(D('[{"n":"a","v":1},{"n":"b","v":2}]', '[{"n":"a","v":1},{"n":"b","v":3}]', { arrayMatchKeys: [] }), ['chg $[1].v']);
  });
  it('detects moved scalars', () => {
    assert.deepEqual(D('["a","b","c"]', '["c","a","b"]'), ['moved $[0]']); // paths use the right side's index
  });
  it('matches objects by id and detects moves', () => {
    const a = '[{"id":1,"v":"a"},{"id":2,"v":"b"},{"id":3,"v":"c"}]';
    const b = '[{"id":3,"v":"c"},{"id":1,"v":"A"},{"id":4,"v":"d"}]';
    assert.deepEqual(D(a, b), ['chg $[id=1].v', 'del $[id=2]', 'add $[id=4]', 'moved $[id=3]']);
    const root = c.diff(P(a), P(b));
    assert.equal(root.matchKey, 'id');
  });
  it('falls back to the next match key when the first is not unique', () => {
    const root = c.diff(P('[{"id":1,"key":"a"},{"id":1,"key":"b"}]'), P('[{"id":1,"key":"b"},{"id":1,"key":"a"}]'));
    assert.equal(root.matchKey, 'key');
  });
  it('does not use a match key that appears on one side only', () => {
    const root = c.diff(P('[{"id":1}]'), P('[{"id":2}]'));
    assert.equal(root.matchKey, undefined);
  });
  it('ignoreArrayOrder', () => {
    assert.deepEqual(D('[1,2,3]', '[3,1,2]', { ignoreArrayOrder: true }), []);
    assert.deepEqual(D('[1,2,2]', '[2,1,2]', { ignoreArrayOrder: true }), []);
    assert.deepEqual(D('[1,2,2]', '[2,1]', { ignoreArrayOrder: true }), ['del $[2]']);
    assert.deepEqual(D('[{"a":1,"b":1},{"c":1}]', '[{"c":1},{"a":1,"b":2}]', { ignoreArrayOrder: true, arrayMatchKeys: [] }), ['chg $[1].b']);
    assert.deepEqual(D('[[1,2],[3]]', '[[3],[2,1]]', { ignoreArrayOrder: true }), []);
  });
  it('handles empty arrays', () => {
    assert.deepEqual(D('[]', '[1]'), ['add $[0]']);
    assert.deepEqual(D('[1]', '[]'), ['del $[0]']);
    assert.deepEqual(D('[]', '[]'), []);
  });
  it('copes with long arrays beyond the LCS limit', () => {
    const a = JSON.stringify(Array.from({ length: 3000 }, (_, i) => i));
    const b = JSON.stringify(Array.from({ length: 3000 }, (_, i) => (i === 1500 ? -1 : i)));
    assert.deepEqual(D(a, b), ['chg $[1500]']);
  });
});

describe('nested JSON in strings', () => {
  const a = '{"p":"{\\"x\\":1,\\"y\\":[1,2]}"}';
  const b = '{"p":"{\\"y\\":[1,2],\\"x\\":2}"}';
  it('compares the JSON inside', () => {
    assert.deepEqual(D(a, b), ['chg $.p.x']);
  });
  it('can be turned off', () => {
    assert.deepEqual(D(a, b, { parseNestedJson: false }), ['chg $.p']);
  });
  it('leaves strings that only look like JSON alone', () => {
    assert.deepEqual(D('{"s":"[not json"}', '{"s":"[not json"}'), []);
    assert.deepEqual(D('{"s":"{a"}', '{"s":"{b"}'), ['chg $.s']);
  });
});

describe('ignore paths', () => {
  const a = '{"meta":{"at":1,"id":"x"},"items":[{"etag":"a","v":1}],"deep":{"at":5}}';
  const b = '{"meta":{"at":2,"id":"y"},"items":[{"etag":"b","v":1}],"deep":{"at":6}}';
  it('anchored path', () => {
    assert.deepEqual(D(a, b, { ignorePaths: ['$.meta.at'] }), ['chg $.meta.id', 'chg $.items[0].etag', 'chg $.deep.at']);
  });
  it('bare name matches at any depth', () => {
    assert.deepEqual(D(a, b, { ignorePaths: ['at', 'etag'] }), ['chg $.meta.id']);
  });
  it('wildcards', () => {
    assert.deepEqual(D(a, b, { ignorePaths: ['$.items[*].etag', '$.*.at'] }), ['chg $.meta.id']);
    assert.deepEqual(D(a, b, { ignorePaths: ['$.**.at', '$.**.etag'] }), ['chg $.meta.id']);
    assert.deepEqual(D(a, b, { ignorePaths: ['$.meta'] }), ['chg $.items[0].etag', 'chg $.deep.at']);
  });
  it('ignored additions and removals', () => {
    assert.deepEqual(D('{"a":1}', '{"a":1,"t":2}', { ignorePaths: ['t'] }), []);
  });
  it('compiles and matches patterns', () => {
    const m = (p, path) => c.matches(c.compilePattern(p), path);
    assert.ok(m('$["a b"][0]', ['a b', 0]));
    assert.ok(!m('$.a', ['a', 'b']));
    assert.ok(m('a.**', ['x', 'a', 'b', 'c']));
    assert.ok(m('$.**', []));
    assert.equal(c.compilePattern('  '), undefined);
  });
});

describe('mergeOrder', () => {
  it('keeps left order and slots right-only entries after their predecessor', () => {
    assert.deepEqual(c.mergeOrder(['a', 'b', 'c'], ['a', 'x', 'c', 'y']), ['a', 'b', 'x', 'c', 'y']);
    assert.deepEqual(c.mergeOrder(['a'], ['z', 'a']), ['z', 'a']);
    assert.deepEqual(c.mergeOrder([], ['a', 'b']), ['a', 'b']);
  });
});

describe('parseLoose', () => {
  const L = (t) => {
    const r = c.parseLoose(t);
    return r.value ? [JSON.stringify(JSON.parse(c.canonicalText(r.value, {}))), r.notes ?? []] : ['ERR', r.error.message];
  };
  it('unwraps a JSON string, even twice', () => {
    assert.deepEqual(L(JSON.stringify(JSON.stringify({ a: 1 }))), ['{"a":1}', ['Unwrapped a JSON string']]);
    assert.deepEqual(L(JSON.stringify(JSON.stringify(JSON.stringify([1])))), ['[1]', ['Unwrapped 2 levels of JSON strings']]);
  });
  it('unescapes text copied without its quotes', () => {
    assert.deepEqual(L(String.raw`{\"a\":1,\"b\":\"x\"}`), ['{"a":1,"b":"x"}', ['Unescaped']]);
  });
  it('finds JSON inside log text', () => {
    assert.deepEqual(L('12:00 INFO [main] got {"a": [1, {"x": "]"}]} in 3ms'), ['{"a":[1,{"x":"]"}]}', ['Skipped the text before and after the JSON']]);
  });
  it('keeps line numbers when skipping text', () => {
    const r = c.parseLoose('log line\nresponse: {\n "a": 1}');
    assert.equal(r.value.map.get('a').line, 3);
  });
  it('leaves valid JSON alone', () => {
    assert.deepEqual(L('"just a string"'), ['"just a string"', []]);
    assert.deepEqual(L('{"a":"{\\"b\\":1}"}'), ['{"a":"{\\"b\\":1}"}', []]);
  });
  it('still reports the original error when nothing works', () => {
    assert.deepEqual(L('{"a": '), ['ERR', 'Unexpected end of input']);
  });
});

describe('canonicalText', () => {
  it('sorts keys and normalizes layout', () => {
    assert.equal(c.canonicalText(P('{"b":1,"a":[2,1]}'), {}), '{\n  "a": [\n    2,\n    1\n  ],\n  "b": 1\n}\n');
  });
  it('sorts arrays when order is ignored', () => {
    assert.equal(c.canonicalText(P('[2,1]'), { ignoreArrayOrder: true }), c.canonicalText(P('[1,2]'), { ignoreArrayOrder: true }));
  });
});

describe('council round 1', () => {
  const L = (t) => c.parseLoose(t);
  it('a typo in a JSON document is a syntax error, never a fragment of it', () => {
    for (const t of ['{\n "name": "app",\n "deps": {"x": "1.0"},\n "scripts": {"a": "b"}\n "version": "2"\n}', '{"outer":{"inner":1},"bad":tru}', '[{"id":1},{"id":2} {"id":3}]', '{"a":[1,2,3],"b":"x" "c":1}']) {
      const r = L(t);
      assert.equal(r.value, undefined, t);
      assert.ok(r.error, t);
    }
    assert.equal(L('{\n "a": 1\n "b": 2\n}').error.line, 3);
  });
  it('reads JSON Lines as an array', () => {
    const r = L('{"id":1,"a":1}\n{"id":2,"a":2}\n');
    assert.equal(r.value.t, 'a');
    assert.equal(r.value.items.length, 2);
    assert.deepEqual(r.notes, ['Read 2 JSON lines as an array']);
    const d = c.changes(c.diff(r.value, L('{"id":1,"a":1}\n{"id":2,"a":999}').value));
    assert.deepEqual(d.map((x) => x.path), ['$[id=2].a']);
  });
  it('prefers the payload over a bracketed log prefix', () => {
    const a = L('[200] {"a":1}');
    const b = L('[200] {"a":2}');
    assert.equal(c.changes(c.diff(a.value, b.value)).length, 1);
    assert.equal(L('GET /x [200] {"a":{"b":[1]}}').value.t, 'o');
  });
  it('canonical text spells numbers one way and stays valid JSON', () => {
    const t = (x) => c.canonicalText(P(x), {});
    assert.equal(t('{"a":1.0}'), t('{"a":1}'));
    assert.equal(t('[.5, 1., 007, 1e2, -0.0, 1.5e-7, 12345678901234567890123]'), '[\n  0.5,\n  1,\n  7,\n  100,\n  0,\n  1.5e-7,\n  1.2345678901234567890123e+22\n]\n');
    JSON.parse(t('[.5, 1., 007]'));
  });
  it('compares huge exponents exactly', () => {
    assert.deepEqual(D('1e99999999999999999999', '1e99999999999999999998'), ['chg $']);
    assert.deepEqual(D('1e99999999999999999999', '10e99999999999999999998'), []);
  });
  it('a string holding JSON versus the value itself is a change', () => {
    assert.deepEqual(D('{"a":"{\\"x\\":1}"}', '{"a":{"x":1}}'), ['wrap $.a']);
    assert.deepEqual(D('{"a":"[None]"}', '{"a":[null]}'), ['chg $.a']); // strict JSON inside strings
  });
  it('pairs a renamed item and a moved, edited one', () => {
    assert.deepEqual(D('[{"name":"alice","age":30,"city":"x"},{"name":"bob","age":4,"city":"y"}]', '[{"name":"alicia","age":30,"city":"x"},{"name":"bob","age":4,"city":"y"}]'), ['chg $[name="alicia"].name']);
    assert.deepEqual(D('[{"a":1,"v":1,"w":3},{"b":2}]', '[{"b":2},{"a":1,"v":9,"w":3}]', { arrayMatchKeys: [] }), ['chg $[1].v', 'moved $[0]']);
  });
  it('length-prefixed hashing: a string never equals a list of items', () => {
    assert.deepEqual(D('[["x,sy"],7]', '[7,["x","y"]]').filter((x) => x.startsWith('moved')), []);
  });
  it('ignore patterns with awkward keys and $-names', () => {
    const m = (p, path) => c.matches(c.compilePattern(p), path);
    for (const k of ['a"b', 'a\\b', 'tab\t', 'a]b', 'a[1]', 'x.y']) assert.ok(m(c.formatPath([k]), [k]), k);
    assert.ok(m('$oid', ['_id', '$oid']));
    assert.ok(m("$['it\\'s']", ["it's"]));
    assert.equal(c.compilePattern('$["open'), undefined);
  });
});


describe('council round 1: security', () => {
  it('long runs of zeros in numbers are linear', () => {
    const t = Date.now();
    P('[1' + '0'.repeat(200000) + '1]');
    assert.ok(Date.now() - t < 500);
  });
  it('many ** in an ignore pattern stay fast', () => {
    const p = c.compilePattern('**.**.**.**.**.**.**.**.**.zzz');
    const path = Array.from({ length: 60 }, (_, i) => 'k' + i);
    const t = Date.now();
    for (let i = 0; i < 1000; i++) c.matches(p, path);
    assert.ok(Date.now() - t < 500);
  });
  it('rejects nesting deeper than the limit with a message', () => {
    const r = c.parse('['.repeat(1001) + ']'.repeat(1001));
    assert.match(r.error.message, /Nested more than 1000 levels/);
    assert.ok(c.parse('['.repeat(1000) + ']'.repeat(1000)).value);
    const deep = (x) => c.parse('['.repeat(999) + x + ']'.repeat(999)).value;
    assert.equal(c.changes(c.diff(deep(1), deep(2))).length, 1);
  });
  it('equal hashes never hide a changed string', () => {
    assert.deepEqual(D('"https://cdn.example.com/build/0acp0gyjkwl"', '"https://cdn.example.com/build/05i016zqf77"'), ['chg $']);
  });
});

describe('council round 1: large arrays', () => {
  const K = (a, b, o) => {
    const k = {};
    for (const x of c.changes(c.diff(P(JSON.stringify(a)), P(JSON.stringify(b)), o))) k[x.kind] = (k[x.kind] || 0) + 1;
    return k;
  };
  it('beyond the exact-LCS size, unchanged items are not reported as moved', () => {
    const a = Array.from({ length: 2001 }, (_, i) => i);
    assert.deepEqual(K(a, [-1, ...a.slice(0, 2000), 99999]), { add: 1, chg: 1 });
    const big = Array.from({ length: 100000 }, (_, i) => i);
    const edited = big.slice();
    for (const k of [5, 20000, 50000, 70000, 99990]) edited[k] = -k;
    assert.deepEqual(K(big, edited), { chg: 5 });
  });
  it('one real move in a long array is one move', () => {
    const a = Array.from({ length: 3000 }, (_, i) => i);
    const b = a.slice();
    b.splice(100, 1);
    b.splice(2500, 0, 100);
    assert.deepEqual(K(a, b), { moved: 1 });
  });
  it('many edited objects without ids still pair up', () => {
    const a = Array.from({ length: 2000 }, (_, i) => ({ sku: 's' + i, qty: i, ts: 1 }));
    assert.deepEqual(K(a, a.map((x) => ({ ...x, ts: 2 })), { arrayMatchKeys: [] }), { chg: 2000 });
    const o = Array.from({ length: 5000 }, (_, i) => ({ name: 'n' + i, v: i }));
    assert.deepEqual(K(o, [{ name: 'new', v: -1 }, ...o], { arrayMatchKeys: [] }), { add: 1 });
  });
});

describe('council round 2', () => {
  it('ignoring an added item matched by key hides only that item', () => {
    const a = '{"c":[{"name":"app","image":"web:1.4.2"},{"name":"side","image":"s:1"}]}';
    const b = '{"c":[{"name":"init","image":"m:1"},{"name":"side","image":"s:1"},{"name":"app","image":"web:1.5.0"}]}';
    const all = D(a, b);
    assert.ok(all.includes('add $.c[name="init"]') && all.includes('chg $.c[name="app"].image'), all.join());
    assert.deepEqual(D(a, b, { ignorePaths: ['$.c[name="init"]'] }).filter((x) => !x.startsWith('moved')), ['chg $.c[name="app"].image']);
    assert.deepEqual(D(a, b, { ignorePaths: ['$.c[*].image'] }).filter((x) => !x.startsWith('moved')), ['add $.c[name="init"]']);
  });
  it('keyed patterns: quoted values, numbers in any spelling', () => {
    const m = (p, path) => c.matches(c.compilePattern(p), path);
    assert.ok(m('$.c[name="a]b"]', ['c', { key: 'name', id: '"a]b"' }]));
    assert.ok(m("$.c[name='x']", ['c', { key: 'name', id: '"x"' }]));
    assert.ok(m('$.c[id=1.0]', ['c', { key: 'id', id: '1' }]));
    assert.ok(!m('$.c[0]', ['c', { key: 'id', id: '0' }]));
    assert.equal(c.formatPath(['c', { key: 'id', id: '1' }]), '$.c[id=1]');
  });
});


describe('prettyText', () => {
  it('lays out one-line JSON, keeping key order and number spelling', () => {
    assert.equal(c.prettyText(P('{"b":1.50,"a":[1,{"x":null}],"e":{},"f":[]}')), '{\n  "b": 1.50,\n  "a": [\n    1,\n    {\n      "x": null\n    }\n  ],\n  "e": {},\n  "f": []\n}\n');
  });
  it('turns lenient input into valid JSON', () => {
    const out = c.prettyText(P("{a: .5, 'b': True, /* c */ d: [1,],}"));
    assert.deepEqual(JSON.parse(out), { a: 0.5, b: true, d: [1] });
  });
  it('lays out what a loose read finds inside a string or a log line', () => {
    const r = c.parseLoose(String.raw`INFO got "{\"a\":1}" in 3ms`);
    assert.equal(c.prettyText(r.value), '{\n  "a": 1\n}\n');
  });
});
