import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { toPosix } from './vault.mjs';
import { checkDeadline, remaining } from './deadline.mjs';

// GIT_DIR and the like, as a git hook sets them, would point git away from the folder asked about.
const gitEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_(?:DIR|WORK_TREE|INDEX_FILE|COMMON_DIR)$/i.test(k)));

// git status prints paths from the top of the work tree whatever folder it runs in, so they are read from there. A
// worktree or submodule has a .git file in place of the folder.
function topOf(dir) {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    if (path.dirname(d) === d) return null;
  }
}

// lib/git.mjs is the one place tools/ runs another program, git, and hooks call only changedFiles from it. Null, not an
// empty list, when git is missing, the folder isn't in a repository, or git fails or runs past the timeout or the time
// left before a hook's deadline, so a caller never takes a failure for a clean tree.
export function changedFiles(cwd, pathspec = [], { ignored = false, timeout = 2000 } = {}) {
  const top = topOf(cwd);
  if (!top) return null;
  checkDeadline();
  let out;
  try {
    // Without optional locks git leaves the index alone, so a status here never holds up the user's own git.
    out = execFileSync('git', [
      '--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all', ...(ignored ? ['--ignored'] : []),
      '--', ...[].concat(pathspec),
    ], { cwd, env: gitEnv(), timeout: Math.max(1, Math.min(timeout, remaining())), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, maxBuffer: 64 << 20 });
  } catch {
    return null;
  }
  const files = [];
  const fields = out.split('\0');
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (f.length < 4) continue;
    files.push(toPosix(path.join(top, f.slice(3))));
    // A rename or copy is followed by the path it came from, which no longer holds that file's text.
    if (/^[RC]|^.[RC]/.test(f)) files.push(toPosix(path.join(top, fields[++i] ?? '')));
  }
  return files;
}

// The git calls refresh makes on its clones in .sources/. Each throws an Error whose message is the reason refresh
// records: git not found, no answer in time, output past the cap, or the command, its exit code and the first line git
// printed to stderr. A repo that asks for a password fails at once rather than waiting out the timeout on a prompt no
// one sees. The operands come from files in raw/refs/, so they go after --end-of-options (-- for clone), where git
// never reads one as an option; a call with no operands has nothing to separate. --end-of-options needs git 2.24, where
// parse-options and the revision machinery learned it, and rev-parse took it only in 2.30, so its one fixed name is an
// argument instead. GIT_DIR keeps git in the clone's own repository: a broken .git would otherwise send it
// up to the vault's, and the ext:: transport, which runs a command a repo string names, stays off whatever the user's
// git config allows.
function run(args, operands, { dir, timeout, quietFail = false, maxBuffer = 256 << 20 }) {
  const argv = ['-c', 'protocol.ext.allow=never', ...args, ...(operands.length ? [args[0] === 'clone' ? '--' : '--end-of-options', ...operands] : [])];
  const env = { ...gitEnv(), GIT_TERMINAL_PROMPT: '0', ...(dir ? { GIT_DIR: path.join(dir, '.git') } : {}) };
  try {
    return execFileSync('git', argv, { cwd: dir, env, timeout, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, maxBuffer });
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error('git not found');
    // An overrun buffer kills git too, so it comes with a signal like a timeout does.
    if (e.code === 'ENOBUFS') throw new Error(`git ${args[0]} printed over ${maxBuffer} bytes`);
    if (e.code === 'ETIMEDOUT' || e.signal) throw new Error(`no answer in ${Math.round(timeout / 1000)} s`);
    if (quietFail) return null;
    const line = String(e.stderr ?? '').split(/\r?\n/).find(l => l.trim()) ?? '';
    throw new Error(`git ${args[0]} exited ${e.status}${line ? `: ${line.trim()}` : ''}`);
  }
}

// With no work tree, no line-ending conversion or long path applies.
export const clone = (repo, dir, { timeout }) => { run(['clone', '--quiet', '--no-checkout'], [repo, dir], { timeout }); };
// A clone killed partway may have no origin, and is cloned again.
export const hasOrigin = (dir, { timeout }) => fs.existsSync(path.join(dir, '.git')) && run(['remote', 'get-url'], ['origin'], { dir, timeout, quietFail: true }) !== null;
// fetch never moves origin/HEAD, so after upstream renames its default branch it would point at the old one for good.
export function fetchOrigin(dir, { timeout }) {
  run(['fetch', '--quiet', '--prune'], ['origin'], { dir, timeout });
  run(['remote', 'set-head', '--auto'], ['origin'], { dir, timeout });
}
export const hasCommit = (dir, commit, { timeout }) => run(['cat-file', '-e'], [`${commit}^{commit}`], { dir, timeout, quietFail: true }) !== null;
// The commit the remote's default branch is at, or null when origin/HEAD doesn't resolve.
export function remoteHead(dir, { timeout }) {
  const out = run(['rev-parse', '--verify', '--quiet', 'origin/HEAD^{commit}'], [], { dir, timeout, quietFail: true });
  return out ? out.toString('utf8').trim() : null;
}
// The newest commit after commit on the default branch that changes path, as { commit, day }, or null when none does.
export function lastChange(dir, commit, file, { timeout }) {
  const line = run(['log', '-n', '1', '--format=%H%x09%cs'], [`${commit}..origin/HEAD`, '--', file], { dir, timeout }).toString('utf8').trim();
  if (!line) return null;
  const [c, day] = line.split('\t');
  return { commit: c, day };
}
// The size in bytes of the file at commit, or null when the commit has no such file. git reads <commit>:<path> with
// forward slashes only.
export function sizeAt(dir, commit, file, { timeout }) {
  const out = run(['cat-file', '-s'], [`${commit}:${file}`], { dir, timeout, quietFail: true });
  return out === null ? null : Number(out.toString('utf8').trim());
}
export const showAt = (dir, commit, file, { timeout }) => run(['show'], [`${commit}:${file}`], { dir, timeout });
