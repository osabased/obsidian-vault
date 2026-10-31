import fs from 'node:fs';
import { vaultPath, writeText, lf } from './vault.mjs';
import { loadNotes, liveRules, renderActive, renderIndex } from './rules.mjs';
import { renderDecisions } from './picks.mjs';

export function build({ check = false, notes = loadNotes() } = {}) {
  const files = { 'active.md': renderActive(liveRules(notes)), 'index.md': renderIndex(notes), 'decisions.md': renderDecisions() };
  const stale = [];
  for (const [name, text] of Object.entries(files)) {
    let current = '';
    try { current = lf(fs.readFileSync(vaultPath(name), 'utf8')); } catch {}
    if (current === text) continue;
    stale.push(name);
    if (!check) writeText(vaultPath(name), text);
  }
  return stale;
}
