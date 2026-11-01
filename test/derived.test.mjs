import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeVault, sessionId, editFile, denied, serve, gitRepo, ruleNote, withFields, sectionOf, LEDGER_GUIDE, LEDGER_REPO } from './fixture.mjs';

// What .state/derived.json holds as raw/refs/ and the notes change, and what the hooks and review make of it.

const ledgerEdit = (v, sid) => denied(editFile(v, sid, 'src/ledger.txt', { abs: path.join(v.projects.almanac, 'src', 'ledger.txt'), cwd: v.projects.almanac })) ?? '';
const unverified = v => Object.keys(JSON.parse(v.read('.state/derived.json')).unverified).sort();
const daysAgo = n => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
const LEDGER_URL = 'https://pkg.invalid/ledger';
const CHANGED = LEDGER_GUIDE.replace('takes a path and', 'takes a path or a URL and');
// A later copy of the preset's ledger guide, as refresh or another machine saves one.
const newCopy = (v, fetched) => v.write('raw/refs/ledger-guide.1234abcd.md', withFields({ url: LEDGER_URL, fetched, replaces: 'raw/refs/ledger-guide.md' }, CHANGED));

test('a note saved again with the same text stays unverified in later sessions and in review status', async t => {
  const server = await serve(t, { '/ledger': { body: CHANGED, etag: '"ledger-2"' } });
  const repo = gitRepo(t, { 'docs/ledger.md': LEDGER_REPO });
  const v = makeVault(t, { presets: ['almanac'], sources: { url: server.url('/ledger'), repo: repo.dir, commit: repo.commit } });
  const cwd = v.projects.almanac;
  const r = await v.runAsync('refresh.mjs');
  assert.equal(r.code, 0, r.stderr);
  const labelled = /- almanac\/ledger-v2: .* source changed on \d{4}-\d\d-\d\d/;
  let sid = sessionId();
  v.startSession(sid, { cwd });
  assert.match(ledgerEdit(v, sid), labelled);
  // Same bytes, a new mtime: what a sync tool or a checkout leaves.
  const old = new Date(Date.now() - 2 * 3600e3);
  fs.utimesSync(v.at('wiki', 'almanac', 'rules', 'ledger-v2.md'), old, old);
  for (let i = 0; i < 2; i++) {
    sid = sessionId();
    v.startSession(sid, { cwd });
    assert.match(ledgerEdit(v, sid), labelled, `session ${i + 1} after the save`);
  }
  const listed = sectionOf(v.run('review.mjs', ['status'], { cwd }).stdout, 'Notes a changed source has left unverified') ?? [];
  assert.match(listed.join('\n'), /^- almanac\/ledger-v2: /m);
});

test('a copy that lands in raw/refs/ with no note changed is derived at the next session start', t => {
  const v = makeVault(t, { presets: ['almanac'] });
  const cwd = v.projects.almanac;
  v.startSession(sessionId(), { cwd });
  assert.deepEqual(unverified(v), []);
  newCopy(v, daysAgo(10));
  const sid = sessionId();
  v.startSession(sid, { cwd });
  assert.ok(unverified(v).includes('almanac/ledger-v2'), `derived.json lists ${unverified(v).join(', ') || 'nothing'} as unverified`);
  assert.match(ledgerEdit(v, sid), new RegExp(`- almanac/ledger-v2: .* source changed on ${daysAgo(10)}`));
});

test('a note that cites a URL is unverified once the URL has a copy fetched after its as_of', t => {
  const v = makeVault(t, { presets: ['almanac'] });
  const note = (slug, asOf, id) => v.write(`wiki/almanac/rules/${slug}.md`, ruleNote({
    domain: 'almanac', topic: 'ledger', kind: 'knowledge', basis: 'source', applies_to: ['src/**'], extra: [`as_of: ${asOf}`],
    doLine: `Pass openLedger a path (${slug}).`, notLine: 'Pass it an object.', because: 'The guide says so.',
    evidence: [`- ${asOf} · source · session 1a2b3c4d · ${LEDGER_URL} · dated ${asOf} · "openLedger takes a path and returns the ledger" (a-0000000${id})`],
  }));
  note('ledger-url-old', daysAgo(20), 1);
  note('ledger-url-new', daysAgo(5), 2);
  v.run('build.mjs');
  assert.ok(!unverified(v).some(k => k.startsWith('almanac/ledger-url')), 'a URL with one copy leaves its notes verified');
  newCopy(v, daysAgo(10));
  v.run('build.mjs');
  const keys = unverified(v);
  assert.ok(keys.includes('almanac/ledger-url-old'), `a note from before the new copy is unverified: ${keys.join(', ')}`);
  assert.ok(!keys.includes('almanac/ledger-url-new'), 'a note whose as_of is after the new copy read it');
});

test('a check that finds the source changed leaves a note on the old copy as stale as its as_of', async t => {
  const server = await serve(t, { '/ledger': { body: LEDGER_GUIDE, etag: '"ledger-1"' } });
  const v = makeVault(t, { presets: ['almanac'], sources: { url: server.url('/ledger') } });
  const rel = 'wiki/almanac/rules/ledger-v2.md';
  v.write(rel, v.read(rel).replace(/^as_of: .*$/m, `as_of: ${daysAgo(300)}`));
  const stale = () => v.run('lint.mjs').stdout.split('\n').filter(l => l.startsWith(`warn ${rel}: `) && /days/.test(l));
  v.run('build.mjs');
  assert.deepEqual(stale(), [], 'the copy the note cites was fetched within staleAfterDays');
  server.set('/ledger', { body: CHANGED, etag: '"ledger-2"' });
  const r = await v.runAsync('refresh.mjs');
  assert.equal(r.code, 0, r.stderr);
  assert.match(stale().join('\n'), /as_of is 30\d days old/);
});
