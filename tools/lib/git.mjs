import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { toPosix } from './vault.mjs';
import { checkDeadline, remaining } from './deadline.mjs';

// git status prints paths from the top of the work tree whatever folder it runs in, so they are read from there. A
// worktree or submodule has a .git file in place of the folder.
function topOf(dir) {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    if (path.dirname(d) === d) return null;
  }
}

// The one place tools/ runs another program. Null, not an empty list, when git is missing, the folder isn't in a
// repository, or git fails or runs past the timeout or the time left before a hook's deadline, so a caller never takes a failure for a clean tree.
export function changedFiles(cwd, pathspec = [], { ignored = false, timeout = 2000 } = {}) {
  const top = topOf(cwd);
  if (!top) return null;
  checkDeadline();
  // GIT_DIR and the like, as a git hook sets them, would point git away from the folder asked about.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_(?:DIR|WORK_TREE|INDEX_FILE|COMMON_DIR)$/i.test(k)));
  let out;
  try {
    // Without optional locks git leaves the index alone, so a status here never holds up the user's own git.
    out = execFileSync('git', [
      '--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all', ...(ignored ? ['--ignored'] : []),
      '--', ...[].concat(pathspec),
    ], { cwd, env, timeout: Math.max(1, Math.min(timeout, remaining())), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, maxBuffer: 64 << 20 });
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
