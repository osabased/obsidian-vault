import fs from 'node:fs';
import path from 'node:path';
import { vaultPath, toolsPath, readJsonSafe, safeId, inVaultFolder, logError, guarded, reloadConfig } from '../lib/vault.mjs';
import { registry } from '../lib/sessions.mjs';
import { agent, hasAgent, listedAgents } from '../lib/agents.mjs';
import { readCall, allowCall, pruneCalls } from '../lib/calls.mjs';
import { listen, notify, RpcError } from './rpc.mjs';
import { TOOLS, toolNamed, parseSchema, listing } from './tools.mjs';

// Newest first. Each has every feature the server uses: tools, their annotations and _meta, and list_changed.
const PROTOCOLS = ['2025-11-25', '2025-06-18'];
const CALL_MS = 120_000;
const SCHEMA_MS = 30_000;
const WATCH_MS = 5000;

const NO_ID = "The vault couldn't tie this call to a session: it came with no call id. Nothing was run.";
const NO_RECORD = "The vault's PreToolUse hook didn't record this call, so it can't tell which session made it. Check that the vault hooks are installed and trusted. Nothing was run.";
const MISMATCH = "This call's record is for another tool or session. Nothing was run.";
const UNLISTED = "The vault's tools answer only the agents listed in vault.config.json. Nothing was run.";
const UNPROMPTED = "The vault listed this tool without its permission prompt on this connection, so it can't tell the user allowed this call. Nothing was run.";
const tooOld = (info, min) => `\`${info.name}\` \`${info.version ?? ''}\` is older than \`${min}\`, which the vault's tools need. Update it.`;

const parts = v => /^\d+(?:\.\d+)*/.exec(String(v ?? ''))?.[0].split('.').map(Number) ?? null;
// A version that doesn't start with a number reads as older than any, so an odd client fails closed.
function atLeast(version, min) {
  const a = parts(version);
  const b = parts(min);
  if (!a || !b) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
}

// The config is read again for each request, since the server runs for the whole session and the user may list an agent
// meanwhile.
function clientOf(info) {
  reloadConfig();
  return (info?.name && listedAgents().find(a => a.mcp?.client === info.name)) || null;
}

const markerFor = (a, version) => (a?.consent === 'prompt' && a.mcp.marker && a.mcp.markerSince && atLeast(version, a.mcp.markerSince) ? a.mcp.marker : null);

// Every adapter's, listed or not, so a script never takes the server's own session variable for the caller's.
function scriptEnv() {
  const env = { ...process.env };
  const names = fs.readdirSync(toolsPath('adapters'), { withFileTypes: true }).filter(e => e.isDirectory() && hasAgent(e.name)).map(e => e.name);
  for (const n of names) delete env[agent(n).sessionVar];
  return env;
}

const text = t => ({ type: 'text', text: t });
const refused = why => ({ content: [text(why)], isError: true });

function failed(row, r) {
  const said = r.stderr.trimEnd() || r.stdout.trimEnd();
  if (r.code === null) return [`\`${row.script}\` didn't finish within ${CALL_MS / 1000} s, so the vault stopped it.`, said].filter(Boolean).join('\n');
  return said || `\`${row.script}\` exited ${r.code} with no message.`;
}

export function serve({ input, output, run }) {
  let info = null;
  let initialized = false;
  // The marked tools the latest list sent with the marker. The marker and the config are read again for each request, so
  // a tool the client holds unmarked, listed before its agent was in vault.config.json, say, ran with no prompt, and its
  // call is no consent.
  let sentMarked = new Set();

  // A script whose --schema fails is left out of the list, so a client is never offered a tool the vault can't describe;
  // the log names it, and the list holds it again once the script answers.
  async function toolList() {
    const a = clientOf(info);
    const variant = a?.consent ?? 'prompt';
    const marker = markerFor(a, info?.version);
    const env = scriptEnv();
    const rows = await Promise.all(TOOLS.map(async row => {
      try {
        const r = await run(process.execPath, [toolsPath(row.script), '--schema', variant], { input: '', cwd: vaultPath(), env, timeoutMs: SCHEMA_MS });
        if (r.code !== 0) throw new Error((r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`).replace(/\s+/g, ' '));
        return listing(row, parseSchema(r.stdout), marker);
      } catch (e) {
        logError('vault mcp', `${row.script} --schema ${variant} failed: ${e.message}`);
        return null;
      }
    }));
    sentMarked = new Set(marker ? TOOLS.filter((row, i) => row.marked && rows[i]).map(row => row.name) : []);
    return { tools: rows.filter(Boolean) };
  }

  async function callTool(params) {
    const row = toolNamed(params.name);
    if (!row) throw new RpcError(-32602, `No vault tool is named ${JSON.stringify(params.name)}.`);
    const a = clientOf(info);
    if (!a) return refused(UNLISTED);
    if (!atLeast(info.version, a.mcp.minVersion)) return refused(tooOld(info, a.mcp.minVersion));
    const call = a.mcp.call(params._meta);
    if (typeof call !== 'string' || !call) return refused(NO_ID);
    const rec = readCall(call);
    if (!rec) return refused(NO_RECORD);
    // A subagent's thread isn't the session's, so only a call from the session's own thread is checked against it.
    const thread = a.mcp.thread(params._meta);
    if (rec.tool !== row.name || (thread != null && rec.subagent == null && rec.session !== thread)) return refused(MISMATCH);
    const entry = readJsonSafe(registry(safeId(rec.session)));
    const dir = inVaultFolder(entry?.cwd) ? vaultPath('tools') : toolsPath();
    // The client ran a marked call only once the user allowed it at its prompt.
    if (row.marked && markerFor(a, info.version)) {
      if (!sentMarked.has(row.name)) return refused(UNPROMPTED);
      allowCall(call);
    }
    const r = await run(process.execPath, [path.join(dir, row.script), ...row.argv(rec.session, call)], {
      input: JSON.stringify(params.arguments ?? {}), cwd: vaultPath(), env: scriptEnv(), timeoutMs: CALL_MS,
    });
    return r.code === 0 ? { content: [text(r.stdout.trimEnd())] } : { content: [text(failed(row, r))], isError: true };
  }

  async function handle(method, params) {
    if (method === 'initialize') {
      info = { name: params.clientInfo?.name ?? null, version: params.clientInfo?.version ?? null };
      initialized = true;
      guarded('vault mcp prune', () => pruneCalls());
      const protocolVersion = PROTOCOLS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOLS[0];
      return { protocolVersion, capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'vault', version: '1' } };
    }
    if (method === 'ping') return {};
    if (method === 'tools/list') return toolList();
    if (method === 'tools/call') return callTool(params);
    throw new RpcError(-32601, `Method not found: ${method}`);
  }

  // post-commit and the launchers replace .live/tools as a whole, so a new folder is a new set of scripts and schemas.
  const signature = () => {
    try {
      const s = fs.statSync(toolsPath());
      return `${s.ino}:${s.birthtimeMs}:${s.mtimeMs}`;
    } catch { return 'missing'; }
  };
  let seen = signature();
  const timer = setInterval(() => {
    const now = signature();
    if (now === seen) return;
    seen = now;
    if (initialized) notify(output, 'notifications/tools/list_changed');
  }, WATCH_MS);
  timer.unref();

  return listen({ input, output, handle }).finally(() => clearInterval(timer));
}
