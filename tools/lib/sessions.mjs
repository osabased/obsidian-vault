import fs from 'node:fs';
import path from 'node:path';
import { vaultPath, statePath, stateDir, readJsonSafe, writeJson, safeId, shortHash, logError, guarded, hookErrors, errorsLog } from './vault.mjs';

const DAY = 86400e3;

export const registry = id => statePath('sessions', `${id}.json`);

// Scripts take the session id as an argument, so one session can't write under another's.
export function ownEntry(sid) {
  const own = process.env.CLAUDE_CODE_SESSION_ID;
  if (own && own !== sid) return { entry: null, notOwn: `${sid} isn't this session, which is ${own}.` };
  return { entry: readJsonSafe(registry(safeId(sid))), notOwn: null };
}

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

// Two markers, both keyed by the rule alone, so a rule reworded since still counts as shown. The delivered one is
// kept through compaction, so /lint can tell a rule a session was shown from one nothing brought up; the excerpt one
// goes with compaction, so propose.mjs calls a rule shown only while it may still be in context. A failed write costs
// the bookkeeping, not the delivery it records.
export const markShown = (sid, key) => guarded('mark shown', () => {
  mark('delivered', sid, key);
  mark('excerpts', sid, `shown|${key}`);
});
export const wasShown = (sid, key) => marked('excerpts', sid, `shown|${key}`);

// Read without creating the folder, since lint reads it and lint changes nothing.
function registeredIds() {
  let names = [];
  try { names = fs.readdirSync(vaultPath('.state', 'sessions')); } catch (e) { if (!stray(e)) throw e; }
  return names.filter(n => n.endsWith('.json')).map(n => n.slice(0, -'.json'.length));
}

// Pages name a session by the first 8 characters of its id. Null when no registered session, or more than one, has
// them, or when its transcript is gone; tidy() drops old sessions from the registry.
export function transcriptFor(prefix) {
  const ids = registeredIds().filter(id => id.startsWith(prefix));
  const file = ids.length === 1 ? readJsonSafe(registry(ids[0]))?.transcript : null;
  return typeof file === 'string' && fs.existsSync(file) ? file : null;
}

// tidy() may prune a session mid-read, and other tools drop files like desktop.ini into folders.
const stray = e => ['ENOENT', 'ENOTDIR', 'EISDIR'].includes(e.code);

function shownKeys(id) {
  const dir = vaultPath('.state', 'delivered', id);
  const keys = new Set();
  let files = [];
  try { files = fs.readdirSync(dir); } catch (e) { if (!stray(e)) throw e; }
  for (const f of files) {
    try { keys.add(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { if (!stray(e)) throw e; }
  }
  return keys;
}

// The registered sessions, with their folder and when they were last seen, and the others the hooks recorded
// deliveries for, each with the rules it was shown.
export function trackedSessions() {
  return [...new Set([...registeredIds(), ...fs.readdirSync(stateDir('delivered'))])].map(id => {
    const entry = readJsonSafe(registry(id));
    return { id, keys: shownKeys(id), cwd: entry?.cwd ?? null, last: entry?.last_seen ?? null };
  });
}

export function clearMarkers(sid) {
  for (const kind of ['gate', 'notes', 'excerpts']) fs.rmSync(vaultPath('.state', kind, safeId(sid)), { recursive: true, force: true });
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

const KINDS = ['gate', 'notes', 'excerpts', 'repeats', 'delivered'];

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
  const registered = new Set(registeredIds());
  for (const id of new Set([...registered, ...KINDS.flatMap(kind => fs.readdirSync(stateDir(kind)))])) {
    try {
      const seen = registered.has(id) ? Date.parse(readJsonSafe(registry(id))?.last_seen) : markersChanged(id);
      if (!(Date.now() - seen <= 30 * DAY)) prune(id);
    } catch (e) {
      logError('tidy', e);
    }
  }
}
