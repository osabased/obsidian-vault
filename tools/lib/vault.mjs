import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const ROOT = path.resolve(import.meta.dirname, '..', '..');
export const vaultPath = (...xs) => path.join(ROOT, ...xs);

const DEFAULTS = {
  delivery: { maxRulesPerEdit: 3, maxRuleChars: 300, maxBlockChars: 1200, maxPromptExcerpts: 3, activeMaxLines: 60, activeMaxBytes: 4096 },
  pass: { command: 'claude', model: 'sonnet', effort: 'low', idleHours: 4, sweepEveryMinutes: 30, maxInputChars: 60000, timeoutSeconds: 300 },
  knowledge: { staleAfterDays: 180 },
};

let loaded;
export function config() {
  if (!loaded) {
    const c = readJson(vaultPath('taste.config.json'), {});
    loaded = {
      domains: c.domains ?? {}, delivery: { ...DEFAULTS.delivery, ...c.delivery }, pass: { ...DEFAULTS.pass, ...c.pass },
      knowledge: { ...DEFAULTS.knowledge, ...c.knowledge },
    };
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
  return lower.startsWith(`${r}/`) ? target.slice(r.length + 1) : null;
}

export const stripWorktree = rel => rel.replace(/^\.claude\/worktrees\/[^/]+(?:\/|$)/i, '');
export const vaultRel = (p, base) => inside(ROOT, p, base);

export function domainsFor(p, base) {
  if (!p) return [];
  const hits = [];
  for (const [domain, d] of Object.entries(config().domains)) {
    for (const project of d.projects ?? []) {
      const rel = inside(project, p, base);
      if (rel !== null) hits.push({ domain, root: toPosix(project), rel: stripWorktree(rel) });
    }
  }
  hits.sort((a, b) => b.root.length - a.root.length);
  return hits.filter((h, i) => hits.findIndex(x => x.domain === h.domain) === i);
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

export const writeJson = (file, data) => writeText(file, `${JSON.stringify(data, null, 2)}\n`);

// One append per batch, so a reader never sees half of a run's rows.
export function appendJsonl(file, rows) {
  if (!rows.length) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, rows.map(r => `${JSON.stringify(r)}\n`).join(''));
}

export function readJsonl(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch {}
  return text.split('\n').flatMap(line => {
    try { return line.trim() ? [JSON.parse(line)] : []; } catch { return []; }
  });
}

export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const pad = n => String(n).padStart(2, '0');
export const today = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const clock = (d = new Date()) => `${today(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

export const inboxFile = () => vaultPath('raw', 'inbox', `${today()}.jsonl`);
export const picksFile = () => vaultPath('raw', 'picks', `${today()}.jsonl`);

function datedRows(folder) {
  const dir = vaultPath('raw', folder);
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort(); } catch {}
  return files.flatMap(f => readJsonl(path.join(dir, f)));
}

export const inboxRows = () => datedRows('inbox');
export const pickRows = () => datedRows('picks');
export const proposalRows = () => inboxRows().filter(r => r.source === 'agent');

export const decisionsFile = () => vaultPath('raw', 'decisions.jsonl');

export function pendingRows(rows = inboxRows()) {
  const done = new Set(readJsonl(decisionsFile()).flatMap(d => (Array.isArray(d.ids) ? d.ids : [])));
  return rows.filter(r => r.id && !done.has(r.id));
}

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

export function mtime(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

export const appendLine = (file, line) => fs.appendFileSync(file, `${line}\n`);

export function logError(name, e) {
  try { appendLine(statePath('errors.log'), `${new Date().toISOString()} ${name}: ${e?.stack ?? e}`); } catch {}
}

export const cwdOf = input => input.cwd || process.cwd();

export const FILE_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
export const SHELL_TOOLS = ['Bash', 'PowerShell'];
export const toolCommand = (name, input) => (SHELL_TOOLS.includes(name) ? String(input.command ?? '') : null);
export const toolFile = (name, input) => (name === 'NotebookEdit' ? input.notebook_path : input.file_path);
// `2>&1`, `=>`, `->` and `>=` contain `>` but write no file.
export const WRITEISH = /(?<![\d&=-])>(?![&=])|\btee\b|\bsed\s+-i|\bmv\b|\bcp\b|\brm\b|\bdel\b|Set-Content|Add-Content|Out-File|Remove-Item|Move-Item|Copy-Item|New-Item|writeFile|appendFile|WriteAllText|\bperl\s+-[a-z]*i/i;

export const skip = () => process.env.CLAUDE_CODE_SAFE_MODE === '1' || process.env.AGENT_TASTE_PASS === '1';

// Hooks fail open: a broken vault must never block the user's session.
export function runHook(name, fn) {
  if (skip()) return;
  try {
    const out = fn(JSON.parse(fs.readFileSync(0, 'utf8').replace(/^\uFEFF/, '')));
    if (out) process.stdout.write(JSON.stringify(out));
  } catch (e) {
    logError(name, e);
  }
}

export const shortHash = s => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16);
export const safeId = s => (/^[A-Za-z0-9_-]{1,100}$/.test(String(s)) ? String(s) : shortHash(s));

export function tryLock(file, staleMs) {
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

export const unlock = file => fs.rmSync(file, { force: true });

export function withLock(file, fn, staleMs = 10000) {
  const giveUp = Date.now() + 3000;
  while (!tryLock(file, staleMs)) {
    if (Date.now() > giveUp) throw new Error(`${path.basename(file)} is held by another process`);
    sleep(50);
  }
  try { return fn(); } finally { unlock(file); }
}
