import fs from 'node:fs';
import path from 'node:path';
import {
  config, vaultPath, statePath, stateDir, readJsonSafe, writeJson, appendJsonl, safeId, shortHash, logError, guarded, hookErrors, errorsLog, domainsFor, sessionReach, toPosix, inVaultFolder, isVaultOnly, olderThan,
} from './vault.mjs';
import { noteTimes } from './cache.mjs';
import { sessionIds, shortName } from './agents.mjs';
import { refuse } from './input.mjs';

const DAY = 86400e3;

export const registry = id => statePath('sessions', `${id}.json`);

// Scripts take the session id as an argument, so one session can't write under another's.
export function ownEntry(sid) {
  const own = sessionIds();
  if (own.length && !own.includes(String(sid))) return { entry: null, notOwn: `${sid} isn't this session, which is ${own.join(' or ')}.` };
  return { entry: readJsonSafe(registry(safeId(sid))), notOwn: null };
}

export const PASS = "The vault's tools pass the session id themselves. From a shell, pass it as the first argument, or run this from the agent's own shell, which sets its session variable.";

// The registry entry of the session a tool runs for. It refuses with noId when no id came, and when the id isn't this
// session's or has no entry, followed by pass; a tool with its own refusal for an id with no entry passes optional.
export function callerEntry(sid, { noId, pass = PASS, optional = false }) {
  if (!sid) refuse(noId);
  const { entry, notOwn } = ownEntry(sid);
  if (notOwn) refuse(notOwn);
  if (!entry && !optional) refuse(`the taste vault has no session ${sid}.${pass ? ` ${pass}` : ''}`);
  return entry;
}

// `cwd` stays where the session registered, so a move into the vault folder doesn't let it propose for every domain;
// `last_cwd` is the folder of its latest prompt or start, which /vault status counts for. Session start passes what sessionReach found for its folder, markers below it among them, so prompts, pick.mjs and
// propose.mjs read the domains and their project roots here rather than scan the tree again.
// last_prompt is set only by a typed message, so the queue's sweep can tell an offer the user wrote past from one a
// resume merely reopened.
export function touchSession(event, hits, agent, { prompted = false } = {}) {
  const id = safeId(event.session);
  const file = registry(id);
  const prev = readJsonSafe(file) ?? {};
  const entry = {
    session: String(event.session),
    agent: agent ?? prev.agent ?? null,
    transcript: event.transcript ?? prev.transcript ?? null,
    cwd: prev.cwd ?? event.cwd ?? null,
    last_cwd: event.cwd ?? prev.last_cwd ?? null,
    last_seen: new Date().toISOString(),
    ...(prompted ? { last_prompt: new Date().toISOString() } : prev.last_prompt ? { last_prompt: prev.last_prompt } : {}),
    // A start in a folder no domain reaches records the folder alone, so its domains are found again from the config and
    // one added later reaches the session from its next prompt rather than its next start.
    ...(hits?.length
      ? { reach: { cwd: event.cwd ?? null, domains: [...new Set(hits.map(h => h.domain))], roots: hits.map(({ domain, root }) => ({ domain, root })) } }
      : hits ? { reach: { cwd: event.cwd ?? null } }
      : prev.reach ? { reach: prev.reach } : {}),
  };
  writeJson(file, entry);
  return entry;
}

// A domain started in a session joins the reach its start recorded, rather than the reach being found again, since this
// process still holds the config from before the domain was added. cwd stays as it was, since prompts read the reach only
// for that folder. A reach with no roots, a folder's alone or none, gets that folder's first.
export function addReach(sid, { domain, root }) {
  const file = registry(safeId(sid));
  const entry = readJsonSafe(file);
  if (!entry) return;
  const cwd = entry.reach ? entry.reach.cwd : entry.cwd ?? null;
  const hits = Array.isArray(entry.reach?.roots) ? entry.reach.roots : sessionReach(cwd);
  const roots = [...hits.map(({ domain: d, root: r }) => ({ domain: d, root: r })), { domain, root }];
  const domains = [...new Set([...(Array.isArray(entry.reach?.domains) ? entry.reach.domains : hits.map(h => h.domain)), domain])];
  writeJson(file, { ...entry, reach: { cwd, domains, roots } });
}

const samePath = (a, b) => Boolean(a && b) && toPosix(a).toLowerCase() === toPosix(b).toLowerCase();

const recorded = (entry, cwd) => (entry?.reach && samePath(entry.reach.cwd, cwd) ? entry.reach : {});
const domainsIn = (entry, cwd) => {
  const { domains } = recorded(entry, cwd);
  return Array.isArray(domains) ? domains : domainsFor(cwd).map(d => d.domain);
};

// The domains session start found for this session's folder, or, in a folder it didn't scan, that folder's own.
export const sessionDomains = (sid, cwd) => domainsIn(sid ? readJsonSafe(registry(safeId(sid))) : null, cwd);

// The same domains, each with its project root. A reach with domains and no roots, from older tools, finds their roots again.
export function sessionHits(sid, cwd) {
  const { roots, domains } = recorded(sid ? readJsonSafe(registry(safeId(sid))) : null, cwd);
  const hits = Array.isArray(roots) ? roots
    : Array.isArray(domains) ? sessionReach(cwd).filter(h => domains.includes(h.domain))
    : domainsFor(cwd);
  return hits.filter(r => typeof r?.domain === 'string' && typeof r?.root === 'string').map(({ domain, root }) => ({ domain, root }));
}

// Each of a registered session's domains with its project root: those the latest session start found, which compaction
// or a resume in another folder replaces, and those of the folder the session began in, so pick.mjs and propose.mjs
// reach the same domains. A reach without roots, from older tools or a start no domain reached, finds them again.
export function sessionRoots(entry) {
  const reach = entry?.reach;
  const latest = Array.isArray(reach?.roots) ? reach.roots
    : Array.isArray(reach?.domains) ? sessionReach(reach.cwd).filter(h => reach.domains.includes(h.domain))
    : reach ? sessionReach(reach.cwd) : [];
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

// A session's markers of one kind are the lines of one file, one JSON string each, so a hook call adds all it marks with
// one append and reads them back with one read. Older tools wrote one file per marker, named by its key's hash and
// holding the key; those still count, looked up by name.
const BATCH = 'keys.jsonl';
const markerDir = (kind, sid) => vaultPath('.state', kind, safeId(sid));
const loaded = new Map();

function readKeys(dir) {
  const keys = new Set();
  let text = '';
  try { text = fs.readFileSync(path.join(dir, BATCH), 'utf8'); } catch (e) { if (!stray(e)) throw e; }
  // A line another hook is still appending reads as cut off, and counts once it is whole.
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { keys.add(String(JSON.parse(line))); } catch { continue; }
  }
  return keys;
}

function markers(kind, sid) {
  const dir = markerDir(kind, sid);
  let m = loaded.get(dir);
  if (!m) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { if (!stray(e)) throw e; }
    m = { keys: readKeys(dir), legacy: new Set(names.filter(n => n !== BATCH)) };
    loaded.set(dir, m);
  }
  return m;
}

export function marked(kind, sid, key) {
  const m = markers(kind, sid);
  return m.keys.has(key) || (m.legacy.size > 0 && m.legacy.has(shortHash(key)));
}

// Marks the keys not yet marked, in one append, and returns them. Two hooks racing on one key can both see it unmarked,
// so each may deliver it; parallel tool calls in one agent are the only race, and they cost a repeat, not a miss.
export function markMany(kind, sid, keys) {
  if (!keys.length) return [];
  const m = markers(kind, sid);
  const fresh = [...new Set(keys)].filter(k => !marked(kind, sid, k));
  if (!fresh.length) return [];
  appendJsonl(path.join(markerDir(kind, sid), BATCH), fresh);
  for (const k of fresh) m.keys.add(k);
  return fresh;
}

export const mark = (kind, sid, key) => markMany(kind, sid, [key]).length > 0;

// A rule comes once a session, by whichever route brings it first: an always rule a prompt's keywords brought isn't loaded
// again, nor one loaded brought by keyword. Both marks hold the rule's hash, so a reworded rule comes again. The always
// marks are kept with the excerpt marks, so clearMarkers resets both.
const alwaysMark = (key, rule) => `always|${key}|${rule.hash}`;
const excerptMark = (key, rule) => `${key}|${rule.hash}`;

// Returns the [key, rule] entries not marked before.
export function markAlways(sid, entries) {
  const id = ([k, r]) => alwaysMark(k, r);
  const fresh = new Set(markMany('excerpts', sid, entries.map(id)));
  return entries.filter(e => fresh.has(id(e)));
}

// The first `max` { key, note } keyword hits no route has brought, left unmarked.
export const dueExcerpts = (sid, hits, max) => unmarked('excerpts', sid, hits.filter(h => !marked('excerpts', sid, alwaysMark(h.key, h.note))), h => excerptMark(h.key, h.note), max);
export const markExcerpts = (sid, hits) => markMany('excerpts', sid, hits.map(h => excerptMark(h.key, h.note)));

// The first `max` items not yet marked, marked in one batch.
export function markFirst(kind, sid, items, max, keyOf) {
  const due = [];
  for (const x of items) {
    if (due.length >= max) break;
    if (!marked(kind, sid, keyOf(x)) && !due.some(d => keyOf(d) === keyOf(x))) due.push(x);
  }
  const fresh = new Set(markMany(kind, sid, due.map(keyOf)));
  return due.filter(x => fresh.has(keyOf(x)));
}

// A subagent's context is its own, so what it was shown is marked apart from the agent that started it. The agent goes
// first, so carryMarkers still finds a rule's key and the hash after it.
export const agentKey = (event, key) => (event.agent ? `${event.agent}|${key}` : key);

// Both hooks mark a page under one kind, so an agent hears of each page once, whichever hook brings it up.
// Only a labelled page has a hash, the one deliverable gave it, so a page comes up again when its labels change.
export const keyHash = (key, hash) => (hash ? `${key}|${hash}` : key);
const pageMark = (event, h) => agentKey(event, keyHash(h.key, h.note?.hash));
export const markPages = (event, ranked, max = config().delivery.maxPages) => markFirst('pages', event.session, ranked, max, h => pageMark(event, h));

// The first `max` items not yet marked, left unmarked, for a hook that marks only what its output budget keeps.
export function unmarked(kind, sid, items, keyOf, max = Infinity) {
  const due = [];
  const seen = new Set();
  for (const x of items) {
    if (due.length >= max) break;
    const key = keyOf(x);
    if (!seen.has(key) && !marked(kind, sid, key)) due.push(x);
    seen.add(key);
  }
  return due;
}

// The [key, rule] entries markAlways would mark and no prompt's keywords brought, left unmarked.
export const dueAlways = (sid, entries) => unmarked('excerpts', sid, entries.filter(([k, r]) => !marked('excerpts', sid, excerptMark(k, r))), ([k, r]) => alwaysMark(k, r));
export const duePages = (event, ranked, max = config().delivery.maxPages) => unmarked('pages', event.session, ranked, h => pageMark(event, h), max);

// Two markers, both keyed by the rule alone, so a rule reworded since still counts as shown. The delivered one is
// kept through compaction, so /lint can tell a rule a session was shown from one nothing brought up; the excerpt one
// goes with compaction, so propose.mjs calls a rule shown only while it may still be in context. A failed write costs
// the bookkeeping, not the delivery it records.
export const markShown = (sid, keys) => guarded('mark shown', () => {
  const all = [].concat(keys);
  markMany('delivered', sid, all);
  markMany('excerpts', sid, all.map(k => `shown|${k}`));
});
export const wasShown = (sid, key) => marked('excerpts', sid, `shown|${key}`);

// The prompt hook stamps when each turn began, so the Stop hook counts only the files saved since. A failed stamp costs
// that turn's shell-write check, not the prompt's delivery.
const turnFile = sid => vaultPath('.state', 'turns', safeId(sid), 'started.json');
export const turnStarted = sid => guarded('turn start', () => writeJson(turnFile(sid), { at: Date.now() }));
export function turnStart(sid) {
  const at = readJsonSafe(turnFile(sid))?.at;
  return Number.isFinite(at) ? at : null;
}

// Read without creating the folder, since lint reads it and lint changes nothing.
function registeredIds() {
  let names = [];
  try { names = fs.readdirSync(vaultPath('.state', 'sessions')); } catch (e) { if (!stray(e)) throw e; }
  return names.filter(n => n.endsWith('.json')).map(n => n.slice(0, -'.json'.length));
}

// A session's short name, from the agent the row naming it or its registry entry gives.
export const sessionName = (sid, agentName) => shortName(sid, agentName ?? readJsonSafe(registry(safeId(sid)))?.agent);

// The registered sessions' entries by short name, and by full id, the names pages call them by.
export function sessionsByName() {
  const byName = new Map();
  const add = (name, entry) => byName.set(name, [...(byName.get(name) ?? []), entry]);
  for (const id of registeredIds()) {
    const entry = readJsonSafe(registry(id));
    if (!entry) continue;
    const sid = String(entry.session ?? id);
    add(shortName(sid, entry.agent), entry);
    add(sid, entry);
  }
  return byName;
}

// Returns the registry entry of the session a page names, or null when no registered session, or more than one, has
// that name, or when its transcript is gone; tidy() drops old sessions from the registry.
export function transcriptFor(name, byName = sessionsByName()) {
  const entries = byName.get(name) ?? [];
  const entry = entries.length === 1 ? entries[0] : null;
  return typeof entry?.transcript === 'string' && fs.existsSync(entry.transcript) ? entry : null;
}

// tidy() may prune a session mid-read, and other tools drop files like desktop.ini into folders.
const stray = e => ['ENOENT', 'ENOTDIR', 'EISDIR'].includes(e.code);

function allKeys(kind, id) {
  const dir = vaultPath('.state', kind, id);
  const keys = readKeys(dir);
  let files = [];
  try { files = fs.readdirSync(dir); } catch (e) { if (!stray(e)) throw e; }
  for (const f of files.filter(n => n !== BATCH)) {
    try { keys.add(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { if (!stray(e)) throw e; }
  }
  return keys;
}

const shownKeys = id => allKeys('delivered', id);

// The rules and pages a session and its subagents were shown since it started or was last compacted or cleared, by key.
// Both come from markers compaction clears, so they cover the same span. A marker may lead with a subagent's id and end
// with a hash; its key is the part naming its domain.
export function shownInContext(sid) {
  const keyOf = m => m.split('|').find(part => part.includes('/'));
  const keys = markers => [...new Set(markers.map(keyOf).filter(Boolean))];
  const id = safeId(sid);
  return { rules: keys([...allKeys('excerpts', id)].filter(m => m.startsWith('shown|'))), pages: keys([...allKeys('pages', id)]) };
}

// A marker holds its id, in which a rule's wording hash follows its key. The session whose evidence changed a rule's
// wording already has it in mind, so its markers move to the new hash and only other sessions get the rule again.
export const carryMarkers = (sid, key, from, to) => guarded('carry markers', () => {
  for (const kind of ['gate', 'excerpts']) {
    const moved = [];
    for (const id of allKeys(kind, safeId(sid))) {
      const parts = id.split('|');
      const i = parts.indexOf(key);
      if (i >= 0 && parts[i + 1] === from) moved.push(parts.with(i + 1, to).join('|'));
    }
    markMany(kind, sid, moved);
  }
});

// The registered sessions, with their folder and when they were last seen, and the others the hooks recorded
// deliveries for, each with the rules it was shown.
export function trackedSessions() {
  return [...new Set([...registeredIds(), ...fs.readdirSync(stateDir('delivered'))])].map(id => {
    const entry = readJsonSafe(registry(id));
    return { id, name: shortName(entry?.session ?? id, entry?.agent), keys: shownKeys(id), cwd: entry?.cwd ?? null, last: entry?.last_seen ?? null };
  });
}

export function clearMarkers(sid) {
  for (const kind of ['gate', 'notes', 'excerpts', 'pages']) {
    // Windows holds a file a scanner or indexer has open for a moment; a failure that lasts still throws.
    fs.rmSync(markerDir(kind, sid), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    loaded.delete(markerDir(kind, sid));
  }
}

const lastLint = () => readJsonSafe(vaultPath('.state', 'lint.json')) ?? {};
const fileSize = file => fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0;

// /lint's status step records how far errors.log went, so session start repeats the errors after that until the user
// runs /lint again, and a session nobody reads can't use them up.
export const lintRan = () => writeJson(vaultPath('.state', 'lint.json'), { at: new Date().toISOString(), errors: fileSize(errorsLog()) });

// /lint marks its end too, so the notes it changed itself don't count toward the next reminder.
export const lintDone = () => writeJson(vaultPath('.state', 'lint.json'), { ...lastLint(), done: new Date().toISOString() });

// Counts every note in the vault, whichever domains the session walks.
export function sinceLint(times = noteTimes()) {
  const { at, done } = lastLint();
  const ran = Date.parse(at);
  if (Number.isNaN(ran)) return { days: null, changed: times.length };
  const since = Math.max(ran, Date.parse(done) || 0);
  return { days: Math.floor((Date.now() - ran) / DAY), changed: times.filter(m => m > since).length };
}

// logError moves a full log to errors.log.1, so a log shorter than /lint saw has rotated since, and the end of
// errors.log.1 holds the rest /lint didn't see.
export function errorsSinceLint() {
  const seen = Number(lastLint().errors) || 0;
  const size = fileSize(errorsLog());
  if (size === seen) return [];
  return size > seen ? hookErrors(errorsLog(), seen) : [...hookErrors(errorsLog('.1'), seen), ...hookErrors()];
}

const KINDS = ['gate', 'notes', 'excerpts', 'pages', 'repeats', 'delivered', 'turns'];

// Removes up to `room` marker files of a session, then its folders, and returns how many files it removed. The registry
// goes last, and only once every folder is gone, so a session left half pruned is tried again next time. Removing files
// changes their folder's mtime, which is how an unregistered session's age is read, so a folder left part pruned gets its
// mtime back and the rest isn't kept another 30 days.
function prune(id, room) {
  let removed = 0;
  for (const kind of KINDS) {
    const dir = vaultPath('.state', kind, id);
    let files = [];
    let before;
    try { before = fs.statSync(dir); files = fs.readdirSync(dir); } catch (e) { if (!stray(e)) throw e; }
    const take = files.slice(0, room - removed);
    for (const f of take) {
      fs.rmSync(path.join(dir, f), { recursive: true, force: true });
      removed++;
    }
    if (take.length < files.length) {
      fs.utimesSync(dir, before.atime, before.mtime);
      return { removed, done: false };
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.rmSync(registry(id), { force: true });
  return { removed, done: true };
}

// An append leaves its folder's mtime as it was, so the batch file's own counts too.
const changedAt = file => fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0;
const markersChanged = id => Math.max(...KINDS.flatMap(kind => [changedAt(vaultPath('.state', kind, id)), changedAt(vaultPath('.state', kind, id, BATCH))]));

// Nothing marks a session's end, so each day's first session start clears sessions idle for 30 days:
// by last_seen when registered, otherwise by when their markers last changed. Session start removes at most
// delivery.tidyMaxMarkers marker files a run and tries again at the next, so a long backlog can't hold it up; /lint
// passes full and clears the lot.
export function tidy({ full = false } = {}) {
  const stampFile = statePath('tidy.json');
  if (!full && !olderThan(readJsonSafe(stampFile)?.at, DAY)) return;
  let room = full ? Infinity : Math.max(0, Number(config().delivery.tidyMaxMarkers) || 0);
  let finished = true;
  const registered = new Set(registeredIds());
  for (const id of new Set([...registered, ...KINDS.flatMap(kind => fs.readdirSync(stateDir(kind)))])) {
    try {
      const seen = registered.has(id) ? Date.parse(readJsonSafe(registry(id))?.last_seen) : markersChanged(id);
      if (!olderThan(seen, 30 * DAY)) continue;
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
