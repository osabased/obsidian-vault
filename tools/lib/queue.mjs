import crypto from 'node:crypto';
import { config, statePath, withLock, appendJsonl, queueFile, queueRows, readJsonSafe, writeText, vaultPath, safeId, today, localDay } from './vault.mjs';
import { registry } from './sessions.mjs';
import { shortName } from './agents.mjs';
import { allOffers, offersLocked, saveOffer, consentOf } from './offers.mjs';
import { keepCallFor } from './calls.mjs';

// The review queue: entries the user hasn't seen or answered, in raw/queue/, and decision rows that name them. Rows are
// never edited, so an entry is open until a kept or dropped row names it; a later row only records it was seen. Every write
// to raw/queue/ and queue.md takes queue.lock, so queue.md is rendered from the rows as they are once the write is done.
// A caller holding offers.lock or propose.lock may take it, never the other way round.
export const queueLocked = fn => withLock(statePath('queue.lock'), fn, { waitMs: 5000 });

export const newId = prefix => `${prefix}-${crypto.randomBytes(4).toString('hex')}`;

export function entryOf(id, rows = queueRows()) {
  const entry = rows.find(r => r.id === id && !r.decides) ?? null;
  const ends = rows.filter(r => r.decides === id && ['kept', 'dropped'].includes(r.decision));
  return { entry, decided: ends.at(-1)?.decision ?? null };
}

export function openEntries(rows = queueRows()) {
  const closed = new Set(rows.filter(r => r.decides && ['kept', 'dropped'].includes(r.decision)).map(r => r.decides));
  return rows.filter(r => !r.decides && typeof r.id === 'string' && !closed.has(r.id)).sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

export function queueEntry({ id, kind, why, unattended, from, session, entry, domain, key, fields, text, quote, checked }) {
  return {
    id, at: new Date().toISOString(), kind, why, unattended, from, session: String(session), agent: entry?.agent ?? null,
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
  const row = { id: newId('d'), at: new Date().toISOString(), decides: id, decision, offer, session: String(sid) };
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

const quietSince = (entry, hours) => !entry || Number.isNaN(Date.parse(entry.last_seen)) || Date.now() - Date.parse(entry.last_seen) >= hours * 3600e3;

function why(o, entry) {
  if (o.state === 'held') return ['unreleased', null];
  const shown = Date.parse(o.released_at ?? o.at);
  return Date.parse(entry?.last_prompt) > shown ? ['skipped', null] : ['ignored', 'left'];
}

// Reads only .state/offers/ and the registry, never a transcript, so it fits in a session start's deadline. The caller's
// own offers are never its to sweep, and a session not quiet yet may still answer its own.
export function sweep(self) {
  const hours = config().queue.sweepAfterHours;
  let moved = 0;
  offersLocked(() => queueLocked(() => {
    const ids = new Set(queueRows().map(r => r.id));
    for (const o of allOffers()) {
      if (o.session === String(self) || o.kind === 'mode' || !['held', 'pending'].includes(o.state)) continue;
      const entry = readJsonSafe(registry(safeId(o.session)));
      if (!quietSince(entry, hours)) continue;
      if (o.state === 'pending' && consentOf(entry) === 'prompt' && keepCallFor(o.id)?.allowed === null) {
        saveOffer({ ...o, state: 'denied' });
        continue;
      }
      // An offer made again from an entry stays that entry, so one rule never has two.
      const id = o.fields?.queued ?? `u-${o.id.slice(2)}`;
      const [reason, unattended] = why(o, entry);
      if (!ids.has(id)) {
        const text = o.code ? o.text.split('\n').slice(0, -1).join('\n') : o.text;
        const domain = o.kind === 'domain' ? o.key : o.key.split('/')[0];
        addEntry(queueEntry({
          id, kind: o.kind, why: reason, unattended, from: o.id, session: o.session, entry, domain, key: o.key, fields: o.fields, text,
          quote: o.quote, checked: o.checked ?? (localDay(o.at) || today()),
        }), shortName(o.session, entry?.agent));
        ids.add(id);
        moved++;
      }
      saveOffer({ ...o, state: 'queued', queued_as: id });
    }
  }));
  return moved;
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
