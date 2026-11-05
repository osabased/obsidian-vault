// VAULT_PERF=1 node --test test/perf/*.perf.mjs
// Wall times include node start-up, so they move with the machine's load. They stay out of test/*.test.mjs, which the
// pre-commit hook runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeVault, sessionId, denied, editFile, unrelatedRules, proposeAtOnce } from '../fixture.mjs';
import { bigVault, addNotes, GATED } from './notes.mjs';

const perf = { skip: !process.env.VAULT_PERF && 'set VAULT_PERF=1 to run the timing tests' };

// One vault holds every test's notes, grown as a test needs more, and it outlives the test that first needs it, so it is
// cleaned up when the process exits, not by a test's t.after.
let vault;
let notes = 0;
const shared = n => {
  vault ??= bigVault({ after: fn => process.on('exit', fn) }, 0);
  if (n > notes) {
    addNotes(vault, notes, n);
    notes = n;
  }
  return vault;
};

// The machine's load only adds time, so the fastest run is the one held to the target; the median shows the spread.
function gatedEditMs(t, v, notes, runs) {
  const times = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    const out = editFile(v, sessionId(), GATED);
    times.push(performance.now() - start);
    assert.ok(denied(out), 'the edit is gated');
  }
  times.sort((a, b) => a - b);
  t.diagnostic(`gated edit, ${notes} notes: fastest ${Math.round(times[0])} ms, median ${Math.round(times[Math.floor(runs / 2)])} ms of ${runs}`);
  return times[0];
}

test('a gated edit takes under 1,000 ms at 1,000 notes', perf, t => {
  const ms = gatedEditMs(t, shared(1000), '1,000', 5);
  assert.ok(ms < 1000, `${Math.round(ms)} ms`);
});

test('a gated edit takes under 300 ms at 3,000 notes', perf, t => {
  const ms = gatedEditMs(t, shared(3000), '3,000', 3);
  assert.ok(ms < 300, `${Math.round(ms)} ms`);
});

test('an AskUserQuestion call takes under 300 ms at 3,000 notes', perf, t => {
  const v = shared(3000);
  const times = [];
  for (let i = 0; i < 3; i++) {
    const start = performance.now();
    const out = v.edit(sessionId(), 'AskUserQuestion', { questions: [{ question: 'Which layout?', header: 'Layout', multiSelect: false, options: [{ label: 'Grid' }, { label: 'Shelf' }] }] });
    times.push(performance.now() - start);
    assert.ok(denied(out), 'the call is gated');
  }
  times.sort((a, b) => a - b);
  t.diagnostic(`AskUserQuestion call, 3,000 notes: fastest ${Math.round(times[0])} ms, median ${Math.round(times[1])} ms of 3`);
  assert.ok(times[0] < 300, `${Math.round(times[0])} ms`);
});

test('three parallel proposes at 3,000 notes all succeed', perf, async t => {
  const v = shared(3000);
  const start = performance.now();
  const results = await proposeAtOnce(v, unrelatedRules('ui', `parallel-${Date.now()}`), { timeout: 120e3 });
  t.diagnostic(`3 proposes in ${Math.round(performance.now() - start)} ms`);
  assert.deepEqual(results.filter(r => r.code !== 0).map(r => `exit ${r.code ?? r.signal}: ${r.stderr.trim().split(/\r?\n/)[0]}`), []);
});

test('a session start with 2,000 open review queue entries takes under 500 ms', perf, t => {
  const v = makeVault(t);
  const rows = Array.from({ length: 2000 }, (_, i) => {
    const n = String(i).padStart(8, '0');
    return JSON.stringify({ id: `u-${n}`, at: '2026-11-01T10:00:00.000Z', kind: 'rule', why: 'ignored', unattended: i % 4 ? null : 'left', from: `o-${n}`, session: '1a2b3c4d-0000', agent: 'claude-code', domain: 'glim', key: `glim/r-${n}` });
  });
  v.write('raw/queue/2026-11-01-1a2b3c4d.jsonl', `${rows.join('\n')}\n`);
  const times = [];
  for (let i = 0; i < 3; i++) {
    const start = performance.now();
    const out = v.startSession(sessionId());
    times.push(performance.now() - start);
    assert.match(out.systemMessage, / · queue 2000 \(500 unattended\)$/);
  }
  times.sort((a, b) => a - b);
  t.diagnostic(`session start, 2,000 queue entries: fastest ${Math.round(times[0])} ms, median ${Math.round(times[1])} ms of 3`);
  assert.ok(times[0] < 500, `${Math.round(times[0])} ms`);
});
