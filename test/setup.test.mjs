import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { cleanEnv } from './fixture.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const FAKE = path.join(import.meta.dirname, 'fixtures', 'fake-claude.mjs');
const ID = 'obsidian-vault@obsidian-vault';
const slash = p => p.replaceAll('\\', '/');

// A committed vault clone holding what setup.mjs needs, a folder with a fake claude first on PATH, and the fake's state.
// The real claude is kept off PATH, since a lookup that skips claude.cmd would reach it and change the user's plugins.
function setupVault(t, { version = '2.1.296', plugins = [], marketplaces = [], claude = true } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-setup-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'my vault');
  fs.mkdirSync(root);
  for (const rel of ['setup.mjs', 'hooks', 'tools', '.claude-plugin', 'vault.config.json']) fs.cpSync(path.join(ROOT, rel), path.join(root, rel), { recursive: true });
  const git = (...args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', env: cleanEnv() });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'vault');
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin);
  if (!claude) { /* no claude on PATH */ } else if (process.platform === 'win32') fs.writeFileSync(path.join(bin, 'claude.cmd'), `@"${process.execPath}" "${FAKE}" %*\r\n`);
  else fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o755 });
  const stateFile = path.join(tmp, 'claude.json');
  fs.writeFileSync(stateFile, JSON.stringify({ version, plugins, marketplaces, calls: [] }));
  const pathKey = Object.keys(process.env).find(k => /^path$/i.test(k)) ?? 'PATH';
  const hasClaude = dir => ['claude', 'claude.exe', 'claude.cmd'].some(f => fs.existsSync(path.join(dir, f)));
  const dirs = (process.env[pathKey] ?? '').split(path.delimiter).filter(d => d && !hasClaude(d));
  const env = cleanEnv({ [pathKey]: [bin, ...dirs].join(path.delimiter), FAKE_CLAUDE_STATE: stateFile });
  return {
    root,
    git,
    run: (args = []) => spawnSync(process.execPath, [path.join(root, 'setup.mjs'), ...args], { cwd: tmp, env, encoding: 'utf8' }),
    state: () => JSON.parse(fs.readFileSync(stateFile, 'utf8')),
  };
}

const calls = (s, ...prefix) => s.state().calls.filter(c => prefix.every((p, i) => c[i] === p));

const REPOSITORY = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).repository;

// A folder marketplace would copy the notes and .state/ into Claude Code's plugin cache (seen with claude 2.1.296).
test('setup installs the plugin from the repo, not this folder, with this folder as its vault, turns on the git hooks and makes the copy in .live', t => {
  const s = setupVault(t);
  const r = s.run();
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const [install] = calls(s, 'plugin', 'install');
  assert.ok(install, 'claude plugin install ran');
  assert.equal(install[2], 'obsidian-vault', 'the CLI takes the bare name with --marketplace');
  assert.equal(install[install.indexOf('--marketplace') + 1], REPOSITORY);
  assert.equal(slash(install[install.indexOf('--config') + 1]), `vault=${slash(s.root)}`);
  assert.equal(s.git('config', 'core.hooksPath').stdout.trim(), '.githooks');
  const tree = fs.readFileSync(path.join(s.root, '.live', 'current'), 'utf8').trim();
  assert.equal(tree, s.git('rev-parse', 'HEAD:tools').stdout.trim());
  assert.ok(fs.existsSync(path.join(s.root, '.live', tree, 'status.mjs')), '.live/current names a copy made from the last commit');
  assert.match(r.stdout, /Restart Claude Code/);
});

test("setup installs the plugin from the clone's remote when it is a URL, so a fork's hooks match its tools", t => {
  const s = setupVault(t);
  s.git('remote', 'add', 'origin', 'https://github.com/someone/my-fork.git');
  assert.equal(s.run().status, 0);
  const [install] = calls(s, 'plugin', 'install');
  assert.equal(install[install.indexOf('--marketplace') + 1], 'https://github.com/someone/my-fork.git');
});

test('setup without claude on PATH says to install Claude Code and changes nothing', t => {
  const s = setupVault(t, { claude: false });
  const r = s.run();
  assert.equal(r.status, 2, r.stderr + r.stdout);
  assert.match(r.stderr, /Claude Code is not on PATH/);
  assert.equal(s.git('config', 'core.hooksPath').stdout.trim(), '');
});

test('setup run again changes nothing about the plugin', t => {
  const s = setupVault(t);
  assert.equal(s.run().status, 0);
  const before = s.state().calls.length;
  const r = s.run();
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const writes = s.state().calls.slice(before).filter(c => ['install', 'enable', 'update'].includes(c[1]) || c.includes('--values-stdin'));
  assert.deepEqual(writes, []);
});

test('setup points an installed plugin at this folder and enables it, without installing it again', t => {
  const s = setupVault(t, { plugins: [{ id: ID, enabled: false, inputs: { vault: 'C:/somewhere/else' } }], marketplaces: ['obsidian-vault'] });
  const r = s.run();
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(calls(s, 'plugin', 'install'), []);
  const [plugin] = s.state().plugins;
  assert.equal(slash(plugin.inputs.vault), slash(s.root));
  assert.equal(plugin.enabled, true);
  assert.match(r.stdout, /somewhere\/else/, 'says which folder it pointed away from');
});

test('setup stops before changing anything when Claude Code is too old', t => {
  const s = setupVault(t, { version: '2.1.200' });
  const r = s.run();
  assert.equal(r.status, 2);
  assert.match(r.stderr, /2\.1\.295/);
  assert.deepEqual(s.state().calls.filter(c => c[0] !== '--version'), []);
  assert.equal(s.git('config', 'core.hooksPath').stdout.trim(), '');
});

test('setup --update pulls, then updates the marketplace and the plugin', t => {
  const s = setupVault(t);
  assert.equal(s.run().status, 0);
  const upstream = `${s.root}-upstream`;
  fs.cpSync(s.root, upstream, { recursive: true });
  s.git('remote', 'add', 'origin', upstream);
  s.git('fetch', '-q', 'origin');
  s.git('branch', '-q', '--set-upstream-to', `origin/${s.git('branch', '--show-current').stdout.trim()}`);
  const before = s.state().calls.length;
  const r = s.run(['--update']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const later = s.state().calls.slice(before);
  assert.ok(later.some(c => c[1] === 'marketplace' && c[2] === 'update' && c[3] === 'obsidian-vault'), JSON.stringify(later));
  assert.ok(later.some(c => c[1] === 'update' && c[2] === ID), JSON.stringify(later));
});
