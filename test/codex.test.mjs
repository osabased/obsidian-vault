import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeVault, ruleNote, pageNote, sourcePage, sessionId, cleanEnv } from './fixture.mjs';
import { codexInput, codexPatch, codexRollout } from './codex.mjs';
import { parsePatch, applyChunks } from '../tools/adapters/codex/patch.mjs';

const SCHEMAS = path.join(import.meta.dirname, 'fixtures', 'codex', 'schema');
const EVENTS = { SessionStart: 'session-start', UserPromptSubmit: 'user-prompt-submit', PreToolUse: 'pre-tool-use', SubagentStart: 'subagent-start', Stop: 'stop' };
const schema = (event, side) => JSON.parse(fs.readFileSync(path.join(SCHEMAS, `${EVENTS[event]}.command.${side}.schema.json`), 'utf8'));
const ZQ_LINE = '- glim/zq-trigger: Do: Set values through a named step. Not: Set a value inline. Because: The user traces values by step name.';
const LEAD = 'Taste rules apply to a file this turn wrote. Re-read the change against them before you stop.';

// The JSON Schema keys the copied schemas use: type, const, enum, required, properties, additionalProperties, $ref into
// definitions, and allOf. Returns the paths that don't fit.
function misfits(s, value, root = s, at = '$') {
  if (s === true) return [];
  if (s.$ref) return misfits(root.definitions[s.$ref.replace('#/definitions/', '')], value, root, at);
  const out = (s.allOf ?? []).flatMap(x => misfits(x, value, root, at));
  const types = [s.type ?? []].flat();
  const typeOf = value === null ? 'null' : Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value;
  if (types.length && !types.includes(typeOf)) return [...out, `${at} is ${typeOf}, not ${types.join(' or ')}`];
  if ('const' in s && value !== s.const) out.push(`${at} is ${JSON.stringify(value)}, not ${JSON.stringify(s.const)}`);
  if (s.enum && !s.enum.includes(value)) out.push(`${at} is ${JSON.stringify(value)}, not one of ${s.enum.join(', ')}`);
  if (typeOf === 'object') {
    for (const k of s.required ?? []) if (!(k in value)) out.push(`${at}.${k} is missing`);
    for (const [k, x] of Object.entries(value)) {
      if (s.properties?.[k] !== undefined) out.push(...misfits(s.properties[k], x, root, `${at}.${k}`));
      else if (s.additionalProperties === false) out.push(`${at}.${k} isn't allowed`);
    }
  }
  return out;
}

function gitProject(v) {
  const env = cleanEnv({ GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: v.project, env, stdio: 'pipe' });
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'start');
}

const codexVault = (t, opts = {}) => makeVault(t, { presets: ['glim'], config: { agents: ['claude-code', 'codex'] }, ...opts });
const run = (v, hook, input) => v.run(`adapters/codex/hooks/${hook}.mjs`, [], { input, cwd: input.cwd });
const hook = (v, name, input) => v.hook(name, input, { agent: 'codex' });
const patchCall = (sid, cwd, ops) => codexInput('PreToolUse', { session_id: sid, cwd, tool_input: { command: typeof ops === 'string' ? ops : codexPatch(ops) } });
const denied = out => (out?.hookSpecificOutput?.permissionDecision === 'deny' ? out.hookSpecificOutput.permissionDecisionReason : null);

test('the patch parser reads Add, Update with and without @@ context, Move to and Delete', () => {
  const text = codexPatch([
    { add: 'src/new.txt', lines: ['one', 'two'] },
    { update: 'src/a.txt', chunks: [{ lines: [' keep', '-old', '+new'] }] },
    { update: 'src/b.txt', moveTo: 'src/c.txt', chunks: [{ context: 'function f() {', lines: ['-  return 1;', '+  return 2;'] }, { context: '', lines: ['+tail'] }] },
    { delete: 'src/gone.txt' },
  ]);
  assert.deepEqual(parsePatch(text), [
    { op: 'add', path: 'src/new.txt', lines: ['one', 'two'] },
    { op: 'update', path: 'src/a.txt', chunks: [{ context: null, old: ['keep', 'old'], new: ['keep', 'new'], eof: false }] },
    {
      op: 'update', path: 'src/b.txt', moveTo: 'src/c.txt', chunks: [
        { context: 'function f() {', old: ['  return 1;'], new: ['  return 2;'], eof: false },
        { context: null, old: [], new: ['tail'], eof: false },
      ],
    },
    { op: 'delete', path: 'src/gone.txt' },
  ]);
});

test('the patch parser skips an Environment ID line, allows whitespace around the markers and CRLF, and reads End of File', () => {
  const text = [
    '  *** Begin Patch  ', '*** Environment ID: env-1', ' *** Add File: a.txt ', '+x', '*** Update File: b.txt', '@@', '-last', '+final', '*** End of File', '',
    '  *** End Patch',
  ].join('\r\n');
  assert.deepEqual(parsePatch(text), [
    { op: 'add', path: 'a.txt', lines: ['x'] },
    { op: 'update', path: 'b.txt', chunks: [{ context: null, old: ['last'], new: ['final'], eof: true }] },
  ]);
  assert.deepEqual(parsePatch(`<<'EOF'\n${codexPatch([{ delete: 'a.txt' }])}EOF\n`), [{ op: 'delete', path: 'a.txt' }], 'a heredoc wrapper is read as Codex reads it');
  assert.deepEqual(parsePatch('*** Begin Patch\n*** End Patch'), []);
});

test('the patch parser refuses what Codex refuses', () => {
  const refused = [
    'not a patch',
    '*** Begin Patch\n*** Add File: a.txt\n+x',
    '*** Begin Patch\n*** Update File: a.txt\n*** End Patch',
    '*** Begin Patch\n*** Update File: a.txt\n@@\n*** End Patch',
    '*** Begin Patch\n*** Update File: a.txt\nnot a change line\n*** End Patch',
    '*** Begin Patch\n*** Add File: a.txt\nno plus\n*** End Patch',
    '*** Begin Patch\n*** Frobnicate File: a.txt\n*** End Patch',
    '*** Begin Patch\n*** Environment ID: one\n*** Environment ID: two\n*** End Patch',
  ];
  for (const text of refused) assert.throws(() => parsePatch(text), /patch/i, JSON.stringify(text));
});

test("chunks apply in order, at their @@ line, matching exactly, then without trailing space, then trimmed, as Codex's seek does", () => {
  const before = 'a\nfunction f() {\n  x = 1;\n}\nfunction g() {\n  x = 1;\n}\n';
  const [{ chunks }] = parsePatch(codexPatch([{ update: 'f', chunks: [{ context: 'function g() {', lines: ['-  x = 1;', '+  x = 2;'] }] }]));
  assert.equal(applyChunks(before, chunks), 'a\nfunction f() {\n  x = 1;\n}\nfunction g() {\n  x = 2;\n}\n');
  const loose = parsePatch(codexPatch([{ update: 'f', chunks: [{ lines: ['-x = 1;', '+y'] }] }]))[0].chunks;
  assert.equal(applyChunks('  x = 1;   \n', loose), 'y\n');
  const end = parsePatch(codexPatch([{ update: 'f', chunks: [{ context: '', lines: ['-z', '+w'], eof: true }] }]))[0].chunks;
  assert.equal(applyChunks('z\nq\nz\n', end), 'z\nq\nw\n', 'an End of File chunk matches at the end');
  const add = parsePatch(codexPatch([{ update: 'f', chunks: [{ lines: ['+more'] }] }]))[0].chunks;
  assert.equal(applyChunks('one\n', add), 'one\nmore\n', 'a chunk with no old lines appends');
  assert.equal(applyChunks('one\n', loose), null, "a chunk that isn't found gives null");
});

test('a patch over two covered files gives one deny naming both, and the same patch again passes', t => {
  const v = codexVault(t);
  const sid = sessionId();
  hook(v, 'session-start', codexInput('SessionStart', { session_id: sid, cwd: v.project }));
  const ops = ['src/a.zq', 'src/b.zq'].map(rel => ({ update: rel, chunks: [{ lines: ['-a', '+set x to 1'] }] }));
  const why = denied(hook(v, 'edit', patchCall(sid, v.project, ops))) ?? '';
  assert.match(why, /^Taste rules apply to src\/a\.zq:/);
  assert.match(why, /\n\nTaste rules apply to src\/b\.zq:/);
  assert.equal(hook(v, 'edit', patchCall(sid, v.project, ops)), null);
});

test('a move is gated on both paths, and a malformed patch fails loudly', t => {
  const v = codexVault(t);
  const sid = sessionId();
  const why = denied(hook(v, 'edit', patchCall(sid, v.project, [{ update: 'docs/a.txt', moveTo: 'src/a.zq', chunks: [{ lines: ['-a', '+set x to 1'] }] }]))) ?? '';
  assert.match(why, /^Taste rules apply to src\/a\.zq:/);
  const r = run(v, 'edit', patchCall(sid, v.project, '*** Begin Patch\n*** Update File: src/a.zq\n*** End Patch'));
  assert.equal(r.code, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /^vault edit failed: [^\n]*is empty[^\n]*; see \.state\/errors\.log\n$/);
});

test("after() on wiki notes: dropping the user's words is refused, notes under ## Agent notes pass, and an unfound chunk refuses a user's page", t => {
  const v = codexVault(t);
  const sid = sessionId();
  const said = '- 2026-10-01 · session 1a2b3c4d · "the cards breathe"';
  v.write('raw/refs/cards.md', 'Cards.\n');
  v.write('wiki/glim/sources/source-cards.md', sourcePage({ source: 'raw/refs/cards.md', body: ['## You said', said, '', "## Agent's reading", 'Roomy cards.', '', '## Rules'] }));
  v.write('wiki/glim/concepts/mine.md', pageNote({ kind: 'concept', extra: ['author: user'], body: ['My words.', '', '## Agent notes', '- first note'] }));
  const edit = ops => hook(v, 'edit', patchCall(sid, v.root, ops));
  const dropped = denied(edit([{ update: 'wiki/glim/sources/source-cards.md', chunks: [{ context: '## You said', lines: [`-${said}`] }] }])) ?? '';
  assert.match(dropped, /This edit removes the user's words or a rule's evidence from wiki\/glim\/sources\/source-cards\.md/);
  assert.equal(edit([{ update: 'wiki/glim/concepts/mine.md', chunks: [{ context: '## Agent notes', lines: [' - first note', '+- second note'] }] }]), null);
  const unfound = denied(edit([{ update: 'wiki/glim/concepts/mine.md', chunks: [{ lines: ['-not in the page', '+x'] }] }])) ?? '';
  assert.match(unfound, /wiki\/glim\/concepts\/mine\.md is the user's own writing/);
  const deleted = denied(edit([{ delete: 'wiki/glim/concepts/mine.md' }])) ?? '';
  assert.match(deleted, /wiki\/glim\/concepts\/mine\.md is the user's own writing/, 'a delete leaves the page empty');
});

test('Stop continues the turn with decision block, and the continuation is neither a turn nor the user\'s words', async t => {
  const v = codexVault(t);
  gitProject(v);
  const sid = sessionId();
  hook(v, 'session-start', codexInput('SessionStart', { session_id: sid, cwd: v.project }));
  hook(v, 'prompt', codexInput('UserPromptSubmit', { session_id: sid, cwd: v.project, prompt: 'write it with a script' }));
  fs.mkdirSync(path.join(v.project, 'src'));
  fs.writeFileSync(path.join(v.project, 'src', 'a.zq'), 'set x to 1\n');
  const r = run(v, 'stop', codexInput('Stop', { session_id: sid, cwd: v.project }));
  assert.equal(r.code, 0, r.stderr);
  const reason = [LEAD, 'src/a.zq:', ZQ_LINE].join('\n');
  assert.equal(r.stdout, `{"decision":"block","reason":${JSON.stringify(reason)}}`);
  const turn = () => v.read(`.state/turns/${sid}/started.json`);
  const stamped = turn();
  const again = run(v, 'prompt', codexInput('UserPromptSubmit', { session_id: sid, cwd: v.project, prompt: reason, turn_id: 'turn-2' }));
  assert.equal(again.code, 0, again.stderr);
  assert.equal(again.stdout, '', 'the continuation gets no excerpts');
  assert.equal(turn(), stamped, "the continuation doesn't restamp the turn");
  const { typedMessages } = await v.import('adapters/codex/adapter.mjs');
  assert.deepEqual(typedMessages(codexRollout(v, sid, ['write it with a script', reason])), ['write it with a script']);
});

test("the provider keeps user.text, drops injected kinds and the question reply, and refuses a format it doesn't know", async t => {
  const v = codexVault(t);
  const sid = sessionId();
  const { typedMessages } = await v.import('adapters/codex/adapter.mjs');
  const file = codexRollout(v, sid, [
    { kinds: ['agents_md.instructions'], text: '# AGENTS.md' },
    { kinds: ['environments.context'], text: '<environment_context>cwd</environment_context>' },
    { kinds: ['additional_content.hook'], text: 'Taste rules that may apply' },
    { kinds: ['user.text'], text: '<send_user_message_question_reply>B, Shelf</send_user_message_question_reply>' },
    { kinds: ['user.text', 'agents_md.instructions'], text: 'mixed' },
    'Keep the grid gap at eight.',
    { role: 'assistant', kinds: null, text: 'Done.' },
    'and the tabs roomy',
  ]);
  assert.deepEqual(typedMessages(file), ['Keep the grid gap at eight.', 'and the tabs roomy']);
  assert.equal(typedMessages(codexRollout(v, sid, ['typed', { kinds: null, text: 'a user message with no kinds' }])), null);
  assert.equal(typedMessages(v.at('.transcripts', 'missing.jsonl')), null);
});

test('SessionStart source maps to the reason, an unknown one read as new', async t => {
  const v = codexVault(t);
  const { events } = await v.import('adapters/codex/adapter.mjs');
  const reason = source => events('session-start', codexInput('SessionStart', { source }))[0].reason;
  assert.deepEqual(['startup', 'resume', 'clear', 'compact', 'fork'].map(reason), ['new', 'resume', 'clear', 'compact', 'new']);
});

const snippet = vault => `{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "node \\"${vault}/.live/tools/adapters/codex/launch.mjs\\" session-start 10", "timeout": 10, "additionalContextLimit": 4000 }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "node \\"${vault}/.live/tools/adapters/codex/launch.mjs\\" prompt 10", "timeout": 10, "additionalContextLimit": 4000 }] }],
    "PreToolUse": [{ "matcher": "apply_patch|mcp__.*", "hooks": [{ "type": "command", "command": "node \\"${vault}/.live/tools/adapters/codex/launch.mjs\\" edit 10", "timeout": 10 }] }],
    "SubagentStart": [{ "hooks": [{ "type": "command", "command": "node \\"${vault}/.live/tools/adapters/codex/launch.mjs\\" subagent-start 10", "timeout": 10, "additionalContextLimit": 4000 }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "node \\"${vault}/.live/tools/adapters/codex/launch.mjs\\" stop 10", "timeout": 10 }] }]
  }
}`;
const WHERE = 'Merge this into ~/.codex/hooks.json, then open /hooks in Codex and trust the five vault hooks. Codex skips them until you do.';

test('node tools/agents.mjs codex prints the hooks.json snippet byte for byte, which parses with the five events', async t => {
  const v = codexVault(t);
  const { registration } = await v.import('adapters/codex/adapter.mjs');
  for (const root of ['/srv/vaults/taste', 'C:/Users/Lowle/My Vaults/taste']) {
    const { where, text } = registration(root);
    assert.equal(text, snippet(root));
    assert.equal(where, WHERE);
    const hooks = JSON.parse(text).hooks;
    assert.deepEqual(Object.keys(hooks), ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'SubagentStart', 'Stop']);
    assert.equal(hooks.PreToolUse[0].hooks[0].command, `node "${root}/.live/tools/adapters/codex/launch.mjs" edit 10`);
  }
  const r = v.run('agents.mjs', ['codex']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, `${snippet(v.root.replace(/\\/g, '/'))}\n\n${WHERE}\n`);
  const none = v.run('agents.mjs', ['nope']);
  assert.equal(none.code, 2);
  assert.match(none.stderr, /^Usage: node tools\/agents\.mjs <agent>/);
});

test('the launcher runs the hook it names, and fails loudly through runHook for a name that is no hook', t => {
  const v = codexVault(t);
  const sid = sessionId();
  const launch = (name, input) => v.run('adapters/codex/launch.mjs', [name, '10'], { input, cwd: v.project });
  const ok = launch('session-start', codexInput('SessionStart', { session_id: sid, cwd: v.project }));
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(JSON.parse(ok.stdout).hookSpecificOutput.additionalContext, /glim\/always-rule/);
  const bad = launch('nope', codexInput('Stop', { session_id: sid, cwd: v.project }));
  assert.equal(bad.code, 1);
  assert.equal(bad.stdout, '');
  assert.match(bad.stderr, /^vault nope failed: [^\n]+; see \.state\/errors\.log\n$/);
});

test('every codexInput payload, and every output the adapter writes, fits the copied 0.153.4 schemas', async t => {
  const v = codexVault(t);
  for (const event of Object.keys(EVENTS)) assert.deepEqual(misfits(schema(event, 'input'), codexInput(event)), [], event);
  assert.deepEqual(misfits(schema('PreToolUse', 'input'), codexInput('PreToolUse', { agent_id: 'a', agent_type: 'default' })), []);
  assert.deepEqual(misfits(schema('Stop', 'input'), { ...codexInput('Stop'), extra: 1 }), ['$.extra isn\'t allowed'], 'the check sees an extra field');
  const { output } = await v.import('adapters/codex/adapter.mjs');
  const outputs = {
    SessionStart: output('session-start', [{ context: 'a' }]),
    UserPromptSubmit: output('prompt', [{ context: 'a' }]),
    SubagentStart: output('subagent-start', [{ context: 'a' }]),
    PreToolUse: output('edit', [{ deny: 'a' }, null, { deny: 'b' }]),
    Stop: output('stop', [{ context: 'a' }]),
  };
  for (const [event, out] of Object.entries(outputs)) assert.deepEqual(misfits(schema(event, 'output'), out), [], event);
  assert.equal(outputs.PreToolUse.hookSpecificOutput.permissionDecisionReason, 'a\n\nb');
  for (const hookName of ['session-start', 'prompt', 'edit', 'subagent-start', 'stop']) assert.equal(output(hookName, [null]), null, hookName);
});

test('a Codex rule on an MCP tool is refused once, and a tool Codex never sends the hook gives no event', async t => {
  const v = codexVault(t);
  const sid = sessionId();
  v.write('wiki/glim/rules/mcp-rule.md', ruleNote({ topic: 'layout', extra: ['tools:', "  - 'mcp__fixture__ask'"], doLine: 'Ask with options.' }));
  const call = tool => hook(v, 'edit', codexInput('PreToolUse', { session_id: sid, cwd: v.project, tool_name: tool, tool_input: { q: 'which?' } }));
  assert.match(denied(call('mcp__fixture__ask')) ?? '', /glim\/mcp-rule: Do: Ask with options\./);
  assert.equal(call('mcp__fixture__ask'), null);
  assert.equal(call('Bash'), null);
  const { events, sends } = await v.import('adapters/codex/adapter.mjs');
  assert.deepEqual(events('edit', codexInput('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } })), []);
  assert.deepEqual(['apply_patch', 'mcp__x__y', 'Bash', 'Edit'].map(sends), [true, true, false, false]);
});
