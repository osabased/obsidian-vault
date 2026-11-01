import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeVault, cleanEnv, sessionId } from './fixture.mjs';
import { matcher as EDIT_HOOK_MATCHER } from '../tools/adapters/claude-code/adapter.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const LAUNCHER = path.join(ROOT, 'hooks', 'launch.mjs');
const hooksJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks', 'hooks.json'), 'utf8'));
const commands = Object.entries(hooksJson.hooks).flatMap(([event, groups]) => groups.flatMap(g => g.hooks.map(h => ({ event, matcher: g.matcher, ...h }))));

test('hooks.json starts each hook through the launcher in exec form, with its timeout as the launcher arg', () => {
  assert.deepEqual(Object.keys(hooksJson.hooks).sort(), ['PreToolUse', 'SessionStart', 'Stop', 'SubagentStart', 'UserPromptSubmit']);
  assert.equal(commands.length, 5, 'one command per event');
  for (const c of commands) {
    assert.equal(c.type, 'command');
    assert.equal(c.command, 'node', `${c.event} runs node with no shell`);
    assert.equal(c.args.length, 3, c.event);
    assert.equal(c.args[0], '${CLAUDE_PLUGIN_ROOT}/hooks/launch.mjs');
    assert.ok(Number.isFinite(c.timeout) && c.timeout > 0, `${c.event} has a timeout`);
    assert.equal(c.args[2], String(c.timeout), `${c.event}: the arg and the timeout agree`);
  }
  assert.deepEqual(commands.map(c => c.args[1]).sort(), ['edit', 'prompt', 'session-start', 'stop', 'subagent-start']);
  const tools = fs.readdirSync(path.join(ROOT, 'tools', 'adapters', 'claude-code', 'hooks')).map(f => f.replace(/\.mjs$/, ''));
  for (const name of tools) assert.ok(commands.some(c => c.args[1] === name), `tools/adapters/claude-code/hooks/${name}.mjs has an event`);
});

test('hooks.json gives only the edit hook a matcher, the one it ships with', () => {
  const edit = commands.filter(c => c.args[1] === 'edit');
  assert.deepEqual(edit.map(c => [c.event, c.matcher]), [['PreToolUse', EDIT_HOOK_MATCHER]]);
  assert.deepEqual(commands.filter(c => c.matcher !== undefined).map(c => c.event), ['PreToolUse']);
  assert.equal(EDIT_HOOK_MATCHER, '^(?:Edit|Write|MultiEdit|NotebookEdit|AskUserQuestion|mcp__.*)$');
});

// Claude Code tests a matcher that isn't a plain list of names as an unanchored regex, so the matcher anchors itself.
test('the edit hook\'s matcher, read as Claude Code reads it, sends the file tools, AskUserQuestion and MCP tools, and nothing else', () => {
  const sends = new RegExp(EDIT_HOOK_MATCHER);
  const sent = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'AskUserQuestion', 'mcp__fixture__set_property', 'TodoWrite', 'Bash', 'NotebookEditor', 'xmcp__fixture__x'].filter(n => sends.test(n));
  assert.deepEqual(sent, ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'AskUserQuestion', 'mcp__fixture__set_property']);
});

test('plugin.json asks for the vault folder', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.userConfig.vault.type, 'directory');
  assert.ok(manifest.userConfig.vault.title && manifest.userConfig.vault.description);
});

function launch(hook, { vault, timeout, input = '{}' } = {}) {
  const env = cleanEnv({});
  delete env.CLAUDE_PLUGIN_OPTION_VAULT;
  if (vault) env.CLAUDE_PLUGIN_OPTION_VAULT = vault;
  const r = spawnSync(process.execPath, [LAUNCHER, ...(hook === undefined ? [] : [hook]), ...(timeout === undefined ? [] : [timeout])], { env, input, encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

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
  assert.match(JSON.parse(started.stdout).hookSpecificOutput.additionalContext, /^Taste vault/);
  assert.ok(v.exists('.state/sessions'), 'the hook wrote to the vault it was pointed at');
  const edit = { session_id: sessionId(), cwd: v.project, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(v.project, 'src', 'a.txt'), old_string: 'a', new_string: 'b' } };
  const late = launch('edit', { vault: v.root, timeout: '0.001', input: JSON.stringify(edit) });
  assert.equal(late.code, 1);
  assert.equal(late.stderr, 'vault edit failed: stopped at its deadline, 0.0002 s before the 0.001 s hook timeout; see .state/errors.log\n');
});

test('the launcher fails loudly: one stderr line, exit 1', t => {
  const v = makeVault(t);
  const failures = [
    ['an unset vault option', launch('prompt'), /^vault prompt failed: the plugin's vault option is not set; run claude plugin configure obsidian-vault\n$/],
    ['a vault with no .live/tools', launch('prompt', { vault: v.root }), /^vault prompt failed: .*\.live[\\/]tools does not exist; run \.githooks\/post-commit in the vault to make it\n$/],
    ['an unknown hook name', launch('../prompt', { vault: v.root }), /^vault \.\.\/prompt failed: no hook of that name, only session-start, prompt, edit, stop, subagent-start\n$/],
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
  assert.match(missing.stderr, /^vault edit failed: .*edit\.mjs does not exist; commit the vault's tools\/ so post-commit copies it\n$/);
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
  assert.match(r.stderr, /^vault prompt failed: the plugin's vault option "some\/vault" is not an absolute path; run claude plugin configure obsidian-vault\n$/);
  assert.ok(!v.exists('.state/sessions'));
});
