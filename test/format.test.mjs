import test from 'node:test';
import assert from 'node:assert/strict';
import { parse, setField } from '../tools/lib/frontmatter.mjs';
import { makeVault, ruleNote, pageNote, sessionId, prompt, userTurn, lintFound } from './fixture.mjs';

const front = lines => `---\n${lines.join('\n')}\n---\nbody\n`;
const data = lines => parse(front(lines)).data;
const check = (rules, text, rel = 'wiki/demo/some-rule.md') => rules.noteErrors(rules.parseNote(text, rel));
const knowledge = ({ extra = [], ...o } = {}) => ruleNote({ kind: 'knowledge', basis: 'source', ...o, extra: ['as_of: 2026-10-01', ...extra] });

const REQUIRES_FLOW = [
  'requires:',
  '  - package: { ecosystem: demo-reader, name: widget-kit }',
  '    ranges:',
  '      - type: SEMVER',
  "        events: [{ introduced: '2.0.0' }, { fixed: '3.0.0' }]",
];
const REQUIRES_BLOCK = [
  'requires:',
  '- package:',
  '    ecosystem: demo-reader',
  "    name: '@demo/widget-kit'",
  '  ranges:',
  '  - type: ECOSYSTEM',
  '    events:',
  "      - introduced: '0'",
  '      - last_affected: 1.4-beta',
];

test('frontmatter reads what it read before', () => {
  assert.deepEqual(data([
    'type: rule', "topic: 'it''s'", 'title: "a\\tb"', 'n: 12 # a comment', 'always: false', 'empty:', 'tilde: ~',
    "applies_to: ['src/**', \"lib/*.ts\"]", 'keywords:', '  - one', '  -', "  - 'two'", 'flat:', '- x', '- y',
    'link: [[wiki/demo/other|other]]', 'items:', '  - [[wiki/demo/a]]', 'summary: >-', '  folded text', '  stays out',
  ]), {
    type: 'rule', topic: "it's", title: 'a\tb', n: '12', always: false, empty: null, tilde: null,
    applies_to: ['src/**', 'lib/*.ts'], keywords: ['one', 'two'], flat: ['x', 'y'],
    link: ['[wiki/demo/other|other]'], items: ['[[wiki/demo/a]]'], summary: '>-',
  });
  assert.deepEqual(parse('﻿---\r\na: 1\r\nlist:\r\n  - b\r\n---\r\nbody').data, { a: '1', list: ['b'] });
  assert.deepEqual(data(['list:', '  -', 'next: 1']), { list: null, next: '1' });
});

test('frontmatter reads nested block and flow mappings as deep as requires goes', () => {
  assert.deepEqual(data(REQUIRES_FLOW).requires, [{
    package: { ecosystem: 'demo-reader', name: 'widget-kit' },
    ranges: [{ type: 'SEMVER', events: [{ introduced: '2.0.0' }, { fixed: '3.0.0' }] }],
  }]);
  assert.deepEqual(data([...REQUIRES_BLOCK, 'topic: code']), {
    requires: [{
      package: { ecosystem: 'demo-reader', name: '@demo/widget-kit' },
      ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '0' }, { last_affected: '1.4-beta' }] }],
    }],
    topic: 'code',
  });
  assert.deepEqual(data(['globs: [src/*.{ts,tsx}, b]']).globs, ['src/*.{ts,tsx}', 'b']);
});

test('setField next to a nested block changes only its top-level key, and leaves a key holding a block alone', () => {
  const text = front(['as_of: 2026-01-01', ...REQUIRES_BLOCK, 'type: rule']).replace(/\n/g, '\r\n');
  const set = setField(text, 'as_of', '2026-10-01');
  assert.equal(set, text.replace('2026-01-01', '2026-10-01'));
  assert.equal(setField(text, 'name', 'x'), text);
  assert.equal(setField(text, 'requires', 'x'), text);
  assert.equal(setField(text, 'type', 'page'), text.replace('type: rule', 'type: page'));
});

test('a knowledge rule takes keywords and always, and every rule needs a channel', async t => {
  const v = makeVault(t);
  const rules = await v.import('lib/rules.mjs');
  assert.deepEqual(check(rules, knowledge({ keywords: ['widget'] })), []);
  assert.deepEqual(check(rules, knowledge({ always: true })), []);
  assert.deepEqual(check(rules, knowledge({ extra: ['tools:', '  - AskUserQuestion'] })), []);
  assert.deepEqual(check(rules, ruleNote({ extra: ["tools: ['mcp__demo__edit']"] })), []);
  const none = 'a rule needs keywords, applies_to, tools or always: true, or nothing brings it up';
  assert.deepEqual(check(rules, knowledge({})), [none]);
  assert.deepEqual(check(rules, ruleNote({})), [none]);
});

test("a knowledge rule's keyword reaches a prompt and its always loads at session start", t => {
  const v = makeVault(t);
  v.write('wiki/demo/rules/widget-api.md', knowledge({ keywords: ['widget'], doLine: 'Call mount first.', notLine: 'Call render first.' }));
  v.write('wiki/demo/rules/kit-version.md', knowledge({ always: true, doLine: 'Use kit 3.', notLine: 'Use kit 2.' }));
  const sid = sessionId();
  assert.match(v.startSession(sid).hookSpecificOutput.additionalContext, /demo\/kit-version: Do: Use kit 3\./);
  assert.match(prompt(v, sid, 'how do I add a widget?').hookSpecificOutput.additionalContext, /demo\/widget-api: Do: Call mount first\./);
});

test('rule length caps follow the kind', async t => {
  const v = makeVault(t);
  const rules = await v.import('lib/rules.mjs');
  const long = 'Word '.repeat(90);
  const fact = rules.parseNote(knowledge({ keywords: ['w'], doLine: long }), 'wiki/demo/rules/fact.md');
  const taste = rules.parseNote(ruleNote({ keywords: ['w'], doLine: long }), 'wiki/demo/rules/taste.md');
  assert.equal(rules.maxChars('knowledge'), 600);
  assert.equal(rules.maxChars('taste'), 300);
  assert.equal(rules.ruleLine('k', { kind: 'knowledge', text: rules.ruleText(fact) }), `- k: ${rules.ruleText(fact)}`);
  const clipped = rules.ruleLine('k', { kind: 'taste', text: rules.ruleText(taste) });
  assert.ok(clipped.endsWith('…') && clipped.length <= '- k: '.length + 300, clipped);

  v.write('wiki/demo/rules/fact.md', knowledge({ keywords: ['w'], doLine: 'Word '.repeat(130) }));
  v.write('wiki/demo/rules/short-fact.md', knowledge({ keywords: ['w'], doLine: long }));
  v.write('wiki/demo/rules/always-fact.md', knowledge({ always: true, doLine: long }));
  const found = (await lintFound(v, /characters/)).map(f => [f.file, f.msg]);
  assert.deepEqual(found, [
    ['wiki/demo/rules/always-fact.md', `always: true loads this rule at every session start, and its Do, Not, Because and the as_of date come to ${rules.ruleText(rules.parseNote(knowledge({ always: true, doLine: long }), 'x/y.md')).length} characters, over the 300 a taste rule may have. Shorten it, or give it keywords instead`],
    ['wiki/demo/rules/fact.md', `Do, Not, Because and the as_of date come to ${rules.ruleText(rules.parseNote(knowledge({ keywords: ['w'], doLine: 'Word '.repeat(130) }), 'x/y.md')).length} characters; the hooks cut them at 600`],
  ]);
});

test('propose refuses a rule over its kind\'s cap and takes keywords on a knowledge rule', t => {
  const v = makeVault(t);
  const sid = sessionId();
  v.startSession(sid, { transcript: v.transcript(sid, [userTurn('kit 3 needs mount before render')]) });
  const fact = o => ({
    domain: 'demo', slug: 'kit-mount', topic: 'code', kind: 'knowledge', basis: 'stated', quote: 'kit 3 needs mount before render',
    do: 'Call mount before render.', not: 'Call render first.', keywords: ['mount'], ...o,
  });
  const over = v.propose(sid, fact({ slug: 'too-long', do: `${'Word '.repeat(120)}end.` }));
  assert.equal(over.code, 1);
  assert.match(over.stderr, /Do, Not, Because and the as_of date come to \d+ characters; keep them under 600 together\./);
  const ok = v.propose(sid, fact({ do: `${'Word '.repeat(70)}end.` }));
  assert.equal(ok.code, 0, ok.stderr);
  const none = v.propose(sid, fact({ slug: 'no-channel', keywords: [] }));
  assert.match(none.stderr, /give it keywords or applies_to, or nothing will deliver it\./);
});

test('tools is a list of exact tool names on any note', async t => {
  const v = makeVault(t);
  const rules = await v.import('lib/rules.mjs');
  const page = extra => check(rules, pageNote({ extra }), 'wiki/demo/code.md');
  assert.deepEqual(page(['tools:', '  - AskUserQuestion', '  - mcp__demo__set_property']), []);
  assert.deepEqual(rules.parseNote(pageNote({ extra: ['tools: [AskUserQuestion]'] }), 'wiki/demo/code.md').tools, ['AskUserQuestion']);
  assert.deepEqual(page(['tools: AskUserQuestion']), ['tools must be a list']);
  assert.deepEqual(page(["tools: ['Ask User', '']"]), ['tools must name each tool exactly, with no spaces: Ask User', 'tools must name each tool exactly, with no spaces: (empty)']);
  assert.deepEqual(check(rules, ruleNote({ keywords: ['x'], extra: ['tools: [true]'] })), ['tools must name each tool exactly, with no spaces: true']);
});

test('requires takes the OSV affected shape on knowledge rules and pages, not taste rules', async t => {
  const v = makeVault(t);
  const rules = await v.import('lib/rules.mjs');
  const page = lines => check(rules, pageNote({ extra: lines }), 'wiki/demo/code.md');
  assert.deepEqual(check(rules, knowledge({ keywords: ['w'], extra: REQUIRES_FLOW })), []);
  assert.deepEqual(page(REQUIRES_BLOCK), []);
  assert.deepEqual(page(["requires: [{ package: { ecosystem: r, name: p }, ranges: [{ type: SEMVER, events: [{ introduced: '0' }, { limit: 2.0.0-rc.1+b5 }] }] }]"]), []);
  assert.deepEqual(check(rules, ruleNote({ keywords: ['w'], extra: REQUIRES_FLOW })), ['requires is for knowledge rules and pages; a taste rule holds whatever the version']);
  const bad = [
    [['requires: widget-kit'], 'requires must be a list of { package, ranges } entries, as in OSV affected'],
    [['requires:', '  - package: { name: p }', '    ranges: [{ type: SEMVER, events: [{ introduced: 1.0.0 }] }]'], 'requires entry 1: package needs an ecosystem and a name'],
    [['requires:', '  - package: { ecosystem: r, name: p }'], 'requires entry 1: ranges must be a list of { type, events }'],
    [['requires:', '  - package: { ecosystem: r, name: p }', '    ranges: [{ type: GIT, events: [{ introduced: 1.0.0 }] }]'], 'requires entry 1: a range type must be SEMVER or ECOSYSTEM'],
    [['requires:', '  - package: { ecosystem: r, name: p }', '    ranges: [{ type: SEMVER, events: [{ since: 1.0.0 }] }]'], "requires entry 1: each event is one of introduced, fixed, last_affected or limit, with a version"],
    [['requires:', '  - package: { ecosystem: r, name: p }', '    ranges: [{ type: SEMVER, events: [{ introduced: 1.0.0, fixed: 2.0.0 }] }]'], "requires entry 1: each event is one of introduced, fixed, last_affected or limit, with a version"],
    [['requires:', '  - package: { ecosystem: r, name: p }', '    ranges: [{ type: SEMVER, events: [{ fixed: v2 }] }]'], 'requires entry 1: v2 is not a semver version'],
    [['requires:', '  - package: { ecosystem: r, name: p }', '    ranges: [{ type: SEMVER, events: [{ fixed: 0 }] }]'], 'requires entry 1: 0 is not a semver version'],
  ];
  for (const [lines, msg] of bad) assert.deepEqual(page(lines), [msg], lines.join(' / '));
  assert.deepEqual(page(['requires:', '  - package: { ecosystem: r, name: p }', '    ranges: [{ type: ECOSYSTEM, events: [{ fixed: v2 }] }]']), []);
});

test('author is user or agent on a page, and never on a rule', async t => {
  const v = makeVault(t);
  const rules = await v.import('lib/rules.mjs');
  const parsed = extra => rules.parseNote(pageNote({ extra }), 'wiki/demo/code.md');
  assert.equal(parsed([]).author, 'agent');
  assert.equal(parsed(['author: user']).author, 'user');
  assert.deepEqual(rules.noteErrors(parsed(['author: user'])), []);
  assert.deepEqual(rules.noteErrors(parsed(['author: me'])), ['author must be user or agent']);
  assert.deepEqual(check(rules, ruleNote({ keywords: ['x'], extra: ['author: agent'] })), ['author is only for pages']);
});

test("lint asks an author: user page for no topic or summary, and lint --fix leaves its file as it is", async t => {
  const v = makeVault(t);
  v.write('wiki/demo/other.md', pageNote({ kind: 'concept' }));
  const link = ['[[demo/other]]'];
  const mine = v.write('wiki/demo/journal.md', pageNote({ kind: 'concept', topic: "''", summary: "''", extra: ['author: user'], body: link }));
  v.write('wiki/demo/agent-page.md', pageNote({ kind: 'concept', topic: "''", summary: "''", body: link }));
  const found = (await lintFound(v, /^no (topic|summary)|^links/)).map(f => [f.file, f.msg.split('.')[0]]);
  assert.deepEqual(found.filter(([f]) => f === 'wiki/demo/journal.md').map(([, m]) => m), ['links [[demo/other]], a note at wiki/demo/other']);
  assert.equal(found.filter(([f]) => f === 'wiki/demo/agent-page.md').length, 3);
  const before = v.read('wiki/demo/journal.md');
  const { lint, fix } = await v.import('lib/lint.mjs');
  const { written } = fix(lint());
  assert.deepEqual(written, ['wiki/demo/agent-page.md']);
  assert.equal(v.read('wiki/demo/journal.md'), before, mine);
});

test('applies_to takes globs over a declared namespace, and file matching never sees them', async t => {
  const v = makeVault(t, { config: { namespaces: { 'demo-tree': { separator: '.', escape: '\\' } } } });
  const rules = await v.import('lib/rules.mjs');
  assert.deepEqual(rules.splitTarget('!demo-tree:Shop.**'), { negated: true, namespace: 'demo-tree', glob: 'Shop.**' });
  assert.deepEqual(rules.splitTarget('src/**'), { negated: false, namespace: null, glob: 'src/**' });
  assert.deepEqual(rules.splitTarget('!src/a:b/*.ts'), { negated: true, namespace: null, glob: 'src/a:b/*.ts' });
  const errs = globs => check(rules, ruleNote({ applies_to: globs }));
  assert.deepEqual(errs(['demo-tree:Shop.**', '!demo-tree:Shop.Debug', 'src/**']), []);
  assert.deepEqual(errs(['other-tree:Shop.**']), ["applies_to names namespace other-tree, which vault.config.json doesn't declare under namespaces"]);
  assert.deepEqual(errs(['file:src/**']), ['applies_to: write a file glob bare, without file:']);
  assert.deepEqual(errs(['demo-tree:Shop.{a']), ['bad glob in applies_to: demo-tree:Shop.{a']);
  v.write('wiki/demo/rules/both.md', ruleNote({ applies_to: ['src/**', 'demo-tree:Shop.**', '!demo-tree:Shop.Debug'] }));
  v.write('wiki/demo/tree-page.md', pageNote({ applies_to: ['demo-tree:Shop.**', 'docs/**'] }));
  assert.deepEqual(rules.liveRules()['demo/both'].applies_to, ['src/**']);
  assert.deepEqual(rules.livePages()['demo/tree-page'].applies_to, ['docs/**']);
});

test('lintConfig checks namespaces and editTools, naming the key', async t => {
  const lintOf = async config => {
    const v = makeVault(t, { config });
    const found = [];
    (await v.import('lib/lint.mjs')).lintConfig((level, file, msg) => found.push([level, file, msg]));
    return found.map(([level, file, msg]) => (level === 'error' && file === 'vault.config.json' ? msg : `${level} ${file} ${msg}`));
  };
  const ns = { 'demo-tree': { separator: '.', escape: '\\' } };
  assert.deepEqual(await lintOf({}), []);
  assert.deepEqual(await lintOf({ namespaces: ns, editTools: { mcp__demo__set_property: { namespace: 'demo-tree', path: 'tool_input.path', after: 'tool_input.value' } } }), []);
  assert.deepEqual(await lintOf({ namespaces: 'x' }), ['namespaces must be an object of { separator, escape } by namespace name']);
  assert.deepEqual(await lintOf({ namespaces: { Tree: { separator: '.', escape: '\\' }, file: { separator: '/', escape: '\\' } } }), [
    'namespaces.Tree: a namespace name is lowercase-kebab-case',
    'namespaces.file: file is the namespace of bare globs; pick another name',
  ]);
  assert.deepEqual(await lintOf({ namespaces: { 'demo-tree': { separator: '', escape: '\\\\' } } }), [
    'namespaces.demo-tree.separator must be a non-empty string',
    'namespaces.demo-tree.escape must be one character',
  ]);
  assert.deepEqual(await lintOf({ namespaces: { 'demo-tree': 'x' } }), ['namespaces.demo-tree must be an object with separator and escape']);
  assert.deepEqual(await lintOf({ editTools: [] }), ['editTools must be an object of { namespace, path, after } by tool name']);
  assert.deepEqual(await lintOf({ namespaces: ns, editTools: { 'bad tool': { namespace: 'demo-tree', path: 'tool_input.path' }, mcp__a__b: { namespace: 'nope', path: 'path', after: 'tool_input.' } } }), [
    'editTools.bad tool: a tool name has no spaces',
    "editTools.mcp__a__b.namespace names nope, which namespaces doesn't declare",
    'editTools.mcp__a__b.path must be tool_input.<field>',
    'editTools.mcp__a__b.after must be tool_input.<field>',
  ]);
  assert.deepEqual(await lintOf({ editTools: { mcp__a__b: 'x' } }), ['editTools.mcp__a__b must be an object with namespace, path and after']);
});
