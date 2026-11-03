import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { vaultFolder, liveTools } from './live.mjs';

// The plugin's hooks.json starts every hook through this file, which runs the hook from the vault's .live/tools/, so the
// installed plugin copy never goes stale against the vault. Session start makes the copy again when the vault's last
// commit changed tools/, so a pull reaches the next session; the other hooks run often and keep the copy they find. The
// failures here print the line runHook prints, and exit 1, which Claude Code shows as a hook error while the call goes
// ahead.
const HOOKS = ['session-start', 'prompt', 'edit', 'stop', 'subagent-start', 'vault-call'];
const CONFIGURE = 'run claude plugin configure obsidian-vault@obsidian-vault';
const [hook = '', timeout] = process.argv.slice(2);

function fail(why) {
  process.stderr.write(`vault ${hook} failed: ${why.replace(/\s+/g, ' ').trim()}\n`);
  process.exitCode = 1;
}

async function launch() {
  if (process.env.CLAUDE_CODE_SAFE_MODE === '1') return;
  if (!HOOKS.includes(hook)) return fail(`no hook of that name, only ${HOOKS.join(', ')}`);
  const vault = process.env.CLAUDE_PLUGIN_OPTION_VAULT;
  if (!vault) return fail(`the plugin's vault option is not set; ${CONFIGURE}`);
  const root = vaultFolder(vault);
  if (!root) return fail(`the plugin's vault option "${vault}" is not an absolute path; ${CONFIGURE}`);
  const tools = liveTools(root, { fix: CONFIGURE, refresh: hook === 'session-start' });
  // A .live copy made before the adapters has its hooks in tools/hooks/, until the vault's next commit replaces it.
  const file = [path.join(tools, 'adapters', 'claude-code', 'hooks', `${hook}.mjs`), path.join(tools, 'hooks', `${hook}.mjs`)].find(f => fs.existsSync(f))
    ?? path.join(tools, 'adapters', 'claude-code', 'hooks', `${hook}.mjs`);
  if (!fs.existsSync(file)) return fail(`${file} does not exist; commit the vault's tools/, then start a new session`);
  if (timeout) process.env.VAULT_HOOK_TIMEOUT = timeout;
  await import(pathToFileURL(file).href);
}

launch().catch(e => fail(String(e?.message ?? e)));
