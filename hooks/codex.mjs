// node "<vault>/hooks/codex.mjs" <hook> <seconds>: the command each Codex hook runs. Its path stays the same across
// vault commits, so the trust the user gives in /hooks holds, and it runs the hook from the vault's current copy in
// .live/, made again at session start when the last commit changed tools/, as hooks/launch.mjs does for Claude Code.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { liveTools, fail } from './live.mjs';

const [hook = ''] = process.argv.slice(2);

try {
  const copy = liveTools(path.resolve(import.meta.dirname, '..'), { fix: 'clone the vault with git and print the hooks again with node tools/agents.mjs codex', refresh: hook === 'session-start' });
  await import(pathToFileURL(path.join(copy, 'adapters', 'codex', 'launch.mjs')).href);
} catch (e) {
  fail(hook, e);
}
