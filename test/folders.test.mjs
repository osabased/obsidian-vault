import test from 'node:test';
import assert from 'node:assert/strict';
import { makeVault, ruleNote, pageNote as page, sourcePage, sessionId, prompt, lintFound } from './fixture.mjs';

const context = out => out?.hookSpecificOutput?.additionalContext ?? null;
const pathOf = (v, rel) => v.at(...rel.split('/')).replace(/\\/g, '/');

const proposal = (o = {}) => ({
  domain: 'glim', slug: 'new-rule', topic: 'code', basis: 'reading', reading: 'The user rewrote the screen twice.',
  do: 'Zebra quartz mango.', not: 'Plover lantern ember.', applies_to: ['src/new/**'], ...o,
});

test('propose writes a new rule into its domain\'s rules folder', t => {
  const v = makeVault(t);
  const sid = sessionId();
  v.startSession(sid);
  const r = v.propose(sid, proposal());
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^Wrote wiki\/glim\/rules\/new-rule\.md\./);
  assert.ok(r.stdout.includes(`edit or delete ${pathOf(v, 'wiki/glim/rules/new-rule.md')}`));
  assert.ok(v.exists('wiki/glim/rules/new-rule.md'));
  assert.equal(v.exists('wiki/glim/new-rule.md'), false);
});

test('propose refuses a slug a note in any folder of the domain has', t => {
  const v = makeVault(t);
  const sid = sessionId();
  v.startSession(sid);
  v.write('wiki/glim/concepts/new-rule.md', page({ kind: 'concept' }));
  const r = v.propose(sid, proposal());
  assert.equal(r.code, 1);
  assert.match(r.stderr, /wiki\/glim\/concepts\/new-rule\.md already exists/);
});

test('a repeat adds its Evidence line to the rule in its folder', t => {
  const v = makeVault(t);
  const sid = sessionId();
  v.startSession(sid);
  v.write('wiki/glim/rules/old-rule.md', ruleNote({ applies_to: ['src/new/**'], doLine: 'Alpha bravo charlie.', notLine: 'Delta foxtrot golf.' }));
  const r = v.propose(sid, proposal({ repeats: 'glim/old-rule' }));
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^Added the Evidence line to wiki\/glim\/rules\/old-rule\.md\./);
  assert.match(v.read('wiki/glim/rules/old-rule.md'), /· agent's reading · session a1b2c3d4 · The user rewrote the screen twice\./);
});

test('notes in their kind folders are delivered, and the index and the hooks give their paths', t => {
  const v = makeVault(t);
  const sid = sessionId();
  v.write('wiki/glim/rules/strict.md', ruleNote({ keywords: ['strict'] }));
  v.write('wiki/glim/concepts/luau-types.md', page({ kind: 'concept', keywords: ['checker'] }));
  v.write('wiki/glim/topics/code.md', page({
    kind: 'topic', body: ['See [[wiki/glim/concepts/luau-types|luau-types]].', '', '## Rules', '- [[wiki/glim/rules/strict|strict]]'],
  }));
  v.startSession(sid);
  const out = context(prompt(v, sid, 'make it strict for the checker'));
  assert.match(out, /- glim\/strict: Do: Do the thing\. Not: Skip the thing\./);
  assert.ok(out.includes(`- glim/luau-types (concept page): What we know. ${pathOf(v, 'wiki/glim/concepts/luau-types.md')}`), out);
  assert.equal(v.run('build.mjs').code, 0);
  const index = v.read('index.md');
  assert.match(index, /^- \[\[wiki\/glim\/topics\/code\|code\]\] · topic page/m);
  assert.match(index, /^- \[\[wiki\/glim\/concepts\/luau-types\|luau-types\]\] · concept page/m);
  assert.match(index, /^- \[\[wiki\/glim\/rules\/strict\|strict\]\] · Do: Do the thing\. · from \[\[wiki\/glim\/topics\/code\|code\]\]$/m);
});

test('a note outside its kind folder is delivered as its frontmatter says, and lint names the folder it goes in', async t => {
  const v = makeVault(t);
  const sid = sessionId();
  v.write('wiki/glim/concepts/strict.md', ruleNote({ keywords: ['strict'] }));
  v.write('wiki/glim/source-shop.md', sourcePage({ source: 'https://example.com/shop' }));
  v.write('wiki/glim/rules/roblox.md', page({ kind: 'entity' }));
  v.write('wiki/glim/topics/code.md', page({ kind: 'topic', body: ['[[wiki/glim/source-shop|source-shop]] [[wiki/glim/rules/roblox|roblox]]', '', '## Rules'] }));
  assert.match(context(prompt(v, sid, 'strict please')), /- glim\/strict: Do: Do the thing\./);
  const found = await lintFound(v, /goes in/);
  assert.deepEqual(found.map(f => [f.level, f.file, f.msg]).sort(), [
    ['warn', 'wiki/glim/concepts/strict.md', 'a rule goes in wiki/glim/rules/'],
    ['warn', 'wiki/glim/rules/roblox.md', 'an entity page goes in wiki/glim/entities/'],
    ['warn', 'wiki/glim/source-shop.md', 'a source page goes in wiki/glim/sources/'],
  ]);
});

test('two notes with one name in a domain are both errors, and neither is delivered', async t => {
  const v = makeVault(t);
  const sid = sessionId();
  v.write('wiki/glim/rules/strict.md', ruleNote({ keywords: ['strict'] }));
  v.write('wiki/glim/strict.md', ruleNote({ keywords: ['strict'], doLine: 'Do the other thing.' }));
  assert.equal(prompt(v, sid, 'strict please'), null);
  const found = await lintFound(v, /has this note's name/);
  assert.deepEqual(found.map(f => [f.level, f.file, f.msg]).sort(), [
    ['error', 'wiki/glim/rules/strict.md', "wiki/glim/strict.md has this note's name too. Rename one: each name is used once in a domain"],
    ['error', 'wiki/glim/strict.md', "wiki/glim/rules/strict.md has this note's name too. Rename one: each name is used once in a domain"],
  ]);
});

test('lint takes a link by its path from the vault root, its path from the note, or a name one note has, and gives the path for any other', async t => {
  const v = makeVault(t);
  v.write('wiki/glim/rules/strict.md', ruleNote({ keywords: ['x'] }));
  v.write('wiki/glim/concepts/luau-types.md', page({ kind: 'concept' }));
  v.write('wiki/global/concepts/luau-types.md', page({ kind: 'concept', domain: 'global' }));
  v.write('wiki/glim/topics/code.md', page({
    kind: 'topic',
    body: [
      '[[wiki/glim/rules/strict|strict]] [[strict]] [x](../rules/strict.md) [y](wiki/glim/rules/strict.md) [[wiki/glim/concepts/luau-types]] [[index]]',
      '[[glim/strict]] [[wiki/glim/strict|strict]] [[luau-types]] [[gone]]', '', '## Rules',
    ],
  }));
  v.run('build.mjs');
  const found = await lintFound(v, /^links/);
  assert.deepEqual(found.map(f => [f.file, f.msg]).sort(), [
    ['wiki/glim/topics/code.md', 'links [[glim/strict]], a note at wiki/glim/rules/strict.md. Link it by that path, as [[wiki/glim/rules/strict|strict]]'],
    ['wiki/glim/topics/code.md', 'links [[gone]], which has no note'],
    ['wiki/glim/topics/code.md', 'links [[luau-types]], which names more than one note. Write its path from the vault root: [[wiki/glim/concepts/luau-types]] or [[wiki/global/concepts/luau-types]]'],
    ['wiki/glim/topics/code.md', 'links [[wiki/glim/strict]], a note at wiki/glim/rules/strict.md. Link it by that path, as [[wiki/glim/rules/strict|strict]]'],
  ]);
});

test('superseded_by names a note in its folder by its link or its key', async t => {
  const v = makeVault(t);
  v.write('wiki/glim/rules/old.md', ruleNote({ keywords: ['x'], extra: ["superseded_by: '[[wiki/glim/rules/new|new]]'"] }));
  v.write('wiki/glim/rules/older.md', ruleNote({ keywords: ['x'], extra: ['superseded_by: glim/new'] }));
  v.write('wiki/glim/rules/new.md', ruleNote({ keywords: ['x'], doLine: 'Do the new thing.' }));
  assert.deepEqual(await lintFound(v, /superseded_by/), []);
  assert.equal(v.run('build.mjs').code, 0);
  assert.match(v.read('index.md'), /^- \[\[wiki\/glim\/rules\/old\|old\]\] · superseded by \[\[wiki\/glim\/rules\/new\|new\]\] · Do/m);
});

test('log takes a page by its path in its folder', t => {
  const v = makeVault(t);
  v.write('wiki/glim/concepts/luau-types.md', page({ kind: 'concept' }));
  const r = v.run('log.mjs', ['wiki/glim/concepts/luau-types.md']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(v.read('log.md'), /wrote page glim\/luau-types/);
});

test('propose refuses a trigger with a lookahead and names the linear-engine reason', t => {
  const v = makeVault(t);
  const sid = sessionId();
  v.startSession(sid);
  const r = v.propose(sid, proposal({ triggers: ['foo(?=bar)'] }));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /trigger foo\(\?=bar\) can't run in linear time/);
  assert.equal(v.exists('wiki/glim/rules/new-rule.md'), false);
});
