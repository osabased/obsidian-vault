import test from 'node:test';
import assert from 'node:assert/strict';
import { makeVault, ruleNote, pageNote as page } from './fixture.mjs';

const search = (v, ...args) => v.run('search.mjs', args);
// Each result starts with its rank and key, so the keys in order are the ranking.
const ranked = r => [...r.stdout.matchAll(/^\d+\. (\S+)/gm)].map(m => m[1]);

test('notes rank by where the words are: a name or keyword beats a passing mention in the body', t => {
  const v = makeVault(t);
  v.write('wiki/glim/concepts/fade-easing.md', page({ kind: 'concept', summary: "'How fades ease.'" }));
  v.write('wiki/glim/concepts/motion.md', page({ kind: 'concept', keywords: ['easing'], summary: "'Motion on screens.'" }));
  v.write('wiki/glim/concepts/layout-grid.md', page({ kind: 'concept', body: ['Cards sit on a grid. Easing is out of scope here.'] }));
  v.write('wiki/glim/concepts/colors.md', page({ kind: 'concept', body: ['Nothing on the subject.'] }));
  const r = search(v, 'easing');
  assert.equal(r.code, 0, r.stderr);
  const order = ranked(r);
  assert.deepEqual(order.slice(0, 2).sort(), ['glim/fade-easing', 'glim/motion']);
  assert.deepEqual(order.slice(2), ['glim/layout-grid']);
});

test("a rule's Do line counts less than its keywords", t => {
  const v = makeVault(t);
  v.write('wiki/glim/rules/alpha.md', ruleNote({ keywords: ['stripes'], doLine: 'Paint zebra.' }));
  v.write('wiki/glim/rules/beta.md', ruleNote({ keywords: ['zebra'], doLine: 'Paint stripes.' }));
  assert.deepEqual(ranked(search(v, 'zebra')), ['glim/beta', 'glim/alpha']);
});

test('a result gives its kind, topic, summary or Do line, path and the line that matched', t => {
  const v = makeVault(t);
  v.write('wiki/glim/concepts/lit-types.md', page({ kind: 'concept', summary: "'What the type checker does.'", body: ['Intro.', '', 'The checker runs in strict mode on save.'] }));
  v.write('wiki/glim/rules/strict.md', ruleNote({ keywords: ['strict'], doLine: 'Start files with a purpose line.' }));
  const r = search(v, 'strict');
  assert.equal(r.code, 0, r.stderr);
  const path = rel => v.at(...rel.split('/')).replace(/\\/g, '/');
  assert.equal(r.stdout, [
    '1. glim/strict · rule · topic code',
    '   Do: Start files with a purpose line.',
    `   ${path('wiki/glim/rules/strict.md')}`,
    '2. glim/lit-types · concept page · topic code',
    '   What the type checker does.',
    `   ${path('wiki/glim/concepts/lit-types.md')}`,
    '   > The checker runs in strict mode on save.',
    '',
  ].join('\n'));
});

test('words match across case, accents and plurals, and stopwords match nothing', t => {
  const v = makeVault(t);
  v.write('wiki/glim/concepts/cafe.md', page({ kind: 'concept', body: ['The Café menu has three entries.'] }));
  v.write('wiki/glim/concepts/buttons.md', page({ kind: 'concept', body: ['A button per entry.'] }));
  assert.deepEqual(ranked(search(v, 'CAFE')), ['glim/cafe']);
  assert.deepEqual(ranked(search(v, 'entry')).sort(), ['glim/buttons', 'glim/cafe']);
  assert.deepEqual(ranked(search(v, 'button')), ['glim/buttons']);
  const r = search(v, 'the');
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'No notes match "the".\n');
});

test('--domain, --kind and --topic narrow the results', t => {
  const v = makeVault(t, { domains: { other: { title: 'Other', vaultOnly: true, topics: [] } } });
  v.write('wiki/glim/rules/pad.md', ruleNote({ keywords: ['padding'], topic: 'layout' }));
  v.write('wiki/glim/rules/pad-fact.md', ruleNote({ kind: 'knowledge', basis: 'stated', applies_to: ['src/**'], extra: ['as_of: 2026-10-01'], topic: 'layout', doLine: 'Padding is in pixels.' }));
  v.write('wiki/glim/concepts/padding.md', page({ kind: 'concept', topic: 'code' }));
  v.write('wiki/other/concepts/padding-scale.md', page({ kind: 'concept', domain: 'other', topic: 'layout' }));
  assert.deepEqual(ranked(search(v, 'padding', '--domain', 'other')), ['other/padding-scale']);
  assert.deepEqual(ranked(search(v, 'padding', '--kind', 'rule')).sort(), ['glim/pad', 'glim/pad-fact']);
  assert.deepEqual(ranked(search(v, 'padding', '--kind', 'knowledge')), ['glim/pad-fact']);
  assert.deepEqual(ranked(search(v, 'padding', '--kind', 'concept', '--topic', 'Layout')), ['other/padding-scale']);
  assert.match(search(v, 'padding', '--kind', 'knowledge').stdout, /^1\. glim\/pad-fact · knowledge rule · topic layout$/m);
});

test('superseded rules are left out, and a note the hooks skip says why', t => {
  const v = makeVault(t);
  v.write('wiki/glim/rules/old.md', ruleNote({ keywords: ['zebra'], extra: ['superseded_by: glim/new'] }));
  v.write('wiki/glim/rules/new.md', ruleNote({ keywords: ['zebra'] }));
  v.write('wiki/glim/rules/broken.md', ruleNote({ keywords: ['zebra'], notLine: '' }));
  const r = search(v, 'zebra');
  assert.deepEqual(ranked(r).sort(), ['glim/broken', 'glim/new']);
  assert.match(r.stdout, /^\d\. glim\/broken · rule · topic code · not delivered: no \*\*Not:\*\* line$/m);
});

test('--raw also searches the text under raw/refs/, and the filters leave it out', t => {
  const v = makeVault(t);
  v.write('raw/refs/shop-article.md', ['---', 'url: https://example.com/shop', 'fetched: 2026-10-01', '---', '', 'Shop screens need a featured shelf.', ''].join('\n'));
  v.write('raw/refs/shot.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0x73, 0x68, 0x65, 0x6c, 0x66]));
  v.write('wiki/glim/concepts/shop.md', page({ kind: 'concept', body: ['The shop.'] }));
  assert.deepEqual(ranked(search(v, 'shelf')), []);
  const r = search(v, 'shelf', '--raw');
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^1\. raw\/refs\/shop-article\.md · raw file\n {3}.*\/raw\/refs\/shop-article\.md\n {3}> Shop screens need a featured shelf\.$/m);
  assert.deepEqual(ranked(r), ['raw/refs/shop-article.md']);
  assert.deepEqual(ranked(search(v, 'shop', '--raw', '--kind', 'concept')), ['glim/shop']);
});

test('--limit caps the results and says how many more matched', t => {
  const v = makeVault(t);
  for (const s of ['aa', 'bb', 'cc']) v.write(`wiki/glim/concepts/${s}.md`, page({ kind: 'concept', body: ['Gizmo.'] }));
  const r = search(v, 'gizmo', '--limit', '2');
  assert.equal(ranked(r).length, 2);
  assert.match(r.stdout, /^1 more matched\. Raise --limit to see it\.$/m);
});

test('a bad call prints the usage and exits 2, and --help lists the filters', t => {
  const v = makeVault(t);
  for (const args of [[], ['  '], ['x', '--limit', '0'], ['x', '--limit', 'two'], ['x', '--kind', 'rules'], ['x', '--colour']]) {
    const r = search(v, ...args);
    assert.equal(r.code, 2, args.join(' '));
    assert.match(r.stderr, /^usage: node tools\/search\.mjs "<words>"/);
  }
  const h = search(v, '--help');
  assert.equal(h.code, 0);
  assert.match(h.stdout, /keywords/);
  assert.match(h.stdout, /--raw/);
});
