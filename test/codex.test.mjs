import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { makeVault, ruleNote, pageNote, sourcePage, sessionId, cleanEnv } from './fixture.mjs';
import { codexInput, codexPatch, codexRollout, hookPrompt } from './codex.mjs';
import { parsePatch, applyChunks } from '../tools/adapters/codex/patch.mjs';

const SCHEMAS = path.join(import.meta.dirname, 'fixtures', 'codex', 'schema');
const EVENTS = { SessionStart: 'session-start', UserPromptSubmit: 'user-prompt-submit', PreToolUse: 'pre-tool-use', SubagentStart: 'subagent-start', Stop: 'stop' };
const schema = (event, side) => JSON.parse(fs.readFileSync(path.join(SCHEMAS, `${EVENTS[event]}.command.${side}.schema.json`), 'utf8'));
const ZQ_LINE = '- glim/zq-trigger: Do: Set values through a named step. Not: Set a value inline. Because: The user traces values by step name.';
const LEAD = 'Rules apply to a file this turn wrote. Re-read the change against them before you stop.';

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
  const spaced = '*** Begin Patch\n*** Add File:   a.txt\n+x\n*** Update File:  b.txt\n*** Move to:  c.txt\n@@\n-y\n+z\n*** End Patch';
  assert.deepEqual(parsePatch(spaced).map(op => [op.path, op.moveTo]), [['  a.txt', undefined], [' b.txt', ' c.txt']],
    'spaces between the marker and the path stay part of the path, as Codex reads it');
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
  const twoAdds = parsePatch(codexPatch([{ update: 'f', chunks: [{ context: '', lines: ['+A'] }, { context: '', lines: ['+B'] }] }]))[0].chunks;
  assert.equal(applyChunks('one\n', twoAdds), 'one\nA\nB\n', 'insertions at the same line keep the patch order');
  assert.equal(applyChunks('one\n', loose), null, "a chunk that isn't found gives null");
});

test('a patch over two covered files gives one deny naming both, and the same patch again passes', t => {
  const v = codexVault(t);
  const sid = sessionId();
  hook(v, 'session-start', codexInput('SessionStart', { session_id: sid, cwd: v.project }));
  const ops = ['src/a.zq', 'src/b.zq'].map(rel => ({ update: rel, chunks: [{ lines: ['-a', '+set x to 1'] }] }));
  const why = denied(hook(v, 'edit', patchCall(sid, v.project, ops))) ?? '';
  assert.match(why, /^Rules apply to src\/a\.zq:/);
  assert.match(why, /\n\nRules apply to src\/b\.zq:/);
  assert.equal(hook(v, 'edit', patchCall(sid, v.project, ops)), null);
});

test('a move is gated on both paths, and a malformed patch fails loudly', t => {
  const v = codexVault(t);
  const sid = sessionId();
  const why = denied(hook(v, 'edit', patchCall(sid, v.project, [{ update: 'docs/a.txt', moveTo: 'src/a.zq', chunks: [{ lines: ['-a', '+set x to 1'] }] }]))) ?? '';
  assert.match(why, /^Rules apply to src\/a\.zq:/);
  const r = run(v, 'edit', patchCall(sid, v.project, '*** Begin Patch\n*** Update File: src/a.zq\n*** End Patch'));
  assert.equal(r.code, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /^vault edit failed: [^\n]*is empty[^\n]*; see \.state\/errors\.log\n$/);
});

test("a move deletes its source and gives the destination the source's new text, and hunks on one path apply in order", async t => {
  const v = codexVault(t);
  const { events } = await v.import('adapters/codex/adapter.mjs');
  fs.mkdirSync(path.join(v.project, 'docs'));
  fs.writeFileSync(path.join(v.project, 'docs', 'a.txt'), 'a\nkeep\n');
  const edits = ops => events('edit', patchCall('s', v.project, ops)).map(e => ({ path: e.target.path, added: e.added, after: e.after }));
  const [source, dest] = edits([{ update: 'docs/a.txt', moveTo: 'src/b.txt', chunks: [{ lines: ['-a', '+set x to 1'] }] }]);
  assert.deepEqual([source.path, source.added, source.after('a\nkeep\n')], ['docs/a.txt', '', '']);
  assert.deepEqual([dest.path, dest.added, dest.after('what was at the destination\n')], ['src/b.txt', 'set x to 1', 'set x to 1\nkeep\n']);
  const [, gone] = edits([{ update: 'docs/missing.txt', moveTo: 'src/b.txt', chunks: [{ lines: ['-a', '+b'] }] }]);
  assert.equal(gone.after(''), null, "a source that can't be read gives null");
  const [added, updated] = edits([{ add: 'src/n.txt', lines: ['one'] }, { update: 'src/n.txt', chunks: [{ lines: [' one', '+two'] }] }]);
  assert.deepEqual([added.after(''), updated.after('')], ['one\n', 'one\ntwo\n'], 'an update after an add applies to the added text');
  const [, second] = edits([{ update: 'docs/a.txt', chunks: [{ lines: ['-a', '+A'] }] }, { update: 'docs/a.txt', chunks: [{ lines: ['-A', '+Z'] }] }]);
  assert.equal(second.after('a\nkeep\n'), 'Z\nkeep\n', 'the second update applies to the first one\'s result');
  const [, , , moved] = edits([{ update: 'docs/a.txt', chunks: [{ lines: ['-keep', '+kept'] }] }, { delete: 'src/b.txt' }, { update: 'docs/a.txt', moveTo: 'src/b.txt', chunks: [{ lines: ['-a', '+b'] }] }]);
  assert.equal(moved.after(''), 'b\nkept\n', 'a move carries the earlier updates of its source');
  const [, readded] = edits([{ delete: 'docs/a.txt' }, { add: 'docs/a.txt', lines: ['fresh'] }]);
  assert.equal(readded.after('a\nkeep\n'), 'fresh\n');
});

test('a move onto a page and an add then update on a page are guarded as the text Codex writes', t => {
  const v = codexVault(t);
  const sid = sessionId();
  const said = '- 2026-10-01 · session 1a2b3c4d · "the cards breathe"';
  v.write('raw/refs/cards.md', 'Cards.\n');
  v.write('wiki/glim/sources/source-cards.md', sourcePage({ source: 'raw/refs/cards.md', body: ['## You said', said, '', "## Agent's reading", 'Roomy cards.', '', '## Rules'] }));
  v.write('wiki/glim/concepts/x.md', pageNote({ kind: 'concept', body: ['Something else entirely.'] }));
  const edit = ops => hook(v, 'edit', patchCall(sid, v.root, ops));
  const over = denied(edit([{ update: 'wiki/glim/concepts/x.md', moveTo: 'wiki/glim/sources/source-cards.md', chunks: [{ context: '', lines: ['+more'] }] }])) ?? '';
  assert.match(over, /This edit removes the user's words or a rule's evidence from wiki\/glim\/sources\/source-cards\.md/);
  const page = ['---', 'kind: concept', 'domain: glim', '---', 'Body.'];
  const claimed = denied(edit([{ add: 'wiki/glim/concepts/n.md', lines: page }, { update: 'wiki/glim/concepts/n.md', chunks: [{ lines: [' domain: glim', '+author: user'] }] }])) ?? '';
  assert.match(claimed, /wiki\/glim\/concepts\/n\.md would be marked author: user/);
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
  assert.deepEqual(typedMessages(codexRollout(v, sid, ['write it with a script', hookPrompt(reason), 'and keep it short'])), ['write it with a script', 'and keep it short'],
    'the continuation as Codex records it is skipped');
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
    { kinds: ['user.text', 'user.image'], content: [{ type: 'input_text', text: 'match this shade' }, { type: 'input_image', image_url: 'data:image/png;base64,AA==' }] },
    { kinds: ['user.text', 'user.text'], content: [{ type: 'input_text', text: '<skill>' }, { type: 'input_text', text: 'two typed items' }] },
    hookPrompt('Rules apply', 'a second fragment with <tags> & "quotes"'),
  ]);
  assert.deepEqual(typedMessages(file), ['Keep the grid gap at eight.', 'and the tabs roomy', 'match this shade']);
  const { transcriptCheck } = await v.import('adapters/codex/adapter.mjs');
  assert.deepEqual(transcriptCheck(file).missing, [], "the live check doesn't count a hook prompt as a missing field");
  assert.equal(typedMessages(codexRollout(v, sid, ['typed', { kinds: null, text: 'a user message with no kinds' }])), null);
  const { content } = hookPrompt('Rules apply');
  assert.equal(typedMessages(codexRollout(v, sid, ['typed', { kinds: null, content: [...content, { type: 'input_text', text: 'not a hook prompt' }] }])), null,
    'a kind-less message is skipped only when every item is a hook prompt');
  assert.equal(typedMessages(v.at('.transcripts', 'missing.jsonl')), null);
});

test('two Codex sessions whose ids share their first 8 characters keep their own short names, inbox files and quotes', async t => {
  const v = codexVault(t);
  const [a, b] = ['019a0fb1-aaaa-7000-8000-0000aaaa0001', '019a0fb1-bbbb-7000-8000-0000bbbb0002'];
  const said = { [a]: 'keep the cards roomy', [b]: 'keep the tabs tight' };
  for (const sid of [a, b]) hook(v, 'session-start', codexInput('SessionStart', { session_id: sid, cwd: v.project, transcript_path: codexRollout(v, sid, [said[sid]]) }));
  const rule = (slug, quote, line, not) => ({ domain: 'glim', slug, topic: slug, basis: 'stated', do: `${line}.`, not: `${not}.`, because: '', applies_to: [`${slug}/**`], quote });
  for (const [sid, r] of [[a, rule('roomy-cards', said[a], 'Give cards room', 'Pack cards in')], [b, rule('tight-tabs', said[b], 'Set tabs close', 'Spread tabs out')]]) {
    const out = v.propose(sid, r);
    assert.equal(out.code, 0, out.stderr);
  }
  assert.match(v.read('wiki/glim/rules/roomy-cards.md'), /· session aaaa0001 · "keep the cards roomy"/);
  assert.match(v.read('wiki/glim/rules/tight-tabs.md'), /· session bbbb0002 · "keep the tabs tight"/);
  assert.deepEqual(fs.readdirSync(v.at('raw', 'inbox')).map(f => f.slice(11)).filter(f => /^(aaaa|bbbb|019a)/.test(f)).sort(), ['aaaa0001.jsonl', 'bbbb0002.jsonl']);
  const { transcriptFor } = await v.import('lib/sessions.mjs');
  assert.deepEqual([transcriptFor('aaaa0001')?.session, transcriptFor('bbbb0002')?.session, transcriptFor('019a0fb1')], [a, b, null]);
  v.write('raw/refs/cards.md', 'Cards.\n');
  v.write('wiki/glim/sources/source-cards.md', sourcePage({ source: 'raw/refs/cards.md', body: ['## You said', `- 2026-10-01 · session aaaa0001 · "${said[a]}"`, `- 2026-10-01 · session bbbb0002 · "${said[a]}"`, '', "## Agent's reading", '', '## Rules'] }));
  const quotes = async () => (await v.import('lib/lint.mjs')).lint().filter(f => /isn't in|can't be checked/.test(f.msg)).map(f => `${f.file}: ${f.msg}`);
  assert.deepEqual(await quotes(), [`wiki/glim/sources/source-cards.md: "${said[a]}" isn't in what the user typed in session bbbb0002. Quote their exact words, with … where you leave some out`]);
  const id = v.read('wiki/glim/rules/tight-tabs.md').match(/\((a-[0-9a-f]{8})\)/)[1];
  v.write('wiki/glim/rules/borrowed.md', ruleNote({ keywords: ['borrow'], evidence: [`- 2026-10-02 · stated · session aaaa0001 · "${said[b]}" (${id})`] }));
  for (const sid of [a, b]) fs.rmSync(v.at('.transcripts', `rollout-2026-11-01T00-00-00-${sid}.jsonl`));
  assert.deepEqual((await quotes()).filter(q => q.startsWith('wiki/glim/rules/')), [`wiki/glim/rules/borrowed.md: "${said[b]}" isn't in what row ${id} recorded for session aaaa0001: it was recorded in session bbbb0002`]);
});

test('SessionStart source maps to the reason, an unknown one read as new', async t => {
  const v = codexVault(t);
  const { events } = await v.import('adapters/codex/adapter.mjs');
  const reason = source => events('session-start', codexInput('SessionStart', { source }))[0].reason;
  assert.deepEqual(['startup', 'resume', 'clear', 'compact', 'fork'].map(reason), ['new', 'resume', 'clear', 'compact', 'new']);
});

const snippet = vault => `{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "node \\"${vault}/hooks/codex.mjs\\" session-start 10", "timeout": 10, "additionalContextLimit": 4000 }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "node \\"${vault}/hooks/codex.mjs\\" prompt 10", "timeout": 10, "additionalContextLimit": 4000 }] }],
    "PreToolUse": [
      { "matcher": "apply_patch|mcp__.*", "hooks": [{ "type": "command", "command": "node \\"${vault}/hooks/codex.mjs\\" edit 10", "timeout": 10 }] },
      { "matcher": "^mcp__vault__[a-z]+$", "hooks": [{ "type": "command", "command": "node \\"${vault}/hooks/codex.mjs\\" vault-call 10", "timeout": 10 }] }
    ],
    "SubagentStart": [{ "hooks": [{ "type": "command", "command": "node \\"${vault}/hooks/codex.mjs\\" subagent-start 10", "timeout": 10, "additionalContextLimit": 4000 }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "node \\"${vault}/hooks/codex.mjs\\" stop 10", "timeout": 10 }] }]
  }
}

[mcp_servers.vault]
command = "node"
args = ["${vault}/mcp/launch.mjs", "${vault}"]`;
const WHERE = 'Merge the JSON into ~/.codex/hooks.json and add the TOML to ~/.codex/config.toml, then open /hooks in Codex and trust the six vault hooks. Codex skips them until you do.';

test('node tools/agents.mjs codex prints the hooks.json snippet and the config.toml block byte for byte, which parse with the five events and one PreToolUse key of two groups', async t => {
  const v = codexVault(t);
  const { registration, vaultMatcher } = await v.import('adapters/codex/adapter.mjs');
  for (const root of ['/srv/vaults/taste', 'C:/Users/Lowle/My Vaults/taste']) {
    const { where, text } = registration(root);
    assert.equal(text, snippet(root));
    assert.equal(where, WHERE);
    const [json, toml] = text.split('\n\n[mcp_servers');
    assert.equal(toml, `.vault]\ncommand = "node"\nargs = ["${root}/mcp/launch.mjs", "${root}"]`);
    const hooks = JSON.parse(json).hooks;
    assert.deepEqual(Object.keys(hooks), ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'SubagentStart', 'Stop']);
    assert.equal(hooks.PreToolUse.length, 2);
    assert.equal(hooks.PreToolUse[0].hooks[0].command, `node "${root}/hooks/codex.mjs" edit 10`);
    assert.equal(hooks.PreToolUse[1].hooks[0].command, `node "${root}/hooks/codex.mjs" vault-call 10`);
    assert.equal(hooks.PreToolUse[1].matcher, vaultMatcher);
  }
  const r = v.run('agents.mjs', ['codex']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, `${snippet(v.root.replace(/\\/g, '/'))}\n\n${WHERE}\n`);
  const none = v.run('agents.mjs', ['nope']);
  assert.equal(none.code, 2);
  assert.match(none.stderr, /^Usage: node tools\/agents\.mjs <agent>/);
});

test('node tools/agents.mjs run from a worktree outside .claude/worktrees/ names the main checkout', t => {
  const v = codexVault(t);
  const env = cleanEnv({ GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: v.root, env, stdio: 'pipe' });
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'vault');
  const elsewhere = `${v.root}-ledger`;
  t.after(() => fs.rmSync(elsewhere, { recursive: true, force: true }));
  git('worktree', 'add', '-q', elsewhere);
  const r = execFileSync(process.execPath, [path.join(elsewhere, 'tools', 'agents.mjs'), 'codex'], { cwd: elsewhere, env, encoding: 'utf8' });
  assert.equal(r, `${snippet(v.root.replace(/\\/g, '/'))}\n\n${WHERE}\n`);
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

test("hooks/codex.mjs makes .live's copy at session start and runs the hook it names from it", t => {
  const v = codexVault(t);
  for (const f of ['codex.mjs', 'live.mjs']) v.write(`hooks/${f}`, fs.readFileSync(path.join(import.meta.dirname, '..', 'hooks', f), 'utf8'));
  v.checkout();
  const sid = sessionId();
  const launch = (name, input) => {
    const r = spawnSync(process.execPath, [v.at('hooks', 'codex.mjs'), name, '10'], { input: JSON.stringify(input), cwd: v.project, env: cleanEnv(), encoding: 'utf8' });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const ok = launch('session-start', codexInput('SessionStart', { session_id: sid, cwd: v.project }));
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(JSON.parse(ok.stdout).hookSpecificOutput.additionalContext, /glim\/always-rule/);
  const tree = execFileSync('git', ['rev-parse', 'HEAD:tools'], { cwd: v.root, env: cleanEnv(), encoding: 'utf8' }).trim();
  assert.equal(fs.readFileSync(v.at('.live', 'current'), 'utf8').trim(), tree);
  const bad = launch('nope', codexInput('Stop', { session_id: sid, cwd: v.project }));
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /^vault nope failed: [^\n]+; see \.state\/errors\.log\n$/, 'the hook name reaches the copy\'s launch.mjs');
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
