import fs from 'node:fs';
import path from 'node:path';
import {
  config, vaultPath, statePath, stateDir, readJsonSafe, writeJson, safeId, shortHash, logError, guarded, hookErrors, errorsLog, domainsFor, sessionReach, toPosix, inVaultFolder, isVaultOnly,
} from './vault.mjs';

const DAY = 86400e3;

export const registry = id => statePath('sessions', `${id}.json`);

// Scripts take the session id as an argument, so one session can't write under another's.
export function ownEntry(sid) {
  const own = process.env.CLAUDE_CODE_SESSION_ID;
  if (own && own !== sid) return { entry: null, notOwn: `${sid} isn't this session, which is ${own}.` };
  return { entry: readJsonSafe(registry(safeId(sid))), notOwn: null };
}

// `cwd` stays where the session registered, so a move into the vault folder doesn't let it propose for every domain.
// Session start passes what sessionReach found for its folder, markers below it among them, so prompts, pick.mjs and
// propose.mjs read the domains and their project roots here rather than scan the tree again.
export function touchSession(input, hits) {
  const id = safeId(input.session_id);
  const file = registry(id);
  const prev = readJsonSafe(file) ?? {};
  const entry = {
    session: String(input.session_id),
    transcript: input.transcript_path ?? prev.transcript ?? null,
    cwd: prev.cwd ?? input.cwd ?? null,
    last_seen: new Date().toISOString(),
    ...(hits
      ? { reach: { cwd: input.cwd ?? null, domains: [...new Set(hits.map(h => h.domain))], roots: hits.map(({ domain, root }) => ({ domain, root })) } }
      : prev.reach ? { reach: prev.reach } : {}),
  };
  writeJson(file, entry);
}

const samePath = (a, b) => Boolean(a && b) && toPosix(a).toLowerCase() === toPosix(b).toLowerCase();

const recorded = (entry, cwd) => (entry?.reach && samePath(entry.reach.cwd, cwd) ? entry.reach : {});
const domainsIn = (entry, cwd) => {
  const { domains } = recorded(entry, cwd);
  return Array.isArray(domains) ? domains : domainsFor(cwd).map(d => d.domain);
};

// The domains session start found for this session's folder, or, in a folder it didn't scan, that folder's own.
export const sessionDomains = (sid, cwd) => domainsIn(sid ? readJsonSafe(registry(safeId(sid))) : null, cwd);

// The same domains, each with its project root.
export function sessionHits(sid, cwd) {
  const { roots } = recorded(sid ? readJsonSafe(registry(safeId(sid))) : null, cwd);
  return Array.isArray(roots) ? roots.filter(r => typeof r?.domain === 'string' && typeof r?.root === 'string')
    : domainsFor(cwd).map(({ domain, root }) => ({ domain, root }));
}

// Each of a registered session's domains with its project root: those the latest session start found, which compaction
// or a resume in another folder replaces, and those of the folder the session began in, so pick.mjs and propose.mjs
// reach the same domains. An entry without roots, written by older tools, finds them again.
export function sessionRoots(entry) {
  const reach = entry?.reach;
  const latest = Array.isArray(reach?.roots) ? reach.roots
    : Array.isArray(reach?.domains) ? sessionReach(reach.cwd).filter(h => reach.domains.includes(h.domain)) : [];
  const first = reach && samePath(reach.cwd, entry?.cwd) ? [] : sessionReach(entry?.cwd);
  const all = [...latest, ...first].filter(r => typeof r?.domain === 'string' && typeof r?.root === 'string').map(({ domain, root }) => ({ domain, root }));
  const keys = all.map(r => `${r.domain}|${toPosix(r.root).toLowerCase()}`);
  return all.filter((r, i) => keys.indexOf(keys[i]) === i);
}

// /ingest runs in the vault folder and can feed any domain but a vault-only one, which takes no rules.
export function proposeDomains(entry) {
  const doms = inVaultFolder(entry?.cwd) ? Object.keys(config().domains) : sessionRoots(entry).map(r => r.domain);
  return [...new Set(doms)].filter(d => Object.hasOwn(config().domains, d) && !isVaultOnly(d));
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

// mark() is the check as well, so two hooks racing deliver each one once.
export function markFirst(kind, sid, items, max, keyOf) {
  const due = [];
  for (const x of items) {
    if (due.length >= max) break;
    if (mark(kind, sid, keyOf(x))) due.push(x);
  }
  return due;
}

// A subagent's context is its own, so what it was shown is marked apart from the agent that started it. The agent goes
// first, so carryMarkers still finds a rule's key and the hash after it.
export const agentKey = (input, key) => (input.agent_id ? `${input.agent_id}|${key}` : key);

// Both hooks mark a page under one kind, so an agent hears of each page once, whichever hook brings it up.
export const markPages = (input, ranked, max = config().delivery.maxPages) => markFirst('pages', input.session_id, ranked, max, h => agentKey(input, h.key));

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

// A marker holds its id, in which a rule's wording hash follows its key. The session whose evidence changed a rule's
// wording already has it in mind, so its markers move to the new hash and only other sessions get the rule again.
export const carryMarkers = (sid, key, from, to) => guarded('carry markers', () => {
  for (const kind of ['gate', 'excerpts']) {
    const dir = vaultPath('.state', kind, safeId(sid));
    let files = [];
    try { files = fs.readdirSync(dir); } catch (e) { if (!stray(e)) throw e; }
    for (const f of files) {
      let parts;
      try { parts = fs.readFileSync(path.join(dir, f), 'utf8').split('|'); } catch (e) { if (stray(e)) continue; throw e; }
      const i = parts.indexOf(key);
      if (i >= 0 && parts[i + 1] === from) mark(kind, sid, parts.with(i + 1, to).join('|'));
    }
  }
});

// The registered sessions, with their folder and when they were last seen, and the others the hooks recorded
// deliveries for, each with the rules it was shown.
export function trackedSessions() {
  return [...new Set([...registeredIds(), ...fs.readdirSync(stateDir('delivered'))])].map(id => {
    const entry = readJsonSafe(registry(id));
    return { id, keys: shownKeys(id), cwd: entry?.cwd ?? null, last: entry?.last_seen ?? null };
  });
}

export function clearMarkers(sid) {
  for (const kind of ['gate', 'notes', 'excerpts', 'pages']) fs.rmSync(vaultPath('.state', kind, safeId(sid)), { recursive: true, force: true });
}

const lastLint = () => readJsonSafe(vaultPath('.state', 'lint.json')) ?? {};
const fileSize = file => fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0;

// /lint's status step records how far errors.log went, so session start repeats the errors after that until the user
// runs /lint again, and a session nobody reads can't use them up.
export const lintRan = () => writeJson(vaultPath('.state', 'lint.json'), { at: new Date().toISOString(), errors: fileSize(errorsLog()) });

// /lint marks its end too, so the notes it changed itself don't count toward the next reminder.
export const lintDone = () => writeJson(vaultPath('.state', 'lint.json'), { ...lastLint(), done: new Date().toISOString() });

export function sinceLint(notes) {
  const { at, done } = lastLint();
  const ran = Date.parse(at);
  if (Number.isNaN(ran)) return { days: null, changed: notes.length };
  const since = Math.max(ran, Date.parse(done) || 0);
  return { days: Math.floor((Date.now() - ran) / DAY), changed: notes.filter(n => n.saved > since).length };
}

// logError moves a full log to errors.log.1, so a log shorter than /lint saw has rotated since, and the end of
// errors.log.1 holds the rest /lint didn't see.
export function errorsSinceLint() {
  const seen = Number(lastLint().errors) || 0;
  const size = fileSize(errorsLog());
  if (size === seen) return [];
  return size > seen ? hookErrors(errorsLog(), seen) : [...hookErrors(errorsLog('.1'), seen), ...hookErrors()];
}

const KINDS = ['gate', 'notes', 'excerpts', 'pages', 'repeats', 'delivered'];

// Removes up to `room` marker files of a session, then its folders, and returns how many files it removed. The registry
// goes last, and only once every folder is gone, so a session left half pruned is tried again next time.
function prune(id, room) {
  let removed = 0;
  for (const kind of KINDS) {
    const dir = vaultPath('.state', kind, id);
    let files = [];
    try { files = fs.readdirSync(dir); } catch (e) { if (!stray(e)) throw e; }
    for (const f of files.slice(0, room - removed)) {
      fs.rmSync(path.join(dir, f), { recursive: true, force: true });
      removed++;
    }
    if (files.length > room - removed) return { removed, done: false };
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.rmSync(registry(id), { force: true });
  return { removed, done: true };
}

const markersChanged = id => Math.max(...KINDS.map(kind => fs.statSync(vaultPath('.state', kind, id), { throwIfNoEntry: false })?.mtimeMs ?? 0));

// Nothing marks a session's end, so each day's first session start clears sessions idle for 30 days:
// by last_seen when registered, otherwise by when their markers last changed. Session start removes at most
// delivery.tidyMaxMarkers marker files a run and tries again at the next, so a long backlog can't hold it up; /lint
// passes full and clears the lot.
export function tidy({ full = false } = {}) {
  const stampFile = statePath('tidy.json');
  if (!full && Date.now() - Date.parse(readJsonSafe(stampFile)?.at) < DAY) return;
  let room = full ? Infinity : Math.max(0, Number(config().delivery.tidyMaxMarkers) || 0);
  let finished = true;
  const registered = new Set(registeredIds());
  for (const id of new Set([...registered, ...KINDS.flatMap(kind => fs.readdirSync(stateDir(kind)))])) {
    try {
      const seen = registered.has(id) ? Date.parse(readJsonSafe(registry(id))?.last_seen) : markersChanged(id);
      if (Date.now() - seen <= 30 * DAY) continue;
      if (room <= 0) { finished = false; break; }
      const r = prune(id, room);
      room -= r.removed;
      if (!r.done) { finished = false; break; }
    } catch (e) {
      logError('tidy', e);
    }
  }
  if (finished) writeJson(stampFile, { at: new Date().toISOString() });
}
