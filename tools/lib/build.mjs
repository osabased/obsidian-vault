import fs from 'node:fs';
import { vaultPath, writeText, writeJson, readJson, lf, statePath, withLock } from './vault.mjs';
import { loadNotes, liveRules, renderActive, renderIndex } from './rules.mjs';
import { renderDecisions } from './picks.mjs';
import { markBuilt } from './cache.mjs';
import { derive } from './sources.mjs';

const render = notes => ({ 'active.md': renderActive(liveRules(notes)), 'index.md': renderIndex(notes), 'decisions.md': renderDecisions() });

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

// A corrupt derived.json throws, as it does in the hooks, rather than lose the checks refresh recorded.
function writeDerived(notes, apply) {
  const file = statePath('derived.json');
  const old = readJson(file, {});
  const next = derive(notes, apply ? apply(old) : old);
  if (JSON.stringify(next) !== JSON.stringify(old)) writeJson(file, next);
}

// The generated files that differ from the notes, written unless check is set, and .state/derived.json. Two builds at
// once could each read the notes before the other's note landed and write last without it, so a build that writes takes
// build.lock and reads the notes once it holds it; notes given are read only by a check. A build that can't take the lock
// within waitMs throws. apply runs under the lock first, given derived.json as it stands, and returns it with refresh's
// checks, after writing any copies under raw/refs/.
export function build({ check = false, notes, waitMs = 60_000, apply } = {}) {
  if (check) return stale(render(notes ?? loadNotes()), false);
  return withLock(statePath('build.lock'), () => {
    const all = loadNotes();
    const out = stale(render(all), true);
    writeDerived(all, apply);
    markBuilt(all);
    return out;
  }, { waitMs });
}
