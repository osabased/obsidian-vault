import test from 'node:test';
import assert from 'node:assert/strict';
import { makeVault, sessionId, userTurn, assistantTurn, ruleNote, keepAllowed, offerOf, lintFound } from './fixture.mjs';

const SAID = 'call them by their screen';
const RULE = 'wiki/glim/rules/the-thing.md';
const rule = (o = {}) => ({
  domain: 'glim', slug: 'tidy-names', topic: 'code', basis: 'stated', quote: SAID,
  do: 'Name widgets after their screen.', not: 'Leave widget names bare.', keywords: ['widgetz'], ...o,
});
const relabel = (o = {}) => ({ change: 'reword', key: 'glim/the-thing', kind: 'practice', basis: 'stated', quote: SAID, ...o });

function started(v) {
  const sid = sessionId();
  v.startSession(sid, { cwd: v.project, transcript: v.transcript(sid, [userTurn(SAID), assistantTurn('Noted.')]) });
  return sid;
}

function offered(r) {
  assert.equal(r.code, 0, r.stderr);
  const o = offerOf(r.stdout);
  assert.ok(o, r.stdout);
  return o;
}

test('propose refuses a rule with no kind and names the three kinds', t => {
  const v = makeVault(t);
  const r = v.propose(started(v), { ...rule(), kind: undefined }, { raw: true });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /kind must be taste, practice or knowledge/);
});

test('a practice rule takes the taste bases, is written with kind practice, and lints clean', async t => {
  const v = makeVault(t);
  const sid = started(v);
  assert.match(v.propose(sid, rule({ kind: 'practice', basis: 'source', source: 'https://example.com', quote: SAID })).stderr, /basis source is for knowledge rules/);
  const r = v.propose(sid, rule({ kind: 'practice' }));
  assert.equal(r.code, 0, r.stderr);
  assert.match(v.read('wiki/glim/rules/tidy-names.md'), /^kind: practice\r?$/m);
  assert.deepEqual(await lintFound(v, /tidy-names/), []);
});

test('a taste and a practice rule are ranked against each other by basis', async t => {
  const v = makeVault(t);
  v.write(RULE, ruleNote({ keywords: ['thing'], basis: 'reading', evidence: ['- 2026-10-01 · agent\'s reading · session 1a2b3c4d · 2026-10-01: saw it. (a-00000001)'] }));
  v.write('wiki/glim/rules/other-thing.md', ruleNote({ kind: 'practice', keywords: ['thing'], doLine: 'Do the other thing.' }));
  const { rankPair, loadNotes } = await import(`file://${v.at('tools', 'lib', 'rules.mjs').replace(/\\/g, '/')}`);
  const notes = loadNotes();
  const [a, b] = ['glim/the-thing', 'glim/other-thing'].map(k => notes.find(n => n.key === k));
  assert.ok(a && b, 'the vault the tools read is the test vault');
  assert.equal(rankPair(a, b)?.first?.key, 'glim/other-thing');
});

test('a reword moves a taste rule to practice, shows the kinds in the offer, and keeps its evidence', async t => {
  const v = makeVault(t, { config: { proposals: 'ask' } });
  v.write(RULE, ruleNote({ keywords: ['thing'] }));
  const sid = started(v);
  const o = offered(v.propose(sid, relabel()));
  assert.match(o.text, /^\*\*Change this rule\?\*\* glim\/the-thing: Do: Do the thing\. Not: Skip the thing\.\nWas: a taste rule\nNow: a practice rule\n/);
  const k = keepAllowed(v, sid, o.id, o.text);
  assert.equal(k.code, 0, k.stderr);
  const after = v.read(RULE);
  assert.match(after, /^kind: practice\r?$/m);
  assert.match(after, /"do the thing" \(a-00000001\)/);
  assert.match(after, /· stated · session [0-9a-f]{8} · "call them by their screen" \(a-[0-9a-f]{8}\)/);
  assert.deepEqual(await lintFound(v, /the-thing/), []);
});

test('a reword to knowledge dates the rule, and a reword out of knowledge is refused', async t => {
  const v = makeVault(t);
  v.write(RULE, ruleNote({ keywords: ['thing'] }));
  const sid = started(v);
  const r = v.propose(sid, relabel({ kind: 'knowledge' }));
  assert.equal(r.code, 0, r.stderr);
  assert.match(v.read(RULE), /^kind: knowledge\r?$/m);
  assert.match(v.read(RULE), /^as_of: \d{4}-\d\d-\d\d\r?$/m);
  assert.deepEqual(await lintFound(v, /the-thing/), []);
  assert.match(v.propose(sid, relabel({ kind: 'practice' })).stderr, /retire it and propose it again/);
});

test('a reword to a kind whose bases leave out the rule\'s basis is refused', t => {
  const v = makeVault(t);
  v.write(RULE, ruleNote({ keywords: ['thing'], basis: 'reading', evidence: ['- 2026-10-01 · agent\'s reading · session 1a2b3c4d · 2026-10-01: saw it. (a-00000001)'] }));
  const r = v.propose(started(v), relabel({ kind: 'knowledge' }));
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /basis/);
  assert.match(v.read(RULE), /^kind: taste\r?$/m);
});
