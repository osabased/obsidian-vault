import fs from 'node:fs';
import { vaultPath, writeText, lf, statePath, withLock } from './vault.mjs';
import { loadNotes, liveRules, renderActive, renderIndex } from './rules.mjs';
import { renderDecisions } from './picks.mjs';
import { markBuilt } from './cache.mjs';

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

// The generated files that differ from the notes, written unless check is set. Two builds at once could each read the
// notes before the other's note landed and write last without it, so a build that writes takes build.lock and reads the
// notes once it holds it; notes given are read only by a check. A build that can't take the lock within waitMs throws.
export function build({ check = false, notes, waitMs = 60_000 } = {}) {
  if (check) return stale(render(notes ?? loadNotes()), false);
  return withLock(statePath('build.lock'), () => {
    const all = loadNotes();
    const out = stale(render(all), true);
    markBuilt(all);
    return out;
  }, { waitMs });
}
