import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// The vault's MCP server, started by the agent with the vault folder as its argument. It runs the server from the
// vault's .live/tools/, as hooks/launch.mjs runs the hooks, so the installed copy never goes stale against the vault.
// The server is pure protocol; this file runs the scripts for it, since tools/ keeps child processes to lib/git.mjs.
const [given = ''] = process.argv.slice(2);

function fail(why) {
  process.stderr.write(`vault mcp failed: ${why.replace(/\s+/g, ' ').trim()}\n`);
  process.exitCode = 1;
}

// Git Bash spells C:/x as /c/x, which node on Windows reads as C:\c\x. A relative path would mean a different folder in
// each session, so it is refused.
function vaultFolder(p) {
  const spelled = process.platform === 'win32' ? p.replace(/^[\\/]([a-z])(?:[\\/]|$)/i, '$1:/') : p;
  return path.isAbsolute(spelled) ? path.resolve(spelled) : null;
}

function run(file, args, { input = '', cwd, env, timeoutMs }) {
  return new Promise(resolve => {
    let stdout = '';
    let stderr = '';
    const child = spawn(file, args, { cwd, env, windowsHide: true });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.setEncoding('utf8').on('data', d => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', d => { stderr += d; });
    child.on('error', e => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: `${stderr}couldn't start ${path.basename(args[0] ?? file)}: ${e.message}` });
    });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    // A script that answers without reading all its input closes the pipe first; its exit code and output still count.
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

async function launch() {
  if (!given) return fail("no vault folder given; pass the vault checkout's absolute path as the first argument");
  const root = vaultFolder(given);
  if (!root) return fail(`the vault folder "${given}" is not an absolute path`);
  const file = path.join(root, '.live', 'tools', 'mcp', 'server.mjs');
  if (!fs.existsSync(file)) return fail(`${file} does not exist; in the vault, run git config core.hooksPath .githooks, then git hook run post-commit`);
  const { serve } = await import(pathToFileURL(file).href);
  await serve({ input: process.stdin, output: process.stdout, run });
}

launch().catch(e => fail(String(e?.message ?? e)));
