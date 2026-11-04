import { localDay } from './lib/vault.mjs';
import { proposeRule } from './lib/propose-rule.mjs';
import { entryOf, openEntries, decide } from './lib/queue.mjs';
import { callerEntry } from './lib/sessions.mjs';
import { currentSession } from './lib/agents.mjs';
import { UsageError, readInput, refuse, failure } from './lib/input.mjs';

const USAGE = [
  'usage: node tools/queue.mjs list',
  '       node tools/queue.mjs show <id>',
  '       node tools/queue.mjs draft [session-id] < rule.json',
  '       node tools/queue.mjs later <id> [session-id]',
  '       node tools/queue.mjs drop <id> [session-id]',
].join('\n');

const NOT = { draft: 'Not drafted', later: 'Not marked', drop: 'Not dropped' };

const sessionOf = sid => callerEntry(sid, {
  noId: "there's no session id. Pass it as an argument, or run this from the agent's own shell, which sets its session variable.",
  pass: '',
});

const lineOf = r => [r.id, localDay(r.at), r.kind, r.why, ...(r.unattended ? [`unattended: ${r.unattended}`] : []), r.key].join(' · ');

function list() {
  const open = openEntries();
  return open.length ? open.map(lineOf).join('\n') : 'The review queue is empty.';
}

function show(id) {
  const { entry, decided } = entryOf(id);
  if (!entry) refuse(`there's no entry \`${id}\` in raw/queue/.`);
  return [lineOf(entry), ...(decided ? [`It was ${decided}.`] : []), '', entry.text, '', JSON.stringify(entry.fields, null, 2)].join('\n');
}

// A draft is the agent's own: it can't plant words as the user's, nor spend a pick the user never saw offered.
function draft(sid) {
  sessionOf(sid);
  const p = readInput();
  for (const k of ['hold', 'release', 'queued']) if (Object.hasOwn(p, k)) refuse(`a draft is one rule's fields; ${k} isn't one of them.`);
  if (!['reading', 'source', 'failure'].includes(p.basis)) refuse(`a draft takes basis reading, source or failure, so basis ${p.basis} is refused.`);
  return proposeRule(sid, p, { queueAs: { why: 'drafted', unattended: null, reply: id => `Drafted \`${id}\` into the review queue; nothing is written.` } });
}

function close(id, decision, sid) {
  const entry = sessionOf(sid);
  const { why } = decide({ id, decision, sid, agentName: entry.agent });
  if (why === 'missing') refuse(`there's no entry \`${id}\` in raw/queue/.`);
  if (why) refuse(`\`${id}\` was already ${why}.`);
  return decision === 'later' ? `Left \`${id}\` open for later.` : `Dropped \`${id}\`.`;
}

const [cmd, ...rest] = process.argv.slice(2);
try {
  const env = () => currentSession()?.id;
  if (cmd === 'list' && !rest.length) console.log(list());
  else if (cmd === 'show' && rest.length === 1) console.log(show(rest[0]));
  else if (cmd === 'draft' && rest.length <= 1) console.log(draft(rest[0] ?? env()));
  else if (['later', 'drop'].includes(cmd) && rest.length >= 1 && rest.length <= 2) console.log(close(rest[0], cmd === 'drop' ? 'dropped' : 'later', rest[1] ?? env()));
  else throw new UsageError();
} catch (e) {
  const f = failure(e, 'queue', USAGE, NOT[cmd] ?? 'Refused');
  console.error(f.message);
  process.exitCode = f.code;
}
