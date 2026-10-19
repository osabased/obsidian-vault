import { runHook, safeId, readJsonSafe, writeJson } from '../lib/vault.mjs';
import { registry, spawnPass } from '../lib/sessions.mjs';

runHook('session-end', input => {
  const id = safeId(input.session_id);
  const entry = readJsonSafe(registry(id));
  if (!entry) return null;
  writeJson(registry(id), { ...entry, transcript: input.transcript_path ?? entry.transcript, last_seen: new Date().toISOString() });
  spawnPass(id);
  return null;
});
