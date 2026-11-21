import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { vaultFolder, liveTools, lease, fail as failLine } from '../hooks/live.mjs';

// The vault's MCP server, started by the agent with the vault folder as its argument. It runs the server from the
// vault's current copy of tools/ in .live/, as hooks/launch.mjs runs the hooks, so the installed copy never goes stale
// against the vault, and makes a new copy when the vault's last commit changed tools/, as session start does. The
// server is pure protocol; this file runs the scripts for it, since tools/ keeps child processes to lib/git.mjs.
const FIX = "pass the vault checkout's absolute path as the first argument";
const [given = ''] = process.argv.slice(2);
const fail = why => failLine('mcp', why);

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
  if (!given) return fail(`no vault folder given; ${FIX}`);
  const root = vaultFolder(given);
  if (!root) return fail(`the vault folder "${given}" is not an absolute path`);
  const copy = liveTools(root, { fix: FIX, refresh: true });
  const file = path.join(copy, 'mcp', 'server.mjs');
  if (!fs.existsSync(file)) return fail(`${file} does not exist; commit the vault's tools/, then start a new session`);
  // The server reads its own copy for as long as the session lasts, so a commit's rebuild keeps that copy until it exits.
  lease(copy);
  const { serve } = await import(pathToFileURL(file).href);
  await serve({ input: process.stdin, output: process.stdout, run });
}

launch().catch(fail);
