import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { armDeadline } from './deadline.mjs';
import { globToRegExp, validGlob } from './glob.mjs';

// The plugin's hooks run a copy of tools/ inside the vault, which .githooks/post-commit keeps at the last
// commit, so the vault is the nearest folder above the code that holds vault.config.json.
function findRoot() {
  const home = path.resolve(import.meta.dirname, '..', '..');
  for (let dir = home; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'vault.config.json'))) return dir;
    if (path.dirname(dir) === dir) return home;
  }
}
export const ROOT = findRoot();
export const vaultPath = (...xs) => path.join(ROOT, ...xs);
// The tools/ this code runs from, so a script a hook names is from the same commit as the hook.
export const toolsPath = (...xs) => path.join(import.meta.dirname, '..', ...xs);

export const DEFAULTS = {
  delivery: { maxRulesPerEdit: 3, maxRuleChars: 300, maxKnowledgeRuleChars: 600, maxBlockChars: 1200, maxPromptExcerpts: 3, maxPages: 3, maxContextChars: 8000, activeMaxLines: 60, activeMaxBytes: 4096, settleSeconds: 60, tidyMaxMarkers: 2000 },
  knowledge: { staleAfterDays: 180, checkAfterDays: 14 },
  refresh: { timeoutSeconds: 20, maxBytes: 5_000_000 },
  docSets: { manifests: ['llms.txt'] },
  lint: { remindAfterDays: 14, remindAfterNotes: 10 },
  picks: { maxSheetBytes: 3_000_000 },
  reach: { markerDepth: 3 },
  namespaces: {},
  editTools: {},
  privacy: { allow: [] },
  compile: { maxBytes: 16_384 },
  queue: { sweepAfterHours: 12 },
};

const strings = xs => (Array.isArray(xs) ? xs.filter(x => typeof x === 'string' && x.trim()) : []);
const local = () => readJsonSafe(vaultPath('vault.local.json')) ?? {};

// Paths differ per machine, so they come from the untracked vault.local.json; a file lint finds broken gives none.
let loaded;
export function config() {
  if (!loaded) {
    const c = readJson(vaultPath('vault.config.json'), {});
    const mine = local();
    const domains = Object.fromEntries(Object.entries(c.domains ?? {}).map(([d, x]) => [d, { ...x, paths: strings(mine.domains?.[d]?.paths) }]));
    const extractors = Array.isArray(c.extractors) ? c.extractors : [];
    // The agents whose tool names lint checks, in the order a script looks for its own session, each a folder in tools/adapters/.
    const agents = Array.isArray(c.agents) ? c.agents : ['claude-code'];
    loaded = { domains, extractors, agents, proposals: c.proposals, quiet: strings(mine.quiet).filter(g => validGlob(g)), ...Object.fromEntries(Object.entries(DEFAULTS).map(([k, d]) => [k, { ...d, ...c[k] }])) };
  }
  return loaded;
}

// For a script that writes the config and then builds from it in the same process.
export const reloadConfig = () => { loaded = undefined; };

// Git Bash hands out /c/Users/... paths; Node on Windows needs c:/Users/... The \\?\ and \\.\ prefixes only lift the
// length limit, so they come off before paths are compared.
const native = p => (process.platform === 'win32'
  ? String(p).replace(/\\/g, '/').replace(/^\/\/[?.]\/UNC\//i, '//').replace(/^\/\/[?.]\/(?=[a-z]:)/i, '').replace(/^\/([a-z])(?=\/|$)/i, '$1:')
  : String(p));

export function toPosix(p, base = process.cwd()) {
  const s = path.resolve(native(base), native(p)).replace(/\\/g, '/');
  return /^[a-z]:\/$/i.test(s) ? s : s.replace(/\/+$/, '');
}

export function inside(root, p, base) {
  const target = toPosix(p, base);
  const r = toPosix(root).toLowerCase();
  const lower = target.toLowerCase();
  if (lower === r) return '';
  const prefix = r.endsWith('/') ? r : `${r}/`;
  return lower.startsWith(prefix) ? target.slice(prefix.length) : null;
}

export const stripWorktree = rel => rel.replace(/^\.claude\/worktrees\/[^/]+(?:\/|$)/i, '');
// The hooks run from the main vault's .live/, so a file in a worktree of the vault is taken as the same file in it.
export const vaultRel = (p, base) => {
  const rel = inside(ROOT, p, base);
  return rel === null ? null : stripWorktree(rel);
};
// A session outside the vault passes full paths.
export const fromRoot = ref => (path.isAbsolute(ref) && vaultRel(ref)) || ref;

// The vault's notes and sources are the user's taste, and the rest are written by the tools or kept for this machine,
// so no rule covers them, and the edit guard decides what may change.
const VAULT_OWN = /^(?:wiki|raw|derived|\.state|\.live|\.sources)(?:\/|$)|^(?:active\.md|index\.md|decisions\.md|vault\.local\.json)$/i;
export const vaultOwn = rel => typeof rel === 'string' && VAULT_OWN.test(rel);

const caseFolds = process.platform === 'win32' || process.platform === 'darwin';
const fold = name => (caseFolds ? name.toLowerCase() : name);

// A marker is a file name, so one with a folder in it, or . or .., which name folders, never matches.
export const isMarkerName = m => typeof m === 'string' && Boolean(m.trim()) && !/[\\/]/.test(m) && !/^\.+$/.test(m.trim());
const markersOf = d => strings(config().domains[d]?.markers).filter(isMarkerName);

// Each marker file name with the domains it puts a folder in.
export function markerDomains() {
  const by = new Map();
  for (const d of Object.keys(config().domains)) {
    for (const m of markersOf(d)) by.set(fold(m), [...(by.get(fold(m)) ?? []), d]);
  }
  return by;
}

// A marker is a file, or a link to one.
export const isFileAt = p => { try { return fs.statSync(p, { throwIfNoEntry: false })?.isFile() ?? false; } catch { return false; } };

// A worktree checks out the same project, so its project root is the main checkout.
export const mainCheckout = dir => dir.replace(/[\\/]\.claude[\\/]worktrees[\\/][^\\/]+(?=[\\/]|$)/i, '');

// The nearest folder at or above p that holds a marker, with every domain whose marker it holds. p may be a file the
// edit is about to create, and a file path never holds a marker, so the walk can start at p itself.
function markedAbove(p, by) {
  if (!by.size) return [];
  for (let dir = p; ; dir = path.dirname(dir)) {
    const doms = [...by].filter(([m]) => isFileAt(path.join(dir, m))).flatMap(([, ds]) => ds);
    if (doms.length) return [...new Set(doms)].map(domain => ({ domain, root: mainCheckout(dir) }));
    if (path.dirname(dir) === dir) return [];
  }
}

// A folder's domains, each with its project root: the nearest marker folder at or above it, and every domain with a
// path that holds it. Global applies everywhere, so callers add it.
export function domainsFor(p, base) {
  if (!p) return [];
  const target = toPosix(p, base);
  const hits = markedAbove(target, markerDomains());
  for (const [domain, d] of Object.entries(config().domains)) {
    for (const project of d.paths) if (inside(project, target) !== null) hits.push({ domain, root: toPosix(project) });
  }
  const withRel = hits.map(h => ({ ...h, rel: stripWorktree(inside(h.root, target)) }));
  withRel.sort((a, b) => b.root.length - a.root.length);
  return withRel.filter((h, i) => withRel.findIndex(x => x.domain === h.domain) === i);
}

// Plain folder entries only: a dependency folder a project ignores is listed as one, and a pattern needs a matcher.
function ignoredFolders(dir) {
  let text = '';
  try { text = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'); } catch {}
  const names = new Set();
  const paths = new Set();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^[#!]/.test(line) || /[*?[\\]/.test(line)) continue;
    const entry = line.replace(/\/+$/, '');
    if (!entry) continue;
    if (entry.replace(/^\//, '').includes('/') || entry.startsWith('/')) paths.add(fold(entry.replace(/^\//, '')));
    else names.add(fold(entry));
  }
  return { names, paths };
}

const SCAN_FOLDERS = 2000;

// Markers in the folders below cwd, down to reach.markerDepth, so a session at a monorepo root hears each package's
// domains. Dot-folders and the folders cwd's .gitignore lists are skipped, and the scan stops after SCAN_FOLDERS
// folders, so a huge tree can't slow session start.
function markedBelow(cwd) {
  const by = markerDomains();
  const depth = Number(config().reach.markerDepth) || 0;
  if (!cwd || !by.size || depth < 1) return [];
  const root = toPosix(cwd);
  const ignored = ignoredFolders(root);
  const hits = [];
  let queue = [{ dir: root, rel: '', level: 0 }];
  let seen = 0;
  while (queue.length && seen < SCAN_FOLDERS) {
    const next = [];
    for (const { dir, rel, level } of queue) {
      if (seen++ >= SCAN_FOLDERS) break;
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch {}
      if (level > 0) {
        const doms = entries.filter(e => e.isFile() || (e.isSymbolicLink() && isFileAt(`${dir}/${e.name}`))).flatMap(e => by.get(fold(e.name)) ?? []);
        for (const domain of new Set(doms)) hits.push({ domain, root: mainCheckout(dir) });
      }
      if (level >= depth) continue;
      for (const e of entries) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (!e.isDirectory() || e.name.startsWith('.') || ignored.names.has(fold(e.name)) || ignored.paths.has(fold(r))) continue;
        // The vault holds copies of other projects, whose markers put a session above it in no domain.
        if (inVaultFolder(`${dir}/${e.name}`)) continue;
        next.push({ dir: `${dir}/${e.name}`, rel: r, level: level + 1 });
      }
    }
    queue = next;
  }
  return hits;
}

// A session's domains with every project root each has: its folder's, and those of the markers below it. The vault
// folder holds copies of other projects under raw/refs/, whose markers put the session in no domain.
export function sessionReach(cwd) {
  const hits = [...domainsFor(cwd), ...(inVaultFolder(cwd) ? [] : markedBelow(cwd))];
  const keys = hits.map(h => `${h.domain}|${fold(toPosix(h.root))}`);
  return hits.filter((h, i) => keys.indexOf(keys[i]) === i);
}

export const inVaultFolder = cwd => Boolean(cwd) && vaultRel(cwd) !== null;

// Folders the user keeps quiet, such as an app's scratch folders, are globs over absolute paths in vault.local.json. A
// glob lint finds broken is left out. A POSIX path's leading slash comes off both sides, as normGlob takes it off the glob.
export function isQuiet(cwd) {
  if (!cwd) return false;
  const p = toPosix(cwd).replace(/^\//, '');
  return config().quiet.some(g => globToRegExp(g).test(p));
}

// A vault-only domain holds pages only, which sessions read from the vault folder. It is set in vault.config.json rather
// than read from missing paths, so a domain is vault-only on every machine or none.
export const isVaultOnly = d => d !== 'global' && config().domains[d]?.vaultOnly === true;
export const everywhereDomains = () => Object.keys(config().domains).filter(d => config().domains[d].everywhere === true && !isVaultOnly(d));

export const PROPOSAL_MODES = ['corrections', 'ask', 'off'];
// A value lint reports counts as the one it would fall back to, so a typo keeps the user's say over each rule.
const modeOr = (x, fallback) => (PROPOSAL_MODES.includes(x) ? x : fallback);
// global has no entry under domains, so it takes the top-level mode.
export function proposalMode(d) {
  const top = modeOr(config().proposals, 'ask');
  return d === 'global' ? top : modeOr(config().domains[d]?.proposals, top);
}

export function domainsByMode(domains) {
  const byMode = new Map();
  for (const d of domains) {
    const mode = proposalMode(d);
    byMode.set(mode, [...(byMode.get(mode) ?? []), d]);
  }
  return byMode;
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) {
    if (e.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw e;
  }
}

export function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
}

const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Windows refuses a rename while another process (Obsidian, antivirus) briefly holds the file.
function retry(fn) {
  for (let i = 0; ; i++) {
    try { return fn(); } catch (e) {
      if (i >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      sleep(50);
    }
  }
}

export function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  try {
    retry(() => fs.renameSync(tmp, file));
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

// Only for a folder the tools keep for themselves, such as a clone in .sources/.
export const removeDir = dir => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });

export const lf = s => String(s ?? '').replace(/\r\n/g, '\n');
// A BOM is the editor's, not the text's, so the guards and triggers read text without it.
export const plainText = s => lf(s).replace(/^\uFEFF/, '');
export const writeJson = (file, data) => writeText(file, `${JSON.stringify(data, null, 2)}\n`);

// The hooks wait out delivery.settleSeconds after a save because Obsidian saves half-typed notes;
// a note written whole is dated back so it applies at once.
export function writeSettled(file, text) {
  writeText(file, text);
  const t = new Date(Date.now() - config().delivery.settleSeconds * 1000);
  fs.utimesSync(file, t, t);
}

// For a change that leaves what a note says as it was. The file keeps the day it was saved, so the pages that watch the
// note don't go stale, but moves on a second, since editors such as VS Code tell a file changed by its time and size.
export function rewriteText(file, text) {
  const { atime, mtime } = fs.statSync(file);
  writeText(file, text);
  fs.utimesSync(file, atime, new Date(mtime.getTime() + 1000));
}

// One append per batch, so a reader never sees half of a run's rows.
export function appendJsonl(file, rows) {
  if (!rows.length) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, rows.map(r => `${JSON.stringify(r)}\n`).join(''));
}

// Never over a file already there, so a sheet copied the same day under the same name gets the next number.
export function copyNew(src, dir, stem, ext) {
  fs.mkdirSync(dir, { recursive: true });
  for (let n = 1; ; n++) {
    const file = path.join(dir, `${stem}${n === 1 ? '' : `-${n}`}${ext}`);
    try {
      fs.copyFileSync(src, file, fs.constants.COPYFILE_EXCL);
      return file;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
}

// A file that can't be read gives missing, so a caller can tell it from an empty one.
export function readJsonl(file, missing = []) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return missing; }
  return text.split('\n').flatMap(line => {
    try { return line.trim() ? [JSON.parse(line)] : []; } catch { return []; }
  });
}

export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export const memo = f => {
  const seen = new Map();
  return k => {
    if (!seen.has(k)) seen.set(k, f(k));
    return seen.get(k);
  };
};

const pad = n => String(n).padStart(2, '0');
export const today = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
// Rows stamp `at` in UTC and files are named for the local day, so a row's day is read as a local day too.
// Whole days from one YYYY-MM-DD day to another, today by default.
export const daysBetween = (from, to = today()) => Math.round((Date.parse(to) - Date.parse(from)) / 864e5);
export const localDay = at => (Number.isNaN(Date.parse(at)) ? '' : today(new Date(at)));
export const clock = (d = new Date()) => `${today(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

// A session writes its own file, so two clones working on one day never append to the same one in git. Rows from before
// that sit in <date>.jsonl. A sheet beside them is <date>-<subject>.<image extension>, which this never matches.
const ROW_FILE = /^\d{4}-\d\d-\d\d(?:-[\w-]{1,8})?\.jsonl$/;
const sessionFile = (folder, name, day) => vaultPath('raw', folder, `${day}-${safeId(name).slice(0, 8)}.jsonl`);

export const inboxFile = (name, day = today()) => sessionFile('inbox', name, day);
export const picksFile = (name, day = today()) => sessionFile('picks', name, day);
export const queueFile = (name, day = today()) => sessionFile('queue', name, day);

export function datedFiles(folder) {
  const dir = vaultPath('raw', folder);
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => ROW_FILE.test(f)).sort(); } catch {}
  return files.map(f => ({ file: `raw/${folder}/${f}`, rows: readJsonl(path.join(dir, f)) }));
}

// Windows, Office and browsers leave these beside the files a person saves.
const LEFTOVER = /^(?:desktop\.ini|thumbs\.db|~\$.*|.*\.(?:tmp|crdownload|part))$/i;

export function filesIn(dir, ext = '', rel = '') {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    if (e.name.startsWith('.') || e.name === 'node_modules' || LEFTOVER.test(e.name)) return [];
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) return filesIn(path.join(dir, e.name), ext, r);
    return e.name.endsWith(ext) ? [r] : [];
  });
}

// By `at`, not by file, so rows read the same whichever clone's file holds them.
const atOf = r => String(r?.at ?? '');
const byAt = (a, b) => (atOf(a) < atOf(b) ? -1 : atOf(a) > atOf(b) ? 1 : 0);
const datedRows = folder => datedFiles(folder).flatMap(f => f.rows).sort(byAt);

export const proposalRows = () => datedRows('inbox').filter(r => r.source === 'agent');
export const pickRows = () => datedRows('picks');
export const queueRows = () => datedRows('queue');

export function appendLog(lines) {
  const file = vaultPath('log.md');
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch {}
  const lead = text && !text.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(file, `${lead}${lines.map(l => `- ${clock()} · ${l}`).join('\n')}\n`);
}

export function statePath(...xs) {
  const file = vaultPath('.state', ...xs);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return file;
}

export function stateDir(...xs) {
  const dir = vaultPath('.state', ...xs);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function mtime(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

export function logError(name, e) {
  try {
    const file = statePath('errors.log');
    const big = () => fs.statSync(file).size > 1 << 20;
    // A hook that saw the full log may wait while another rotates it, so it checks the size again under
    // the lock rather than rotate the fresh log over the full one. No log yet, a busy lock or a failed
    // rename: this error still gets logged.
    try { if (big()) withLock(`${file}.lock`, () => { if (big()) fs.renameSync(file, `${file}.1`); }, { waitMs: 3000 }); } catch {}
    fs.appendFileSync(file, `${new Date().toISOString()} ${name}: ${e?.stack ?? e}\n`);
  } catch {}
}

// A hook section that fails, like a line built from a malformed config, costs its own result, not the rest of the hook.
// Running out of time is the hook's failure, not the section's, so that error goes on up.
export function guarded(name, fn, fallback = '') {
  try { return fn(); } catch (e) {
    if (e?.code === 'EDEADLINE') throw e;
    logError(name, e);
    return fallback;
  }
}

const ENTRY = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z) (.*)$/;

export const errorsLog = (suffix = '') => vaultPath('.state', `errors.log${suffix}`);

export function hookErrors(file = errorsLog(), from = 0) {
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    return [];
  }
  return buf.subarray(from).toString('utf8').split(/\r?\n/).flatMap(l => {
    const m = l.match(ENTRY);
    return m ? [{ at: m[1], message: m[2] }] : [];
  });
}

export const cwdOf = input => input.cwd || process.cwd();

// A failed hook exits 1 with one line, so the user sees a hook error and the call goes ahead; exit 2 would block it. The
// adapter turns the agent's input into events, one per thing the call changes, and the handler's results into the
// agent's output.
export async function runHook(name, agent, handler) {
  if (agent.disabled(process.env)) return;
  armDeadline();
  try {
    const input = JSON.parse(fs.readFileSync(0, 'utf8').replace(/^\uFEFF/, ''));
    const results = [];
    for (const event of agent.events(name, input)) results.push(await handler(event, agent));
    const out = agent.output(name, results);
    if (out) process.stdout.write(JSON.stringify(out));
  } catch (e) {
    logError(name, e);
    const why = String(e?.message ?? e).replace(/\s+/g, ' ').trim();
    process.stderr.write(`vault ${name} failed: ${why}; see .state/errors.log\n`);
    process.exitCode = 1;
  }
}

export const shortHash = s => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16);
export const safeId = s => (/^[A-Za-z0-9_-]{1,100}$/.test(String(s)) ? String(s) : shortHash(s));

// A lock file holds its owner's token, "<pid>:<random>". Release and stealing both go by the token, so a process
// never removes a lock someone else now holds.
const alive = pid => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};

const LOCK_UNOWNED_MS = 10_000;

// A dead owner's lock is stale at once. A live owner keeps it until staleMs, which guards against a recycled pid, as
// Windows hands out; it has to pass well before a waiter gives up, and well after the longest real hold. A file with no token yet is being written, or was cut short.
function stale(token, ageMs, staleMs) {
  const pid = Number(/^(\d+)/.exec(token)?.[1]);
  if (!pid) return ageMs > LOCK_UNOWNED_MS;
  return alive(pid) ? ageMs > staleMs : true;
}

const readToken = file => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };

// Moving the file aside is atomic, so of several waiters that judge one lock stale only one gets it. If the lock moved was
// a fresh one taken meanwhile, it goes back.
function steal(file, seen, token) {
  const aside = `${file}.${token.replace(':', '-')}.stale`;
  try { fs.renameSync(file, aside); } catch { return; }
  if (readToken(aside) !== seen) {
    try { fs.linkSync(aside, file); } catch {}
  }
  fs.rmSync(aside, { force: true });
}

function tryLock(file, token, staleMs) {
  try {
    fs.writeFileSync(file, token, { flag: 'wx' });
    return true;
  } catch (e) {
    // Windows refuses to create a file while another process is still deleting it, as a lock being released is.
    if (e.code !== 'EEXIST' && !(process.platform === 'win32' && e.code === 'EPERM')) throw e;
  }
  const seen = readToken(file);
  if (seen !== null && stale(seen, Date.now() - mtime(file), staleMs)) steal(file, seen, token);
  return false;
}

// A propose holds the lock for about 6 s at 3,000 notes, and three at once run one after another, so a waiter gives up
// only after a minute, and a live holder's lock goes stale at half that.
export function withLock(file, fn, { waitMs = 60_000, staleMs = 30_000 } = {}) {
  const token = `${process.pid}:${crypto.randomBytes(6).toString('hex')}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const giveUp = Date.now() + waitMs;
  while (!tryLock(file, token, staleMs)) {
    if (Date.now() >= giveUp) throw Object.assign(new Error(`${path.basename(file)} is held by another process`), { code: 'ELOCKED' });
    sleep(50);
  }
  try { return fn(); } finally { if (readToken(file) === token) fs.rmSync(file, { force: true }); }
}
