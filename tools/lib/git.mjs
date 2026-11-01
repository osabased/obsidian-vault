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
// records: git not found, no answer in time, or the command, its exit code and the first line git printed to stderr.
// A repo that asks for a password fails at once rather than waiting out the timeout on a prompt no one sees.
function run(args, { cwd, timeout, quietFail = false }) {
  try {
    return execFileSync('git', args, { cwd, env: { ...gitEnv(), GIT_TERMINAL_PROMPT: '0' }, timeout, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, maxBuffer: 256 << 20 });
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error('git not found');
    if (e.code === 'ETIMEDOUT' || e.signal) throw new Error(`no answer in ${Math.round(timeout / 1000)} s`);
    if (quietFail) return null;
    const line = String(e.stderr ?? '').split(/\r?\n/).find(l => l.trim()) ?? '';
    throw new Error(`git ${args[0] === '-c' ? args[2] : args[0]} exited ${e.status}${line ? `: ${line.trim()}` : ''}`);
  }
}

// With no work tree, no line-ending conversion or long path applies.
export const clone = (repo, dir, { timeout }) => { run(['clone', '--quiet', '--no-checkout', repo, dir], { timeout }); };
export const fetchOrigin = (dir, { timeout }) => { run(['fetch', '--quiet', 'origin'], { cwd: dir, timeout }); };
export const hasCommit = (dir, commit, { timeout }) => run(['cat-file', '-e', `${commit}^{commit}`], { cwd: dir, timeout, quietFail: true }) !== null;
// The commit the remote's default branch is at, or null when origin/HEAD doesn't resolve.
export function remoteHead(dir, { timeout }) {
  const out = run(['rev-parse', '--verify', '--quiet', 'origin/HEAD^{commit}'], { cwd: dir, timeout, quietFail: true });
  return out ? out.toString('utf8').trim() : null;
}
// The commits after commit on the default branch that change path, newest first, as { commit, day }.
export function changedSince(dir, commit, file, { timeout }) {
  const out = run(['log', '--format=%H%x09%cs', `${commit}..origin/HEAD`, '--', file], { cwd: dir, timeout }).toString('utf8');
  return out.split(/\r?\n/).filter(Boolean).map(l => {
    const [c, day] = l.split('\t');
    return { commit: c, day };
  });
}
// The file's bytes at commit, or null when the commit has no such file. git reads <commit>:<path> with forward slashes only.
export function showAt(dir, commit, file, { timeout }) {
  const spec = `${commit}:${file.replace(/\\/g, '/')}`;
  if (run(['cat-file', '-e', spec], { cwd: dir, timeout, quietFail: true }) === null) return null;
  return run(['show', spec], { cwd: dir, timeout });
}
