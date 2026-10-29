import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeVault, ruleNote, userTurn } from './fixture.mjs';

let n = 0;
const sessionId = () => `a1b2c3d4-0000-4000-8000-${String(++n).padStart(12, '0')}`;

function setup(t, { quote } = {}) {
  const v = makeVault(t);
  const sid = sessionId();
  v.startSession(sid, quote ? { transcript: v.transcript(sid, [userTurn(quote)]) } : {});
  return { v, sid };
}

const proposal = (o = {}) => ({
  domain: 'demo', slug: 'new-rule', topic: 'code', basis: 'reading', reading: 'The user rewrote the screen twice.',
  do: 'Zebra quartz mango.', not: 'Plover lantern ember.', applies_to: ['src/new/**'], ...o,
});
const inbox = v => fs.readdirSync(v.at('raw', 'inbox')).flatMap(f => v.read(`raw/inbox/${f}`).trim().split('\n').map(l => JSON.parse(l)));

test('a rule alone goes straight through and lands in the inbox', t => {
  const { v, sid } = setup(t);
  const r = v.propose(sid, proposal());
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^Wrote wiki\/demo\/new-rule\.md\./);
  assert.match(r.stdout, /\*\*New rule\*\* demo\/new-rule: Do: Zebra quartz mango\. Not: Plover lantern ember\./);
  assert.match(r.stdout, /It applies from now on\./);
  assert.ok(v.exists('wiki/demo/new-rule.md'));
  assert.match(v.read('wiki/demo/new-rule.md'), /· agent's reading · session a1b2c3d4 · The user rewrote the screen twice\. \(a-[0-9a-f]{8}\)/);
  const files = fs.readdirSync(v.at('raw', 'inbox'));
  assert.equal(files.length, 1);
  assert.match(files[0], /^\d{4}-\d\d-\d\d\.jsonl$/);
  const [row] = inbox(v);
  assert.match(row.id, /^a-[0-9a-f]{8}$/);
  assert.equal(row.source, 'agent');
  assert.equal(row.kind, 'reading');
  assert.equal(row.text, 'The user rewrote the screen twice.');
  assert.equal(row.note, 'demo/new-rule');
  assert.equal(row.session, sid);
  assert.equal(row.domain, 'demo');
  assert.match(v.read('log.md'), /wrote demo\/new-rule · session a1b2c3d4/);
});

test('a shared glob refuses once with the list, the identical retry goes through', t => {
  const { v, sid } = setup(t);
  v.write('wiki/demo/old-rule.md', ruleNote({ topic: 'layout', applies_to: ['src/new/**'], doLine: 'Alpha bravo charlie.', notLine: 'Delta foxtrot golf.' }));
  const first = v.propose(sid, proposal());
  assert.equal(first.code, 1);
  assert.match(first.stderr, /^Not proposed: it may repeat these rules:/);
  assert.match(first.stderr, /- demo\/old-rule: Do: Alpha bravo charlie\. Not: Delta foxtrot golf\. \[not shown in this session\]/);
  assert.match(first.stderr, /"repeats": "<that rule's key>"/);
  assert.ok(!v.exists('wiki/demo/new-rule.md'));
  assert.equal(fs.existsSync(v.at('raw', 'inbox')), false);

  const retry = v.propose(sid, proposal());
  assert.equal(retry.code, 0, retry.stderr);
  assert.match(retry.stdout, /It may overlap demo\/old-rule\./);
  assert.ok(v.exists('wiki/demo/new-rule.md'));
});

test('a shared keyword lists the rule', t => {
  const { v, sid } = setup(t);
  v.write('wiki/demo/old-rule.md', ruleNote({ topic: 'layout', keywords: ['buttons'], doLine: 'Alpha bravo charlie.', notLine: 'Delta foxtrot golf.' }));
  const r = v.propose(sid, proposal({ applies_to: [], keywords: ['Buttons'] }));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /- demo\/old-rule:/);
  assert.equal(v.propose(sid, proposal({ applies_to: [], keywords: ['Buttons'] })).code, 0);
});

test('shared words alone list the rule', t => {
  const { v, sid } = setup(t);
  v.write('wiki/demo/old-rule.md', ruleNote({ topic: 'layout', keywords: ['cards'], doLine: 'Keep card spacing generous.', notLine: 'Cram cards together.' }));
  const p = proposal({ applies_to: ['src/other/**'], do: 'Keep card spacing generous.', not: 'Cram cards together tightly.' });
  const r = v.propose(sid, p);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /- demo\/old-rule:/);
  assert.equal(v.propose(sid, p).code, 0);
});

test('a rule on the same topic lists every rule of that topic even with nothing shared', t => {
  const { v, sid } = setup(t);
  v.write('wiki/demo/old-rule.md', ruleNote({ topic: 'code', keywords: ['other'], doLine: 'Alpha bravo charlie.', notLine: 'Delta foxtrot golf.' }));
  const r = v.propose(sid, proposal());
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Every demo rule on code:/);
  assert.match(r.stderr, /- demo\/old-rule:/);
  assert.equal(v.propose(sid, proposal()).code, 0);
});

test('an unrelated rule in another topic does not refuse', t => {
  const { v, sid } = setup(t);
  v.write('wiki/demo/old-rule.md', ruleNote({ topic: 'layout', keywords: ['other'], doLine: 'Alpha bravo charlie.', notLine: 'Delta foxtrot golf.' }));
  assert.equal(v.propose(sid, proposal()).code, 0);
});

test('a changed retry is refused again', t => {
  const { v, sid } = setup(t);
  v.write('wiki/demo/old-rule.md', ruleNote({ topic: 'layout', applies_to: ['src/new/**'], doLine: 'Alpha bravo charlie.', notLine: 'Delta foxtrot golf.' }));
  assert.equal(v.propose(sid, proposal()).code, 1);
  v.write('wiki/demo/another.md', ruleNote({ topic: 'layout', applies_to: ['src/new/**'], doLine: 'Hotel india juliet.', notLine: 'Kilo lima mike.' }));
  assert.equal(v.propose(sid, proposal()).code, 1);
});

test('repeats adds an Evidence line to the named note instead of writing a new one', t => {
  const { v, sid } = setup(t);
  v.write('wiki/demo/old-rule.md', ruleNote({ topic: 'layout', applies_to: ['src/new/**'], doLine: 'Alpha bravo charlie.', notLine: 'Delta foxtrot golf.' }));
  const r = v.propose(sid, proposal({ repeats: 'demo/old-rule' }));
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^Added the Evidence line to wiki\/demo\/old-rule\.md\./);
  assert.match(r.stdout, /\*\*Rule backed again\*\* demo\/old-rule: Do: Alpha bravo charlie\./);
  assert.ok(!v.exists('wiki/demo/new-rule.md'));
  const note = v.read('wiki/demo/old-rule.md');
  const evidence = note.split('## Evidence\n')[1].trim().split('\n');
  assert.equal(evidence.length, 2);
  assert.match(evidence[0], /do the thing/);
  assert.match(evidence[1], /· agent's reading · session a1b2c3d4 · The user rewrote the screen twice\. \(a-[0-9a-f]{8}\)$/);
  const [row] = inbox(v);
  assert.equal(row.note, 'demo/old-rule');
  assert.match(v.read('log.md'), /added evidence to demo\/old-rule · session a1b2c3d4/);
});

test('repeats naming a rule that is not delivered is refused', t => {
  const { v, sid } = setup(t);
  const r = v.propose(sid, proposal({ repeats: 'demo/missing' }));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /repeats names demo\/missing, which isn't a delivered rule in demo or global/);
  const bad = v.propose(sid, proposal({ repeats: 'Not A Key' }));
  assert.match(bad.stderr, /repeats must be a rule key/);
});

test('the same stated words back two rules: refused once, then through', t => {
  const quote = 'always use flat buttons';
  const { v, sid } = setup(t, { quote });
  const stated = o => proposal({ basis: 'stated', quote, reading: undefined, ...o });
  assert.equal(v.propose(sid, stated({ slug: 'first-rule' })).code, 0);
  const second = stated({ slug: 'second-rule', applies_to: ['src/other/**'], do: 'Hotel india juliet.', not: 'Kilo lima mike.', topic: 'layout' });
  const r = v.propose(sid, second);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /these words already back demo\/first-rule\./);
  assert.equal(v.propose(sid, second).code, 0);
  assert.ok(v.exists('wiki/demo/second-rule.md'));
});

test('always: true is refused', t => {
  const { v, sid } = setup(t);
  const r = v.propose(sid, proposal({ always: true }));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /^Not proposed: always is the user's to set in Obsidian\./);
  assert.ok(!v.exists('wiki/demo/new-rule.md'));
});

test('a rule over 300 characters is refused', t => {
  const { v, sid } = setup(t);
  const r = v.propose(sid, proposal({ do: `${'Word '.repeat(70)}end.`, not: 'Plover lantern ember.' }));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Do, Not and Because come to \d+ characters; keep them under 300 together\./);
  assert.ok(!v.exists('wiki/demo/new-rule.md'));
});

test('a taste rule with neither keywords nor applies_to is refused', t => {
  const { v, sid } = setup(t);
  const r = v.propose(sid, proposal({ applies_to: [] }));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /give it keywords or applies_to/);
});

test('an existing slug is refused', t => {
  const { v, sid } = setup(t);
  v.write('wiki/demo/new-rule.md', ruleNote({ topic: 'layout', keywords: ['zzz'] }));
  const r = v.propose(sid, proposal());
  assert.equal(r.code, 1);
  assert.match(r.stderr, /wiki\/demo\/new-rule\.md already exists/);
});

test('a session that never started is refused', t => {
  const v = makeVault(t);
  const r = v.propose(sessionId(), proposal());
  assert.equal(r.code, 1);
  assert.match(r.stderr, /has no session/);
});
