import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config, vaultPath, statePath, stateDir, readJsonSafe, writeJson, safeId, shortHash, mtime, domainsFor } from './vault.mjs';

const DAY = 86400e3;

export const registry = id => statePath('sessions', `${id}.json`);
export const passFiles = id => ({ state: statePath('passes', `${id}.json`), lock: statePath('passes', `${id}.lock`) });
export const lockStaleMs = () => (config().pass.timeoutSeconds * 4 + 60) * 1000;

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

export function mark(kind, sid, key) {
  const file = marker(kind, sid, key);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(file, key, { flag: 'wx' });
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw e;
  }
}

export function clearMarkers(sid) {
  for (const kind of ['gate', 'excerpts']) fs.rmSync(vaultPath('.state', kind, safeId(sid)), { recursive: true, force: true });
}

export function spawnPass(id) {
  spawn(process.execPath, [vaultPath('tools', 'session-pass.mjs'), id], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

function prune(id) {
  fs.rmSync(registry(id), { force: true });
  fs.rmSync(passFiles(id).state, { force: true });
  // No hook writes 'captured' markers; this clears the ones still in .state/.
  for (const kind of ['gate', 'excerpts', 'captured']) fs.rmSync(vaultPath('.state', kind, id), { recursive: true, force: true });
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
