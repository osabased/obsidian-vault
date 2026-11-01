import fs from 'node:fs';
import { createRequire } from 'node:module';
import { config, toolsPath } from './vault.mjs';

// Everything one agent does its own way, its hook input and output, tool names and transcripts, lives in
// tools/adapters/<agent>/adapter.mjs, so the core names no agent. A session registered before any entry named its agent
// was the first adapter's.
export const AGENT_NAME = /^[a-z0-9][a-z0-9_-]*$/;
export const FIRST_AGENT = 'claude-code';
const fileOf = name => toolsPath('adapters', name, 'adapter.mjs');
export const hasAgent = name => typeof name === 'string' && AGENT_NAME.test(name) && fs.existsSync(fileOf(name));

// Hooks run synchronously, and require loads an ES module synchronously from Node 22.12 on.
const load = createRequire(import.meta.url);
const loaded = new Map();

export function agent(name) {
  if (!hasAgent(name)) throw new Error(`no agent ${name}: tools/adapters/${name}/adapter.mjs doesn't exist`);
  if (!loaded.has(name)) loaded.set(name, load(fileOf(name)));
  return loaded.get(name);
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

// The user's typed messages in a registered session, read by the adapter of the agent that registered it. Null when the
// transcript can't be read.
export function typedFor(entry) {
  const name = entry?.agent ?? FIRST_AGENT;
  return entry?.transcript && hasAgent(name) ? agent(name).typedMessages(entry.transcript) : null;
}

export const editsFile = tool => listedAgents().some(a => a.fileTools.includes(tool));
export const sentToHook = tool => listedAgents().some(a => a.sends(tool));
export const hookMatchers = () => listedAgents().map(a => a.matcher).join(' or ');
