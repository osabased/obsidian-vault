// VAULT_PERF=1 node --test test/perf/*.perf.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionId } from '../fixture.mjs';
import { bigVault } from './notes.mjs';

const perf = { skip: !process.env.VAULT_PERF && 'set VAULT_PERF=1 to run the timing tests' };

// Half the 10 s timeout every hook runs under, so a loaded machine still finishes before the deadline.
const BUDGET_MS = 5000;
const REFS = 3000;
// A build with nothing changed renders the generated files and stats raw/refs/, and reads no copy in it.
const NO_CHANGE_MS = 1500;

test(`at 3,000 notes and 3,000 files in raw/refs/, a session start that builds takes under ${BUDGET_MS} ms and a build with nothing changed under ${NO_CHANGE_MS} ms`, perf, t => {
  const v = bigVault(t, 3000);
  for (let i = 0; i < REFS; i++) {
    v.write(`raw/refs/bulk/page-${i}.md`, `---\nurl: https://pkg.invalid/page-${i}\nfetched: 2026-10-01\n---\n${'Some saved text. '.repeat(1200)}\n`, { saved: null });
  }
  v.run('build.mjs');
  const rel = 'wiki/ui/rules/rule-0.md';
  const timed = change => {
    change();
    const start = performance.now();
    v.startSession(sessionId(), { cwd: v.project });
    return performance.now() - start;
  };
  // A changed note and a copy that lands in raw/refs/ each make the session start derive from every copy.
  const edited = [0, 1, 2].map(() => timed(() => v.write(rel, `${v.read(rel)}\n`)));
  const landed = [0, 1, 2].map(i => timed(() => v.write(`raw/refs/bulk/new-${i}.md`, `---\nurl: https://pkg.invalid/new-${i}\nfetched: 2026-10-02\n---\nNew.\n`, { saved: null })));
  const idle = [0, 1, 2].map(() => timed(() => {}));
  const rebuilt = [0, 1, 2].map(() => { const start = performance.now(); v.run('build.mjs'); return performance.now() - start; });
  const fastest = xs => Math.round(Math.min(...xs));
  t.diagnostic(`session start: after a note edit ${fastest(edited)} ms, after a new copy ${fastest(landed)} ms, with nothing changed ${fastest(idle)} ms; build.mjs with nothing changed ${fastest(rebuilt)} ms (fastest of 3 each)`);
  assert.ok(fastest(edited) < BUDGET_MS, `after a note edit: ${fastest(edited)} ms`);
  assert.ok(fastest(landed) < BUDGET_MS, `after a new copy: ${fastest(landed)} ms`);
  assert.ok(fastest(rebuilt) < NO_CHANGE_MS, `build.mjs with nothing changed: ${fastest(rebuilt)} ms`);
});
