# Changelog

## 0.4.0

- Text mode: compare plain text line by line, with changed words marked, moved lines
  (edited or not) shown where they were and where they went, "Ignore whitespace" and
  "Changes only". Files that aren't JSON open in Text; a broken JSON file offers
  "Compare as text".
- Changed strings are marked word by word, down to the characters that differ in a
  near-identical word, hash or token. "Compare strings" shows two long values in full.
- A long array item that keeps its place is never reported as moved.
- "Compare with…" lists every open file, JSON first.

## 0.3.0

- Find (Ctrl+F / Cmd+F) in the comparison: keys and values, both documents or one,
  match case and regular expressions, including folded and hidden parts. A query that
  starts with `$` is a path (`$.items[*].price`, `$..id`) and steps through every value
  there.

## 0.2.0

- A `{×}` button in the editor title bar opens an empty comparison to paste into
  (`jsonSemanticDiff.showTitleButton` hides it).
- Pasting one-line JSON into the edit boxes lays it out with indentation; a **Format**
  button does the same on demand, keeping key order. Escaped or wrapped JSON comes out
  as the JSON inside.

## 0.1.0

First release.

- Side-by-side semantic comparison of two JSON documents: key order, formatting and
  number spelling are ignored; big numbers are compared exactly.
- Array items matched by `id`-like keys, by longest common run, or as sets. Moved items
  are shown where they were and where they went; renamed or edited items still pair up.
- JSON inside strings compared as JSON, and a string turning into an object (or back)
  counts as a change.
- Lenient input: comments, trailing commas, single quotes, unquoted keys, escaped JSON,
  JSON Lines, JSON inside log text. A document with a syntax error reports its line and
  column instead of being guessed at.
- Compare with another file, the clipboard, the selection, HEAD, or the two sides of any
  diff editor, with keyboard shortcuts for each.
- Change navigation and list, folding, changes-only view, ignore paths, swap, in-place
  editing, normalized text diff, Markdown summary.
- Keyboard and screen reader support, High Contrast themes, and comparisons that come
  back after a window reload.
- In Restricted Mode, comparison settings from the workspace are not applied.
