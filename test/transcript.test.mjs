import test from 'node:test';
import assert from 'node:assert/strict';
import { makeVault, userTurn, assistantTurn, toolResult, sessionId } from './fixture.mjs';
import { codexRollout } from './codex.mjs';

// The fixture half of the typed-text provider test (design 6.7c): one record of each kind a provider reads or skips, so a
// field the provider stops reading, or reads wrongly, changes the list. test/live/transcripts.live.mjs checks the same
// fields in this machine's newest transcripts.

test("Claude Code's provider returns exactly the user's typed words from each kind of record", async t => {
  const v = makeVault(t);
  const { typedMessages } = await v.import('adapters/claude-code/adapter.mjs');
  const file = v.transcript(sessionId(), [
    { ...userTurn('typed prompt'), origin: { kind: 'human' } },
    assistantTurn('the agent answers'),
    { type: 'attachment', attachment: { type: 'queued_command', commandMode: 'prompt', origin: { kind: 'human' }, prompt: 'queued prompt' } },
    toolResult('answered', {
      questions: [{ question: 'Which layout?', options: [{ label: 'A, Grid' }, { label: 'B, Shelf' }] }],
      answers: { 'Which layout?': 'B, Shelf,with a wider gap' },
      annotations: { 'Which layout?': { notes: 'the featured card reads first' } },
    }),
    { ...userTurn('skill text the app injected'), isMeta: true },
    { ...userTurn('the summary of a compaction'), isCompactSummary: true },
    toolResult('output of a tool'),
    { ...userTurn('a background task finished'), origin: { kind: 'task-notification' } },
    { ...userTurn([{ type: 'text', text: 'keep it <system-reminder>context the app added</system-reminder>' }]), origin: { kind: 'human' } },
  ]);
  assert.deepEqual(typedMessages(file), ['typed prompt', 'queued prompt', '\n,with a wider gap', 'the featured card reads first', 'keep it  ']);
});

test("Codex's provider returns exactly the user's typed words from each kind of record", async t => {
  const v = makeVault(t, { config: { agents: ['claude-code', 'codex'] } });
  const { typedMessages } = await v.import('adapters/codex/adapter.mjs');
  const file = codexRollout(v, sessionId(), [
    { kinds: ['agents_md.instructions'], text: '# AGENTS.md' },
    { kinds: ['environments.context'], text: '<environment_context>cwd</environment_context>' },
    { kinds: ['additional_content.hook'], text: 'Taste rules that may apply' },
    'typed prompt',
    { kinds: ['user.text'], text: '<send_user_message_question_reply>B, Shelf</send_user_message_question_reply>' },
    { role: 'assistant', kinds: null, text: 'the agent answers' },
    { role: 'developer', kinds: ['user.text'], text: 'developer text' },
    'second prompt',
  ]);
  assert.deepEqual(typedMessages(file), ['typed prompt', 'second prompt']);
});
