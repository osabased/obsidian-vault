import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { currentCopy } from '../tools/lib/current.mjs';

// Both launchers and .githooks/post-commit find or make the vault's copy of tools/ in .live/ here. Of tools/ beside this
// file, only lib/current.mjs is imported, which the server shares to read the pointer: the rest of the vault's code for
// paths, locks and errors belongs to the .live copy this file makes.

// The one line every launcher prints when it fails, which Claude Code and Codex show as a hook error, and exit 1.
export function fail(name, why) {
  process.stderr.write(`vault ${name} failed: ${String(why?.message ?? why).replace(/\s+/g, ' ').trim()}\n`);
  process.exitCode = 1;
}

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
function retry(fn, tries = 5) {
  for (let i = 0; ; i++) {
    try { return fn(); } catch (e) {
      if (i >= tries || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      sleep(50 * (i + 1));
    }
  }
}

// A launcher killed at its hook timeout leaves its lock behind, so an old lock is taken over. Two waiters can both take
// over one old lock, so a holder checks the lock is still its own before it switches current, and removes only its own.
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

const mine = lock => {
  try { return fs.readFileSync(lock, 'utf8') === String(process.pid); } catch { return false; }
};

// Each copy is .live/<tree>/, tools/ as of a commit, named by its tree, and .live/current names the one sessions run. A
// copy's files never change once made; only the .retired and .lease.<pid> markers come and go. A rebuild makes the new
// copy beside the old and then replaces current, so a hook or script already running keeps every file it started with,
// and a new one finds a whole copy.
// A retired copy outlives every hook and script that started in it. The vault's MCP server lives as long as its session
// and keeps reading its own copy, so it leases that copy (lease below).
const RETIRED_MS = 60 * 60_000;

const alive = pid => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};

export function lease(copy) {
  const file = path.join(copy, `.lease.${process.pid}`);
  try { fs.writeFileSync(file, ''); } catch { return; }
  process.on('exit', () => { try { fs.rmSync(file, { force: true }); } catch {} });
}

// Whether a live process leases dir. The leases of processes gone, as a server that crashed leaves them, are removed, so a
// later process given the same pid doesn't hold the copy.
function held(dir) {
  let any = false;
  for (const f of fs.readdirSync(dir)) {
    if (!/^\.lease\.\d+$/.test(f)) continue;
    if (alive(Number(f.slice(7)))) any = true;
    else fs.rmSync(path.join(dir, f), { force: true });
  }
  return any;
}

// Copies retired for RETIRED_MS that no live process leases, and what a build that died left behind. The copy current
// names stays, retired or not.
function prune(root) {
  const live = path.join(root, '.live');
  const keep = path.basename(currentCopy(root) ?? '');
  let names;
  try { names = fs.readdirSync(live); } catch { return; }
  for (const name of names) {
    if (!/^(?:[0-9a-f]{40,64}(?:\.\d+)?|current\.\d+|index\.\d+(?:\.lock)?)$/.test(name)) continue;
    const p = path.join(live, name);
    try {
      const leased = fs.statSync(p).isDirectory() && held(p);
      if (name === keep || leased) continue;
      const since = [path.join(p, '.retired'), path.join(p, '.tree'), p].find(f => fs.existsSync(f));
      if (Date.now() - fs.statSync(since).mtimeMs >= RETIRED_MS) fs.rmSync(p, { recursive: true, force: true });
    } catch {}
  }
}

// The SessionStart hook and the MCP server of one session start at once, and post-commit may run beside them, so the
// build runs under a lock, and whoever waited finds current already naming the copy.
function make(root, wait) {
  const live = path.join(root, '.live');
  const head = () => git(root, ['rev-parse', 'HEAD:tools']);
  const quick = path.join(live, head());
  if (currentCopy(root) === quick) return quick;
  fs.mkdirSync(live, { recursive: true });
  const lock = path.join(live, 'tools.lock');
  const giveUp = Date.now() + wait;
  while (!take(lock)) {
    if (Date.now() >= giveUp) throw new Error(`${lock} is held by another process`);
    sleep(50);
  }
  const index = path.join(live, `index.${process.pid}`);
  const pointer = path.join(live, `current.${process.pid}`);
  let next = null;
  try {
    // HEAD may have moved while this waited, as when post-commit held the lock for a newer commit.
    const tree = head();
    const copy = path.join(live, tree);
    const was = currentCopy(root);
    if (was === copy) return copy;
    if (!fs.existsSync(path.join(copy, '.tree'))) {
      next = `${copy}.${process.pid}`;
      fs.rmSync(copy, { recursive: true, force: true });
      git(root, ['read-tree', tree], { GIT_INDEX_FILE: index });
      git(root, ['checkout-index', '-a', '-f', `--prefix=${path.relative(root, next).replaceAll('\\', '/')}/`], { GIT_INDEX_FILE: index });
      fs.writeFileSync(path.join(next, '.tree'), `${tree}\n`);
      retry(() => fs.renameSync(next, copy));
    }
    // A checkout back to an older commit makes its copy current again. The copy replaced is marked before the switch, so
    // nothing after it can fail and leave that copy aged from its build; prune never removes the copy current names.
    fs.rmSync(path.join(copy, '.retired'), { force: true });
    if (was) fs.writeFileSync(path.join(was, '.retired'), '');
    if (!mine(lock)) throw new Error(`${lock} was taken over by another process`);
    fs.writeFileSync(pointer, `${tree}\n`);
    retry(() => fs.renameSync(pointer, path.join(live, 'current')), 10);
    prune(root);
    return copy;
  } finally {
    for (const p of [next, index, `${index}.lock`, pointer]) if (p) fs.rmSync(p, { recursive: true, force: true });
    if (mine(lock)) fs.rmSync(lock, { force: true });
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

// The one copy an older plugin kept, .live/tools, which a vault upgraded from it runs until it has a copy of its own.
function legacy(root) {
  const tools = path.join(root, '.live', 'tools');
  return fs.existsSync(path.join(tools, '.tree')) ? tools : null;
}

// The vault's current copy in .live/, made from its last commit when there is none, and with refresh again when that
// commit changed tools/. A folder without .git keeps the copy it has. Each refusal ends with fix, the launcher's way to
// give another folder, and none says to change git config: run in the wrong folder, that turns the folder's own git hooks
// off. A refresh that fails keeps the old copy and is logged, so the session still gets its rules; with fallback false,
// as post-commit runs it, it throws instead, so the failure shows where the user committed.
export function liveTools(root, { fix, refresh = false, wait = LOCK_WAIT_MS, fallback = true }) {
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
  const have = currentCopy(root) ?? legacy(root);
  const clone = fs.existsSync(path.join(root, '.git'));
  if (have && !(refresh && clone)) return have;
  if (!clone) {
    throw new Error(`${root} is not a git clone, so .live can't be made from its last commit; clone the vault with git clone ${repository()} instead of downloading it, and ${fix}`);
  }
  try { return make(root, wait); } catch (e) {
    const why = `couldn't make a copy of tools/ in ${path.join(root, '.live')} from the vault's last commit: ${e.message}`;
    if (!have || !fallback) throw new Error(why);
    logError(root, why);
    return have;
  }
}
