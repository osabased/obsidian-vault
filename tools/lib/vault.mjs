import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// The hooks in settings.json run a copy of tools/ inside the vault, which .githooks/post-commit keeps at the last
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

const DEFAULTS = {
  delivery: { maxRulesPerEdit: 3, maxRuleChars: 300, maxBlockChars: 1200, maxPromptExcerpts: 3, maxPages: 3, activeMaxLines: 60, activeMaxBytes: 4096, settleSeconds: 60 },
  knowledge: { staleAfterDays: 180 },
  lint: { remindAfterDays: 14, remindAfterNotes: 10 },
  picks: { maxSheetBytes: 3_000_000 },
  reach: { markerDepth: 3 },
};

const strings = xs => (Array.isArray(xs) ? xs.filter(x => typeof x === 'string' && x.trim()) : []);
const local = () => readJsonSafe(vaultPath('vault.local.json'))?.domains ?? {};

// Paths differ per machine, so they come from the untracked vault.local.json; a file lint finds broken gives none.
let loaded;
export function config() {
  if (!loaded) {
    const c = readJson(vaultPath('vault.config.json'), {});
    const mine = local();
    const domains = Object.fromEntries(Object.entries(c.domains ?? {}).map(([d, x]) => [d, { ...x, paths: strings(mine?.[d]?.paths) }]));
    loaded = { domains, ...Object.fromEntries(Object.entries(DEFAULTS).map(([k, d]) => [k, { ...d, ...c[k] }])) };
  }
  return loaded;
}

// Git Bash hands out /c/Users/... paths; Node on Windows needs c:/Users/...
const native = p => (process.platform === 'win32' ? String(p).replace(/\\/g, '/').replace(/^\/([a-z])(?=\/|$)/i, '$1:') : String(p));

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
export const vaultRel = (p, base) => inside(ROOT, p, base);

const caseFolds = process.platform === 'win32' || process.platform === 'darwin';
const fold = name => (caseFolds ? name.toLowerCase() : name);

// A marker is a file name, so one with a folder in it never matches.
const markersOf = d => strings(config().domains[d]?.markers).filter(m => !/[\\/]/.test(m));

// Each marker file name with the domains it puts a folder in.
function markerDomains() {
  const by = new Map();
  for (const d of Object.keys(config().domains)) {
    for (const m of markersOf(d)) by.set(fold(m), [...(by.get(fold(m)) ?? []), d]);
  }
  return by;
}

const hasDir = dir => fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory() ?? false;

// The nearest folder at or above p that holds a marker, with every domain whose marker it holds. p may be a file the
// edit is about to create, and a file path never holds a marker, so the walk can start at p itself.
function markedAbove(p, by) {
  if (!by.size) return [];
  for (let dir = p; ; dir = path.dirname(dir)) {
    const doms = [...by].filter(([m]) => fs.existsSync(path.join(dir, m))).flatMap(([, ds]) => ds);
    if (doms.length) return [...new Set(doms)].map(domain => ({ domain, root: dir }));
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
        const doms = entries.filter(e => e.isFile()).flatMap(e => by.get(fold(e.name)) ?? []);
        for (const domain of new Set(doms)) hits.push({ domain, root: dir });
      }
      if (level >= depth) continue;
      for (const e of entries) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (!e.isDirectory() || e.name.startsWith('.') || ignored.names.has(fold(e.name)) || ignored.paths.has(fold(r))) continue;
        next.push({ dir: `${dir}/${e.name}`, rel: r, level: level + 1 });
      }
    }
    queue = next;
  }
  return hits;
}

// A session's domains: its folder's, and those of the markers below it.
export function sessionReach(cwd) {
  const hits = [...domainsFor(cwd), ...markedBelow(cwd)];
  return hits.filter((h, i) => hits.findIndex(x => x.domain === h.domain) === i);
}

export const inVaultFolder = cwd => Boolean(cwd) && vaultRel(cwd) !== null;

// A vault-only domain holds pages only, which sessions read from the vault folder.
const isVaultOnly = d => d !== 'global' && config().domains[d]?.vaultOnly === true;
export const everywhereDomains = () => Object.keys(config().domains).filter(d => config().domains[d].everywhere === true && !isVaultOnly(d));

// /ingest runs in the vault folder and can feed any domain. A session takes the domains session start found for it,
// with those of its folder.
export function proposeDomains(entry) {
  if (inVaultFolder(entry?.cwd)) return Object.keys(config().domains);
  const found = Array.isArray(entry?.reach?.domains) ? entry.reach.domains : [];
  return [...new Set([...found, ...domainsFor(entry?.cwd).map(d => d.domain)])].filter(d => Object.hasOwn(config().domains, d));
}
// The vault folder is where every domain's pages are read, a vault-only domain's among them; an everywhere domain's
// pages reach every session.
export const readableDomains = (doms, vaultFolder) => [...new Set([...(vaultFolder ? Object.keys(config().domains) : [...doms, ...everywhereDomains()]), 'global'])];

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

export const lf = s => String(s ?? '').replace(/\r\n/g, '\n');
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

const pad = n => String(n).padStart(2, '0');
export const today = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
// Rows stamp `at` in UTC and files are named for the local day, so a row's day is read as a local day too.
export const localDay = at => (Number.isNaN(Date.parse(at)) ? '' : today(new Date(at)));
export const clock = (d = new Date()) => `${today(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

export const inboxFile = () => vaultPath('raw', 'inbox', `${today()}.jsonl`);
export const picksFile = (day = today()) => vaultPath('raw', 'picks', `${day}.jsonl`);

export function datedFiles(folder) {
  const dir = vaultPath('raw', folder);
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort(); } catch {}
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

const datedRows = folder => datedFiles(folder).flatMap(f => f.rows);

export const proposalRows = () => datedRows('inbox').filter(r => r.source === 'agent');
export const pickRows = () => datedRows('picks');

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
    try { if (big()) withLock(`${file}.lock`, () => { if (big()) fs.renameSync(file, `${file}.1`); }); } catch {}
    fs.appendFileSync(file, `${new Date().toISOString()} ${name}: ${e?.stack ?? e}\n`);
  } catch {}
}

// A hook section that fails, like a line built from a malformed config, costs its own result, not the rest of the hook.
export function guarded(name, fn, fallback = '') {
  try { return fn(); } catch (e) { logError(name, e); return fallback; }
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

export const FILE_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
export const toolFile = (name, input) => (name === 'NotebookEdit' ? input.notebook_path : input.file_path);

// Hooks fail open: a broken vault must never block the user's session.
export function runHook(name, fn) {
  if (process.env.CLAUDE_CODE_SAFE_MODE === '1') return;
  try {
    const out = fn(JSON.parse(fs.readFileSync(0, 'utf8').replace(/^\uFEFF/, '')));
    if (out) process.stdout.write(JSON.stringify(out));
  } catch (e) {
    logError(name, e);
  }
}

export const shortHash = s => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16);
export const safeId = s => (/^[A-Za-z0-9_-]{1,100}$/.test(String(s)) ? String(s) : shortHash(s));

function tryLock(file, staleMs) {
  for (let i = 0; i < 2; i++) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (Date.now() - mtime(file) <= staleMs) return false;
      fs.rmSync(file, { force: true });
    }
  }
  return false;
}

export function withLock(file, fn, staleMs = 10000) {
  const giveUp = Date.now() + 3000;
  while (!tryLock(file, staleMs)) {
    if (Date.now() > giveUp) throw new Error(`${path.basename(file)} is held by another process`);
    sleep(50);
  }
  try { return fn(); } finally { fs.rmSync(file, { force: true }); }
}
