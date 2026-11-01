import test from 'node:test';
import assert from 'node:assert/strict';
import { parse, setField } from '../tools/lib/frontmatter.mjs';
import { makeVault, ruleNote, pageNote, sessionId, prompt, userTurn, lintFound, editFile } from './fixture.mjs';

const front = lines => `---\n${lines.join('\n')}\n---\nbody\n`;
const data = lines => parse(front(lines)).data;
const check = (rules, text, rel = 'wiki/glim/some-rule.md') => rules.noteErrors(rules.parseNote(text, rel));
const knowledge = ({ extra = [], ...o } = {}) => ruleNote({ kind: 'knowledge', basis: 'source', ...o, extra: ['as_of: 2026-10-01', ...extra] });

const REQUIRES_FLOW = [
  'requires:',
  '  - package: { ecosystem: glim-reader, name: widget-kit }',
  '    ranges:',
  '      - type: SEMVER',
  "        events: [{ introduced: '2.0.0' }, { fixed: '3.0.0' }]",
];
const REQUIRES_BLOCK = [
  'requires:',
  '- package:',
  '    ecosystem: glim-reader',
  "    name: '@glim/widget-kit'",
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
    'link: [[wiki/glim/other|other]]', 'items:', '  - [[wiki/glim/a]]', 'summary: >-', '  folded text', '  stays out',
  ]), {
    type: 'rule', topic: "it's", title: 'a\tb', n: '12', always: false, empty: null, tilde: null,
    applies_to: ['src/**', 'lib/*.ts'], keywords: ['one', 'two'], flat: ['x', 'y'],
    link: ['[wiki/glim/other|other]'], items: ['[[wiki/glim/a]]'], summary: 'folded text stays out',
  });
  assert.deepEqual(parse('﻿---\r\na: 1\r\nlist:\r\n  - b\r\n---\r\nbody').data, { a: '1', list: ['b'] });
  assert.deepEqual(data(['list:', '  -', 'next: 1']), { list: null, next: '1' });
});

test('frontmatter reads nested block and flow mappings as deep as requires goes', () => {
  assert.deepEqual(data(REQUIRES_FLOW).requires, [{
    package: { ecosystem: 'glim-reader', name: 'widget-kit' },
    ranges: [{ type: 'SEMVER', events: [{ introduced: '2.0.0' }, { fixed: '3.0.0' }] }],
  }]);
  assert.deepEqual(data([...REQUIRES_BLOCK, 'topic: code']), {
    requires: [{
      package: { ecosystem: 'glim-reader', name: '@glim/widget-kit' },
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
  assert.deepEqual(check(rules, ruleNote({ extra: ["tools: ['mcp__fixture__edit']"] })), []);
  const none = 'a rule needs keywords, applies_to, tools or always: true, or nothing brings it up';
  assert.deepEqual(check(rules, knowledge({})), [none]);
  assert.deepEqual(check(rules, ruleNote({})), [none]);
});

test("6.1b: a knowledge rule's keyword reaches a prompt and its always loads at session start", t => {
  const v = makeVault(t, { presets: ['almanac'] });
  v.write('wiki/almanac/rules/pkg-major.md', knowledge({ domain: 'almanac', topic: 'ledger', always: true, doLine: 'Check the pkg major version first.', notLine: 'Assume pkg 3.' }));
  const sid = sessionId();
  const cwd = v.projects.almanac;
  assert.match(v.startSession(sid, { cwd }).hookSpecificOutput.additionalContext, /almanac\/pkg-major: Do: Check the pkg major version first\./);
  assert.match(prompt(v, sid, 'how do I call openLedger?', { cwd }).hookSpecificOutput.additionalContext, /almanac\/ledger-v2: Do: Call openLedger with the path\./);
});

test('rule length caps follow the kind', async t => {
  const v = makeVault(t);
  const rules = await v.import('lib/rules.mjs');
  const long = 'Word '.repeat(90);
  const fact = rules.parseNote(knowledge({ keywords: ['w'], doLine: long }), 'wiki/glim/rules/fact.md');
  const taste = rules.parseNote(ruleNote({ keywords: ['w'], doLine: long }), 'wiki/glim/rules/taste.md');
  assert.equal(rules.maxChars('knowledge'), 600);
  assert.equal(rules.maxChars('taste'), 300);
  assert.equal(rules.ruleLine('k', { kind: 'knowledge', text: rules.ruleText(fact) }), `- k: ${rules.ruleText(fact)}`);
  const clipped = rules.ruleLine('k', { kind: 'taste', text: rules.ruleText(taste) });
  assert.ok(clipped.endsWith('…') && clipped.length <= '- k: '.length + 300, clipped);

  v.write('wiki/glim/rules/fact.md', knowledge({ keywords: ['w'], doLine: 'Word '.repeat(130) }));
  v.write('wiki/glim/rules/short-fact.md', knowledge({ keywords: ['w'], doLine: long }));
  v.write('wiki/glim/rules/always-fact.md', knowledge({ always: true, doLine: long }));
  const found = (await lintFound(v, /characters/)).map(f => [f.file, f.msg]);
  assert.deepEqual(found, [
    ['wiki/glim/rules/always-fact.md', `always: true loads this rule at every session start, and its Do, Not, Because and the as_of date come to ${rules.ruleText(rules.parseNote(knowledge({ always: true, doLine: long }), 'x/y.md')).length} characters, over the 300 a taste rule may have. Shorten it, or give it keywords instead`],
    ['wiki/glim/rules/fact.md', `Do, Not, Because and the as_of date come to ${rules.ruleText(rules.parseNote(knowledge({ keywords: ['w'], doLine: 'Word '.repeat(130) }), 'x/y.md')).length} characters; the hooks cut them at 600`],
  ]);
});

test('propose refuses a rule over its kind\'s cap and takes keywords on a knowledge rule', t => {
  const v = makeVault(t);
  const sid = sessionId();
  v.startSession(sid, { transcript: v.transcript(sid, [userTurn('kit 3 needs mount before render')]) });
  const fact = o => ({
    domain: 'glim', slug: 'kit-mount', topic: 'code', kind: 'knowledge', basis: 'stated', quote: 'kit 3 needs mount before render',
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
  const page = extra => check(rules, pageNote({ extra }), 'wiki/glim/code.md');
  assert.deepEqual(page(['tools:', '  - AskUserQuestion', '  - mcp__fixture__set_property']), []);
  assert.deepEqual(rules.parseNote(pageNote({ extra: ['tools: [AskUserQuestion]'] }), 'wiki/glim/code.md').tools, ['AskUserQuestion']);
  assert.deepEqual(page(['tools: AskUserQuestion']), ['tools must be a list']);
  assert.deepEqual(page(["tools: ['Ask User', '']"]), ['tools must name each tool exactly, with no spaces: Ask User', 'tools must name each tool exactly, with no spaces: (empty)']);
  assert.deepEqual(check(rules, ruleNote({ keywords: ['x'], extra: ['tools: [true]'] })), ["tools item true isn't text. Single-quote it, as in 'true'"]);
});

test('requires takes the OSV affected shape on knowledge rules and pages, not taste rules', async t => {
  const v = makeVault(t);
  const rules = await v.import('lib/rules.mjs');
  const page = lines => check(rules, pageNote({ extra: lines }), 'wiki/glim/code.md');
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
  const parsed = extra => rules.parseNote(pageNote({ extra }), 'wiki/glim/code.md');
  assert.equal(parsed([]).author, 'agent');
  assert.equal(parsed(['author: user']).author, 'user');
  assert.deepEqual(rules.noteErrors(parsed(['author: user'])), []);
  assert.deepEqual(rules.noteErrors(parsed(['author: me'])), ['author must be user or agent']);
  assert.deepEqual(check(rules, ruleNote({ keywords: ['x'], extra: ['author: agent'] })), ['author is only for pages']);
});

test("lint asks an author: user page for no topic or summary, and lint --fix leaves its file as it is", async t => {
  const v = makeVault(t);
  v.write('wiki/glim/other.md', pageNote({ kind: 'concept' }));
  const link = ['[[glim/other]]'];
  const mine = v.write('wiki/glim/journal.md', pageNote({ kind: 'concept', topic: "''", summary: "''", extra: ['author: user'], body: link }));
  v.write('wiki/glim/agent-page.md', pageNote({ kind: 'concept', topic: "''", summary: "''", body: link }));
  const found = (await lintFound(v, /^no (topic|summary)|^links/)).map(f => [f.file, f.msg.split('.')[0]]);
  assert.deepEqual(found.filter(([f]) => f === 'wiki/glim/journal.md').map(([, m]) => m), ['links [[glim/other]], a note at wiki/glim/other']);
  assert.equal(found.filter(([f]) => f === 'wiki/glim/agent-page.md').length, 3);
  const before = v.read('wiki/glim/journal.md');
  const { lint, fix } = await v.import('lib/lint.mjs');
  const { written } = fix(lint());
  assert.deepEqual(written, ['wiki/glim/agent-page.md']);
  assert.equal(v.read('wiki/glim/journal.md'), before, mine);
});

test('applies_to takes globs over a declared namespace, and file matching never sees them', async t => {
  const v = makeVault(t, { config: { namespaces: { 'glim-tree': { separator: '.', escape: '\\' } } } });
  const rules = await v.import('lib/rules.mjs');
  const errs = globs => check(rules, ruleNote({ applies_to: globs }));
  assert.deepEqual(errs(['glim-tree:Shop.**', '!glim-tree:Shop.Debug', 'src/**']), []);
  assert.deepEqual(errs(['other-tree:Shop.**']), ["applies_to names namespace other-tree, which vault.config.json doesn't declare under namespaces"]);
  assert.deepEqual(errs(['glim-tree:Shop.{a']), ['bad glob in applies_to: glim-tree:Shop.{a']);
  assert.deepEqual(errs(['glim-tree:Shop\\.\\{a']), []);
  v.write('wiki/glim/rules/both.md', ruleNote({ applies_to: ['src/**', '!src/gen/**', 'glim-tree:Shop.**', '!glim-tree:Shop.Debug'] }));
  v.write('wiki/glim/rules/tree-only.md', ruleNote({ topic: 'layout', applies_to: ['glim-tree:**'] }));
  v.write('wiki/glim/tree-page.md', pageNote({ applies_to: ['glim-tree:Shop.**', 'docs/**'] }));
  assert.deepEqual(rules.liveRules()['glim/both'].applies_to, ['src/**', '!src/gen/**', 'glim-tree:Shop.**', '!glim-tree:Shop.Debug']);
  assert.deepEqual(rules.livePages()['glim/tree-page'].applies_to, ['glim-tree:Shop.**', 'docs/**']);
  const sid = sessionId();
  const gated = rel => editFile(v, sid, rel)?.hookSpecificOutput?.permissionDecisionReason ?? '';
  const first = gated('src/a.zq');
  assert.match(first, /glim\/both/);
  assert.doesNotMatch(first, /glim\/tree-only/);
  assert.equal(gated('src/gen/b.zq'), '', 'the ! file entry still excludes');
});

test('a file glob is the file namespace, with or without file:, and a drive letter is no namespace', async t => {
  const v = makeVault(t, { config: { namespaces: { 'glim-tree': { separator: '.', escape: '\\' } } } });
  const rules = await v.import('lib/rules.mjs');
  const errs = globs => check(rules, ruleNote({ applies_to: globs }));
  assert.deepEqual(errs(['file:src/**']), []);
  assert.deepEqual(errs(['C:/x/**', 'c:/y']), []);
  v.write('wiki/glim/rules/prefixed.md', ruleNote({ applies_to: ['file:src/**', '!file:src/gen/**'] }));
  const sid = sessionId();
  assert.match(editFile(v, sid, 'src/a.zq')?.hookSpecificOutput?.permissionDecisionReason ?? '', /glim\/prefixed/);
  assert.equal(editFile(v, sid, 'src/gen/b.zq'), null);
});

test('lint reports an undeclared namespace and an exclusion that comes first', async t => {
  const v = makeVault(t, { config: { namespaces: { 'glim-tree': { separator: '.', escape: '\\' } } } });
  const rules = await v.import('lib/rules.mjs');
  const errs = globs => check(rules, ruleNote({ applies_to: globs }));
  assert.deepEqual(errs(['!src/gen/**', 'src/**']), ['exclusion in applies_to comes before any entry that adds files: !src/gen/**']);
  assert.deepEqual(errs(['src/**', '!glim-tree:Shop.Debug', 'glim-tree:Shop.**']), ['exclusion in applies_to comes before any entry that adds glim-tree targets: !glim-tree:Shop.Debug']);
  v.write('wiki/glim/rules/ghost.md', ruleNote({ applies_to: ['ghost-tree:A.**'] }));
  v.write('wiki/glim/rules/first.md', ruleNote({ topic: 'layout', applies_to: ['!src/gen/**', 'src/**'] }));
  const found = (await v.import('lib/lint.mjs')).lint().filter(f => f.level === 'error' && f.file.startsWith('wiki/glim/rules/')).map(f => [f.file, f.msg]);
  assert.deepEqual(found, [
    ['wiki/glim/rules/first.md', 'exclusion in applies_to comes before any entry that adds files: !src/gen/**'],
    ['wiki/glim/rules/ghost.md', "applies_to names namespace ghost-tree, which vault.config.json doesn't declare under namespaces"],
  ]);
});

test('lintConfig checks namespaces and editTools, naming the key', async t => {
  const lintOf = async config => {
    const v = makeVault(t, { config });
    const found = [];
    (await v.import('lib/lint.mjs')).lintConfig((level, file, msg) => found.push([level, file, msg]));
    return found.map(([level, file, msg]) => (level === 'error' && file === 'vault.config.json' ? msg : `${level} ${file} ${msg}`));
  };
  const ns = { 'glim-tree': { separator: '.', escape: '\\' } };
  assert.deepEqual(await lintOf({}), []);
  assert.deepEqual(await lintOf({ namespaces: ns, editTools: { mcp__fixture__set_property: { namespace: 'glim-tree', path: 'tool_input.path', after: 'tool_input.value' } } }), []);
  assert.deepEqual(await lintOf({ namespaces: 'x' }), ['namespaces must be an object of { separator, escape } by namespace name']);
  assert.deepEqual(await lintOf({ namespaces: { Tree: { separator: '.', escape: '\\' }, t: { separator: '.', escape: '\\' }, 'café': { separator: '.', escape: '\\' }, file: { separator: '/', escape: '\\' } } }), [
    'namespaces.Tree: a namespace name is two or more lowercase letters, digits, - or _, starting with a letter',
    'namespaces.t: a namespace name is two or more lowercase letters, digits, - or _, starting with a letter',
    'namespaces.café: a namespace name is two or more lowercase letters, digits, - or _, starting with a letter',
    'namespaces.file: file is the namespace of bare globs; pick another name',
  ]);
  assert.deepEqual(await lintOf({ namespaces: { glim_tree: { separator: '.', escape: '\\' } } }), []);
  assert.deepEqual(await lintOf({ namespaces: { 'glim-tree': { separator: '', escape: '\\\\' } } }), [
    'namespaces.glim-tree.separator must be a non-empty string',
    'namespaces.glim-tree.escape must be one character',
  ]);
  assert.deepEqual(await lintOf({ namespaces: { 'glim-tree': 'x' } }), ['namespaces.glim-tree must be an object with separator and escape']);
  assert.deepEqual(await lintOf({ editTools: [] }), ['editTools must be an object of { namespace, path, after } by tool name']);
  assert.deepEqual(await lintOf({ namespaces: ns, editTools: { 'bad tool': { namespace: 'glim-tree', path: 'tool_input.path' }, mcp__a__b: { namespace: 'nope', path: 'path', after: 'tool_input.' } } }), [
    'editTools.bad tool: a tool name has no spaces',
    "editTools.mcp__a__b.namespace names nope, which namespaces doesn't declare",
    'editTools.mcp__a__b.path must be tool_input.<field>',
    'editTools.mcp__a__b.after must be tool_input.<field>',
  ]);
  assert.deepEqual(await lintOf({ editTools: { mcp__a__b: 'x' } }), ['editTools.mcp__a__b must be an object with namespace, path and after']);
});

test("lintConfig refuses an editTools entry the edit hook never sees or reads itself, and an alias it can't load", async t => {
  const ns = { 'glim-tree': { separator: '.', escape: '\\' } };
  const lintOf = async (config, domains = {}) => {
    const v = makeVault(t, { config: { namespaces: ns, ...config }, domains });
    v.write('tools/ext/aliases/fixture.mjs', 'export function toFile() { return null; }\n');
    const found = [];
    (await v.import('lib/lint.mjs')).lintConfig((level, file, msg) => found.push(`${level} ${file} ${msg}`));
    return found;
  };
  const entry = { namespace: 'glim-tree', path: 'tool_input.path' };
  assert.deepEqual(await lintOf({ editTools: { Write: entry, set_property: entry } }), [
    'error vault.config.json editTools.Write: Write edits a file, which the edit hook reads from the call itself; take it out of editTools',
    "error vault.config.json editTools.set_property: the edit hook's matcher, Edit|Write|MultiEdit|NotebookEdit|AskUserQuestion|mcp__.*, never sends set_property to the hook, so it would never be gated",
  ]);
  const glim = aliases => ({ glim: { title: 'Glim', topics: ['code'], aliases } });
  assert.deepEqual(await lintOf({}, glim({ 'glim-tree': 'fixture' })), []);
  assert.deepEqual(await lintOf({}, glim('fixture')), ['error vault.config.json glim.aliases must be an object of alias extension names by namespace']);
  assert.deepEqual(await lintOf({}, glim({ file: 'fixture', 'glim-tree': 'missing', ghost: '../x' })), [
    "error vault.config.json glim.aliases.file: file isn't a namespace that vault.config.json declares under namespaces",
    "error vault.config.json glim.aliases.glim-tree names missing, and tools/ext/aliases/missing.mjs doesn't exist",
    "error vault.config.json glim.aliases.ghost: ghost isn't a namespace that vault.config.json declares under namespaces",
    'error vault.config.json glim.aliases.ghost must name an extension in lowercase letters, digits, - or _',
  ]);
});

test('setField writes a value that reads back exactly, replacing only the old value and keeping a trailing comment', () => {
  const cases = [
    ["source: 'raw\\refs\\Designer''s shop.png'", "raw/refs/Designer's shop.png", "source: 'raw/refs/Designer''s shop.png'"],
    ["source: 'raw\\refs\\Shop #2.png'", 'raw/refs/Shop #2.png', "source: 'raw/refs/Shop #2.png'"],
    ['source: raw\\refs\\a.png', 'raw/refs/a #1.png', "source: 'raw/refs/a #1.png'"],
    ['source: raw/a.png', 'raw/refs/a: b.png', "source: 'raw/refs/a: b.png'"],
    ['source: raw/a.png', "'quoted'", "source: '''quoted'''"],
    ['source: raw/a.png', 'true', "source: 'true'"],
    ['source: raw\\refs\\a.png # by hand', 'raw/refs/a.png', 'source: raw/refs/a.png # by hand'],
    ['source: raw/a#b.png\t# by hand', 'raw/c.png', 'source: raw/c.png\t# by hand'],
    ['source: raw/a.png # by hand', 'raw/refs/a #1.png', "source: 'raw/refs/a #1.png' # by hand"],
    ["source: 'raw\\refs\\Shop #2.png' # by hand", 'raw/refs/Shop #2.png', "source: 'raw/refs/Shop #2.png' # by hand"],
    ["source: 'it''s #2' # by hand", 'raw/c.png', "source: 'raw/c.png' # by hand"],
    ['source: "raw\\\\refs\\\\a \\" #b.png" # by hand', 'raw/refs/a.png', "source: 'raw/refs/a.png' # by hand"],
    ["source: 'raw/a.png'#tail", 'raw/c.png', "source: 'raw/c.png'"],
  ];
  for (const [line, val, want] of cases) {
    const out = setField(front([line, 'type: page']), 'source', val);
    assert.equal(out.split('\n')[1], want, line);
    assert.equal(parse(out).data.source, val, out);
    assert.equal(parse(out).data.type, 'page', out);
  }
});

test('lintConfig refuses an escape that is a glob character or is in the separator', async t => {
  const lintOf = async namespaces => {
    const v = makeVault(t, { config: { namespaces } });
    const found = [];
    (await v.import('lib/lint.mjs')).lintConfig((level, file, msg) => found.push(msg));
    return found;
  };
  for (const ch of ['*', '?', '[', ']', '{', '}', ',', '!']) {
    assert.deepEqual(await lintOf({ 'glim-tree': { separator: '.', escape: ch } }), [`namespaces.glim-tree.escape ${ch} is a glob character. Pick one that isn't * ? [ ] { } , or !`]);
  }
  assert.deepEqual(await lintOf({ 'glim-tree': { separator: '.', escape: '.' } }), ['namespaces.glim-tree.escape . is in the separator. Pick another character']);
  assert.deepEqual(await lintOf({ 'glim-tree': { separator: '::', escape: ':' } }), ['namespaces.glim-tree.escape : is in the separator. Pick another character']);
  assert.deepEqual(await lintOf({ 'glim-tree': { separator: '.', escape: '/' } }), []);
  assert.deepEqual(await lintOf({ 'glim-tree': { separator: '/', escape: '\\' } }), []);
});

test('a quote inside a plain flow item is text, so the list still splits at its commas', () => {
  assert.deepEqual(data(["keywords: [don't, x, y]"]).keywords, ["don't", 'x', 'y']);
  assert.deepEqual(data(['keywords: [say "hi, there", x]']).keywords, ['say "hi', 'there"', 'x']);
  assert.deepEqual(data(["keywords: ['a, b', c]"]).keywords, ['a, b', 'c']);
  assert.deepEqual(data(["k: {a: 'b, c', d: it's}"]).k, { a: 'b, c', d: "it's" });
  assert.deepEqual(data(["k: [x, {a: 'b, c'}]"]).k, ['x', { a: 'b, c' }]);
});

test('propose quotes a topic YAML would read as something other than text', t => {
  for (const topic of ['true', '2026']) {
    const v = makeVault(t, { topics: [topic] });
    const sid = sessionId();
    v.startSession(sid);
    const r = v.propose(sid, {
      domain: 'glim', slug: 'new-rule', topic, basis: 'reading', reading: 'The user rewrote the screen twice.',
      do: 'Zebra quartz mango.', not: 'Plover lantern ember.', applies_to: ['src/new/**'],
    });
    assert.equal(r.code, 0, `${topic}: ${r.stderr}`);
    assert.match(v.read('wiki/glim/rules/new-rule.md'), new RegExp(`^topic: '${topic}'$`, 'm'));
  }
});

test('a folded block scalar reads as its lines joined by spaces, a literal one by newlines, and setField leaves either alone', () => {
  const lines = ['a: >-', '  one', '  two', 'b: |', '  x', '  y', 'c: z'];
  assert.deepEqual(data(lines), { a: 'one two', b: 'x\ny', c: 'z' });
  const text = front(lines);
  assert.equal(setField(text, 'a', 'new'), text);
});

test('a literal block scalar keeps the indentation of its lines relative to the first', () => {
  assert.deepEqual(data(['a: |', '  if x:', '    y()', '  z', 'b: c']), { a: 'if x:\n  y()\nz', b: 'c' });
});
