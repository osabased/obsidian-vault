import crypto from 'node:crypto';
import fs from 'node:fs';
import { statePath, stateDir, readJsonSafe, writeJson, removeDir, safeId, withLock } from './vault.mjs';
import { normText } from './quotes.mjs';
import { agent, hasAgent, FIRST_AGENT, typedFor } from './agents.mjs';
import { keepCallFor } from './calls.mjs';

// An offer is what the user agrees to before a rule, its evidence, a domain or a mode is written: the fields checked
// when it was made, the text shown to the user, and for an agent whose consent is a code, the code the user types back.
const CODE = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const MAX_AGE = 7 * 864e5;
const offerFile = id => statePath('offers', `${safeId(id)}.json`);
export const offersLocked = (fn, waitMs = 5000) => withLock(statePath('offers.lock'), fn, { waitMs });

export const consentOf = entry => agent(hasAgent(entry?.agent) ? entry.agent : FIRST_AGENT).consent;

// Every code holds a digit, so it is never a word the user might type for another reason.
function newCode() {
  for (;;) {
    const code = [...crypto.randomBytes(4)].map(b => CODE[b % CODE.length]).join('');
    if (/\d/.test(code)) return code;
  }
}

export function allOffers() {
  const dir = stateDir('offers');
  return fs.readdirSync(dir).filter(n => n.endsWith('.json')).map(n => readJsonSafe(`${dir}/${n}`)).filter(o => o?.id);
}

export const offerText = (lines, code) => [...lines, ...(code ? [`Reply "keep ${code}" to keep it, or say how to word it otherwise.`] : [])].join('\n');

export const REPLY = {
  held: id => `Held \`${id}\`; nothing is written yet. Don't show it now. Release it with the others when the task is done.`,
  prompt: id => `Offered \`${id}\`; nothing is written yet. Call the vault's \`keep\` tool now with id \`${id}\` and offer set to the lines below, exactly. The user allows or denies it at the prompt; a Deny ends this proposal, so don't offer it again unless they ask.`,
  code: id => `Offered \`${id}\`; nothing is written yet. End your reply with the lines below as they are. If the user's next message has the code, call \`keep\` with id \`${id}\` and offer set to these lines.`,
};

// A held offer waits for the agent's release and a pending one for the user, so the purge spares both: the sweep moves
// them to the review queue instead. A mode offer has no place in the queue and goes with the purge.
const PURGED = new Set(['kept', 'used', 'superseded', 'denied', 'queued']);
const purged = o => (PURGED.has(o.state) || o.kind === 'mode') && (Date.now() - Date.parse(o.at) >= MAX_AGE || Number.isNaN(Date.parse(o.at)));

// extra carries what the review queue needs if the offer goes there: the quote that passed its check, the day it was
// checked, and what release does with a held offer.
export function makeOffer({ kind, sid, entry, key, fields, lines, hold = false, extra = {} }) {
  const code = consentOf(entry) === 'code' ? newCode() : null;
  const text = offerText(lines, code);
  const offer = {
    id: `o-${crypto.randomBytes(4).toString('hex')}`, kind, session: String(sid), key, fields, text,
    typed: typedFor(entry)?.length ?? null, code, at: new Date().toISOString(), state: hold ? 'held' : 'pending', ...extra,
  };
  offersLocked(() => {
    for (const o of allOffers()) {
      if (purged(o)) removeDir(offerFile(o.id));
      else if (['pending', 'held'].includes(o.state) && o.session === offer.session && o.kind === kind && o.key === key) writeJson(offerFile(o.id), { ...o, state: 'superseded' });
    }
    writeJson(offerFile(offer.id), offer);
  });
  return { id: offer.id, text, code, reply: hold ? REPLY.held(offer.id) : `${REPLY[code ? 'code' : 'prompt'](offer.id)}

${text}` };
}

export const heldOffers = sid => allOffers().filter(o => o.session === String(sid) && o.state === 'held');

// typed is counted again at release, so a code the user types after the final reply passes codeConsent.
export function releaseOffers(sid, typed) {
  return offersLocked(() => heldOffers(sid).sort((a, b) => a.at.localeCompare(b.at)).map(o => {
    const released = { ...o, state: 'pending', typed, released_at: new Date().toISOString() };
    writeJson(offerFile(o.id), released);
    return released;
  }));
}

// A keep recorded and never allowed was denied at the prompt, and the user's next message is past it, so the Deny is
// marked before pruneCalls drops the record that shows it.
export function markDenied(sid) {
  offersLocked(() => {
    for (const o of allOffers()) {
      if (o.session === String(sid) && o.state === 'pending' && keepCallFor(o.id)?.allowed === null) writeJson(offerFile(o.id), { ...o, state: 'denied' });
    }
  });
}

// For a caller already holding offersLocked.
export const saveOffer = o => writeJson(offerFile(o.id), o);

export const readOffer = id => (typeof id === 'string' && id ? readJsonSafe(offerFile(id)) : null);

// Moves an offer on from pending once, so two keeps of one offer can't both write. False when it had already moved.
export function claimOffer(id) {
  return offersLocked(() => {
    const o = readOffer(id);
    if (o?.state !== 'pending') return false;
    writeJson(offerFile(id), { ...o, state: 'used' });
    return true;
  });
}

export const keptOffer = id => offersLocked(() => {
  const o = readOffer(id);
  if (o) writeJson(offerFile(id), { ...o, state: 'kept' });
});

// The hook records the keep a prompt agent makes before the user answers, and the server marks it allowed only once
// they allow it, so a recorded keep left unallowed was denied.
export function declined(sid, text) {
  return allOffers().some(o => o.session === String(sid) && o.text === text && (o.state === 'denied' || keepCallFor(o.id)?.allowed === null));
}

// The user's first typed message since the offer holds its code, and the agent's reply before it showed the offer, so
// the user saw what they agree to and agreed after it.
export function codeConsent(entry, offer) {
  const name = hasAgent(entry?.agent) ? entry.agent : FIRST_AGENT;
  const typed = typedFor(entry);
  const said = entry?.transcript ? agent(name).conversation?.(entry.transcript) : null;
  if (!typed || !said || offer.typed === null) return "the taste vault can't read this session's transcript, so it can't check the user agreed. Ask the user to make the change by hand.";
  if (typed.length <= offer.typed) return "the user hasn't replied since the offer. End your reply with it and wait.";
  if (typed.length > offer.typed + 1) return "the user has sent more than one message since the offer, so their reply to it isn't their latest. Propose it again.";
  const code = new RegExp(`(?<![\\p{L}\\p{N}])${offer.code}(?![\\p{L}\\p{N}])`, 'iu');
  if (!code.test(typed[offer.typed])) return "the user's reply after the offer doesn't have its code, so they didn't agree. Don't keep it.";
  const users = said.flatMap((e, i) => (e.role === 'user' ? [i] : []));
  const from = offer.typed > 0 ? users[offer.typed - 1] : -1;
  const shown = said.slice(from + 1, users[offer.typed]).filter(e => e.role === 'agent').map(e => e.text).join('\n');
  if (!normText(shown).includes(normText(offer.text))) {
    return "your reply before the user's didn't show the offer's lines, so they didn't see what they'd agree to. Propose it again.";
  }
  return null;
}
