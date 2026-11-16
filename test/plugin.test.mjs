import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { makeVault, cleanEnv, sessionId } from './fixture.mjs';
import { matcher as EDIT_HOOK_MATCHER, vaultMatcher as VAULT_HOOK_MATCHER } from '../tools/adapters/claude-code/adapter.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const LAUNCHER = path.join(ROOT, 'hooks', 'launch.mjs');
const hooksJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks', 'hooks.json'), 'utf8'));
const commands = Object.entries(hooksJson.hooks).flatMap(([event, groups]) => groups.flatMap(g => g.hooks.map(h => ({ event, matcher: g.matcher, ...h }))));

test('hooks.json starts each hook through the launcher in exec form, with its timeout as the launcher arg', () => {
  assert.deepEqual(Object.keys(hooksJson.hooks).sort(), ['PreToolUse', 'SessionStart', 'Stop', 'SubagentStart', 'UserPromptSubmit']);
  assert.equal(commands.length, 6, 'one command per hook');
  for (const c of commands) {
    assert.equal(c.type, 'command');
    assert.equal(c.command, 'node', `${c.event} runs node with no shell`);
    assert.equal(c.args.length, 3, c.event);
    assert.equal(c.args[0], '${CLAUDE_PLUGIN_ROOT}/hooks/launch.mjs');
    assert.ok(Number.isFinite(c.timeout) && c.timeout > 0, `${c.event} has a timeout`);
    assert.equal(c.args[2], String(c.timeout), `${c.event}: the arg and the timeout agree`);
  }
  assert.deepEqual(commands.map(c => c.args[1]).sort(), ['edit', 'prompt', 'session-start', 'stop', 'subagent-start', 'vault-call']);
  const tools = fs.readdirSync(path.join(ROOT, 'tools', 'adapters', 'claude-code', 'hooks')).map(f => f.replace(/\.mjs$/, ''));
  for (const name of tools) assert.ok(commands.some(c => c.args[1] === name), `tools/adapters/claude-code/hooks/${name}.mjs has an event`);
});

test('hooks.json gives only the edit and vault-call hooks a matcher, the ones their adapter ships with', () => {
  const edit = commands.filter(c => c.args[1] === 'edit');
  assert.deepEqual(edit.map(c => [c.event, c.matcher]), [['PreToolUse', EDIT_HOOK_MATCHER]]);
  const vaultCall = commands.filter(c => c.args[1] === 'vault-call');
  assert.deepEqual(vaultCall.map(c => [c.event, c.matcher, c.onFailure]), [['PreToolUse', VAULT_HOOK_MATCHER, 'block']]);
  assert.deepEqual(commands.filter(c => c.matcher !== undefined).map(c => c.event), ['PreToolUse', 'PreToolUse']);
  assert.deepEqual(commands.filter(c => c.onFailure !== undefined).map(c => c.args[1]), ['vault-call']);
  assert.equal(EDIT_HOOK_MATCHER, '^(?:Edit|Write|MultiEdit|NotebookEdit|AskUserQuestion|mcp__.*)$');
});

// Claude Code tests a matcher that isn't a plain list of names as an unanchored regex, so the matcher anchors itself.
test('the edit hook\'s matcher, read as Claude Code reads it, sends the file tools, AskUserQuestion and MCP tools, and nothing else', () => {
  const sends = new RegExp(EDIT_HOOK_MATCHER);
  const sent = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'AskUserQuestion', 'mcp__fixture__set_property', 'TodoWrite', 'Bash', 'NotebookEditor', 'xmcp__fixture__x'].filter(n => sends.test(n));
  assert.deepEqual(sent, ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'AskUserQuestion', 'mcp__fixture__set_property']);
});

test("the vault-call matcher, read as Claude Code reads it, sends the vault's tools whether the plugin or claude mcp add started the server, and nothing else", () => {
  const sends = new RegExp(VAULT_HOOK_MATCHER);
  const sent = ['mcp__plugin_obsidian-vault_vault__keep', 'mcp__vault__propose', 'mcp__plugin_obsidian-vault_vault__', 'mcp__other__keep', 'xmcp__vault__keep', 'mcp__vault__keep2', 'mcp__plugin_other_vault__keep', 'Bash'].filter(n => sends.test(n));
  assert.deepEqual(sent, ['mcp__plugin_obsidian-vault_vault__keep', 'mcp__vault__propose']);
});

test('plugin.json asks for the vault folder', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.userConfig.vault.type, 'directory');
  assert.ok(manifest.userConfig.vault.title && manifest.userConfig.vault.description);
});

function launchEnv(vault, extra) {
  const env = cleanEnv(extra);
  delete env.CLAUDE_PLUGIN_OPTION_VAULT;
  if (vault) env.CLAUDE_PLUGIN_OPTION_VAULT = vault;
  return env;
}

function launch(hook, { vault, timeout, input = '{}', env } = {}) {
  const r = spawnSync(process.execPath, [LAUNCHER, ...(hook === undefined ? [] : [hook]), ...(timeout === undefined ? [] : [timeout])], { env: launchEnv(vault, env), input, encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function launchAsync(hook, { vault, input = '{}' } = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [LAUNCHER, hook], { env: launchEnv(vault) });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', d => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', d => { stderr += d; });
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

const startInput = (v, sid = sessionId()) => JSON.stringify({ session_id: sid, cwd: v.project, hook_event_name: 'SessionStart', source: 'startup' });

function liveVault(t) {
  const v = makeVault(t);
  fs.cpSync(v.at('tools'), v.at('.live', 'tools'), { recursive: true });
  return v;
}

test('the launcher runs the hook from the vault, with the timeout it was given', t => {
  const v = liveVault(t);
  v.write('wiki/glim/rules/gate.md', '---\ntype: rule\ndomain: glim\nkind: taste\nbasis: stated\ntopic: code\nalways: false\napplies_to:\n  - "src/**"\ntriggers: []\nkeywords: []\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n\n**Do:** Do it.\n**Not:** Not it.\n**Because:**\n');
  const started = launch('session-start', { vault: v.root, input: JSON.stringify({ session_id: sessionId(), cwd: v.project, hook_event_name: 'SessionStart', source: 'startup' }) });
  assert.equal(started.code, 0, started.stderr);
  assert.match(JSON.parse(started.stdout).hookSpecificOutput.additionalContext, /^Vault/);
  assert.ok(v.exists('.state/sessions'), 'the hook wrote to the vault it was pointed at');
  const edit = { session_id: sessionId(), cwd: v.project, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(v.project, 'src', 'a.txt'), old_string: 'a', new_string: 'b' } };
  const late = launch('edit', { vault: v.root, timeout: '0.001', input: JSON.stringify(edit) });
  assert.equal(late.code, 1);
  assert.equal(late.stderr, 'vault edit failed: stopped at its deadline, 0.0002 s before the 0.001 s hook timeout; see .state/errors.log\n');
});

test('the launcher fails loudly: one stderr line, exit 1', t => {
  const v = makeVault(t);
  const failures = [
    ['an unset vault option', launch('prompt'), /^vault prompt failed: the plugin's vault option is not set; run claude plugin configure obsidian-vault@obsidian-vault\n$/],
    ['an unknown hook name', launch('../prompt', { vault: v.root }), /^vault \.\.\/prompt failed: no hook of that name, only session-start, prompt, edit, stop, subagent-start, vault-call\n$/],
    ['no hook name', launch(undefined, { vault: v.root }), /^vault {2}failed: no hook of that name/],
  ];
  for (const [what, r, line] of failures) {
    assert.equal(r.code, 1, what);
    assert.equal(r.stdout, '', what);
    assert.match(r.stderr, line, what);
  }
  fs.mkdirSync(v.at('.live', 'tools', 'adapters', 'claude-code', 'hooks'), { recursive: true });
  const missing = launch('edit', { vault: v.root });
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /^vault edit failed: .*edit\.mjs does not exist; commit the vault's tools\/, then start a new session\n$/);
});

// Each of these is a folder a beginner might give the option. The advice names the vault's own fix, never a git config
// change, which run in some other folder would turn that folder's git hooks off.
test('the launcher says what is wrong with the vault folder', t => {
  const v = makeVault(t);
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-plain-'));
  const config = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-claude-config-'));
  t.after(() => { for (const dir of [plain, config]) fs.rmSync(dir, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(config, 'plugins', 'marketplaces'), { recursive: true });
  const cached = makeVault(t, { under: path.join(config, 'plugins', 'marketplaces') });
  fs.cpSync(cached.at('tools'), cached.at('.live', 'tools'), { recursive: true });
  const configure = 'run claude plugin configure obsidian-vault@obsidian-vault\n$';
  const cases = [
    ['a folder that is not there', launch('prompt', { vault: v.at('gone') }), new RegExp(`^vault prompt failed: .*gone does not exist; ${configure}`)],
    ['a file', launch('prompt', { vault: v.at('vault.config.json') }), new RegExp(`^vault prompt failed: .*vault\\.config\\.json is a file, not a folder; ${configure}`)],
    ['a folder that is not a vault', launch('prompt', { vault: plain }), new RegExp(`^vault prompt failed: .*vault-plain-\\w+ is not a vault: it needs vault\\.config\\.json and tools/; ${configure}`)],
    ['a download that is not a git clone', launch('prompt', { vault: v.root }), new RegExp(`^vault prompt failed: .*vault-test-\\w+ is not a git clone, so \\.live/tools can't be made from its last commit; clone the vault with git clone https://github\\.com/osabased/obsidian-vault instead of downloading it, and ${configure}`)],
    ["a vault in Claude Code's plugins folder", launch('prompt', { vault: cached.root, env: { CLAUDE_CONFIG_DIR: config } }), new RegExp(`^vault prompt failed: .*vault-test-\\w+ is inside Claude Code's plugins folder, which an update replaces along with any rules kept there; clone the vault to a folder of your own and ${configure}`)],
  ];
  for (const [what, r, line] of cases) {
    assert.equal(r.code, 1, what);
    assert.equal(r.stdout, '', what);
    assert.match(r.stderr, line, what);
    assert.doesNotMatch(r.stderr, /git config/, what);
  }
  assert.ok(!cached.exists('.state/sessions'), 'the vault in the plugins folder ran no hook');
});

test("the launcher makes .live/tools from the vault's last commit, without what isn't committed", t => {
  const v = makeVault(t);
  v.checkout();
  v.write('tools/half-made.mjs', 'throw new Error("half made");\n');
  const r = launch('session-start', { vault: v.root, input: startInput(v) });
  assert.equal(r.code, 0, r.stderr);
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /^Vault/);
  assert.ok(v.exists('.live/tools/adapters/claude-code/hooks/session-start.mjs'));
  assert.ok(!v.exists('.live/tools/half-made.mjs'));
  assert.deepEqual(fs.readdirSync(v.at('.live')), ['tools'], 'nothing left over beside the copy');
});

test('session start makes .live/tools again once a commit changes tools/, and the other hooks run the copy they find', t => {
  const v = makeVault(t);
  v.checkout();
  const sid = sessionId();
  assert.equal(launch('session-start', { vault: v.root, input: startInput(v, sid) }).code, 0);
  v.write('tools/added.txt', 'x\n');
  v.checkout();
  const prompted = launch('prompt', { vault: v.root, input: JSON.stringify({ session_id: sid, cwd: v.project, prompt: 'hi', hook_event_name: 'UserPromptSubmit' }) });
  assert.equal(prompted.code, 0, prompted.stderr);
  assert.ok(!v.exists('.live/tools/added.txt'));
  const started = launch('session-start', { vault: v.root, input: startInput(v) });
  assert.equal(started.code, 0, started.stderr);
  assert.ok(v.exists('.live/tools/added.txt'));
});

test('sessions that start at once make one .live/tools between them', async t => {
  const v = makeVault(t);
  v.checkout();
  const runs = await Promise.all([1, 2, 3, 4].map(() => launchAsync('session-start', { vault: v.root, input: startInput(v) })));
  for (const r of runs) assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(fs.readdirSync(v.at('.live')), ['tools'], 'nothing left over beside the copy');
  assert.ok(v.exists('.live/tools/adapters/claude-code/hooks/session-start.mjs'));
});

test('the launcher runs tools/hooks/<hook>.mjs from a .live copy made before the adapters', t => {
  const v = makeVault(t);
  v.write('.live/tools/hooks/prompt.mjs', "process.stdout.write('ran the old hook');\n");
  const r = launch('prompt', { vault: v.root });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, 'ran the old hook');
});

test('the launcher reports a hook that cannot load', t => {
  const v = makeVault(t);
  v.write('.live/tools/adapters/claude-code/hooks/prompt.mjs', 'export const = ;\n');
  const r = launch('prompt', { vault: v.root });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /^vault prompt failed: .+\n$/);
});

test('the launcher reads a Git Bash drive path as the Windows one', { skip: process.platform !== 'win32' }, t => {
  const v = liveVault(t);
  const gitBash = v.root.replaceAll('\\', '/').replace(/^([a-z]):/i, (_, d) => `/${d.toLowerCase()}`);
  assert.match(gitBash, /^\/[a-z]\//);
  const r = launch('session-start', { vault: gitBash, input: JSON.stringify({ session_id: sessionId(), cwd: v.project, hook_event_name: 'SessionStart', source: 'startup' }) });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(v.exists('.state/sessions'), 'the hook ran in the vault the path names');
});

test('the launcher refuses a vault path that is not absolute, so it cannot mean a folder per session', t => {
  const v = makeVault(t);
  const r = launch('prompt', { vault: 'some/vault' });
  assert.equal(r.code, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /^vault prompt failed: the plugin's vault option "some\/vault" is not an absolute path; run claude plugin configure obsidian-vault@obsidian-vault\n$/);
  assert.ok(!v.exists('.state/sessions'));
});

test('the install line quotes the vault path, so a path with spaces stays one argument', async () => {
  const { registration } = await import('../tools/adapters/claude-code/adapter.mjs');
  assert.match(registration('/home/ledger/my vault').text, /--config "vault=\/home\/ledger\/my vault"$/m);
});
