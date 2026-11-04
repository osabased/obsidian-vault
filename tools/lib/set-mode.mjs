import fs from 'node:fs';
import {
  config, vaultPath, statePath, withLock, writeText, appendLog, toPosix, inVaultFolder, reloadConfig, PROPOSAL_MODES,
} from './vault.mjs';
import { joinList } from './rules.mjs';
import { callerEntry, proposeDomains, PASS } from './sessions.mjs';
import { valuesOf, setMember } from './json.mjs';
import { modeLines } from './instructions.mjs';
import { typedFor, shortName } from './agents.mjs';
import { refuse, line } from './input.mjs';
import { useCall } from './calls.mjs';
import { makeOffer, offerText, consentOf } from './offers.mjs';

const FIELD_NAMES = new Set(['mode', 'domain']);

function fields(p) {
  const unknown = Object.keys(p).find(k => !FIELD_NAMES.has(k));
  if (unknown) refuse(`${unknown} isn't a field proposals.mjs takes. The \`proposals\` tool's schema lists the fields.`);
  const mode = line(p, 'mode');
  if (!PROPOSAL_MODES.includes(mode)) refuse(`mode must be ${joinList(PROPOSAL_MODES, 'or')}.`);
  const named = line(p, 'domain', false).normalize('NFC');
  const domain = named === 'global' ? '' : named;
  if (domain && !Object.hasOwn(config().domains, domain)) {
    refuse(`vault.config.json has no domain ${domain}. Give one of ${joinList(Object.keys(config().domains), 'or')}, or leave domain out.`);
  }
  return { mode, domain };
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

// The mode is the user's to change, so it changes only once they agree: at the prompt for the proposals call itself, or
// by typing the code of an offer. The input is read after the session is checked, so a script run from the wrong place
// says that first: p is the input, or a function that reads it. call is the proposals call the user allowed; kept is the
// consent keep found, with the offer's text and code, which the fields must still give. The user allowed one call with
// the input they saw, so the call is spent before the fields are checked, and a refused run can't be run again.
export function setMode(sid, p, { call = null, kept = null } = {}) {
  const entry = callerEntry(sid, { noId: `there's no session id to set the mode for. ${PASS}` });
  if (typeof p === 'function') p = p();
  const prompted = !kept && consentOf(entry) === 'prompt';
  if (prompted && !useCall(call, { session: String(sid), tool: 'proposals', input: p })) {
    refuse("proposals changes the mode only from the vault's `proposals` tool, once the user allows it at the prompt.");
  }
  const f = fields(p);
  const what = `${f.mode}${f.domain ? ` for ${f.domain}` : ''}`;
  const offer = [`**Set proposals?** ${what}: ${MEANS[f.mode]}.`];
  if (kept) {
    if (offerText(offer, kept.code) !== kept.text) refuse("the vault changed since the offer, so it isn't what the user agreed to. Propose it again.");
  } else if (!prompted) {
    if (!typedFor(entry)) refuse("the taste vault has no transcript for this session, so it can't check the user agreed. Ask the user to set proposals in vault.config.json.");
    return makeOffer({ kind: 'mode', sid, entry, key: `mode:${f.domain || 'global'}`, fields: p, lines: offer }).reply;
  }
  withLock(statePath('config.lock'), () => {
    write(f);
    appendLog([`set proposals to ${what} · session ${shortName(sid, entry.agent)}`]);
  });
  reloadConfig();
  return reply(f, entry);
}
