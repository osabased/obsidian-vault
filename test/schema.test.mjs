import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeVault, ruleNote, pageNote as page, sourcePage, userTurn, lintFound } from './fixture.mjs';

const SID = '9f8e7d6c-0000-4000-8000-000000000003';

const parsed = (rules, opts) => rules.parseNote(page(opts), 'wiki/glim/code.md');

// A vault-only domain reaches no project; the vault folder is where its pages are read.
const researchVault = t => makeVault(t, { domains: { reading: { title: 'Reading', vaultOnly: true, topics: ['solvers'] } } });

test('a page needs a kind from the list, and only a topic page is a topic page', async t => {
  const v = makeVault(t);
  const rules = await v.import('lib/rules.mjs');
  for (const kind of rules.PAGE_KINDS) {
    const n = parsed(rules, { kind, extra: kind === 'source' ? ['source: https://example.com/notes'] : [] });
    assert.deepEqual(rules.noteErrors(n), [], kind);
    assert.equal(rules.isTopicPage(n), kind === 'topic', kind);
  }
  v.write('wiki/glim/no-kind.md', page({ kind: null, topic: 'drafts' }));
  v.write('wiki/glim/rule-kind.md', page({ kind: 'taste' }));
  v.write('wiki/glim/listed-kind.md', page({ kind: null, extra: ['kind:', '  - concept'] }));
  const unkinded = 'a page needs kind: topic, concept, entity, synthesis or source';
  assert.deepEqual((await lintFound(v, /kind/)).map(f => [f.level, f.file, f.msg]), [
    ['warn', 'wiki/glim/no-kind.md', unkinded],
    ['warn', 'wiki/glim/rule-kind.md', unkinded],
  ]);
  assert.ok(rules.domainTopics().get('glim').includes('drafts'));
});

test('a global entry in vault.config.json is not a vault-only domain', async t => {
  const v = makeVault(t, { domains: { global: { title: 'Global', topics: ['code'] } } });
  v.write('wiki/global/some-rule.md', ruleNote({ domain: 'global', keywords: ['x'] }));
  assert.deepEqual((await lintFound(v, /./)).filter(f => f.level === 'error'), []);
  assert.deepEqual(Object.keys((await v.import('lib/rules.mjs')).liveRules()), ['global/some-rule']);
});

test('the index labels each page by its kind', async t => {
  const v = makeVault(t);
  v.write('wiki/glim/code.md', page({ kind: 'topic' }));
  v.write('wiki/glim/lit-types.md', page({ kind: 'concept' }));
  v.write('wiki/glim/source-changelog.md', sourcePage({ source: 'https://example.com/changelog' }));
  v.write('wiki/glim/rule-kind.md', page({ kind: 'taste' }));
  v.write('wiki/glim/elsewhere.md', page({ kind: 'concept', domain: 'other' }));
  const rules = await v.import('lib/rules.mjs');
  const index = rules.renderIndex(rules.loadNotes());
  assert.match(index, /\|code\]\] · topic page · /);
  assert.match(index, /\|lit-types\]\] · concept page · /);
  assert.match(index, /\|source-changelog\]\] · source page · /);
  assert.match(index, /\|rule-kind\]\] · page · /);
  assert.match(index, /\|elsewhere\]\] · concept page · no sources · not valid: domain is other but the note is in wiki\/glim\/ · /);
});

test('lint warns when a rule a page links changes after it, except on a source page', async t => {
  const v = makeVault(t);
  v.write('wiki/glim/some-rule.md', ruleNote({ keywords: ['x'] }));
  // Saved before the fixture's updated date, so each page's day stays 2026-10-01 whenever the test runs.
  const saved = new Date(2026, 8, 1);
  for (const [slug, kind] of [['code', 'topic'], ['lit-types', 'concept'], ['shop-answer', 'synthesis'], ['source-shop', 'source']]) {
    const extra = kind === 'source' ? ['source: https://example.com/shop'] : [];
    fs.utimesSync(v.write(`wiki/glim/${slug}.md`, page({ kind, extra, body: ['## Rules', '- [[wiki/glim/some-rule|some-rule]]'] })), saved, saved);
  }
  const stale = await lintFound(v, /after this page/);
  assert.deepEqual(stale.map(f => [f.level, f.file]), [['warn', 'wiki/glim/code.md'], ['warn', 'wiki/glim/lit-types.md'], ['warn', 'wiki/glim/shop-answer.md']]);
  assert.match(stale[0].msg, /^glim\/some-rule changed on \d{4}-\d\d-\d\d, after this page \(2026-10-01\)\. Check the page still matches it, then set updated$/);
});

test('lint warns on two topic pages on one topic, not on other pages sharing it', async t => {
  const v = makeVault(t);
  v.write('wiki/glim/code.md', page({ kind: 'topic' }));
  v.write('wiki/glim/lit-types.md', page({ kind: 'concept' }));
  v.write('wiki/glim/strict-mode.md', page({ kind: 'concept' }));
  assert.deepEqual(await lintFound(v, /another topic page/), []);
  v.write('wiki/glim/code-notes.md', page({ kind: 'topic' }));
  const twice = (await lintFound(v, /another topic page/)).map(f => f.file).sort();
  assert.deepEqual(twice, ['wiki/glim/code-notes.md', 'wiki/glim/code.md']);
});

test('lint warns on a source page with no source, and on no other page for it', async t => {
  const v = makeVault(t);
  v.write('wiki/glim/source-shop.md', page({ kind: 'source' }));
  v.write('wiki/glim/code.md', page({ kind: 'topic' }));
  const found = await lintFound(v, /^no source\./);
  assert.deepEqual(found.map(f => [f.level, f.file]), [['warn', 'wiki/glim/source-shop.md']]);
  assert.equal(found[0].msg, 'no source. A source page names the file under raw/ or the URL it is about');
});

test('a vault-only domain holds pages, and a rule there is an error', async t => {
  const v = researchVault(t);
  v.write('wiki/reading/solver-history.md', page({ domain: 'reading', topic: 'solvers', kind: 'concept' }));
  v.write('wiki/reading/use-new-solver.md', ruleNote({ domain: 'reading', topic: 'solvers', keywords: ['solver'] }));
  const found = await lintFound(v, /./);
  assert.deepEqual(found.filter(f => f.level === 'error').map(f => [f.file, f.msg]), [
    ['wiki/reading/use-new-solver.md', 'reading is vault-only, so it holds pages only. Put the rule in a domain that reaches projects, or in global'],
  ]);
  const rules = await v.import('lib/rules.mjs');
  assert.deepEqual(Object.keys(rules.liveRules()), []);
});

test('propose refuses a rule in a vault-only domain', t => {
  const v = researchVault(t);
  v.startSession(SID, { cwd: v.root, transcript: v.transcript(SID, [userTurn('always use the new solver')]) });
  const r = v.propose(SID, {
    domain: 'reading', slug: 'use-new-solver', topic: 'solvers', basis: 'stated', quote: 'always use the new solver',
    do: 'Use the new solver.', not: 'Use the old solver.', because: '', applies_to: [], keywords: ['solver'],
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /reading is vault-only/);
  assert.equal(v.exists('wiki/reading/use-new-solver.md'), false);
});

test('a session in the vault folder hears every domain\'s topics, and a project session only its own', t => {
  const v = researchVault(t);
  const context = cwd => v.startSession(SID, { cwd })?.hookSpecificOutput.additionalContext ?? '';
  assert.match(context(v.root), /touches layout, code or solvers,/);
  assert.match(context(v.project), /touches layout or code,/);
});

test('review status does not list a vault-only domain\'s topics as missing rules', t => {
  const v = researchVault(t);
  const out = v.run('review.mjs', ['status']).stdout;
  assert.match(out, /glim: layout, code/);
  assert.doesNotMatch(out, /reading: solvers/);
});
