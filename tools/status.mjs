import { inVaultFolder, readableDomains, readJsonSafe, safeId, plural } from './lib/vault.mjs';
import { loadNotesAsync, settledNotes, liveRules, deliverable, deliveryFor, joinList } from './lib/rules.mjs';
import { registry, sessionDomains, sessionHits, shownInContext } from './lib/sessions.mjs';
import { statusLine } from './lib/status.mjs';
import { currentSession } from './lib/agents.mjs';
import { UsageError, refuse, failure } from './lib/input.mjs';

const RUN = 'usage: node tools/status.mjs [session-id]';
const USAGE = `${RUN}\n       node tools/status.mjs --help says what it prints`;

const help = () => [
  RUN,
  '',
  "Prints the session's status line for the domains its prompts reach now, then the rules and pages the vault has shown",
  "the session and its subagents since it started or was last compacted. Without a session id it takes the one the",
  "agent's shell sets.",
].join('\n');

function shown(sid) {
  const { rules, pages } = shownInContext(sid);
  const part = (keys, noun) => (keys.length ? `${plural(keys.length, noun)}, ${joinList(keys, 'and')}` : '');
  const parts = [part(rules, 'rule'), part(pages, 'page')].filter(Boolean);
  return `shown since the session started or was last compacted: ${parts.length ? parts.join('; ') : 'nothing yet'}`;
}

// The domains and rules a prompt in the session gets, which follow the session's latest start and the folder it began in.
async function status(sid) {
  if (!sid) refuse("there's no session id. Pass the one from the taste vault's note at session start, or run this from the agent's own shell, which sets it.");
  const entry = readJsonSafe(registry(safeId(sid)));
  if (!entry) refuse(`the taste vault has no session ${sid}.`);
  const cwd = entry.cwd;
  const doms = sessionDomains(sid, cwd);
  const vaultFolder = inVaultFolder(cwd);
  const readable = readableDomains(doms, vaultFolder);
  const notes = settledNotes(await loadNotesAsync(vaultFolder ? null : readable));
  const ctx = deliveryFor(sessionHits(sid, cwd));
  const rules = deliverable(liveRules(notes), ctx);
  return [statusLine({ doms, vaultFolder, rules, notes, readable, ctx }), shown(sid)].join('\n');
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
