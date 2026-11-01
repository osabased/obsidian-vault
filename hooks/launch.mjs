import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// The plugin's hooks.json starts every hook through this file, which runs the hook from the vault's .live/tools/, so the
// installed plugin copy never goes stale against the vault. The failures here print the line runHook prints, and exit 1,
// which Claude Code shows as a hook error while the call goes ahead.
const HOOKS = ['session-start', 'prompt', 'edit', 'stop', 'subagent-start'];
const [hook = '', timeout] = process.argv.slice(2);

function fail(why) {
  process.stderr.write(`vault ${hook} failed: ${why.replace(/\s+/g, ' ').trim()}\n`);
  process.exitCode = 1;
}

// The option is whatever the user typed, and Git Bash spells C:/x as /c/x, which node on Windows reads as C:\c\x. A
// relative path would mean a different folder in each session, so it is refused. The vault code that does this for other
// paths can't be imported, since it lives in the .live copy this file is looking for.
function vaultFolder(given) {
  const spelled = process.platform === 'win32' ? given.replace(/^[\\/]([a-z])(?:[\\/]|$)/i, '$1:/') : given;
  return path.isAbsolute(spelled) ? path.resolve(spelled) : null;
}

async function launch() {
  if (process.env.CLAUDE_CODE_SAFE_MODE === '1') return;
  if (!HOOKS.includes(hook)) return fail(`no hook of that name, only ${HOOKS.join(', ')}`);
  const vault = process.env.CLAUDE_PLUGIN_OPTION_VAULT;
  if (!vault) return fail("the plugin's vault option is not set; run claude plugin configure obsidian-vault");
  const root = vaultFolder(vault);
  if (!root) return fail(`the plugin's vault option "${vault}" is not an absolute path; run claude plugin configure obsidian-vault`);
  const tools = path.join(root, '.live', 'tools');
  if (!fs.existsSync(tools)) return fail(`${tools} does not exist; run .githooks/post-commit in the vault to make it`);
  const file = path.join(tools, 'hooks', `${hook}.mjs`);
  if (!fs.existsSync(file)) return fail(`${file} does not exist; commit the vault's tools/ so post-commit copies it`);
  if (timeout) process.env.VAULT_HOOK_TIMEOUT = timeout;
  await import(pathToFileURL(file).href);
}

launch().catch(e => fail(String(e?.message ?? e)));
