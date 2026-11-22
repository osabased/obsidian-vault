import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeVault, sessionId, userTurn, assistantTurn, ruleNote, keepAllowed, offerOf, lintFound } from './fixture.mjs';

const SAID = 'that one is about layout';
const RULE = 'wiki/glim/rules/the-thing.md';
const retopic = (o = {}) => ({ change: 'reword', key: 'glim/the-thing', topic: 'layout', basis: 'stated', quote: SAID, ...o });

function started(v) {
  const sid = sessionId();
  v.startSession(sid, { cwd: v.project, transcript: v.transcript(sid, [userTurn(SAID), assistantTurn('Noted.')]) });
  return sid;
}

test('a reword moves a rule to another topic, shows both topics in the offer, and keeps the rest of the note', async t => {
  const v = makeVault(t, { config: { proposals: 'ask' } });
  v.write(RULE, ruleNote({ keywords: ['thing'] }));
  const sid = started(v);
  const r = v.propose(sid, retopic());
  assert.equal(r.code, 0, r.stderr);
  const o = offerOf(r.stdout);
  assert.ok(o, r.stdout);
  assert.match(o.text, /^\*\*Change this rule\?\*\* glim\/the-thing: Do: Do the thing\. Not: Skip the thing\.\nWas: topic code\nNow: topic layout\n/);
  const k = keepAllowed(v, sid, o.id, o.text);
  assert.equal(k.code, 0, k.stderr);
  const after = v.read(RULE);
  assert.match(after, /^topic: layout\r?$/m);
  assert.match(after, /^kind: taste\r?$/m);
  assert.match(after, /^\*\*Do:\*\* Do the thing\.\r?$/m);
  assert.match(after, /"do the thing" \(a-00000001\)/);
  assert.match(after, /· stated · session [0-9a-f]{8} · "that one is about layout" \(a-[0-9a-f]{8}\)/);
  assert.deepEqual(await lintFound(v, /the-thing/), []);
});

test('a reword to the topic the rule already has, in any case, is refused', t => {
  const v = makeVault(t);
  v.write(RULE, ruleNote({ keywords: ['thing'] }));
  const r = v.propose(started(v), retopic({ topic: ' Code ' }));
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /leaves glim\/the-thing as it is/);
});

test('a reword to a blank topic is refused', t => {
  const v = makeVault(t);
  v.write(RULE, ruleNote({ keywords: ['thing'] }));
  const r = v.propose(started(v), retopic({ topic: '  ' }));
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /topic is missing/);
  assert.match(v.read(RULE), /^topic: code\r?$/m);
});

test('a topic reword drafted into the queue, offered again and kept, moves the rule', t => {
  const v = makeVault(t, { config: { proposals: 'ask' } });
  v.write(RULE, ruleNote({ keywords: ['thing'] }));
  const sid = started(v);
  const d = v.run('queue.mjs', ['draft'], { input: JSON.stringify(retopic({ basis: 'reading', quote: undefined, reading: 'The rule is about layout, not code.' })), env: { CLAUDE_CODE_SESSION_ID: sid } });
  assert.equal(d.code, 0, d.stderr);
  const [row] = fs.readdirSync(v.at('raw', 'queue')).flatMap(f => v.read(`raw/queue/${f}`).trim().split('\n').filter(Boolean).map(l => JSON.parse(l)));
  assert.match(v.read(RULE), /^topic: code\r?$/m);
  const o = offerOf(v.propose(sid, { queued: row.id }).stdout);
  assert.ok(o);
  assert.match(o.text, /\nWas: topic code\nNow: topic layout\n/);
  const k = keepAllowed(v, sid, o.id, o.text);
  assert.equal(k.code, 0, k.stderr);
  assert.match(v.read(RULE), /^topic: layout\r?$/m);
});

test("a reword that only moves a knowledge rule's topic keeps its as_of, since nothing about the fact was checked", t => {
  const v = makeVault(t, { config: { proposals: 'ask' } });
  v.write(RULE, ruleNote({ kind: 'knowledge', basis: 'source', extra: ['as_of: 2026-10-01'], keywords: ['thing'] }));
  const sid = started(v);
  const o = offerOf(v.propose(sid, retopic()).stdout);
  assert.ok(o);
  assert.doesNotMatch(o.text, /As of 20\d\d-\d\d-\d\d\.\nNow:/);
  const k = keepAllowed(v, sid, o.id, o.text);
  assert.equal(k.code, 0, k.stderr);
  const after = v.read(RULE);
  assert.match(after, /^topic: layout\r?$/m);
  assert.match(after, /^as_of: 2026-10-01\r?$/m);
});
