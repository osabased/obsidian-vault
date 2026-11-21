// node "<vault>/hooks/codex.mjs" <hook> <seconds>, which imports this file from .live's current copy.
// The vault is found from this file's own folder, so the command needs no option or environment variable. Codex's hook
// input carries no timeout, so the seconds repeat the hook's timeout for the deadline.
import { runHook } from '../../lib/vault.mjs';
import * as agent from './adapter.mjs';

const [hook, seconds] = process.argv.slice(2);
if (seconds) process.env.VAULT_HOOK_TIMEOUT = seconds;
if (agent.hookNames.includes(hook)) await import(`./hooks/${hook}.mjs`);
else runHook(String(hook), agent, () => { throw new Error(`no hook ${hook}; the hooks are ${agent.hookNames.join(', ')}`); });
