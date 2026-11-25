import test from 'node:test';
import assert from 'node:assert/strict';
import { makeVault, sessionId, denied, userTurn } from './fixture.mjs';
import { codexInput, codexRollout, hookPrompt } from './codex.mjs';

const AGENTS = [
  { name: 'claude-code', tool: t => `mcp__plugin_obsidian-vault_vault__${t}`, input: fields => ({ hook_event_name: 'PreToolUse', ...fields }) },
  { name: 'codex', tool: t => `mcp__vault__${t}`, input: fields => codexInput('PreToolUse', fields) },
];

const vault = t => makeVault(t, { presets: ['glim'], config: { agents: ['claude-code', 'codex'] } });
const record = (v, call) => JSON.parse(v.read(`.state/calls/${call}.json`));
const ASKED = "The user was already asked to keep offer `o-1a2b3c4d` and denied it, or hasn't answered yet. A Deny ends a proposal: don't offer it again unless the user asks.";
const SPENT = "Offer `o-1a2b3c4d` already had its one keep call, which the user allowed. If that call didn't write, propose it again for a new offer.";
async function registered(v, sid, agent) {
  const { touchSession } = await v.import('lib/sessions.mjs');
  touchSession({ session: sid, cwd: v.project }, null, agent);
}

for (const a of AGENTS) {
  const call = (v, sid, tool, id, args = {}, extra = {}) => v.hook('vault-call', a.input({
    session_id: sid, cwd: v.project, tool_name: a.tool(tool), tool_use_id: id, tool_input: args, ...extra,
  }), { agent: a.name });

  test(`${a.name}: the vault-call hook records the call with its session, and the subagent that made it`, async t => {
    const v = vault(t);
    const sid = sessionId();
    assert.equal(call(v, sid, 'propose', 'toolu_one', { rule: 'x' }), null);
    const rec = record(v, 'toolu_one');
    const { inputHash } = await v.import('lib/calls.mjs');
    assert.deepEqual({ ...rec, at: typeof rec.at }, { call: 'toolu_one', session: sid, subagent: null, tool: 'propose', offer: null, input: inputHash({ rule: 'x' }), at: 'string', allowed: null, used: null });
    assert.equal(call(v, sid, 'pick', 'toolu_two', {}, { agent_id: 'agent-7' }), null);
    assert.equal(record(v, 'toolu_two').subagent, 'agent-7');
    assert.equal(record(v, 'toolu_two').tool, 'pick');
  });

  test(`${a.name}: a second keep for one offer is denied and writes nothing; the same call again is not`, t => {
    const v = vault(t);
    const sid = sessionId();
    assert.equal(call(v, sid, 'keep', 'toolu_k1', { id: 'o-1a2b3c4d', offer: 'text' }), null);
    assert.equal(record(v, 'toolu_k1').offer, 'o-1a2b3c4d');
    const why = denied(call(v, sid, 'keep', 'toolu_k2', { id: 'o-1a2b3c4d', offer: 'text' }));
    assert.equal(why, ASKED);
    assert.ok(!v.exists('.state/calls/toolu_k2.json'));
    assert.equal(call(v, sid, 'keep', 'toolu_k1', { id: 'o-1a2b3c4d', offer: 'text' }), null);
    assert.equal(call(v, sid, 'keep', 'toolu_k3', { id: 'o-99999999', offer: 'text' }), null);
    assert.equal(call(v, sid, 'proposals', 'toolu_p1', { id: 'o-1a2b3c4d' }), null);
    assert.equal(record(v, 'toolu_p1').offer, null);
  });

  test(`${a.name}: a call with no call id fails the hook`, t => {
    const v = vault(t);
    const r = v.run(`adapters/${a.name}/hooks/vault-call.mjs`, [], { input: a.input({ session_id: sessionId(), cwd: v.project, tool_name: a.tool('propose'), tool_use_id: undefined, tool_input: {} }), cwd: v.project });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^vault vault-call failed: .*no call id/);
  });

  test(`${a.name}: the edit hook gives no event for a vault tool, so no rule or AskUserQuestion gate reaches it`, async t => {
    const v = vault(t);
    const { events, vaultTool } = await v.import(`adapters/${a.name}/adapter.mjs`);
    const input = a.input({ session_id: sessionId(), cwd: v.project, tool_name: a.tool('propose'), tool_use_id: 'toolu_e', tool_input: {} });
    assert.equal(vaultTool(input.tool_name), 'propose');
    assert.deepEqual(events('edit', input), []);
    assert.deepEqual(events('edit', { ...input, tool_name: 'mcp__other__propose' }).map(e => e.tool), ['mcp__other__propose']);
    assert.equal(v.hook('edit', input, { agent: a.name }), null);
    const [e] = events('vault-call', { ...input, agent_id: 'sub-1' });
    assert.deepEqual(e, { session: input.session_id, subagent: 'sub-1', cwd: v.project, tool: 'propose', call: 'toolu_e', args: {} });
  });
}

const ccKeep = (v, sid, id) => v.hook('vault-call', AGENTS[0].input({
  session_id: sid, cwd: v.project, tool_name: AGENTS[0].tool('keep'), tool_use_id: id, tool_input: { id: 'o-1a2b3c4d', offer: 'text' },
}), { agent: 'claude-code' });

test('a second keep after one the user allowed is denied as spent, not as denied', async t => {
  const v = vault(t);
  const sid = sessionId();
  await registered(v, sid, 'claude-code');
  assert.equal(ccKeep(v, sid, 'toolu_k1'), null);
  assert.equal(denied(ccKeep(v, sid, 'toolu_k2')), ASKED);
  const { allowCall } = await v.import('lib/calls.mjs');
  allowCall('toolu_k1');
  assert.equal(denied(ccKeep(v, sid, 'toolu_k3')), SPENT);
  assert.ok(!v.exists('.state/calls/toolu_k3.json'));
});

test('a keep of a held offer is denied before it is recorded, so the offer keeps its one keep for after release', t => {
  const v = makeVault(t, { config: { proposals: 'ask' } });
  const sid = sessionId();
  v.startSession(sid, { transcript: v.transcript(sid, [userTurn('name widgets after their screen')]) });
  const r = v.propose(sid, {
    domain: 'glim', slug: 'held-one', topic: 'code', basis: 'stated', quote: 'name widgets after their screen',
    do: 'Name widgets after their screen.', not: 'Leave widget names bare.', keywords: ['widgetz'], hold: true,
  });
  const id = /^Held `(o-[0-9a-f]{8})`/.exec(r.stdout)?.[1];
  assert.ok(id, r.stderr);
  const out = v.hook('vault-call', AGENTS[0].input({
    session_id: sid, cwd: v.project, tool_name: AGENTS[0].tool('keep'), tool_use_id: 'toolu_h1', tool_input: { id, offer: 'text' },
  }), { agent: 'claude-code' });
  assert.equal(denied(out), `Offer \`${id}\` is held. Call \`propose\` with \`release: true\` first.`);
  assert.ok(!v.exists('.state/calls/toolu_h1.json'));
});

test('Codex: a keep retried for one offer is recorded, not denied, and carries no offer', async t => {
  const v = vault(t);
  const sid = sessionId();
  await registered(v, sid, 'codex');
  const keep = id => v.hook('vault-call', AGENTS[1].input({
    session_id: sid, cwd: v.project, tool_name: AGENTS[1].tool('keep'), tool_use_id: id, tool_input: { id: 'o-1a2b3c4d', offer: 'text' },
  }), { agent: 'codex' });
  assert.equal(keep('call_k1'), null);
  assert.equal(keep('call_k2'), null);
  assert.equal(record(v, 'call_k2').offer, null);
  assert.equal(record(v, 'call_k2').tool, 'keep');
});

test("Codex conversation() holds exactly typedMessages' items as the user's entries, with the agent's replies between", async t => {
  const v = vault(t);
  const sid = sessionId();
  const file = codexRollout(v, sid, [
    'first typed message',
    { role: 'assistant', text: 'the agent answers' },
    { kinds: null, content: hookPrompt('a Stop continuation').content },
    { kinds: ['user.text', 'user.image'], text: 'typed with an image' },
    { kinds: ['user.environment'], text: 'injected text' },
    { role: 'assistant', text: '**Keep this rule?** glim/x: y' },
    'the code is K7QM',
  ]);
  const { conversation, typedMessages } = await v.import('adapters/codex/adapter.mjs');
  const talk = conversation(file);
  assert.deepEqual(talk.filter(e => e.role === 'user').map(e => e.text), typedMessages(file));
  assert.deepEqual(talk.map(e => e.role), ['user', 'agent', 'user', 'agent', 'user']);
  assert.equal(talk[3].text, '**Keep this rule?** glim/x: y');
  assert.equal(conversation(v.at('.transcripts', 'missing.jsonl')), null);
});
