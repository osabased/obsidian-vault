import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { liveTools } from './hooks/live.mjs';

// Sets up this clone as the vault for Claude Code, and with --update pulls it and updates the plugin. Safe to run again.
const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)));
const ID = 'obsidian-vault@obsidian-vault';
const MARKETPLACE = 'obsidian-vault';
const MIN_NODE = [22, 12, 0];
const MIN_CLAUDE = [2, 1, 295];
const FIX = 'run node setup.mjs from your vault clone';
const posix = p => p.replaceAll('\\', '/');
const fold = p => (process.platform === 'win32' ? posix(path.resolve(p)).toLowerCase() : path.resolve(p));
const older = (v, min) => { for (let i = 0; i < 3; i++) if (v[i] !== min[i]) return v[i] < min[i]; return false; };
const done = [];

function stop(why, code = 2) {
  process.stderr.write(`setup: ${why}\n`);
  process.exit(code);
}

// npm installs claude on Windows as claude.cmd, which Node starts only through a shell.
const quote = a => (/^[\w./:=@-]+$/.test(a) ? a : `"${a.replaceAll('"', '\\"')}"`);
function claude(args, { input } = {}) {
  let r = spawnSync('claude', args, { encoding: 'utf8', input, windowsHide: true });
  if (r.error?.code === 'ENOENT' && process.platform === 'win32' && spawnSync('where', ['claude'], { windowsHide: true }).status === 0) {
    r = spawnSync(['claude', ...args].map(quote).join(' '), { encoding: 'utf8', input, shell: true, windowsHide: true });
  }
  if (r.error?.code === 'ENOENT') {
    stop('Claude Code is not on PATH. Install it, then run this again.');
  }
  if (r.status !== 0) stop(`claude ${args.join(' ')} failed: ${(r.stderr || r.stdout || '').trim()}`, 1);
  return r.stdout;
}
const claudeJson = args => JSON.parse(claude([...args, '--json']));

function git(args, { fail = 2 } = {}) {
  const r = spawnSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', windowsHide: true });
  if (r.error) stop(`git is not on PATH (${r.error.message}). Install git, then run this again.`);
  if (r.status !== 0 && fail) stop(`git ${args.join(' ')} failed: ${r.stderr.trim()}`, fail);
  return r.status === 0 ? r.stdout.trim() : null;
}

const args = process.argv.slice(2);
const update = args.includes('--update');
if (args.some(a => a !== '--update')) stop('usage: node setup.mjs [--update]');

const node = process.versions.node.split('.').map(Number);
if (older(node, MIN_NODE)) stop(`Node.js ${MIN_NODE.join('.')} or later is needed; this is ${process.versions.node}.`);
const version = (claude(['--version']).match(/(\d+)\.(\d+)\.(\d+)/) ?? []).slice(1).map(Number);
if (version.length !== 3 || older(version, MIN_CLAUDE)) {
  stop(`Claude Code ${MIN_CLAUDE.join('.')} or later is needed; this is ${version.join('.') || 'unknown'}. Run claude update, then run this again.`);
}
const top = git(['rev-parse', '--show-toplevel'], { fail: 0 });
if (!top || fold(top) !== fold(ROOT)) stop(`${ROOT} is not a git clone of the vault. Clone it with git clone, then run node setup.mjs in the clone.`);

if (update) {
  git(['pull', '--ff-only'], { fail: 1 });
  done.push('pulled the vault');
}
try {
  liveTools(ROOT, { fix: FIX, refresh: true });
} catch (e) {
  stop(e.message);
}
if (git(['config', 'core.hooksPath'], { fail: 0 }) !== '.githooks') {
  git(['config', 'core.hooksPath', '.githooks']);
  done.push("turned on the vault's git hooks");
}

// A folder marketplace would copy the whole folder, notes and .state/ included, into Claude Code's plugin cache, so the
// plugin comes from the remote the clone was made from, or this repo's own when that remote is a local folder.
function source() {
  const origin = git(['remote', 'get-url', 'origin'], { fail: 0 });
  if (origin && /^(?:https?|ssh|git):\/\/|^[\w.-]+@[\w.-]+:/.test(origin)) return origin;
  return JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).repository;
}

const vault = posix(ROOT);
const installed = claudeJson(['plugin', 'list']).find(p => p.id === ID);
if (!installed) {
  const known = claudeJson(['plugin', 'marketplace', 'list']).some(m => m.name === MARKETPLACE);
  claude(['plugin', 'install', ...(known ? [ID] : ['obsidian-vault', '--marketplace', source()]), '--config', `vault=${vault}`]);
  done.push(`installed the plugin, with ${vault} as its vault`);
} else {
  const was = claudeJson(['plugin', 'configure', ID]).inputs?.vault;
  if (!was || fold(was) !== fold(vault)) {
    claude(['plugin', 'configure', ID, '--values-stdin'], { input: JSON.stringify({ vault }) });
    done.push(was ? `pointed the plugin at ${vault} (it was ${posix(was)})` : `set the plugin's vault to ${vault}`);
  }
  if (!installed.enabled) {
    claude(['plugin', 'enable', ID]);
    done.push('enabled the plugin');
  }
}
if (update) {
  claude(['plugin', 'marketplace', 'update', MARKETPLACE]);
  claude(['plugin', 'update', ID]);
  done.push('updated the plugin');
}

process.stdout.write([
  done.length ? `setup: ${done.join('; ')}.` : 'setup: already set up; nothing changed.',
  'Restart Claude Code. Each session then starts with a line such as `vault: no domain here · 0 global rules · proposals: ask`.',
  'Open this folder in Obsidian to read and edit the notes.',
  '',
].join('\n'));
