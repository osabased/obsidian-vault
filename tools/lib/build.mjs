import fs from 'node:fs';
import { vaultPath, writeText, writeJson, lf, statePath, withLock, skipIfLocked } from './vault.mjs';
import { loadNotes, liveRules, renderActive, renderIndex, readDerived } from './rules.mjs';
import { renderDecisions } from './picks.mjs';
import { renderQueue, queueLocked } from './queue.mjs';
import { markBuilt, changedSinceBuild, refStats } from './cache.mjs';
import { derive } from './sources.mjs';

const render = notes => ({ 'active.md': renderActive(liveRules(notes)), 'index.md': renderIndex(notes), 'decisions.md': renderDecisions() });

// queue.md is rendered and written under queue.lock, so it never overwrites a newer one a queue write left. A holder of
// the lock writes queue.md itself once its rows are in, so a build that finds the lock taken leaves queue.md to it rather
// than wait.
const writeQueueFile = () => skipIfLocked(() => queueLocked(() => stale({ 'queue.md': renderQueue() }, true), 0)) ?? [];

function stale(files, write) {
  const out = [];
  for (const [name, text] of Object.entries(files)) {
    let current = '';
    try { current = lf(fs.readFileSync(vaultPath(name), 'utf8')); } catch {}
    if (current === text) continue;
    out.push(name);
    if (write) writeText(vaultPath(name), text);
  }
  return out;
}

// A corrupt derived.json is rewritten from raw/refs/ and the notes, which loses only the checks refresh recorded. Derive
// reads every copy in raw/refs/, so it is skipped while neither they nor the notes changed since the last build; apply
// writes copies first, so its chains are read afresh.
function writeDerived(notes, { apply, refs, chains }) {
  const file = statePath('derived.json');
  const old = readDerived();
  if (!apply && old && !changedSinceBuild(notes, null, refs)) return;
  const next = apply ? derive(notes, apply(old ?? {})) : derive(notes, old ?? {}, chains);
  if (JSON.stringify(next) !== JSON.stringify(old)) writeJson(file, next);
}

// The generated files that differ from the notes, written unless check is set, and .state/derived.json. Two builds at
// once could each read the notes before the other's note landed and write last without it, so a build that writes takes
// build.lock and reads the notes once it holds it; notes given are read only by a check. A build that can't take the lock
// within waitMs throws. apply runs under the lock first, given derived.json as it stands, and returns it with refresh's
// checks, after writing any copies under raw/refs/. A caller that holds refStats() or sourceChains() passes them as refs
// and chains so raw/refs/ isn't read twice; with apply, both are taken afresh once its copies are written.
export function build({ check = false, notes, waitMs = 60_000, apply, refs, chains } = {}) {
  if (check) return stale({ ...render(notes ?? loadNotes()), 'queue.md': renderQueue() }, false);
  return withLock(statePath('build.lock'), () => {
    const all = loadNotes();
    const out = [...stale(render(all), true), ...writeQueueFile()];
    const before = apply ? null : (refs ?? refStats());
    writeDerived(all, { apply, refs: before, chains });
    markBuilt(all, before ?? refStats());
    return out;
  }, { waitMs });
}
