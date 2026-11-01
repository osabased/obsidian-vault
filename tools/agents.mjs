// node tools/agents.mjs <agent>
// Prints what registers the vault's hooks with an agent, for the user to run or merge. It writes nothing, since the agent
// that runs it may not write outside the vault.
import { ROOT, mainCheckout } from './lib/vault.mjs';
import { agent, hasAgent } from './lib/agents.mjs';

const [name, ...rest] = process.argv.slice(2);
if (!hasAgent(name) || rest.length) {
  console.error('Usage: node tools/agents.mjs <agent>\n<agent> names a folder in tools/adapters/.');
  process.exit(2);
}
// A worktree's hooks would stop working once it is removed, so the hooks run from the main checkout.
const { where, text } = agent(name).registration(mainCheckout(ROOT).replace(/\\/g, '/'));
process.stdout.write(`${text}\n\n${where}\n`);
