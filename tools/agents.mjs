// node tools/agents.mjs <agent>
// Prints what registers the vault's hooks with an agent, for the user to run or merge. It writes nothing, since the agent
// that runs it may not write outside the vault.
import { ROOT, mainCheckout } from './lib/vault.mjs';
import { agent, hasAgent } from './lib/agents.mjs';
import { mainWorktree } from './lib/git.mjs';

const [name, ...rest] = process.argv.slice(2);
if (!hasAgent(name) || rest.length) {
  console.error('Usage: node tools/agents.mjs <agent>\n<agent> names a folder in tools/adapters/.');
  process.exit(2);
}
// A worktree's hooks would stop working once it is removed, so the hooks run from the main checkout. Git knows it from
// any worktree; the path is the fallback when git can't say.
const { where, text } = agent(name).registration((mainWorktree(ROOT) ?? mainCheckout(ROOT)).replace(/\\/g, '/'));
process.stdout.write(`${text}\n\n${where}\n`);
