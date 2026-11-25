import { config, statePath, withLock, appendJsonl, queueFile, queueRows, writeText, vaultPath, today, localDay, newId, olderThan } from './vault.mjs';
import { registryEntry } from './sessions.mjs';
import { shortName } from './agents.mjs';
import { allOffers, offersLocked, saveOffer, consentOf, plainText } from './offers.mjs';
import { keepCallFor } from './calls.mjs';
import { loadNotes, ruleEnded } from './rules.mjs';

// The review queue: entries the user hasn't seen or answered, in raw/queue/, and decision rows that name them. Rows are
// never edited, so an entry is open until a kept or dropped row names it; a later row only records it was seen. Every write
// to raw/queue/ and queue.md takes queue.lock, so queue.md is rendered from the rows as they are once the write is done.
// A caller holding offers.lock, propose.lock or build.lock may take it, never the other way round; build takes it only
// when it is free at once.
export const queueLocked = (fn, waitMs = 5000) => withLock(statePath('queue.lock'), fn, { waitMs });

export const CLOSING = ['kept', 'dropped'];

// Each kind of change an offer holds, in the order lint lists them. noun is what keep calls it. queued: the review queue
// holds it, and propose takes its entry again. offerOnly: an offer in every mode, since corrections writes only what the
// user corrected. citesNoOne: it takes no one's words as evidence. change: propose takes it as a change to a live rule.
// onRule: its key names the rule it adds to or changes, so it ends with that rule.
export const CHANGE_KINDS = {
  rule: { noun: 'rule', queued: true },
  evidence: { noun: 'rule', queued: true, onRule: true },
  page: { noun: 'page', queued: true, offerOnly: true, citesNoOne: true },
  reword: { noun: 'rule', queued: true, change: true, onRule: true },
  retire: { noun: 'rule', queued: true, offerOnly: true, citesNoOne: true, change: true, onRule: true },
  domain: { noun: 'domain', queued: true, offerOnly: true },
  move: { noun: 'rule', queued: true, offerOnly: true, citesNoOne: true, change: true, onRule: true },
  mode: { noun: 'setting', offerOnly: true },
};
export const kindIs = (kind, fact) => Object.hasOwn(CHANGE_KINDS, kind) && CHANGE_KINDS[kind][fact] === true;
export const kindsThat = fact => Object.keys(CHANGE_KINDS).filter(k => CHANGE_KINDS[k][fact] === true);

// Each closed entry's id, with the decision of the last row that closed it.
function closedBy(rows) {
  const closed = new Map();
  for (const r of rows) if (r.decides && CLOSING.includes(r.decision)) closed.set(r.decides, r.decision);
  return closed;
}

export function entryOf(id, rows = queueRows()) {
  return { entry: rows.find(r => r.id === id && !r.decides) ?? null, decided: closedBy(rows).get(id) ?? null };
}

// In the order of `at`, as queueRows reads them.
export function openEntries(rows = queueRows()) {
  const closed = closedBy(rows);
  return rows.filter(r => !r.decides && typeof r.id === 'string' && !closed.has(r.id));
}

// The rules a retirement entry already asks about: open, or dropped by the user, who kept the rule. A kept one retired it.
export function retirementsAsked(rows = queueRows()) {
  const closed = closedBy(rows);
  return new Set(rows.filter(r => !r.decides && r.kind === 'retire' && closed.get(r.id) !== 'kept').map(r => r.key));
}

export function queueEntry({ id, kind, why, unattended, from, session, entry, agent = null, domain, key, fields, text, quote, checked }) {
  return {
    id, at: new Date().toISOString(), kind, why, unattended, from, session: String(session), agent: entry?.agent ?? agent,
    transcript: entry?.transcript ?? null, cwd: entry?.cwd ?? null, domain, key, fields, text, quote: quote ?? null, checked,
  };
}

function addEntry(row, name) {
  appendJsonl(queueFile(name), [row]);
  writeQueue();
}

export const appendEntry = (row, name) => queueLocked(() => addEntry(row, name));

// For a caller already holding queue.lock, which checked the entry is open under it.
export function closeEntry({ id, decision, offer = null, sid, agentName }) {
  const row = { id: newId('d'), at: new Date().toISOString(), decides: id, decision, offer, session: String(sid), agent: agentName ?? null };
  appendJsonl(queueFile(shortName(sid, agentName)), [row]);
  writeQueue();
  return row;
}

// Checked and written under one lock, so two drops of one entry, or a drop and a keep, can't both close it.
export function decide({ id, decision, offer = null, sid, agentName }) {
  return queueLocked(() => {
    const { entry, decided } = entryOf(id);
    if (!entry) return { why: 'missing' };
    if (decided) return { why: decided };
    return { row: closeEntry({ id, decision, offer, sid, agentName }) };
  });
}

const quietSince = (entry, hours) => olderThan(entry?.last_seen, hours * 3600e3);

function why(o, entry) {
  if (o.state === 'held') return ['unreleased', null];
  const shown = Date.parse(o.released_at ?? o.at);
  return Date.parse(entry?.last_prompt) > shown ? ['skipped', null] : ['ignored', 'left'];
}

// Reads only .state/offers/ and the registry, never a transcript, so it fits in a session start's deadline. The caller's
// own offers are never its to sweep, and a session not quiet yet may still answer its own, as may one whose registry
// entry can't be read. waitMs caps the wait for both locks together, so a session start can leave the sweep to the next
// one. Most starts find nothing to sweep, so the locks and the queue's rows are taken only once a read without them finds
// an offer.
export function sweep(self, { waitMs = 5000 } = {}) {
  const hours = config().queue.sweepAfterHours;
  const registries = new Map();
  const registered = sid => {
    if (!registries.has(sid)) {
      let read = null;
      try { read = { entry: registryEntry(sid) }; } catch {}
      registries.set(sid, read);
    }
    return registries.get(sid);
  };
  const quiet = sid => { const read = registered(sid); return read !== null && quietSince(read.entry, hours); };
  const due = o => o.session !== String(self) && o.kind !== 'mode' && ['held', 'pending'].includes(o.state) && quiet(o.session);
  if (!allOffers().some(due)) return 0;
  // An offer on a rule that has since ended can't be kept, so it isn't queued. The notes are every domain's, since the
  // offer's may be one this session doesn't read, and are read before the locks, only when such an offer is due.
  const onRule = o => due(o) && kindIs(o.kind, 'onRule');
  const notes = allOffers().some(onRule) ? loadNotes() : null;
  const added = new Map();
  const queued = [];
  const giveUp = Date.now() + waitMs;
  offersLocked(() => queueLocked(() => {
    const ids = new Set(queueRows().map(r => r.id));
    for (const o of allOffers().filter(due)) {
      const { entry } = registered(o.session);
      if (o.state === 'pending' && consentOf(entry ?? { agent: o.agent }) === 'prompt' && keepCallFor(o.id)?.allowed === null) {
        saveOffer({ ...o, state: 'denied' });
        continue;
      }
      if (notes && kindIs(o.kind, 'onRule') && ruleEnded(o.key, notes)) {
        saveOffer({ ...o, state: 'moot' });
        continue;
      }
      // An offer made again from an entry stays that entry, so one rule never has two.
      const id = o.fields?.queued ?? `u-${o.id.slice(2)}`;
      const [reason, unattended] = why(o, entry);
      if (!ids.has(id)) {
        const domain = o.kind === 'domain' ? o.key : o.key.split('/')[0];
        const file = shortName(o.session, entry?.agent ?? o.agent);
        added.set(file, [...(added.get(file) ?? []), queueEntry({
          id, kind: o.kind, why: reason, unattended, from: o.id, session: o.session, entry, agent: o.agent ?? null, domain, key: o.key, fields: o.fields,
          text: plainText(o), quote: o.quote, checked: o.checked ?? (localDay(o.at) || today()),
        })]);
        ids.add(id);
      }
      queued.push({ ...o, state: 'queued', queued_as: id });
    }
    // The rows go first, so an offer is never marked queued without its entry.
    for (const [file, rows] of added) appendJsonl(queueFile(file), rows);
    queued.forEach(saveOffer);
    if (added.size) writeQueue();
  }, Math.max(0, giveUp - Date.now())), waitMs);
  return [...added.values()].reduce((n, rows) => n + rows.length, 0);
}

export function renderQueue(rows = queueRows()) {
  const open = openEntries(rows);
  const out = ['# Review queue', '', 'Generated by tools/build.mjs from the entries in raw/queue/. Do not edit.'];
  if (!open.length) out.push('', 'Nothing waits for review.');
  for (const r of open) {
    const mark = r.unattended ? ` · unattended: ${r.unattended}` : '';
    out.push('', `## ${r.id} · ${r.key}`, '', `${localDay(r.at)} · ${r.kind} · ${r.why}${mark}`, '', String(r.text ?? ''));
  }
  return `${out.join('\n')}\n`;
}

// Session start builds only when a note changed, so whatever adds to the queue writes queue.md itself.
export const writeQueue = () => writeText(vaultPath('queue.md'), renderQueue());
