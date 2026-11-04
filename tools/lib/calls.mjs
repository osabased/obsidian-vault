import crypto from 'node:crypto';
import fs from 'node:fs';
import { statePath, stateDir, readJsonSafe, writeJson, removeDir, safeId, withLock, olderThan } from './vault.mjs';

// The PreToolUse hook records each call of a vault tool before the call runs; the server and the scripts it runs read
// the record to learn which session made the call and whether the user allowed it. One lock serves them all, since a
// record changes in three steps (recorded, allowed, used) from different processes.
const callFile = call => statePath('calls', `${safeId(call)}.json`);
const offerFile = offer => statePath('calls', 'offers', `${safeId(offer)}.json`);
const locked = fn => withLock(statePath('calls.lock'), fn, { waitMs: 5000 });
const stored = call => (call ? readJsonSafe(callFile(call)) : null);

// Keys sorted at every depth, so the hook's copy of the input and the one the script parsed hash the same whatever order
// each side's JSON put them in. Keys holding undefined are left out, as JSON.stringify leaves them out.
function canonical(x) {
  if (Array.isArray(x)) return `[${x.map(canonical).join(',')}]`;
  if (x && typeof x === 'object') {
    return `{${Object.keys(x).filter(k => x[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonical(x[k])}`).join(',')}}`;
  }
  return JSON.stringify(x) ?? 'null';
}

// The user allowed a call with the input the prompt showed them, so the record holds its hash and the script's run must
// give the same input.
export const inputHash = input => crypto.createHash('sha256').update(canonical(input ?? {})).digest('hex');

// The first call to carry an offer wins: a second one for it writes nothing and returns the first's id, so a Deny on
// the first keep ends the offer and the agent can't ask the user again for the same text.
export function recordCall({ call, session, subagent, tool, offer = null, input }) {
  return locked(() => {
    if (offer !== null) {
      const first = readJsonSafe(offerFile(offer))?.call;
      if (first && first !== call) return { seen: first };
    }
    // A hook that runs again for one call must not clear what the user's allowing already set.
    if (stored(call)) return { seen: null };
    writeJson(callFile(call), {
      call, session, subagent: subagent ?? null, tool, offer, input: inputHash(input), at: new Date().toISOString(), allowed: null, used: null,
    });
    if (offer !== null) writeJson(offerFile(offer), { call });
    return { seen: null };
  });
}

export const readCall = stored;

export function allowCall(call) {
  return locked(() => {
    const rec = stored(call);
    if (!rec) return null;
    if (!rec.allowed) writeJson(callFile(call), Object.assign(rec, { allowed: new Date().toISOString() }));
    return rec;
  });
}

export function useCall(call, { session, tool, offer = null, input }) {
  return locked(() => {
    const rec = stored(call);
    if (!rec?.allowed || rec.used || rec.session !== session || rec.tool !== tool || (rec.offer ?? null) !== offer) return false;
    // Spent on a mismatch too, so a call refused once can't be run again with any input.
    writeJson(callFile(call), Object.assign(rec, { used: new Date().toISOString() }));
    return rec.input === inputHash(input);
  });
}

export function keepCallFor(offer) {
  const first = readJsonSafe(offerFile(offer))?.call;
  return first ? stored(first) : null;
}

function mtime(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

// A keep's record is the only sign of a Deny, so it stays while its offer is pending: the sweep reads it to mark the
// offer denied rather than queue it. The offer's file is read directly, since offers.mjs imports this module.
const waiting = offer => typeof offer === 'string' && readJsonSafe(statePath('offers', `${safeId(offer)}.json`))?.state === 'pending';

export function pruneCalls(maxAgeMs = 2 * 864e5) {
  const dir = stateDir('calls');
  const old = (file, at) => olderThan(Number.isFinite(at) ? at : mtime(file), maxAgeMs);
  locked(() => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = `${dir}/${e.name}`;
      if (!e.isFile() || !e.name.endsWith('.json')) continue;
      const rec = readJsonSafe(file);
      if (old(file, Date.parse(rec?.at)) && !waiting(rec?.offer)) removeDir(file);
    }
    const offers = stateDir('calls', 'offers');
    for (const name of fs.readdirSync(offers)) {
      if (old(`${offers}/${name}`, NaN) && !waiting(name.replace(/\.json$/, ''))) removeDir(`${offers}/${name}`);
    }
  });
}
