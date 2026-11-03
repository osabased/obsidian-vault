import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Both launchers find the vault's .live/tools/ here. The vault's own code for paths, locks and errors can't be imported,
// since it lives in the .live copy this file makes.

// The option is whatever the user typed, and Git Bash spells C:/x as /c/x, which node on Windows reads as C:\c\x. A
// relative path would mean a different folder in each session, so it is refused.
export function vaultFolder(given) {
  const spelled = process.platform === 'win32' ? given.replace(/^[\\/]([a-z])(?:[\\/]|$)/i, '$1:/') : given;
  return path.isAbsolute(spelled) ? path.resolve(spelled) : null;
}

const LOCK_WAIT_MS = 4000;
const LOCK_STALE_MS = 30_000;
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const real = p => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };

function inside(child, parent) {
  const fold = process.platform === 'win32' ? p => p.toLowerCase() : p => p;
  const rel = path.relative(fold(real(parent)), fold(real(child)));
  return rel === '' || (rel.split(path.sep)[0] !== '..' && !path.isAbsolute(rel));
}

// An inherited GIT_DIR or GIT_INDEX_FILE, as inside another repository's git hook, would point git away from the vault.
function git(root, args, env = {}) {
  const own = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_(?:DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY)$/i.test(k)));
  const r = spawnSync('git', ['-C', root, ...args], { env: { ...own, ...env }, encoding: 'utf8', windowsHide: true, timeout: 5000 });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(r.stderr.trim().split('\n')[0] || `git ${args[0]} exited ${r.status}`);
  return r.stdout.trim();
}

// Windows refuses a rename while another process (antivirus, a hook loading a script) briefly holds a file in the folder.
function retry(fn) {
  for (let i = 0; ; i++) {
    try { return fn(); } catch (e) {
      if (i >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      sleep(50 * (i + 1));
    }
  }
}

// A launcher killed at its hook timeout leaves its lock behind, so an old lock is taken over.
function take(lock) {
  try {
    fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
    return true;
  } catch (e) {
    if (e.code !== 'EEXIST' && !(process.platform === 'win32' && e.code === 'EPERM')) throw e;
  }
  try { if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.rmSync(lock, { force: true }); } catch {}
  return false;
}

// The copy is of tools/ as of HEAD, built beside the old one and swapped in, as .githooks/post-commit builds it, and
// stamped with the tree it holds. The SessionStart hook and the MCP server of one session start at once, so the build
// runs under a lock, and whoever waited finds the stamp already matching.
function make(root, tools) {
  const tree = git(root, ['rev-parse', 'HEAD:tools']);
  const built = () => { try { return fs.readFileSync(path.join(tools, '.tree'), 'utf8').trim() === tree; } catch { return false; } };
  if (built()) return;
  const live = path.dirname(tools);
  fs.mkdirSync(live, { recursive: true });
  const lock = path.join(live, 'tools.lock');
  const giveUp = Date.now() + LOCK_WAIT_MS;
  while (!take(lock)) {
    if (Date.now() >= giveUp) throw new Error(`${lock} is held by another process`);
    sleep(50);
  }
  const next = `${tools}.${process.pid}`;
  const old = `${tools}.old.${process.pid}`;
  const index = path.join(live, `index.${process.pid}`);
  try {
    if (built()) return;
    git(root, ['read-tree', tree], { GIT_INDEX_FILE: index });
    git(root, ['checkout-index', '-a', '-f', `--prefix=${path.relative(root, next).replaceAll('\\', '/')}/`], { GIT_INDEX_FILE: index });
    fs.writeFileSync(path.join(next, '.tree'), `${tree}\n`);
    if (fs.existsSync(tools)) retry(() => fs.renameSync(tools, old));
    try { retry(() => fs.renameSync(next, tools)); } catch (e) {
      if (fs.existsSync(old)) fs.renameSync(old, tools);
      throw e;
    }
  } finally {
    for (const p of [next, old, index]) fs.rmSync(p, { recursive: true, force: true });
    fs.rmSync(lock, { force: true });
  }
}

// In the line format of the vault's errors.log, whose entries since the last /lint each session start names.
function logError(root, why) {
  try {
    fs.mkdirSync(path.join(root, '.state'), { recursive: true });
    fs.appendFileSync(path.join(root, '.state', 'errors.log'), `${new Date().toISOString()} launch: ${why}\n`);
  } catch {}
}

const repository = () => JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', '.claude-plugin', 'plugin.json'), 'utf8')).repository;

// The vault's .live/tools/, made from its last commit when it is missing, and with refresh again when that commit changed
// tools/. A folder without .git keeps the copy it has. Each refusal ends with fix, the launcher's way to give another
// folder, and none says to change git config: run in the wrong folder, that turns the folder's own git hooks off. A
// refresh that fails keeps the old copy and is logged, so the session still gets its rules.
export function liveTools(root, { fix, refresh = false }) {
  const plugins = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'plugins');
  if (inside(root, plugins)) {
    throw new Error(`${root} is inside Claude Code's plugins folder, which an update replaces along with any rules kept there; clone the vault to a folder of your own and ${fix}`);
  }
  let stat;
  try { stat = fs.statSync(root); } catch { throw new Error(`${root} does not exist; ${fix}`); }
  if (!stat.isDirectory()) throw new Error(`${root} is a file, not a folder; ${fix}`);
  if (!fs.existsSync(path.join(root, 'vault.config.json')) || !fs.existsSync(path.join(root, 'tools'))) {
    throw new Error(`${root} is not a vault: it needs vault.config.json and tools/; ${fix}`);
  }
  const tools = path.join(root, '.live', 'tools');
  const have = fs.existsSync(tools);
  const clone = fs.existsSync(path.join(root, '.git'));
  if (have && !(refresh && clone)) return tools;
  if (!clone) {
    throw new Error(`${root} is not a git clone, so .live/tools can't be made from its last commit; clone the vault with git clone ${repository()} instead of downloading it, and ${fix}`);
  }
  try { make(root, tools); } catch (e) {
    const why = `couldn't make ${tools} from the vault's last commit: ${e.message}`;
    if (!have) throw new Error(why);
    logError(root, why);
  }
  return tools;
}
