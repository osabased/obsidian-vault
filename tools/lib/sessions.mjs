import fs from 'node:fs';
import path from 'node:path';
import { vaultPath, statePath, stateDir, readJsonSafe, writeJson, safeId, shortHash, logError } from './vault.mjs';

const DAY = 86400e3;

export const registry = id => statePath('sessions', `${id}.json`);

// `loaded` records when each domain's always-on rules went into the session's context, so rules
// confirmed later, or domains the session moves into, are delivered with the next prompt. `cwd` stays where
// the session registered, so a move into the vault folder doesn't let it propose for every domain.
export function touchSession(input, { loaded = [] } = {}) {
  const id = safeId(input.session_id);
  const file = registry(id);
  const prev = readJsonSafe(file) ?? {};
  const now = new Date().toISOString();
  const entry = {
    session: String(input.session_id),
    transcript: input.transcript_path ?? prev.transcript ?? null,
    cwd: prev.cwd ?? input.cwd ?? null,
    last_seen: now,
    loaded: { ...prev.loaded, ...Object.fromEntries(loaded.map(d => [d, now])) },
  };
  writeJson(file, entry);
  return { ...entry, id };
}

const marker = (kind, sid, key) => vaultPath('.state', kind, safeId(sid), shortHash(key));

export const marked = (kind, sid, key) => fs.existsSync(marker(kind, sid, key));

function create(file, text) {
  try {
    fs.writeFileSync(file, text, { flag: 'wx' });
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, { flag: 'wx' });
  }
}

function mark(kind, sid, key) {
  try {
    create(marker(kind, sid, key), key);
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw e;
  }
}

export const markRepeat = (sid, id) => mark('repeats', sid, id);

export function clearMarkers(sid) {
  for (const kind of ['gate', 'excerpts']) fs.rmSync(vaultPath('.state', kind, safeId(sid)), { recursive: true, force: true });
}

// Unlike the gate and excerpt markers, `shown` markers survive compaction, so a repeat can tell
// whether the rule it repeats ever reached the agent in the wording confirmed now.
export const markShown = (sid, key, hash) => mark('shown', sid, `${key}|${hash}`);
export const wasShown = (sid, key, hash) => marked('shown', sid, `${key}|${hash}`);

export function markDelivered(kind, sid, id, key, hash) {
  if (!mark(kind, sid, id)) return false;
  // Only registered sessions can propose, so only theirs need shown markers.
  if (fs.existsSync(registry(safeId(sid)))) markShown(sid, key, hash);
  return true;
}

const KINDS = ['gate', 'excerpts', 'shown', 'repeats'];

// The registry goes last, so a session whose markers can't be removed yet is tried again next time.
function prune(id) {
  for (const kind of KINDS) fs.rmSync(vaultPath('.state', kind, id), { recursive: true, force: true });
  fs.rmSync(registry(id), { force: true });
}

const markersChanged = id => Math.max(...KINDS.map(kind => fs.statSync(vaultPath('.state', kind, id), { throwIfNoEntry: false })?.mtimeMs ?? 0));

// Nothing marks a session's end, so each day's first session start clears sessions idle for 30 days:
// by last_seen when registered, otherwise by when their markers last changed.
export function tidy() {
  const stampFile = statePath('tidy.json');
  if (Date.now() - Date.parse(readJsonSafe(stampFile)?.at) < DAY) return;
  writeJson(stampFile, { at: new Date().toISOString() });
  const registered = new Set(fs.readdirSync(stateDir('sessions')).filter(n => n.endsWith('.json')).map(n => n.slice(0, -'.json'.length)));
  for (const id of new Set([...registered, ...KINDS.flatMap(kind => fs.readdirSync(stateDir(kind)))])) {
    try {
      const seen = registered.has(id) ? Date.parse(readJsonSafe(registry(id))?.last_seen) : markersChanged(id);
      if (!(Date.now() - seen <= 30 * DAY)) prune(id);
    } catch (e) {
      logError('tidy', e);
    }
  }
}
