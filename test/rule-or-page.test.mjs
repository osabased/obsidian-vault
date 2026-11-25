import test from 'node:test';
import assert from 'node:assert/strict';
import { makeVault, sessionId, userTurn, assistantTurn, ruleNote, pageNote, prompt } from './fixture.mjs';

// A rule is for a mistake an agent would make at a set moment and not catch in time, backed by the user's words, a
// failure or a dated source; the rest goes on pages, and a rule drawn from a page points to it.

const SAID = 'call them by their screen';
const RULE = 'wiki/glim/rules/the-thing.md';
const rule = (o = {}) => ({
  domain: 'glim', slug: 'tidy-names', topic: 'code', kind: 'taste', basis: 'stated', quote: SAID,
  do: 'Name widgets after their screen.', not: 'Leave widget names bare.', keywords: ['widgetz'], ...o,
});
const reading = (o = {}) => rule({ basis: 'reading', quote: undefined, reading: 'The user renamed the shop widgets after their screen.', ...o });

function started(v) {
  const sid = sessionId();
  v.startSession(sid, { cwd: v.project, transcript: v.transcript(sid, [userTurn(SAID), assistantTurn('Noted.')]) });
  return sid;
}

const refusedToPage = r => {
  assert.notEqual(r.code, 0, r.stdout);
  assert.match(r.stderr, /vault page/);
};

test('propose refuses a new rule on basis reading or inferred and sends the agent to a page', t => {
  const v = makeVault(t);
  const sid = started(v);
  refusedToPage(v.propose(sid, reading()));
  refusedToPage(v.propose(sid, rule({ basis: 'inferred' })));
  assert.equal(v.exists('wiki/glim/rules/tidy-names.md'), false);
  assert.equal(v.propose(sid, rule()).code, 0, 'the same rule on the user\'s words is written');
});

test('evidence on basis reading for a rule the vault has is refused too, and a reword on it still goes through', t => {
  const v = makeVault(t);
  v.write(RULE, ruleNote({ keywords: ['thing'] }));
  const sid = started(v);
  const before = v.read(RULE);
  refusedToPage(v.propose(sid, reading({ repeats: 'glim/the-thing' })));
  assert.equal(v.read(RULE), before);
  const r = v.propose(sid, { change: 'reword', key: 'glim/the-thing', basis: 'reading', reading: 'The user wants it brief.', do: 'Do the thing briefly.' });
  assert.equal(r.code, 0, r.stderr);
  assert.match(v.read(RULE), /Do the thing briefly\./);
});

test('a quote the user never typed sends a new rule\'s agent to a page, not to basis reading', t => {
  const v = makeVault(t);
  const r = v.propose(started(v), rule({ quote: 'words nobody typed' }));
  refusedToPage(r);
  assert.doesNotMatch(r.stderr, /basis reading/);
});

const delivered = (v, words) => prompt(v, sessionId(), words)?.hookSpecificOutput?.additionalContext ?? '';
const morePath = (v, rel) => `More: ${v.at(...rel.split('/')).replace(/\\/g, '/')}`;

test('a delivered rule ends with the page it is drawn from, else its topic\'s page, else nothing', t => {
  const v = makeVault(t);
  v.write(RULE, ruleNote({ keywords: ['thingz'] }));
  assert.doesNotMatch(delivered(v, 'about thingz'), /More:/);
  v.write('wiki/glim/topics/code.md', pageNote({ body: ['What the vault holds on code.'] }));
  assert.ok(delivered(v, 'about thingz').includes(morePath(v, 'wiki/glim/topics/code.md')), delivered(v, 'about thingz'));
  v.write('wiki/glim/syntheses/thing-notes.md', pageNote({ kind: 'synthesis', body: ['Why the thing.', '', '## Rules', '- [[wiki/glim/rules/the-thing|the-thing]]'] }));
  const out = delivered(v, 'about thingz');
  assert.ok(out.includes(morePath(v, 'wiki/glim/syntheses/thing-notes.md')), out);
  assert.equal(out.match(/More:/g).length, 1, 'one page only');
});

test('a rule\'s page link leaves its delivery hash alone, so adding a page redelivers nothing', async t => {
  const v = makeVault(t);
  v.write(RULE, ruleNote({ keywords: ['thingz'] }));
  const { liveRules, loadNotes } = await v.import('lib/rules.mjs');
  const before = liveRules(loadNotes())['glim/the-thing'];
  v.write('wiki/glim/topics/code.md', pageNote({ body: ['What the vault holds on code.'] }));
  const after = liveRules(loadNotes())['glim/the-thing'];
  assert.equal(after.page, 'wiki/glim/topics/code.md');
  assert.equal(after.hash, before.hash);
});

const startNote = (v, re = /`propose` tool/) => (v.startSession(sessionId())?.hookSpecificOutput?.additionalContext ?? '')
  .split('\n\n').filter(b => re.test(b)).join('\n\n');

test('every mode\'s start note draws the rule line, sends the rest to pages and asks for a pages line', t => {
  for (const proposals of ['corrections', 'ask', 'off']) {
    const text = startNote(makeVault(t, { config: { proposals } }));
    assert.match(text, /silent or costly/, proposals);
    assert.match(text, /vault page/, proposals);
    assert.match(text, /one line naming any vault pages/, proposals);
  }
});
