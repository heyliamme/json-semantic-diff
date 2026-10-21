// Properties checked over many random document pairs:
//  - each column of the side-by-side view, read top to bottom, is the document it shows;
//  - a document compared with a reordered copy of itself has no changes;
//  - there are no changes exactly when the normalized texts are equal;
//  - every change starts on exactly one row.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const c = require('../dist/core.js');
const { Builder, inPrintOrder } = require('../dist/render.js');

let seed = +(process.env.FUZZ_SEED || 1);
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const WORDS = ['id', 'name', 'value', 'tags', 'a', 'b', 'x y', 'nested', 'list', 'é', 'key', '😀', 'a"b'];

function gen(depth = 0) {
  const r = rnd();
  if (depth > 3 || r < 0.35) return pick([1, 0, -2.5, 'text', '', 'with "quotes"', true, false, null, 1e21, 42, 'x😀y', 'x😃y', '{"j":1}', '{"j":2}']);
  if (r < 0.65) {
    const o = {};
    for (let i = 0, n = Math.floor(rnd() * 5); i < n; i++) o[pick(WORDS)] = gen(depth + 1);
    return o;
  }
  if (rnd() < 0.3) return Array.from({ length: Math.floor(rnd() * 5) }, (_, i) => ({ id: i * 7 + Math.floor(rnd() * 3), v: gen(depth + 2) }));
  return Array.from({ length: Math.floor(rnd() * 6) }, () => gen(depth + 1));
}

function mutate(v, depth = 0) {
  if (Array.isArray(v)) {
    const a = v.map((x) => (rnd() < 0.3 ? mutate(x, depth + 1) : x));
    if (rnd() < 0.3 && a.length) a.splice(Math.floor(rnd() * a.length), 1);
    if (rnd() < 0.3) a.splice(Math.floor(rnd() * (a.length + 1)), 0, gen(depth + 1));
    if (rnd() < 0.2 && a.length > 1) a.push(a.shift());
    return a;
  }
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) {
      if (rnd() < 0.15) continue;
      o[k] = rnd() < 0.35 ? mutate(v[k], depth + 1) : v[k];
    }
    if (rnd() < 0.25) o[pick(WORDS) + '2'] = gen(depth + 1);
    return o;
  }
  return rnd() < 0.5 ? gen(depth + 1) : v;
}

function shuffleKeys(v) {
  if (Array.isArray(v)) return v.map(shuffleKeys);
  if (v && typeof v === 'object') {
    const keys = Object.keys(v).sort(() => rnd() - 0.5);
    return Object.fromEntries(keys.map((k) => [k, shuffleKeys(v[k])]));
  }
  return v;
}

const decode = (h) =>
  h
    .replace(/<span class="badge[^"]*">[^<]*<\/span>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

function rows(root, list, extra = {}) {
  const changeIndex = new Map(list.map((x, i) => [x.node, i]));
  const b = new Builder({ collapsed: new Set(), expanded: new Set(), gapsOpen: new Set(), changesOnly: false, foldThreshold: Infinity, changeIndex, ...extra });
  b.node(root, 0, false, false);
  return b.rows;
}

const column = (rs, side) => rs.filter((r) => r[side]).map((r) => decode(r[side].h)).join('\n');

describe('side-by-side rows (random documents)', () => {
  it('each column reads back as its document; changes start on exactly one row', () => {
    for (let n = 0; n < 1500; n++) {
      const a = gen();
      const b = rnd() < 0.15 ? shuffleKeys(a) : mutate(a);
      // Vary number spelling: 7 → 7.0 or 7e0 at random; it must never count as a change.
      const respell = (t) => t.replace(/(?<=[:\[,])(\d+)(?=[,\]}])/g, (m) => (rnd() < 0.3 ? m + '.0' : rnd() < 0.2 ? m + 'e0' : m));
      const ta = respell(JSON.stringify(a));
      const tb = respell(JSON.stringify(b));
      for (const ignoreArrayOrder of [false, true]) {
        const opts = { ignoreArrayOrder, parseNestedJson: false };
        const root = c.diff(c.parse(ta).value, c.parse(tb).value, opts);
        const list = inPrintOrder(root, c.changes(root));
        const rs = rows(root, list);
        const ctx = `#${n}\n${ta}\n${tb}`;
        // Columns hold the same values (key order may follow the other side; with
        // ignoreArrayOrder the right side's items follow the left).
        const canon = (t) => c.canonicalText(c.parse(t).value, { ignoreArrayOrder });
        assert.deepEqual(canon(column(rs, 'l')), canon(ta), ctx);
        assert.deepEqual(canon(column(rs, 'r')), canon(tb), ctx);
        // Next always goes down the screen.
        const starts = rs.filter((r) => r.ch !== undefined).map((r) => r.ch);
        assert.deepEqual(starts, list.map((_, i) => i), ctx);
        assert.ok(!/\\ud[89ab]/i.test(rs.map((r) => (r.l?.h ?? '') + (r.r?.h ?? '')).join('')), 'split surrogate');
        // Line numbers count up by one on each side.
        for (const side of ['l', 'r']) {
          const ns = rs.filter((r) => r[side]).map((r) => r[side].n);
          assert.deepEqual(ns, ns.map((_, i) => i + 1), ctx);
        }
        const same = c.canonicalText(c.parse(ta).value, opts) === c.canonicalText(c.parse(tb).value, opts);
        assert.equal(list.length === 0, same, `no changes <=> same normalized text\n${ctx}\n${list.map((x) => x.kind + ' ' + x.path).join(', ')}`);
      }
    }
  });

  it('a reordered copy has no changes', () => {
    for (let n = 0; n < 500; n++) {
      const a = gen();
      const root = c.diff(c.parse(JSON.stringify(a)).value, c.parse(JSON.stringify(shuffleKeys(a))).value);
      assert.deepEqual(c.changes(root), [], JSON.stringify(a));
    }
  });

  it('folding and "changes only" still leave each change on one row', () => {
    for (let n = 0; n < 400; n++) {
      const a = gen();
      const b = mutate(a);
      const root = c.diff(c.parse(JSON.stringify(a)).value, c.parse(JSON.stringify(b)).value);
      const list = c.changes(root);
      const rs = rows(root, list, { changesOnly: true, foldThreshold: 0 });
      assert.deepEqual(
        rs.filter((r) => r.ch !== undefined).map((r) => r.ch).sort((x, y) => x - y),
        list.map((_, i) => i),
      );
      // A line keeps its number whatever is folded or hidden.
      const full = rows(root, list);
      const num = (rs2) => new Map(rs2.filter((r) => r.ch !== undefined).map((r) => [r.ch, [r.l?.n, r.r?.n]]));
      const a2 = num(full);
      for (const [k, v] of num(rs)) assert.deepEqual(v, a2.get(k));
    }
  });
});

describe('long arrays (patience and Myers paths)', () => {
  it('columns read back, each change on one row in order, for arrays past the exact-LCS size', () => {
    const t0 = Date.now();
    for (let n = 0; n < 40; n++) {
      const len = 2001 + Math.floor(rnd() * 1500);
      const pool = n % 2 ? () => Math.floor(rnd() * 5) : () => ({ k: Math.floor(rnd() * 3), v: 'a' + Math.floor(rnd() * 4) });
      const a = Array.from({ length: len }, pool);
      const b = a.slice();
      for (let e = 0; e < 1 + Math.floor(rnd() * 6); e++) {
        const at = Math.floor(rnd() * b.length);
        const op = rnd();
        if (op < 0.3) b.splice(at, 1);
        else if (op < 0.6) b.splice(at, 0, pool());
        else if (op < 0.8) b[at] = pool();
        else b.splice(Math.floor(rnd() * b.length), 0, ...b.splice(at, 1));
      }
      const ta = JSON.stringify(a);
      const tb = JSON.stringify(b);
      const root = c.diff(c.parse(ta).value, c.parse(tb).value, { arrayMatchKeys: [] });
      const list = inPrintOrder(root, c.changes(root));
      const rs = rows(root, list);
      const canon = (t) => c.canonicalText(c.parse(t).value, {});
      assert.equal(canon(column(rs, 'l')), canon(ta), `#${n} left`);
      assert.equal(canon(column(rs, 'r')), canon(tb), `#${n} right`);
      assert.deepEqual(rs.filter((r) => r.ch !== undefined).map((r) => r.ch), list.map((_, i) => i), `#${n} change rows`);
      // A handful of edits never turns into hundreds of reported changes.
      assert.ok(list.length <= 40, `#${n}: ${list.length} changes for at most 6 edits`);
    }
    assert.ok(Date.now() - t0 < 20000);
  });
});

describe('rows', () => {
  it('marks a changed emoji whole', () => {
    const root = c.diff(c.parse('{"m":"x😀y"}').value, c.parse('{"m":"x😃y"}').value);
    const r = rows(root, c.changes(root)).find((x) => x.k === 'chg');
    assert.match(r.l.h, /x<mark>😀<\/mark>y/);
    assert.match(r.r.h, /x<mark>😃<\/mark>y/);
  });
  it('highlights the differing part of a string', () => {
    const root = c.diff(c.parse('{"s":"12 Harbor Rd"}').value, c.parse('{"s":"12 Harbor Road"}').value);
    const rs = rows(root, c.changes(root));
    const r = rs.find((x) => x.k === 'chg');
    assert.match(r.l.h, /"12 Harbor Rd"/); // nothing removed on the left
    assert.match(r.r.h, /"12 Harbor R<mark>oa<\/mark>d"/);
  });
  it('escapes HTML in keys and values', () => {
    const root = c.diff(c.parse('{"<b>":"<img src=x onerror=alert(1)>"}').value, c.parse('{"<b>":"<i>"}').value);
    const html = rows(root, c.changes(root))
      .map((r) => (r.l?.h ?? '') + (r.r?.h ?? ''))
      .join('');
    assert.ok(!/<b>|<img|<i>/.test(html.replace(/<\/?(span|mark)[^>]*>/g, '')), html);
  });
  it('folds long unchanged containers and hides unchanged runs', () => {
    const big = JSON.stringify({ keep: Array.from({ length: 60 }, (_, i) => i), a: 1, b: 2, c: 3 });
    const root = c.diff(c.parse(big).value, c.parse(big.replace('"c":3', '"c":4')).value);
    const list = c.changes(root);
    const folded = rows(root, list, { foldThreshold: 40 });
    assert.ok(folded.some((r) => r.fold === '$.keep' && !r.open));
    const gaps = rows(root, list, { changesOnly: true, foldThreshold: 40 });
    assert.equal(gaps.filter((r) => r.gap).length, 1);
    assert.equal(gaps.length, 4); // {, gap, "c", }
  });
});

describe('find', () => {
  const { search } = require('../dist/search.js');
  const a = '{"user":{"id":7,"name":"Mai"},"items":[{"id":"sku-1","price":10},{"id":"sku-2","price":null}],"note":"Price list"}';
  const b = '{"user":{"id":7,"name":"Mai Tran"},"items":[{"id":"sku-1","price":12},{"id":"sku-3","price":5}],"note":"price list"}';
  const root = c.diff(c.parse(a).value, c.parse(b).value);
  const q = (text, extra = {}) => search(root, { text, caseSensitive: false, regex: false, scope: 'both', ...extra });
  const where = (f) => f.hits.map((h) => `${h.side}:${h.node.path}`);
  it('finds keys and values on both sides, case-insensitively by default', () => {
    // A removed or added item prints as one block, so a match inside it is one hit on it.
    assert.deepEqual(where(q('price')), ['l:$.items[id="sku-1"].price', 'r:$.items[id="sku-1"].price', 'l:$.items[id="sku-2"]', 'r:$.items[id="sku-3"]', 'l:$.note', 'r:$.note']);
    assert.deepEqual(where(q('Price', { caseSensitive: true })), ['l:$.note']);
  });
  it('limits to one side', () => {
    assert.deepEqual(where(q('mai', { scope: 'r' })), ['r:$.user.name']);
    assert.deepEqual(where(q('null', { scope: 'l' })), ['l:$.items[id="sku-2"]']);
  });
  it('regular expressions, and a clear error for a bad one', () => {
    assert.deepEqual(where(q('^sku-[23]$', { regex: true })), ['l:$.items[id="sku-2"]', 'r:$.items[id="sku-3"]']);
    assert.equal(q('(', { regex: true }).error, 'Not a valid regular expression');
  });
  it('path queries find every value at a path, including unchanged and folded ones', () => {
    const f = q('$.items[*].price');
    assert.ok(f.pathMode);
    assert.equal(f.hits.length, 4);
    assert.deepEqual(where(q('$..id', { scope: 'l' })), ['l:$.user.id', 'l:$.items[id="sku-1"].id', 'l:$.items[id="sku-2"]']);
    assert.equal(q('$[').error, 'Not a valid path');
  });
  it('a revealed path stays on screen under folding and "changes only"', () => {
    const r2 = c.diff(c.parse('{"a":{"x":1,"y":2,"z":3},"b":1}').value, c.parse('{"a":{"x":1,"y":2,"z":3},"b":2}').value);
    for (const extra of [{ changesOnly: true }, { foldThreshold: 0 }]) {
      assert.ok(!rows(r2, [], extra).some((r) => r.path === '$.a.y'), JSON.stringify(extra));
      assert.ok(rows(r2, [], { ...extra, reveal: '$.a.y' }).some((r) => r.path === '$.a.y'), JSON.stringify(extra));
    }
  });
});
