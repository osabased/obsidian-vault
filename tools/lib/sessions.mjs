import fs from 'node:fs';
import path from 'node:path';
import { vaultPath, statePath, stateDir, readJsonSafe, writeJson, safeId, shortHash, logError, hookErrors, errorsLog } from './vault.mjs';

const DAY = 86400e3;

export const registry = id => statePath('sessions', `${id}.json`);

// `cwd` stays where the session registered, so a move into the vault folder doesn't let it propose for every domain.
export function touchSession(input) {
  const id = safeId(input.session_id);
  const file = registry(id);
  const prev = readJsonSafe(file) ?? {};
  const entry = {
    session: String(input.session_id),
    transcript: input.transcript_path ?? prev.transcript ?? null,
    cwd: prev.cwd ?? input.cwd ?? null,
    last_seen: new Date().toISOString(),
  };
  writeJson(file, entry);
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

// True only for the call that made the marker, so two hooks racing deliver a rule once.
export function mark(kind, sid, key) {
  try {
    create(marker(kind, sid, key), key);
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw e;
  }
}

// Kept with the excerpt markers, so clearMarkers resets both.
export const markAlways = (sid, key, r) => mark('excerpts', sid, `always|${key}|${r.hash}`);

export function clearMarkers(sid) {
  for (const kind of ['gate', 'excerpts']) fs.rmSync(vaultPath('.state', kind, safeId(sid)), { recursive: true, force: true });
}

const lastLint = () => readJsonSafe(vaultPath('.state', 'lint.json')) ?? {};
const fileSize = file => fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0;

// /lint's status step records how far errors.log went, so session start repeats the errors after that until the user
// runs /lint again, and a session nobody reads can't use them up.
export const lintRan = () => writeJson(vaultPath('.state', 'lint.json'), { at: new Date().toISOString(), errors: fileSize(errorsLog()) });

export function daysSinceLint() {
  const at = Date.parse(lastLint().at);
  return Number.isNaN(at) ? null : Math.floor((Date.now() - at) / DAY);
}

// logError moves a full log to errors.log.1, so a log shorter than /lint saw has rotated since, and the end of
// errors.log.1 holds the rest /lint didn't see.
export function errorsSinceLint() {
  const seen = Number(lastLint().errors) || 0;
  const size = fileSize(errorsLog());
  if (size === seen) return [];
  return size > seen ? hookErrors(errorsLog(), seen) : [...hookErrors(errorsLog('.1'), seen), ...hookErrors()];
}

const KINDS = ['gate', 'excerpts', 'repeats'];

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
