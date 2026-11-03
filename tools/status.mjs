import { inVaultFolder, readableDomains, readJsonSafe, safeId, plural } from './lib/vault.mjs';
import { loadNotesAsync, settledNotes, liveRules, deliverable, deliveryFor, joinList } from './lib/rules.mjs';
import { registry, sessionDomains, sessionHits, shownThisSession } from './lib/sessions.mjs';
import { statusLine } from './lib/status.mjs';
import { currentSession } from './lib/agents.mjs';
import { UsageError, refuse, failure } from './lib/input.mjs';

const RUN = 'usage: node tools/status.mjs [session-id]';
const USAGE = `${RUN}\n       node tools/status.mjs --help says what it prints`;

const help = () => [
  RUN,
  '',
  "Prints the session's status line, as session start shows it to the user, then the rules and pages the vault has shown",
  'the session and its subagents. Without a session id it takes the one the agent\'s shell sets.',
].join('\n');

function shown(sid) {
  const { rules, pages } = shownThisSession(sid);
  const part = (keys, noun) => (keys.length ? `${plural(keys.length, noun)}, ${joinList(keys, 'and')}` : '');
  const parts = [part(rules, 'rule'), part(pages, 'page')].filter(Boolean);
  return `shown this session: ${parts.length ? parts.join('; ') : 'nothing yet'}`;
}

async function status(sid) {
  if (!sid) refuse("there's no session id. Pass the one from the taste vault's note at session start, or run this from the agent's own shell, which sets it.");
  const entry = readJsonSafe(registry(safeId(sid)));
  if (!entry) refuse(`the taste vault has no session ${sid}.`);
  const cwd = entry.cwd;
  const doms = sessionDomains(sid, cwd);
  const vaultFolder = inVaultFolder(cwd);
  const readable = readableDomains(doms, vaultFolder);
  const notes = settledNotes(await loadNotesAsync(vaultFolder ? null : readable));
  const rules = deliverable(liveRules(notes), deliveryFor(sessionHits(sid, cwd)));
  return [statusLine({ doms, vaultFolder, rules, notes, readable }), shown(sid)].join('\n');
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
