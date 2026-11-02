import fs from 'node:fs';
import {
  config, vaultPath, statePath, withLock, writeText, appendLog, toPosix, inVaultFolder, reloadConfig, PROPOSAL_MODES,
} from './lib/vault.mjs';
import { joinList } from './lib/rules.mjs';
import { inLatest } from './lib/quotes.mjs';
import { ownEntry, proposeDomains } from './lib/sessions.mjs';
import { valuesOf, setMember } from './lib/json.mjs';
import { modeLines } from './lib/instructions.mjs';
import { currentSession, shortName } from './lib/agents.mjs';
import { UsageError, readInput, refuse, failure, line } from './lib/input.mjs';

const RUN = 'usage: node tools/proposals.mjs [session-id] < mode.json';
const USAGE = `${RUN}\n       node tools/proposals.mjs --help lists the fields of mode.json`;

const help = () => [
  RUN,
  '',
  'Sets when agents propose rules, in vault.config.json. mode.json is an object with these fields:',
  '  mode       corrections: propose.mjs writes a rule as soon as the agent proposes it',
  '             ask: the agent offers each rule, and propose.mjs writes it once the user agrees',
  '             off: the agent proposes a rule only when the user asks for one',
  '  domain     optional, a domain to give a mode of its own; without it, or with global, the mode for global and',
  '             every domain without one of its own',
  "  approved   the user's words asking for the change, as they typed them in their latest message",
  '',
  'A session in the vault folder proposes as in corrections whatever the mode, since /ingest goes through each rule with',
  'the user.',
].join('\n');

const FIELDS = new Set(['mode', 'domain', 'approved']);

const PASS = "Pass the session id from the taste vault's note at session start, or run this from the agent's own shell, which sets its session id.";

function sessionOf(sid) {
  if (!sid) refuse(`there's no session id to set the mode for. ${PASS}`);
  const { entry, notOwn } = ownEntry(sid);
  if (notOwn) refuse(notOwn);
  if (!entry) refuse(`the taste vault has no session ${sid}. ${PASS}`);
  return entry;
}

function fields(p) {
  const unknown = Object.keys(p).find(k => !FIELDS.has(k));
  if (unknown) refuse(`${unknown} isn't a field proposals.mjs takes. node tools/proposals.mjs --help lists the fields.`);
  const mode = line(p, 'mode');
  if (!PROPOSAL_MODES.includes(mode)) refuse(`mode must be ${joinList(PROPOSAL_MODES, 'or')}.`);
  const named = line(p, 'domain', false).normalize('NFC');
  const domain = named === 'global' ? '' : named;
  if (domain && !Object.hasOwn(config().domains, domain)) {
    refuse(`vault.config.json has no domain ${domain}. Give one of ${joinList(Object.keys(config().domains), 'or')}, or leave domain out.`);
  }
  return { mode, domain };
}

// The mode is the user's to change, so it changes only with their words from their latest message, as a domain starts.
function approval(entry, p) {
  const approved = line(p, 'approved', false);
  if (!approved) refuse("approved is missing: give the user's words asking for the change, from their latest message.");
  const agreed = inLatest(entry, approved);
  if (agreed === null) refuse("the taste vault has no transcript for this session, so it can't check approved is the user's words. Ask the user to set proposals in vault.config.json.");
  if (!agreed) refuse("approved isn't in the user's latest message. Change the mode only when the user asks, and pass their words as approved.");
}

function write({ mode, domain }) {
  const file = vaultPath('vault.config.json');
  const raw = fs.readFileSync(file, 'utf8');
  const top = raw.indexOf('{');
  if (top < 0) refuse("vault.config.json holds no JSON object. /lint names the problem; it is the user's to fix.");
  if (!domain) {
    writeText(file, setMember(raw, top, 1, 'proposals', mode));
    return;
  }
  const domains = valuesOf(raw, top).get('domains');
  const at = domains !== undefined && raw[domains] === '{' ? valuesOf(raw, domains).get(domain) : undefined;
  // Another run may have changed the file since the checks.
  if (at === undefined || raw[at] !== '{') refuse(`vault.config.json has no domain ${domain} to set.`);
  writeText(file, setMember(raw, at, 3, 'proposals', mode));
}

const MEANS = {
  corrections: 'agents write a rule as soon as they propose it',
  ask: 'agents offer each rule and write it once you agree',
  off: 'agents propose a rule only when you ask for one',
};

function reply({ mode, domain }, entry) {
  const own = domain ? [] : Object.entries(config().domains)
    .filter(([, c]) => PROPOSAL_MODES.includes(c.proposals))
    .map(([d, c]) => `${d} keeps its own mode, ${c.proposals}.`);
  const now = inVaultFolder(entry.cwd)
    ? 'This session is in the vault folder, so it proposes as before.'
    : `From now on in this session: ${modeLines([...proposeDomains(entry), 'global'])}`;
  const what = `${mode}${domain ? ` for ${domain}` : ''}`;
  return [
    `Set proposals to ${what} in vault.config.json. ${now}`,
    'End your reply with this line as it is:',
    '',
    `**Proposals** ${what}: ${MEANS[mode]}.${own.length ? ` ${own.join(' ')}` : ''} To change it, ask again or edit ${toPosix(vaultPath('vault.config.json'))}.`,
  ].join('\n');
}

// The input is read after the session is checked, so a script run from the wrong place says that first.
function setMode(sid, input) {
  const entry = sessionOf(sid);
  const p = input();
  const f = fields(p);
  approval(entry, p);
  withLock(statePath('config.lock'), () => {
    write(f);
    appendLog([`set proposals to ${f.mode}${f.domain ? ` for ${f.domain}` : ''} · session ${shortName(sid, entry.agent)}`]);
  });
  reloadConfig();
  return reply(f, entry);
}

const args = process.argv.slice(2);
try {
  if (args[0] === '--help' && args.length === 1) console.log(help());
  else if (args.length > 1) throw new UsageError();
  else console.log(setMode(args[0] ?? currentSession()?.id, readInput));
} catch (e) {
  const f = failure(e, 'proposals', USAGE, 'Not set');
  console.error(f.message);
  process.exitCode = f.code;
}
