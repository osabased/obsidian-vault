import test from 'node:test';
import assert from 'node:assert/strict';
import { makeVault, ruleNote, pageNote, denied, sessionId, editFile } from './fixture.mjs';

const vault = async (t, opts) => {
  const v = makeVault(t, opts);
  return { v, rules: await v.import('lib/rules.mjs') };
};
const check = (rules, text, rel = 'wiki/glim/some-rule.md') => rules.noteErrors(rules.parseNote(text, rel));
const without = (text, re) => text.split('\n').filter(l => !re.test(l)).join('\n');

test('valid taste rule parses and has no errors', async t => {
  const { rules } = await vault(t);
  const n = rules.parseNote(ruleNote({ applies_to: ['src/**/*.zq'], keywords: ['strict'], because: 'Fewer bugs.' }), 'wiki/glim/some-rule.md');
  assert.equal(n.key, 'glim/some-rule');
  assert.equal(n.domain, 'glim');
  assert.equal(n.slug, 'some-rule');
  assert.equal(n.depth, 2);
  assert.equal(n.kind, 'taste');
  assert.equal(n.topic, 'code');
  assert.equal(n.do, 'Do the thing.');
  assert.equal(n.not, 'Skip the thing.');
  assert.equal(n.because, 'Fewer bugs.');
  assert.deepEqual(n.applies_to, ['src/**/*.zq']);
  assert.deepEqual(n.keywords, ['strict']);
  assert.deepEqual(n.triggers, []);
  assert.equal(n.always, false);
  assert.equal(n.superseded_by, null);
  assert.deepEqual(rules.noteErrors(n), []);
});

test('kind defaults to taste and a topic is lowercased', async t => {
  const { rules } = await vault(t);
  const n = rules.parseNote(ruleNote({ topic: 'Layout' }).replace('kind: taste\n', ''), 'wiki/glim/some-rule.md');
  assert.equal(n.kind, 'taste');
  assert.equal(n.topic, 'layout');
});

test('note without frontmatter is not ok', async t => {
  const { rules } = await vault(t);
  assert.deepEqual(check(rules, '**Do:** a\n**Not:** b\n'), ['no frontmatter']);
});

test('missing Do and Not lines are errors', async t => {
  const { rules } = await vault(t);
  const base = ruleNote({ keywords: ['x'] });
  assert.deepEqual(check(rules, without(base, /^\*\*Do:\*\*/)), ['no **Do:** line']);
  assert.deepEqual(check(rules, without(base, /^\*\*Not:\*\*/)), ['no **Not:** line']);
});

test('basis must fit the kind', async t => {
  const { rules } = await vault(t);
  assert.deepEqual(check(rules, ruleNote({ basis: 'failure', keywords: ['x'] })), ['basis failure is for knowledge rules; set kind: knowledge']);
  assert.deepEqual(check(rules, ruleNote({ basis: 'bogus', keywords: ['x'] })), ['basis must be stated, inferred, pick or reading']);
  const k = ruleNote({ kind: 'knowledge', basis: 'reading', applies_to: ['a/**'], extra: ['as_of: 2026-10-01'] });
  assert.deepEqual(check(rules, k), ["a knowledge rule's basis must be stated, failure or source"]);
});

test('knowledge rule needs as_of and a channel, and takes keywords or always', async t => {
  const { rules } = await vault(t);
  const ok = ruleNote({ kind: 'knowledge', basis: 'source', applies_to: ['a/**'], extra: ['as_of: 2026-10-01'] });
  assert.deepEqual(check(rules, ok), []);
  const n = rules.parseNote(ok, 'wiki/glim/some-rule.md');
  assert.equal(n.kind, 'knowledge');
  assert.equal(n.as_of, '2026-10-01');
  assert.match(rules.ruleText(n), /As of 2026-10-01\.$/);

  assert.match(check(rules, ruleNote({ kind: 'knowledge', basis: 'source', applies_to: ['a/**'] }))[0], /needs as_of/);
  assert.match(check(rules, ruleNote({ kind: 'knowledge', basis: 'source', applies_to: ['a/**'], extra: ['as_of: 2999-01-01'] }))[0], /in the future/);
  assert.deepEqual(check(rules, ruleNote({ kind: 'knowledge', basis: 'source', extra: ['as_of: 2026-10-01'] })), ['a rule needs keywords, applies_to, tools or always: true, or nothing brings it up']);
  const both = ruleNote({ kind: 'knowledge', basis: 'source', applies_to: ['a/**'], keywords: ['k'], extra: ['as_of: 2026-10-01'] });
  assert.deepEqual(check(rules, both), []);
  const always = ruleNote({ kind: 'knowledge', basis: 'source', always: true, extra: ['as_of: 2026-10-01'] });
  assert.deepEqual(check(rules, always), []);
});

test('as_of on a taste rule is an error', async t => {
  const { rules } = await vault(t);
  assert.deepEqual(check(rules, ruleNote({ keywords: ['x'], extra: ['as_of: 2026-10-01'] })), ['as_of is only for knowledge rules; taste rules never expire']);
});

test('bad kind, glob and trigger regex are errors', async t => {
  const { rules } = await vault(t);
  assert.deepEqual(check(rules, ruleNote({ kind: 'weird', keywords: ['x'] })), ['kind must be taste, practice or knowledge']);
  assert.deepEqual(check(rules, ruleNote({ applies_to: ['a/{b'] })), ['bad glob in applies_to: a/{b']);
  assert.deepEqual(check(rules, ruleNote({ keywords: ['x'] }).replace('triggers: []', "triggers:\n  - '('")), ['bad regex in triggers: (']);
});

test('names, type and domain are checked', async t => {
  const { rules } = await vault(t);
  const base = ruleNote({ keywords: ['x'] });
  assert.deepEqual(check(rules, base, 'wiki/glim/Some_Rule.md'), ['file and folder names must be lowercase-kebab-case']);
  assert.deepEqual(check(rules, base, 'wiki/glim/Ünicode-regel.md'), ['file and folder names must be lowercase-kebab-case']);
  assert.deepEqual(check(rules, base, 'wiki/glim/café-règle.md'), []);
  assert.deepEqual(check(rules, base, 'wiki/glim/ボタン-2.md'), []);
  assert.deepEqual(check(rules, base, 'wiki/glim/कार्य.md'), []);
  assert.deepEqual(check(rules, base, 'wiki/glim/café--règle.md'), ['file and folder names must be lowercase-kebab-case']);
  const decomposed = rules.parseNote(base, 'wiki/glim/café-règle.md');
  assert.equal(decomposed.key, 'glim/café-règle');
  assert.deepEqual(rules.noteErrors(decomposed), []);
  assert.equal(rules.toKey('wiki/glim/café.md'), 'glim/café');
  assert.ok(rules.KEY_RE.test('démo/ボタン'));
  assert.deepEqual(check(rules, base, 'wiki/other/some-rule.md'), ['domain is glim but the note is in wiki/other/']);
  assert.deepEqual(check(rules, base.replace('type: rule', 'type: wat')), ['type must be rule or page']);
  assert.ok(check(rules, without(base, /^domain:/)).includes('no domain'));
});

test('superseded_by resolves to a key', async t => {
  const { rules } = await vault(t);
  const n = rules.parseNote(ruleNote({ keywords: ['x'], extra: ["superseded_by: '[[wiki/glim/new-one|new-one]]'"] }), 'wiki/glim/some-rule.md');
  assert.equal(n.superseded_by, 'glim/new-one');
  assert.deepEqual(rules.noteErrors(n), []);
  assert.equal(rules.parseNote(ruleNote({ extra: ['superseded_by: glim/Other.md'] }), 'wiki/glim/a.md').superseded_by, 'glim/other');
});

test('superseded notes are not live rules', async t => {
  const { v, rules } = await vault(t);
  v.write('wiki/glim/old.md', ruleNote({ keywords: ['x'], extra: ['superseded_by: glim/new'] }));
  v.write('wiki/glim/new.md', ruleNote({ keywords: ['y'] }));
  assert.deepEqual(Object.keys(rules.liveRules()), ['glim/new']);
});

test('page note parses without rule checks', async t => {
  const { rules } = await vault(t);
  const page = pageNote({ body: ['## Rules'] });
  const n = rules.parseNote(page, 'wiki/glim/code.md');
  assert.equal(n.type, 'page');
  assert.equal(n.summary, 'What we know.');
  assert.equal(n.do, '');
  assert.deepEqual(rules.noteErrors(n), []);
  assert.equal(rules.isTopicPage(n), true);
  assert.equal(rules.isTopicPage(rules.parseNote(page.replace('kind: topic', 'kind: source\nsource: raw/refs/x.png'), 'wiki/glim/source-x.md')), false);
  assert.deepEqual(check(rules, page.replace('domain: glim\n', '')), ['no domain']);
});

test('pages are not live rules', async t => {
  const { v, rules } = await vault(t);
  v.write('wiki/glim/code.md', pageNote({ body: ['## Rules'] }));
  assert.deepEqual(rules.liveRules(), {});
});

test('settledNotes leaves out a note saved within settleSeconds', async t => {
  const { v, rules } = await vault(t);
  v.write('wiki/glim/old.md', ruleNote({ keywords: ['x'] }));
  v.write('wiki/glim/fresh.md', ruleNote({ keywords: ['y'] }), { settled: false });
  assert.deepEqual(rules.settledNotes().map(n => n.key), ['glim/old']);
  assert.deepEqual(Object.keys(rules.settledRules()), ['glim/old']);
  assert.deepEqual(Object.keys(rules.liveRules()), ['glim/fresh', 'glim/old']);
});

test('settleSeconds in the config changes the window', async t => {
  const long = await vault(t, { config: { delivery: { settleSeconds: 7200 } } });
  long.v.write('wiki/glim/hour-old.md', ruleNote({ keywords: ['x'] }));
  assert.deepEqual(long.rules.settledNotes(), []);

  const zero = await vault(t, { config: { delivery: { settleSeconds: 0 } } });
  zero.v.write('wiki/glim/fresh.md', ruleNote({ keywords: ['x'] }), { settled: false });
  assert.deepEqual(zero.rules.settledNotes().map(n => n.key), ['glim/fresh']);
});

test('a folded summary reads as its text, or lint refuses it', async t => {
  const { rules } = await vault(t);
  const n = rules.parseNote(pageNote({ summary: '>-\n  Shop screens the user liked\n  and why.' }), 'wiki/glim/shop.md');
  assert.ok(n.summary === 'Shop screens the user liked and why.' || rules.noteErrors(n).some(e => /summary/.test(e)),
    `summary reads as ${JSON.stringify(n.summary)} and lint finds no error in it`);
});

test('a list item that reads as key: value is an error naming the field and the item, and the reader never sees it as text', async t => {
  const { rules } = await vault(t);
  const hint = item => `reads as a key and value, not text. Single-quote an item that holds ": ", as in '${item}'`;
  const narrow = ruleNote({ applies_to: ['**/*.zq'] }).replace('triggers: []', 'triggers:\n  - Glow: 1[0-9]');
  const n = rules.parseNote(narrow, 'wiki/glim/narrow.md');
  assert.deepEqual(n.triggers, []);
  assert.deepEqual(rules.noteErrors(n), [`triggers item Glow: 1[0-9] ${hint('Glow: 1[0-9]')}`]);
  const keyed = ruleNote({ keywords: ['x'] }).replace('keywords:', 'keywords:\n  - shop: tabs');
  assert.deepEqual(check(rules, keyed), [`keywords item shop: tabs ${hint('shop: tabs')}`]);
  assert.deepEqual(check(rules, ruleNote({ keywords: ['x'], extra: ['superseded_by:', '  - glim: new-one'] })), [`superseded_by item glim: new-one ${hint('glim: new-one')}`]);
  assert.deepEqual(check(rules, ruleNote({ keywords: ['x'], extra: ['tools:', '  - true'] })), ["tools item true isn't text. Single-quote it, as in 'true'"]);
  const pageText = pageNote({ kind: 'concept', extra: ['applies_to:', '  - src: ui'] });
  assert.deepEqual(check(rules, pageText, 'wiki/glim/some-page.md'), [`applies_to item src: ui ${hint('src: ui')}`]);
  assert.deepEqual(check(rules, ruleNote({ applies_to: ['**/*.zq'] }).replace('triggers: []', "triggers:\n  - 'Glow: 1[0-9]'")), []);
});

test('an edit is not gated by a rule whose trigger item reads as key: value', t => {
  const v = makeVault(t);
  v.write('wiki/glim/narrow.md', ruleNote({ applies_to: ['**/*.zq'] }).replace('triggers: []', 'triggers:\n  - Glow: 1[0-9]'));
  assert.equal(denied(editFile(v, sessionId(), 'src/a.zq', { tool: 'Write', text: 'set x to 1' })), null);
});

test('slugs and domains take modifier letters, as in サーバー, 人々 and ʻokina', async t => {
  const { rules } = await vault(t);
  const base = ruleNote({ keywords: ['x'] });
  for (const slug of ['サーバー', '人々', 'ʻokina']) {
    assert.deepEqual(check(rules, base, `wiki/glim/${slug}.md`), [], slug);
    assert.ok(rules.KEY_RE.test(`glim/${slug}`), slug);
    assert.ok(rules.KEBAB.test(slug), slug);
  }
});

test('the linear regex engine works on the installed Node after the flag is set', async t => {
  const { rules } = await vault(t);
  assert.ok(rules.tryRegex('a.*b')?.test('a--b'));
  assert.equal(rules.tryRegex('a(?=b)'), null);
  assert.equal(rules.tryRegex('(?<=a)b')?.test('ab'), true);
  assert.match(rules.regexError('a{1000}'), /linear time/);
  assert.match(rules.regexError('('), /^bad regex in triggers: \($/);
});

const knowledgeRule = (checked, { domain = 'glim', extra = [] } = {}) => ruleNote({
  domain, kind: 'knowledge', basis: 'source', keywords: ['react'],
  extra: ['as_of: 2026-10-01', 'package: { ecosystem: npm, name: react }', `checked_with: '${checked}'`, ...extra],
  evidence: ['- 2026-10-01 · source · session 1a2b3c4d · https://example.com/react · dated 2026-10-01 · "react"'],
});

test('checked_with must be a version its ecosystem compares: whole semver where its reader reads semver', async t => {
  const { v, rules } = await vault(t, { domains: { glim: { readers: ['plain'] } } });
  v.write('tools/ext/readers/plain.mjs', [
    "export const ecosystem = 'npm';", "export const lockfiles = ['plain.lock'];", "export const scheme = 'SEMVER';", 'export const read = () => ({});', '',
  ].join('\n'));
  for (const bad of ['18', 'v18.2.0', '^18.2.0']) {
    assert.ok(check(rules, knowledgeRule(bad)).some(e => e.startsWith(`checked_with must be a whole semver version, in quotes, such as '1.4.0', since npm versions are semver: ${bad}`)), bad);
  }
  assert.deepEqual(check(rules, knowledgeRule('18.2.0')), []);
});

test('checked_with is not checked where no reader reads its ecosystem, since nothing compares it there', async t => {
  const { rules } = await vault(t);
  for (const any of ['2024.1', 'v18.2.0']) assert.deepEqual(check(rules, knowledgeRule(any)), [], any);
});

test("checked_with on an ECOSYSTEM reader's ecosystem is checked by that reader's compare", async t => {
  const { v, rules } = await vault(t, { domains: { glim: { readers: ['dated'] } } });
  v.write('tools/ext/readers/dated.mjs', [
    "export const ecosystem = 'npm';", "export const lockfiles = ['dated.lock'];", "export const scheme = 'ECOSYSTEM';", 'export const read = () => ({});',
    "export const compare = (a, b) => { if (!/^[0-9]{4}-[0-9]{2}$/.test(a) || !/^[0-9]{4}-[0-9]{2}$/.test(b)) throw new Error('not a month'); return a < b ? -1 : a > b ? 1 : 0; };", '',
  ].join('\n'));
  assert.deepEqual(check(rules, knowledgeRule('2026-10')), [], 'not semver, but the reader compares it');
  assert.deepEqual(check(rules, knowledgeRule('18.2.0')), ["checked_with 18.2.0 isn't a version the npm reader can compare"]);
});

test('an empty requires list leaves checked_with to decide the fit', async t => {
  const { rules } = await vault(t);
  const movedOn = (a, b) => Number(b.split('.')[0]) > Number(a.split('.')[0]);
  const versions = new Map([['glim', [new Map([['npm', { versions: { react: '19.0.0' }, compare: null, movedOn }]])]]]);
  const pkg = { ecosystem: 'npm', name: 'react' };
  assert.equal(rules.noteFit({ kind: 'knowledge', requires: [], package: pkg, checked_with: '18.2.0', domain: 'glim' }, () => versions)?.fit, 'mismatch');
  assert.equal(rules.noteFit({ kind: 'knowledge', requires: null, package: pkg, checked_with: '18.2.0', domain: 'glim' }, () => versions)?.fit, 'mismatch');
});

test('a retired field that is not a day is an error, not a retirement', async t => {
  const { rules } = await vault(t);
  const n = rules.parseNote(ruleNote({ keywords: ['thing'], extra: ['retired: someday'] }), 'wiki/glim/some-rule.md');
  assert.equal(rules.isRetired(n), false);
  assert.equal(rules.undelivered(n), 'retired must be the day the rule was retired, as YYYY-MM-DD');
  assert.equal(rules.isRetired(rules.parseNote(ruleNote({ keywords: ['thing'], extra: ['retired: 2026-10-02'] }), 'wiki/glim/some-rule.md')), true);
});
