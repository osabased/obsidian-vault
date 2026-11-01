import test from 'node:test';
import assert from 'node:assert/strict';
import { parse, setField, plainSafe, yamlQuote } from '../tools/lib/frontmatter.mjs';
import { makeVault, ruleNote, lintFound } from './fixture.mjs';

const front = lines => `---\n${lines.join('\n')}\n---\nbody\n`;
const data = lines => parse(front(lines)).data;

test('a single-quoted scalar continues on the next lines, each break folding to one space', () => {
  assert.deepEqual(data(["summary: 'one line", '  and two', "   and three'", 'next: 1']), { summary: 'one line and two and three', next: '1' });
});

test('a double-quoted scalar folds the same way, and a backslash at a line end drops the break', () => {
  assert.deepEqual(data(['summary: "one line', '  and two"', 'joined: "ab\\', '  cd"', 'tab: "a\\tb', '  c"']), {
    summary: 'one line and two', joined: 'abcd', tab: 'a\tb c',
  });
});

test('an empty line inside a quoted scalar is a newline, and blank lines inside it are not dropped', () => {
  assert.deepEqual(data(["summary: 'first", '', '  second', '', '', "  third'"]).summary, 'first\nsecond\n\nthird');
});

test("a '' on a continuation line is one quote, and a comment-looking line inside quotes is text", () => {
  assert.deepEqual(data(["summary: 'it", "  isn''t", "  # not a comment' # a comment"]).summary, "it isn't # not a comment");
});

test('quoted scalars continue inside list items and nested mappings', () => {
  assert.deepEqual(data(['keywords:', "  - 'a", "    b'", '  - plain', '  - "c', '    d"', 'outer:', "  inner: 'x", "    y'", 'after: 2']), {
    keywords: ['a b', 'plain', 'c d'], outer: { inner: 'x y' }, after: '2',
  });
});

test('an unterminated quote is reported, and the lines after it still parse', () => {
  const r = parse(front(["summary: 'never closed", 'next: 1']));
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /^summary: .*never closes/);
  assert.equal(r.data.next, '1');
  assert.deepEqual(parse(front(['a: 1'])).errors, []);
});

test('lint marks a note whose quote never closes, and reads a folded summary whole', async t => {
  const v = makeVault(t);
  const page = (summary, name) => v.write(`wiki/${v.domain}/concepts/${name}.md`, [
    '---', 'type: page', `domain: ${v.domain}`, 'kind: concept', 'topic: code', ...summary, 'created: 2026-10-01', 'updated: 2026-10-01', '---', 'text', '',
  ].join('\n'));
  page(["summary: 'one line", "  and two'"], 'folded');
  page(["summary: 'one line", 'created2: 1'], 'open');
  v.write(`wiki/${v.domain}/rules/r.md`, ruleNote({ domain: v.domain, keywords: ['x'] }));
  const { loadNotes } = await v.import('lib/rules.mjs');
  const notes = Object.fromEntries(loadNotes().map(n => [n.slug, n]));
  assert.equal(notes.folded.summary, 'one line and two');
  assert.deepEqual((await lintFound(v, /quote.*never closes/)).map(f => f.file), [`wiki/${v.domain}/concepts/open.md`]);
});

test('a value with a line break is written double-quoted and reads back whole, replacing a folded one in full', () => {
  assert.equal(plainSafe('a\nb'), false);
  assert.equal(yamlQuote('a\nb\\c"d'), String.raw`"a\nb\\c\"d"`);
  const text = front(["as_of: 'old", '  value\' # mine', 'topic: code']);
  const out = setField(text, 'as_of', 'a\nb');
  assert.equal(out, front(['as_of: "a\\nb" # mine', 'topic: code']));
  assert.deepEqual(parse(out).data, { as_of: 'a\nb', topic: 'code' });
  assert.equal(setField(front(["note: 'x", '  as_of: 1\'', 'as_of: 2']), 'as_of', 'three'), front(["note: 'x", '  as_of: 1\'', 'as_of: three']));
});
