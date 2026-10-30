import test from 'node:test';
import assert from 'node:assert/strict';
import { makeVault, ruleNote, pageNote as page, sourcePage, sessionId, prompt, lintFound } from './fixture.mjs';

const context = out => out?.hookSpecificOutput?.additionalContext ?? null;
const pathOf = (v, rel) => v.at(...rel.split('/')).replace(/\\/g, '/');

const proposal = (o = {}) => ({
  domain: 'demo', slug: 'new-rule', topic: 'code', basis: 'reading', reading: 'The user rewrote the screen twice.',
  do: 'Zebra quartz mango.', not: 'Plover lantern ember.', applies_to: ['src/new/**'], ...o,
});

test('propose writes a new rule into its domain\'s rules folder', t => {
  const v = makeVault(t);
  const sid = sessionId();
  v.startSession(sid);
  const r = v.propose(sid, proposal());
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^Wrote wiki\/demo\/rules\/new-rule\.md\./);
  assert.ok(r.stdout.includes(`edit or delete ${pathOf(v, 'wiki/demo/rules/new-rule.md')}`));
  assert.ok(v.exists('wiki/demo/rules/new-rule.md'));
  assert.equal(v.exists('wiki/demo/new-rule.md'), false);
});

test('propose refuses a slug a note in any folder of the domain has', t => {
  const v = makeVault(t);
  const sid = sessionId();
  v.startSession(sid);
  v.write('wiki/demo/concepts/new-rule.md', page({ kind: 'concept' }));
  const r = v.propose(sid, proposal());
  assert.equal(r.code, 1);
  assert.match(r.stderr, /wiki\/demo\/concepts\/new-rule\.md already exists/);
});

test('a repeat adds its Evidence line to the rule in its folder', t => {
  const v = makeVault(t);
  const sid = sessionId();
  v.startSession(sid);
  v.write('wiki/demo/rules/old-rule.md', ruleNote({ applies_to: ['src/new/**'], doLine: 'Alpha bravo charlie.', notLine: 'Delta foxtrot golf.' }));
  const r = v.propose(sid, proposal({ repeats: 'demo/old-rule' }));
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^Added the Evidence line to wiki\/demo\/rules\/old-rule\.md\./);
  assert.match(v.read('wiki/demo/rules/old-rule.md'), /· agent's reading · session a1b2c3d4 · The user rewrote the screen twice\./);
});

test('notes in their kind folders are delivered, and the index and the hooks give their paths', t => {
  const v = makeVault(t);
  const sid = sessionId();
  v.write('wiki/demo/rules/strict.md', ruleNote({ keywords: ['strict'] }));
  v.write('wiki/demo/concepts/luau-types.md', page({ kind: 'concept', keywords: ['checker'] }));
  v.write('wiki/demo/topics/code.md', page({
    kind: 'topic', body: ['See [[wiki/demo/concepts/luau-types|luau-types]].', '', '## Rules', '- [[wiki/demo/rules/strict|strict]]'],
  }));
  v.startSession(sid);
  const out = context(prompt(v, sid, 'make it strict for the checker'));
  assert.match(out, /- demo\/strict: Do: Do the thing\. Not: Skip the thing\./);
  assert.ok(out.includes(`- demo/luau-types (concept page): What we know. ${pathOf(v, 'wiki/demo/concepts/luau-types.md')}`), out);
  assert.equal(v.run('build.mjs').code, 0);
  const index = v.read('index.md');
  assert.match(index, /^- \[\[wiki\/demo\/topics\/code\|code\]\] · topic page/m);
  assert.match(index, /^- \[\[wiki\/demo\/concepts\/luau-types\|luau-types\]\] · concept page/m);
  assert.match(index, /^- \[\[wiki\/demo\/rules\/strict\|strict\]\] · Do: Do the thing\. · from \[\[wiki\/demo\/topics\/code\|code\]\]$/m);
});

test('a note outside its kind folder is delivered as its frontmatter says, and lint names the folder it goes in', async t => {
  const v = makeVault(t);
  const sid = sessionId();
  v.write('wiki/demo/concepts/strict.md', ruleNote({ keywords: ['strict'] }));
  v.write('wiki/demo/source-shop.md', sourcePage({ source: 'https://example.com/shop' }));
  v.write('wiki/demo/rules/roblox.md', page({ kind: 'entity' }));
  v.write('wiki/demo/topics/code.md', page({ kind: 'topic', body: ['[[wiki/demo/source-shop|source-shop]] [[wiki/demo/rules/roblox|roblox]]', '', '## Rules'] }));
  assert.match(context(prompt(v, sid, 'strict please')), /- demo\/strict: Do: Do the thing\./);
  const found = await lintFound(v, /goes in/);
  assert.deepEqual(found.map(f => [f.level, f.file, f.msg]).sort(), [
    ['warn', 'wiki/demo/concepts/strict.md', 'a rule goes in wiki/demo/rules/'],
    ['warn', 'wiki/demo/rules/roblox.md', 'an entity page goes in wiki/demo/entities/'],
    ['warn', 'wiki/demo/source-shop.md', 'a source page goes in wiki/demo/sources/'],
  ]);
});

test('two notes with one name in a domain are both errors, and neither is delivered', async t => {
  const v = makeVault(t);
  const sid = sessionId();
  v.write('wiki/demo/rules/strict.md', ruleNote({ keywords: ['strict'] }));
  v.write('wiki/demo/strict.md', ruleNote({ keywords: ['strict'], doLine: 'Do the other thing.' }));
  assert.equal(prompt(v, sid, 'strict please'), null);
  const found = await lintFound(v, /has this note's name/);
  assert.deepEqual(found.map(f => [f.level, f.file, f.msg]).sort(), [
    ['error', 'wiki/demo/rules/strict.md', "wiki/demo/strict.md has this note's name too. Rename one: each name is used once in a domain"],
    ['error', 'wiki/demo/strict.md', "wiki/demo/rules/strict.md has this note's name too. Rename one: each name is used once in a domain"],
  ]);
});

test('lint takes a link by its path from the vault root, its path from the note, or a name one note has, and gives the path for any other', async t => {
  const v = makeVault(t);
  v.write('wiki/demo/rules/strict.md', ruleNote({ keywords: ['x'] }));
  v.write('wiki/demo/concepts/luau-types.md', page({ kind: 'concept' }));
  v.write('wiki/global/concepts/luau-types.md', page({ kind: 'concept', domain: 'global' }));
  v.write('wiki/demo/topics/code.md', page({
    kind: 'topic',
    body: [
      '[[wiki/demo/rules/strict|strict]] [[strict]] [x](../rules/strict.md) [y](wiki/demo/rules/strict.md) [[wiki/demo/concepts/luau-types]] [[index]]',
      '[[demo/strict]] [[wiki/demo/strict|strict]] [[luau-types]] [[gone]]', '', '## Rules',
    ],
  }));
  v.run('build.mjs');
  const found = await lintFound(v, /^links/);
  assert.deepEqual(found.map(f => [f.file, f.msg]).sort(), [
    ['wiki/demo/topics/code.md', 'links [[demo/strict]], a note at wiki/demo/rules/strict.md. Link it by that path, as [[wiki/demo/rules/strict|strict]]'],
    ['wiki/demo/topics/code.md', 'links [[gone]], which has no note'],
    ['wiki/demo/topics/code.md', 'links [[luau-types]], which names more than one note. Write its path from the vault root: [[wiki/demo/concepts/luau-types]] or [[wiki/global/concepts/luau-types]]'],
    ['wiki/demo/topics/code.md', 'links [[wiki/demo/strict]], a note at wiki/demo/rules/strict.md. Link it by that path, as [[wiki/demo/rules/strict|strict]]'],
  ]);
});

test('superseded_by names a note in its folder by its link or its key', async t => {
  const v = makeVault(t);
  v.write('wiki/demo/rules/old.md', ruleNote({ keywords: ['x'], extra: ["superseded_by: '[[wiki/demo/rules/new|new]]'"] }));
  v.write('wiki/demo/rules/older.md', ruleNote({ keywords: ['x'], extra: ['superseded_by: demo/new'] }));
  v.write('wiki/demo/rules/new.md', ruleNote({ keywords: ['x'], doLine: 'Do the new thing.' }));
  assert.deepEqual(await lintFound(v, /superseded_by/), []);
  assert.equal(v.run('build.mjs').code, 0);
  assert.match(v.read('index.md'), /^- \[\[wiki\/demo\/rules\/old\|old\]\] · superseded by \[\[wiki\/demo\/rules\/new\|new\]\] · Do/m);
});

test('log takes a page by its path in its folder', t => {
  const v = makeVault(t);
  v.write('wiki/demo/concepts/luau-types.md', page({ kind: 'concept' }));
  const r = v.run('log.mjs', ['wiki/demo/concepts/luau-types.md']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(v.read('log.md'), /wrote page demo\/luau-types/);
});
