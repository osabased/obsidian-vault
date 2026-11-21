import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { makeVault, ruleNote, sessionId, cleanEnv } from './fixture.mjs';

const HOOKS = path.resolve(import.meta.dirname, '..', '.githooks');

test('a copy of tools/ inside the vault reads and writes the vault, and names tools rather than scripts', t => {
  const v = makeVault(t);
  v.write('wiki/glim/rules/said.md', ruleNote({ always: true, doLine: 'Zebra quartz mango.' }));
  v.makeLive();
  const r = spawnSync(process.execPath, [v.at(v.live('hooks/session-start.mjs'))], {
    input: JSON.stringify({ session_id: sessionId(), cwd: v.project, hook_event_name: 'SessionStart', source: 'startup' }), env: cleanEnv(), encoding: 'utf8',
  });
  const context = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  assert.match(context, /Zebra quartz mango\./);
  assert.match(context, /vault's `propose` tool/);
  assert.ok(!context.includes('.mjs'), 'the start hook names tools, not script paths');
  assert.ok(fs.existsSync(v.at('.state', 'sessions')));
  assert.ok(!fs.existsSync(v.at('.live', '.state')));
});

const LIVE = pathToFileURL(path.join(HOOKS, '..', 'hooks', 'live.mjs')).href;
// No process has this pid: Windows and Linux both answer ESRCH for it.
const GONE = 2147483644;

// A git vault in a temp folder with the vault's post-commit and the builder, and one tool file to change.
function gitVault(t) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-git-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  // The pre-commit hook runs these tests with GIT_INDEX_FILE and the like set for the vault's own commit.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: repo, env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  fs.mkdirSync(path.join(repo, '.githooks'));
  fs.mkdirSync(path.join(repo, 'hooks'));
  for (const f of ['post-commit', 'post-commit.mjs']) fs.copyFileSync(path.join(HOOKS, f), path.join(repo, '.githooks', f));
  fs.copyFileSync(path.join(HOOKS, '..', 'hooks', 'live.mjs'), path.join(repo, 'hooks', 'live.mjs'));
  fs.mkdirSync(path.join(repo, 'tools', 'lib'), { recursive: true });
  fs.copyFileSync(path.join(HOOKS, '..', 'tools', 'lib', 'current.mjs'), path.join(repo, 'tools', 'lib', 'current.mjs'));
  fs.writeFileSync(path.join(repo, 'vault.config.json'), '{}\n');
  fs.mkdirSync(path.join(repo, 'no-hooks'));
  fs.writeFileSync(path.join(repo, '.gitignore'), '.live/\nno-hooks/\n');
  git('init', '-q');
  git('config', 'core.hooksPath', '.githooks');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  const live = (...xs) => path.join(repo, '.live', ...xs);
  const source = path.join(repo, 'tools', 'hooks', 'a.mjs');
  fs.mkdirSync(path.dirname(source), { recursive: true });
  return {
    repo, env, git, live, source,
    current: () => fs.readFileSync(live('current'), 'utf8').trim(),
    // A commit post-commit doesn't see, so .live/current falls behind HEAD.
    quiet: (text, m) => { fs.writeFileSync(source, text); git('-c', `core.hooksPath=${path.join(repo, 'no-hooks')}`, 'commit', '-q', '-am', m); },
  };
}

test('post-commit points .live/current at a copy of tools/ as of the last commit, and prunes old copies no server holds', t => {
  const { git, live, source, current } = gitVault(t);
  const tool = () => fs.readFileSync(live(current(), 'hooks', 'a.mjs'), 'utf8').replace(/\r\n/g, '\n');
  fs.writeFileSync(source, 'one\n');
  git('add', '.');
  git('commit', '-q', '-m', 'one');
  const one = current();
  assert.equal(one, git('rev-parse', 'HEAD:tools'));
  assert.equal(tool(), 'one\n');
  fs.writeFileSync(source, 'half-written\n');
  git('commit', '-q', '--allow-empty', '-m', 'empty');
  assert.equal(tool(), 'one\n');
  git('commit', '-q', '-am', 'two');
  const two = current();
  assert.equal(tool(), 'half-written\n');
  assert.deepEqual(fs.readdirSync(live()).sort(), [one, two, 'current'].sort(), 'the copy a running server may still read stays for now');
  assert.ok(fs.existsSync(live(one, '.retired')));

  // An hour on, the next rebuild removes a retired copy, unless a server that is still running leased it.
  const hourAgo = new Date(Date.now() - 2 * 60 * 60_000);
  fs.utimesSync(live(one, '.retired'), hourAgo, hourAgo);
  fs.writeFileSync(live(one, `.lease.${GONE}`), '');
  fs.writeFileSync(source, 'three\n');
  git('commit', '-q', '-am', 'three');
  const three = current();
  assert.ok(!fs.existsSync(live(one)), 'a retired copy whose server has exited is removed');
  fs.utimesSync(live(two, '.retired'), hourAgo, hourAgo);
  fs.writeFileSync(live(two, `.lease.${process.pid}`), '');
  fs.writeFileSync(live(three, `.lease.${GONE}`), '');
  fs.writeFileSync(live(three, `.lease.${process.pid}`), '');
  fs.writeFileSync(source, 'four\n');
  git('commit', '-q', '-am', 'four');
  assert.deepEqual(fs.readdirSync(live()).sort(), [two, three, current(), 'current'].sort(), 'a copy a running server leased stays');
  assert.equal(tool(), 'four\n');
  assert.deepEqual(fs.readdirSync(live(three)).filter(f => f.startsWith('.lease.')), [`.lease.${process.pid}`], 'a lease whose server has exited goes, even on a copy still young');
});

test('a server lease goes when its process exits', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-lease-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `const m = await import(${JSON.stringify(LIVE)}); m.lease(${JSON.stringify(dir)}); if (!(await import('node:fs')).readdirSync(${JSON.stringify(dir)}).length) process.exit(3);`], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('a build that waited on the lock makes the copy of the commit HEAD names once it holds it', async t => {
  const v = gitVault(t);
  fs.writeFileSync(v.source, 'one\n');
  v.git('add', '.');
  v.git('commit', '-q', '-m', 'one');
  v.quiet('two\n', 'two');
  const lock = v.live('tools.lock');
  fs.writeFileSync(lock, '0');
  // This builder reads HEAD, at two, then waits on the lock while three is committed.
  const builder = spawn(process.execPath, ['--input-type=module', '-e', `const m = await import(${JSON.stringify(LIVE)}); m.liveTools(${JSON.stringify(v.repo)}, { fix: 'x', refresh: true, wait: 20000 });`], { env: v.env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  builder.stderr.on('data', d => { stderr += d; });
  const done = new Promise(resolve => builder.on('close', resolve));
  await new Promise(r => setTimeout(r, 1500));
  v.quiet('three\n', 'three');
  fs.rmSync(lock);
  assert.equal(await done, 0, stderr);
  assert.equal(v.current(), v.git('rev-parse', 'HEAD:tools'));
});

test('post-commit fails loudly when it can\'t make the copy, where a session keeps the old one', async t => {
  const v = gitVault(t);
  fs.writeFileSync(v.source, 'one\n');
  v.git('add', '.');
  v.git('commit', '-q', '-m', 'one');
  const one = v.live(v.current());
  v.quiet('two\n', 'two');
  fs.writeFileSync(v.live('tools.lock'), '0');
  const { liveTools } = await import(LIVE);
  assert.equal(liveTools(v.repo, { fix: 'x', refresh: true }), one);
  assert.throws(() => liveTools(v.repo, { fix: 'x', refresh: true, wait: 100, fallback: false }), /held by another process/);
});

test('a vault whose only copy is an older plugin\'s .live/tools runs it until it has a copy of its own', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-legacy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'tools'));
  fs.writeFileSync(path.join(dir, 'vault.config.json'), '{}\n');
  fs.mkdirSync(path.join(dir, '.live', 'tools'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.live', 'tools', '.tree'), `${'a'.repeat(40)}\n`);
  const { liveTools } = await import(LIVE);
  assert.equal(liveTools(dir, { fix: 'x', refresh: true }), path.join(dir, '.live', 'tools'));
});

test('pre-commit keeps the generated files out of a commit that lacks a note they are built from', t => {
  const v = makeVault(t);
  const env = cleanEnv({ GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });
  const git = (...args) => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: v.root, env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r;
  };
  const committed = () => git('show', 'HEAD:index.md').stdout;
  git('init', '-q');
  git('add', '-A');
  // The first commit holds tools/ and test/, which would start this test run again from inside the hook.
  git('commit', '-q', '--no-verify', '-m', 'base');
  fs.mkdirSync(v.at('.git', 'hooks'), { recursive: true });
  fs.copyFileSync(path.join(HOOKS, 'pre-commit'), v.at('.git', 'hooks', 'pre-commit'));

  v.write('wiki/glim/rules/zebra-rule.md', ruleNote({ always: true, doLine: 'Zebra quartz mango.' }));
  git('add', 'wiki');
  git('commit', '-q', '-m', 'a note');
  assert.ok(committed().includes('zebra-rule'), 'a commit that holds every note carries the index built from them');

  v.write('wiki/glim/rules/plover-rule.md', ruleNote({ always: true, doLine: 'Plover lantern fig.' }));
  v.write('memo.txt', 'one\n');
  git('add', 'memo.txt');
  const r = git('commit', '-m', 'a file, the new note left out');
  assert.ok(v.read('index.md').includes('plover-rule'), 'the folder keeps the index built from every note');
  assert.ok(!committed().includes('plover-rule'), 'the commit names no note it lacks');
  assert.ok(r.stderr.includes('stay out of this commit'), r.stderr);
  v.write('memo.txt', 'two\n');
  git('commit', '-q', '-am', 'every tracked change');
  assert.ok(!committed().includes('plover-rule'), 'commit -a stages the rebuilt index, and the hook takes it out again');
  v.write('memo.txt', 'three\n');
  git('commit', '-q', '-m', 'one path', '--', 'memo.txt');
  assert.ok(!committed().includes('plover-rule'));

  git('add', 'wiki');
  git('commit', '-q', '-m', 'the note');
  assert.ok(committed().includes('plover-rule'));
});
