import test from 'node:test';
import assert from 'node:assert/strict';
import { makeVault, sessionId, PRESETS } from './fixture.mjs';

test('a vault with every preset lints clean, and a session in glim\'s project gets its always rule', async t => {
  const v = makeVault(t, { presets: Object.keys(PRESETS) });
  const context = v.startSession(sessionId())?.hookSpecificOutput?.additionalContext ?? '';
  assert.match(context, /glim\/always-rule: Do: Open each glim file with a purpose line\./);
  const found = (await v.import('lib/lint.mjs')).lint().map(f => `${f.level} ${f.file}: ${f.msg}`);
  // The presets' Evidence cites sessions this vault never registered, which lint can only count.
  assert.deepEqual(found, ["warn wiki: 5 quotes can't be checked: 5 cite a session whose transcript is gone. node tools/review.mjs status lists them."]);
});
