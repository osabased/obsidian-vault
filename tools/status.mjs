import { readJsonSafe, safeId, plural } from './lib/vault.mjs';
import { joinList } from './lib/rules.mjs';
import { registry, shownInContext } from './lib/sessions.mjs';
import { sessionView } from './lib/reach.mjs';
import { statusLine } from './lib/status.mjs';
import { agent, hasAgent, currentSession, FIRST_AGENT } from './lib/agents.mjs';
import { UsageError, refuse, failure } from './lib/input.mjs';

const RUN = 'usage: node tools/status.mjs [session-id]';
const USAGE = `${RUN}\n       node tools/status.mjs --help says what it prints`;

const help = () => [
  RUN,
  '',
  "Prints the session's status line for the folder its latest prompt came from, then the rules and pages the vault has shown",
  "the session and its subagents since it started or was last compacted. Without a session id it takes the one the",
  "agent's shell sets.",
].join('\n');

function shown(sid) {
  const { rules, pages } = shownInContext(sid);
  const part = (keys, noun) => (keys.length ? `${plural(keys.length, noun)}, ${joinList(keys, 'and')}` : '');
  const parts = [part(rules, 'rule'), part(pages, 'page')].filter(Boolean);
  return `shown since the session started or was last compacted: ${parts.length ? parts.join('; ') : 'nothing yet'}`;
}

// The line counts what a prompt in the session would get now, in the folder its latest prompt came from, with the tools
// its agent sends the edit hook.
async function status(sid) {
  if (!sid) refuse("there's no session id. Pass the one from the taste vault's note at session start, or run this from the agent's own shell, which sets it.");
  const entry = readJsonSafe(registry(safeId(sid)));
  if (!entry) refuse(`the taste vault has no session ${sid}.`);
  const cwd = entry.last_cwd ?? entry.reach?.cwd ?? entry.cwd;
  const adapter = agent(hasAgent(entry.agent) ? entry.agent : FIRST_AGENT);
  return [statusLine(await sessionView(sid, cwd, adapter), entry), shown(sid)].join('\n');
}

const args = process.argv.slice(2);
try {
  if (args[0] === '--help' && args.length === 1) console.log(help());
  else if (args.length > 1) throw new UsageError();
  else console.log(await status(args[0] ?? currentSession()?.id));
} catch (e) {
  const f = failure(e, 'status', USAGE);
  console.error(f.message);
  process.exitCode = f.code;
}
