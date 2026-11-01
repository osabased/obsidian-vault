import test from 'node:test';
import assert from 'node:assert/strict';
import { makeVault, ruleNote, sessionId } from './fixture.mjs';

const DAY = 864e5;
const ago = ms => new Date(Date.now() - ms);
const stamp = (v, at) => v.write('.state/lint.json', `${JSON.stringify({ at: at.toISOString(), errors: 0 })}\n`);
const note = (v, i, saved) => {
  const rel = `wiki/demo/rules/r${i}.md`;
  v.write(rel, ruleNote({ doLine: `Do thing ${i}.`, because: 'It reads better.' }), { saved });
};
const reminder = v => v.startSession(sessionId())?.hookSpecificOutput.additionalContext.split('\n\n').find(l => l.startsWith('Taste vault: /lint')) ?? null;
const remind = (v, what) => `Taste vault: /lint ${what}. Remind the user to run /lint in \`${v.root.replace(/\\/g, '/')}\`.`;

test('session start reminds about /lint once notes change, not on a quiet vault', t => {
  const v = makeVault(t);
  assert.equal(reminder(v), null, 'nothing to lint yet');
  note(v, 1, ago(30 * DAY));
  assert.equal(reminder(v), remind(v, "hasn't run yet, and the vault has 1 note"));

  stamp(v, ago(20 * DAY));
  assert.equal(reminder(v), null, 'no note changed since /lint ran, however long ago');
  note(v, 2, ago(3600e3));
  assert.equal(reminder(v), remind(v, 'last ran 20 days ago, and 1 note changed since'));
});

test('session start reminds sooner when remindAfterNotes notes changed', t => {
  const v = makeVault(t);
  stamp(v, ago(DAY + 3600e3));
  for (let i = 1; i <= 9; i++) note(v, i, ago(3600e3));
  assert.equal(reminder(v), null, 'nine notes, one day');
  note(v, 10, ago(3600e3));
  assert.equal(reminder(v), remind(v, 'last ran 1 day ago, and 10 notes changed since'));
  stamp(v, ago(2 * 3600e3));
  assert.equal(reminder(v), remind(v, 'last ran today, and 10 notes changed since'));
});

test('the notes /lint changes before review.mjs done don\'t count toward the next reminder', t => {
  const v = makeVault(t, { config: { lint: { remindAfterDays: 0 } } });
  note(v, 1, ago(30 * DAY));
  assert.equal(v.run('review.mjs', ['status']).code, 0);
  note(v, 2, ago(0));
  assert.equal(reminder(v), remind(v, 'last ran today, and 1 note changed since'));
  const r = v.run('review.mjs', ['done']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(reminder(v), null);
  assert.equal(v.run('review.mjs', ['done', 'extra']).code, 2);
});

test("the reminder counts the whole vault's notes, not only the session's domains", t => {
  const v = makeVault(t, { domains: { other: { title: 'Other', topics: ['x'] } } });
  for (let i = 0; i < 12; i++) v.write(`wiki/other/rules/r${i}.md`, ruleNote({ domain: 'other', topic: 'x', doLine: `Do thing ${i}.` }), { saved: ago(2 * DAY) });
  assert.equal(reminder(v), remind(v, "hasn't run yet, and the vault has 12 notes"));
  stamp(v, ago(DAY));
  for (let i = 0; i < 10; i++) v.write(`wiki/other/rules/r${i}.md`, ruleNote({ domain: 'other', topic: 'x', doLine: `Do thing ${i} again.` }));
  assert.equal(reminder(v), remind(v, 'last ran 1 day ago, and 10 notes changed since'));
});
