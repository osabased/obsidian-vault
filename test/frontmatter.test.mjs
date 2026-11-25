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

test('an unterminated quote is reported, and the lines after it still parse, a later quote too', () => {
  const r = parse(front(["summary: 'never closed", 'next: 1', 'list:', "  - 'x'"]));
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /^summary: .*never closes/);
  assert.equal(r.data.next, '1');
  assert.deepEqual(r.data.list, ['x']);
  assert.deepEqual(parse(front(['a: 1'])).errors, []);
});

test('a plain value holding ": " is reported, since Obsidian rejects the whole block, and a quoted one or a URL is not', () => {
  const r = parse(front(['summary: How to choose: compare them', 'topic: design']));
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /^summary: the value on line 2 holds ": "/);
  assert.equal(r.data.topic, 'design');
  assert.match(parse(front(['summary: ends with a colon:'])).errors.join(), /^summary: /);
  assert.deepEqual(parse(front(["summary: 'How to choose: compare'", 'url: https://a.b/c', 'at: 12:30', 'note: a # b: c'])).errors, []);
});

// A value continues only onto lines indented past its parent, so a quote left open never takes the keys below it.
const reads = (lines, want, errors = []) => {
  const r = parse(front(lines));
  assert.deepEqual(r.data, want);
  assert.deepEqual(r.errors.map(e => e.replace(/ (?:quote )?opened on line \d+ never closes.*/, '')), errors);
};

test('an unclosed quote on a key keeps the keys below it, even one with a later quote or apostrophe', () => {
  reads(["summary: 'Missing close", 'topic: code', "keywords: ['shimmer']", 'always: false'],
    { summary: "'Missing close", topic: 'code', keywords: ['shimmer'], always: false }, ["summary: the '"]);
  reads(["summary: 'It works", 'topic: layout', 'keywords:', "  - don't", 'always: true'],
    { summary: "'It works", topic: 'layout', keywords: ["don't"], always: true }, ["summary: the '"]);
});

test('an unclosed quote on a list item keeps the items and keys below it, and the error names the list', () => {
  reads(['keywords:', "  - 'shimmer", '  - glow', "topic: it's code"], { keywords: ["'shimmer", 'glow'], topic: "it's code" }, ["keywords: the '"]);
  reads(['items:', '  - name: x', "    tags: ['a", '  - b'], { items: [{ name: 'x', tags: "['a" }, 'b'] }, ['tags: the [']);
});

test('the body of a block scalar is never read for quotes, and keeps its line breaks', () => {
  reads(['summary: |', "  'tis the season", "topic: don't panic", "keywords: ['a']"], { summary: "'tis the season", topic: "don't panic", keywords: ['a'] });
  reads(['notes: |', "  'tis the season", '  more', 'type: rule'], { notes: "'tis the season\nmore", type: 'rule' });
  reads(['summary: |', '  "Hello,', '  world"', '  next'], { summary: '"Hello,\nworld"\nnext' });
  reads(['desc: >', "  'Tis the season", "title: Bob's", 'topic: x'], { desc: "'Tis the season", title: "Bob's", topic: 'x' });
  reads(['desc: |', '  "hi', '  there', 'other: x'], { desc: '"hi\nthere', other: 'x' });
  reads(['desc: |-', '  "Quoted', '  text" he said', 'other: x'], { desc: '"Quoted\ntext" he said', other: 'x' });
  const item = parse(front(['items:', '  - |', "    'a", '  - b']));
  assert.deepEqual([item.data.items.at(-1), item.errors], ['b', []]);
});

test('a value on its own line under its key continues past the key, not past its own indent', () => {
  reads(['summary:', "  'one", " two'", 'next: 1'], { summary: 'one two', next: '1' });
  reads(['applies_to:', "  ['src/**',", "  'test/**']", 'next: 1'], { applies_to: ['src/**', 'test/**'], next: '1' });
});

test('a quote opened after `- key:` folds onto lines indented past the key', () => {
  reads(['items:', "  - name: 'a", "      b'", '    kind: c', '  - name: d'], { items: [{ name: 'a b', kind: 'c' }, { name: 'd' }] });
  reads(['items:', "  - name: 'a", "  - name: b'"], { items: [{ name: "'a" }, { name: "b'" }] }, ["name: the '"]);
});

test('a flow list continues while its bracket is open, and one never closed is reported', () => {
  reads(["applies_to: ['src/**',", "  'test/**']", 'topic: code'], { applies_to: ['src/**', 'test/**'], topic: 'code' });
  reads(['tags: {a: 1,', "  b: 'x, y'}"], { tags: { a: '1', b: 'x, y' } });
  reads(["applies_to: ['src/**',", 'topic: code'], { applies_to: "['src/**',", topic: 'code' }, ['applies_to: the [']);
  assert.match(parse(front(["applies_to: ['src/**',", 'topic: code'])).errors[0], /^applies_to: the \[ opened on line 2 never closes. Close it with a matching \]$/);
});

test('a plain scalar folds the more indented lines below it that are not keys or list items', () => {
  reads(['summary: one', '  two', '', '  three', 'next: 1'], { summary: 'one two\nthree', next: '1' });
  reads(['summary: The tab bar', "  'tis cramped", 'topic: ui', 'keywords:', "  - don't"], { summary: "The tab bar 'tis cramped", topic: 'ui', keywords: ["don't"] });
  reads(['keywords:', '  - one', '    two', '  - three'], { keywords: ['one two', 'three'] });
  reads(['outer: x', '  inner: 1', 'next: 1'], { outer: 'x', next: '1' });
});

test('text after a closing quote is reported', () => {
  reads(["k: 'a' tail", "j: 'b' # fine"], { k: 'a', j: 'b' }, ['k: text follows the closing quote on line 2. Put it inside the quotes, or after a #']);
  reads(["k: 'a", "  b' tail"], { k: 'a b' }, ['k: text follows the closing quote on line 3. Put it inside the quotes, or after a #']);
});

test('a double-quoted scalar reads every YAML escape, and a backslash before a break reads the same on any line', () => {
  assert.equal(data(['a: "\\u00e9\\x41\\U0001F600\\/\\_\\0\\e"']).a, 'éA😀/\u00a0\0\x1b');
  assert.deepEqual(data(['a: "x\\ ', '  y"', 'b: "x', '  y\\ ', '  z"']), { a: 'xy', b: 'x yz' });
});

test('CRLF line ends read and write as LF ones do', () => {
  const text = front(["summary: 'one", "  two'", "keywords: ['a',", "  'b']", 'as_of: 2026-01-01']).replace(/\n/g, '\r\n');
  assert.deepEqual(parse(text).data, { summary: 'one two', keywords: ['a', 'b'], as_of: '2026-01-01' });
  assert.equal(setField(text, 'summary', 'x'), text.replace("summary: 'one\r\n  two'", "summary: 'x'"));
  assert.equal(setField(text, 'as_of', '2026-02-02'), text.replace('2026-01-01', '2026-02-02'));
});

test('setField keeps the lines below an unclosed quote, and updates a key after a block scalar', () => {
  const a = front(["summary: 'Rules for the UI", 'topic: code', 'applies_to:', "  - 'src/**'"]);
  assert.equal(setField(a, 'summary', 'x'), front(["summary: 'x'", 'topic: code', 'applies_to:', "  - 'src/**'"]));
  const src = front(['type: page', "source: './raw/refs/a.md", 'topic: code', 'keywords:', "  - 'x'", 'updated: 2026-10-01']);
  assert.equal(setField(src, 'source', 'raw/refs/a.md'), src.replace("'./raw/refs/a.md", "'raw/refs/a.md'"));
  const b = front(['summary: |', "  'tis", 'as_of: 2026-01-01', "x: it's"]);
  assert.equal(setField(b, 'as_of', '2026-02-02'), b.replace('2026-01-01', '2026-02-02'));
  const c = setField(front(["a: 'x", 'b: 1']), 'b', '2');
  assert.deepEqual(parse(c).data, { a: "'x", b: '2' });
  assert.match(parse(c).errors.join(), /^a: the ' quote opened on line 2 never closes/);
});

test('a long run of spaces parses in linear time', () => {
  const start = performance.now();
  parse(front([`summary: a${' '.repeat(40000)}b`, `${'x'.repeat(10)}${' '.repeat(40000)}y`]));
  assert.ok(performance.now() - start < 200, `${Math.round(performance.now() - start)} ms`);
});

test('a rule whose extra field never closes its quote keeps its topic and applies_to', async t => {
  const v = makeVault(t);
  const rules = await v.import('lib/rules.mjs');
  const n = rules.parseNote(ruleNote({ domain: v.domain, keywords: ['tabs'], applies_to: ['src/**'], extra: ["note: 'unclosed"] }), `wiki/${v.domain}/rules/r.md`);
  assert.deepEqual(n.applies_to, ['src/**']);
  assert.equal(n.data.topic, 'code');
  assert.equal(rules.noteErrors(n).filter(e => /never closes/.test(e)).length, 1);
  assert.match(rules.notTextError('keywords', { a: 'x\ny' }), /Double-quote an item .* as in "a: x\\ny"$/);
});

test('lint reports a quote that never closes in a saved source, a bundle source.md and derived text', async t => {
  const v = makeVault(t);
  v.write('raw/refs/a.md', "---\nurl: 'https://example.com\nfetched: 2026-10-01\n---\ntext\n");
  v.write('raw/refs/b/source.md', "---\nurl: https://example.com\ncommit: 'abc1234\n---\n");
  v.write('raw/refs/b/x.zq', 'set x to 1\n');
  v.write(`derived/${'0'.repeat(64)}.md`, "---\nkind: pdf\nextractor: 'x\nextractor_version: 1\nsource: raw/refs/a.md\n---\n");
  const found = (await v.import('lib/lint.mjs')).lint().filter(f => /never closes/.test(f.msg));
  assert.deepEqual(found.map(f => [f.level, f.file]).sort(), [['warn', `derived/${'0'.repeat(64)}.md`], ['warn', 'raw/refs/a.md'], ['warn', 'raw/refs/b/source.md']]);
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
