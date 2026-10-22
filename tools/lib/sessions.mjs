import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config, vaultPath, statePath, stateDir, readJsonSafe, writeJson, safeId, shortHash, mtime, domainsFor } from './vault.mjs';

const DAY = 86400e3;

export const registry = id => statePath('sessions', `${id}.json`);
export const passFiles = id => ({ state: statePath('passes', `${id}.json`), lock: statePath('passes', `${id}.lock`) });
export const lockStaleMs = () => (config().pass.timeoutSeconds * 4 + 60) * 1000;

const PASS_END = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z) ([A-Za-z0-9_-]{1,100}) (kept \d.*|failed: (.*))/;

// A pass logs picks and pattern captures along the way; only its kept or failed line says how it ended.
export function lastPass() {
  let log = '';
  try { log = fs.readFileSync(vaultPath('.state', 'passes.log'), 'utf8'); } catch {}
  const [, at, id, kept, failed] = log.split(/\r?\n/).map(l => PASS_END.exec(l)).findLast(Boolean) ?? [];
  return at ? { at, id, kept: failed === undefined ? kept : undefined, failed } : null;
}

// `loaded` records when each domain's always-on rules went into the session's context, so rules
// confirmed later, or domains the session moves into, are delivered with the next prompt.
export function touchSession(input, { loaded = [] } = {}) {
  const id = safeId(input.session_id);
  const file = registry(id);
  const prev = readJsonSafe(file) ?? {};
  const now = new Date().toISOString();
  const entry = {
    session: String(input.session_id),
    transcript: input.transcript_path ?? prev.transcript ?? null,
    cwd: input.cwd ?? prev.cwd ?? null,
    domain: domainsFor(input.cwd)[0]?.domain ?? prev.domain ?? null,
    first_seen: prev.first_seen ?? now,
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
  // Only registered sessions can propose, and only theirs are pruned.
  if (fs.existsSync(registry(safeId(sid)))) markShown(sid, key, hash);
  return true;
}

export function spawnPass(id) {
  spawn(process.execPath, [vaultPath('tools', 'session-pass.mjs'), id], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

function prune(id) {
  fs.rmSync(registry(id), { force: true });
  fs.rmSync(passFiles(id).state, { force: true });
  // No hook writes 'captured' markers; this clears the ones still in .state/.
  for (const kind of ['gate', 'excerpts', 'shown', 'repeats', 'captured']) fs.rmSync(vaultPath('.state', kind, id), { recursive: true, force: true });
}

const fileSize = file => {
  try { return fs.statSync(file).size; } catch { return 0; }
};

function rotate(file) {
  if (fileSize(file) > 1 << 20) fs.renameSync(file, `${file}.1`);
}

// SessionEnd may not fire (a closed app, a crash), so prompts in any session also catch up idle ones.
export function maybeSweep(currentId) {
  const { idleHours, sweepEveryMinutes } = config().pass;
  const stampFile = statePath('sweep.json');
  if (Date.now() - Date.parse(readJsonSafe(stampFile)?.at) < sweepEveryMinutes * 60e3) return;
  writeJson(stampFile, { at: new Date().toISOString() });
  let spawned = 0;
  for (const name of fs.readdirSync(stateDir('sessions'))) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -'.json'.length);
    const entry = readJsonSafe(registry(id));
    const idle = Date.now() - Date.parse(entry?.last_seen);
    if (!entry || !(idle <= 30 * DAY)) {
      prune(id);
      continue;
    }
    if (id === currentId || idle < idleHours * 3600e3 || spawned >= 3) continue;
    const size = fileSize(entry.transcript);
    const { state, lock } = passFiles(id);
    const passed = readJsonSafe(state);
    // State from before picks were logged lacks `picks`, so those sessions get one more pass for them.
    if (!size || ((passed?.offset ?? 0) >= size && passed?.picks)) continue;
    if (Date.now() - mtime(lock) < lockStaleMs()) continue;
    spawnPass(id);
    spawned++;
  }
  for (const f of ['errors.log', 'passes.log']) rotate(statePath(f));
}
