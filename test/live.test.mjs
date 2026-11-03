import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeVault, ruleNote, sessionId, cleanEnv } from './fixture.mjs';

const HOOKS = path.resolve(import.meta.dirname, '..', '.githooks');

test('a copy of tools/ inside the vault reads and writes the vault, and names tools rather than scripts', t => {
  const v = makeVault(t);
  v.write('wiki/glim/rules/said.md', ruleNote({ always: true, doLine: 'Zebra quartz mango.' }));
  fs.cpSync(v.at('tools'), v.at('.live', 'tools'), { recursive: true });
  const r = spawnSync(process.execPath, [v.at('.live', 'tools', 'hooks', 'session-start.mjs')], {
    input: JSON.stringify({ session_id: sessionId(), cwd: v.project, hook_event_name: 'SessionStart', source: 'startup' }), env: cleanEnv(), encoding: 'utf8',
  });
  const context = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  assert.match(context, /Zebra quartz mango\./);
  assert.match(context, /vault's `propose` tool/);
  assert.ok(!context.includes('.mjs'), 'the start hook names tools, not script paths');
  assert.ok(fs.existsSync(v.at('.state', 'sessions')));
  assert.ok(!fs.existsSync(v.at('.live', '.state')));
});

test('post-commit keeps .live/tools at the last commit', t => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-git-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  // The pre-commit hook runs these tests with GIT_INDEX_FILE and the like set for the vault's own commit.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: repo, env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  fs.mkdirSync(path.join(repo, 'hooks'));
  fs.copyFileSync(path.join(HOOKS, 'post-commit'), path.join(repo, 'hooks', 'post-commit'));
  git('init', '-q');
  git('config', 'core.hooksPath', 'hooks');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  const tool = (...xs) => path.join(repo, ...xs, 'tools', 'hooks', 'a.mjs');
  const live = () => fs.readFileSync(tool('.live'), 'utf8').replace(/\r\n/g, '\n');
  fs.mkdirSync(path.dirname(tool()), { recursive: true });
  fs.writeFileSync(tool(), 'one\n');
  git('add', 'tools');
  git('commit', '-q', '-m', 'one');
  assert.equal(live(), 'one\n');
  fs.writeFileSync(tool(), 'half-written\n');
  git('commit', '-q', '--allow-empty', '-m', 'empty');
  assert.equal(live(), 'one\n');
  git('commit', '-q', '-am', 'two');
  assert.equal(live(), 'half-written\n');
  assert.deepEqual(fs.readdirSync(path.join(repo, '.live')), ['tools']);
});
