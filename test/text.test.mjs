// Word-level string diff and the plain-text mode.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const c = require('../dist/core.js');
const { diffText, textRows, lineLabel } = require('../dist/textrows.js');

const show = ([l, r]) => [l, r].map((ps) => ps.map((p) => (p.changed ? `[${p.text}]` : p.text)).join(''));

describe('wordDiff', () => {
  it('marks whole words that changed', () => {
    assert.deepEqual(show(c.wordDiff('The quick brown fox jumps', 'The quick red fox leaps')), ['The quick [brown] fox [jumps]', 'The quick [red] fox [leaps]']);
  });
  it('goes down to characters for near-identical words', () => {
    assert.deepEqual(show(c.wordDiff('12 Harbor Rd', '12 Harbor Road')), ['12 Harbor Rd', '12 Harbor R[oa]d']);
    assert.deepEqual(show(c.wordDiff('2026-10-24', '2026-10-23')), ['2026-10-2[4]', '2026-10-2[3]']);
  });
  it('never splits an emoji', () => {
    assert.deepEqual(show(c.wordDiff('x😀y', 'x😃y')), ['x[😀]y', 'x[😃]y']);
  });
  it('marks everything when the two have little in common', () => {
    assert.deepEqual(show(c.wordDiff('pending', 'paid')), ['[pending]', '[paid]']);
    assert.deepEqual(show(c.wordDiff('abc', '')), ['[abc]', '']);
  });
  it('rebuilds both strings exactly', () => {
    let seed = 3;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const words = ['alpha', 'beta', ' ', '  ', ',', 'Ω', '😀', 'x1', '\t', 'beta2'];
    for (let n = 0; n < 2000; n++) {
      const a = Array.from({ length: Math.floor(rnd() * 12) }, () => words[Math.floor(rnd() * words.length)]).join('');
      const b = Array.from({ length: Math.floor(rnd() * 12) }, () => words[Math.floor(rnd() * words.length)]).join('');
      const [l, r] = c.wordDiff(a, b);
      assert.equal(l.map((p) => p.text).join(''), a);
      assert.equal(r.map((p) => p.text).join(''), b);
    }
  });
});

describe('text mode', () => {
  const rowsOf = (a, b, o = {}, s = {}) => {
    const t = diffText(a, b, { ignoreWhitespace: false, ...o });
    const list = c.changes(t.root);
    const out = textRows(t.root, t.left, t.right, { changesOnly: false, gapsOpen: new Set(), changeIndex: new Map(list.map((x, i) => [x.node, i])), ...s });
    return { ...out, list };
  };
  const plain = (h) => h.replace(/<span class="badge[^"]*">[^<]*<\/span>/g, '').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const column = (rows, side) => rows.filter((r) => r[side]).map((r) => plain(r[side].h).replace(/^ $/, '')).join('\n');

  it('lines match up; changed lines are marked word by word', () => {
    const { rows, list } = rowsOf('one\ntwo three\nfour\n', 'one\ntwo 3\nfour\nfive\n');
    assert.deepEqual(list.map((x) => `${x.kind} ${lineLabel(x.node)}`), ['chg line 2', 'add right line 4']);
    assert.match(rows[1].r.h, /two <mark>3<\/mark>/);
  });
  it('a moved line is shown where it was and where it went', () => {
    const { rows, list } = rowsOf('a\nb\nc\nd\n', 'a\nc\nd\nb\n');
    assert.deepEqual(list.map((x) => x.kind), ['moved']);
    assert.ok(rows.some((r) => r.l && /moved: now line 4/.test(r.l.h)));
    assert.ok(rows.some((r) => r.r && /moved: was line 2/.test(r.r.h)));
  });
  it('an edited line that also moved pairs with itself, not with its old neighbour', () => {
    const a = 'Release\n- Export to CSV\n- Dark theme: better contrast for links\n';
    const b = 'Release\n- Dark theme: better contrast for links and buttons\n- Export to CSV\n- New: export to Excel\n';
    const { list } = rowsOf(a, b);
    assert.deepEqual(list.map((x) => [x.kind, ...(x.also ?? [])].join('+') + ' ' + lineLabel(x.node)), ['add right line 4', 'moved+chg line 3 → 2']);
  });
  it('JSON arrays of strings: an edited label pairs with itself', () => {
    const P = (t) => c.parse(t).value;
    assert.deepEqual(c.changes(c.diff(P('["fast startup", "dark theme for links", "csv"]'), P('["fast startup", "dark theme for links and buttons", "csv"]'))).map((x) => x.kind + ' ' + x.path), ['chg $[1]']);
  });
  it('a moved and edited line marks its edits on both halves', () => {
    const { rows } = rowsOf('a\nkeep\nflutter build ipa --release\nb\n', 'flutter build ipa --release --obfuscate\na\nkeep\nb\n');
    const right = rows.find((r) => r.r && /was line 3/.test(r.r.h));
    assert.ok(right && /<mark> --obfuscate<\/mark>|<mark>--obfuscate<\/mark>/.test(right.r.h), right && right.r.h);
    assert.match(right.r.h, /moved and changed/);
  });
  it('ignore whitespace', () => {
    assert.equal(rowsOf('  a  b\n', 'a b\n', { ignoreWhitespace: true }).list.length, 0);
    assert.equal(rowsOf('  a  b\n', 'a b\n').list.length, 1);
  });
  it('escapes HTML and shows file line numbers', () => {
    const { rows } = rowsOf('<b>x</b>\n', '<i>x</i>\n');
    assert.ok(!/<b>|<i>/.test(rows[0].l.h + rows[0].r.h));
    assert.equal(rows[0].l.ln, 1);
  });
  it('changes only keeps two lines of context and hides the rest', () => {
    const a = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    const b = a.replace('line 15', 'line fifteen');
    const { rows } = rowsOf(a, b, {}, { changesOnly: true });
    assert.equal(rows.filter((r) => r.gap).length, 2);
    assert.equal(rows.filter((r) => !r.gap).length, 5);
  });
  it('random texts: each column reads back as its text, each change starts on one row', () => {
    let seed = 11;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const pool = ['alpha', 'beta gamma', '', '  indented', 'x = 1', 'x = 2', '}', '{', 'return y'];
    for (let n = 0; n < 600; n++) {
      const a = Array.from({ length: Math.floor(rnd() * 15) }, () => pool[Math.floor(rnd() * pool.length)]);
      const b = a.slice();
      for (let e = 0; e < 3; e++) {
        const at = Math.floor(rnd() * (b.length + 1));
        const op = rnd();
        if (op < 0.3) b.splice(at, 1);
        else if (op < 0.6) b.splice(at, 0, pool[Math.floor(rnd() * pool.length)]);
        else if (b.length) b.push(b.splice(at % b.length, 1)[0]);
      }
      const { rows, list } = rowsOf(a.join('\n'), b.join('\n'));
      const ctx = JSON.stringify([a, b]);
      assert.equal(column(rows, 'l'), c.splitLines(a.join('\n')).join('\n'), ctx);
      assert.equal(column(rows, 'r'), c.splitLines(b.join('\n')).join('\n'), ctx);
      assert.deepEqual(rows.filter((r) => r.ch !== undefined).map((r) => r.ch).sort((x, y) => x - y), list.map((_, i) => i), ctx);
    }
  });
});
