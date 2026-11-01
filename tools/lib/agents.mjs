import fs from 'node:fs';
import { config, toolsPath } from './vault.mjs';
import { byName, EXTENSION_NAME } from './ext.mjs';

// Everything one agent does its own way, its hook input and output, tool names and transcripts, lives in
// tools/adapters/<agent>/adapter.mjs, so the core names no agent. A session registered before any entry named its agent
// was the first adapter's.
export const AGENT_NAME = EXTENSION_NAME;
export const FIRST_AGENT = 'claude-code';
const adapters = byName(name => toolsPath('adapters', name, 'adapter.mjs'));
export const hasAgent = adapters.has;

export function agent(name) {
  if (!hasAgent(name)) throw new Error(`no agent ${name}: tools/adapters/${name}/adapter.mjs doesn't exist`);
  return adapters.load(name);
}

// The adapters config lists, for lint's tool-name checks and for finding the session a script runs in. A name with no
// adapter is skipped here; lint reports it.
let listed;
export function listedAgents() {
  const c = config();
  if (listed?.c !== c) listed = { c, agents: (Array.isArray(c.agents) ? c.agents : []).filter(hasAgent).map(agent) };
  return listed.agents;
}

// The session a script runs in, from the first listed agent whose session variable is set.
export function currentSession(env = process.env) {
  for (const a of listedAgents()) if (env[a.sessionVar]) return { agent: a.name, id: env[a.sessionVar] };
  return null;
}

// The ids every adapter in tools/adapters/ finds set in its session variable, whatever agents lists, so whether a
// session is the one a script runs in doesn't turn on vault.config.json.
export function sessionIds(env = process.env) {
  const names = fs.readdirSync(toolsPath('adapters'), { withFileTypes: true }).filter(e => e.isDirectory() && hasAgent(e.name)).map(e => e.name);
  return [...new Set(names.map(n => env[agent(n).sessionVar]).filter(Boolean).map(String))];
}

// A session's short name, which pages, raw/inbox and raw/picks file names and log lines call it by, as its agent's
// adapter gives it. A session whose agent isn't known is named as the first agent names it.
export const shortName = (sid, name) => agent(hasAgent(name) ? name : FIRST_AGENT).shortName(String(sid));

// The user's typed messages in a registered session, read by the adapter of the agent that registered it. Null when the
// transcript can't be read.
export function typedFor(entry) {
  const name = entry?.agent ?? FIRST_AGENT;
  return entry?.transcript && hasAgent(name) ? agent(name).typedMessages(entry.transcript) : null;
}

export const editsFile = tool => listedAgents().some(a => a.fileTools.includes(tool));
export const sentToHook = tool => listedAgents().some(a => a.sends(tool));
export const hookMatchers = () => listedAgents().map(a => a.matcher).join(' or ');
