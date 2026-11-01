import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { makeVault, sessionId } from './fixture.mjs';

const DAY = 864e5;

test('a hook that throws prints one line, logs the error and exits 1', t => {
  const v = makeVault(t);
  v.write('vault.config.json', '{ not json');
  const r = v.run('hooks/session-start.mjs', [], { input: { session_id: sessionId(), cwd: v.project, source: 'startup' } });
  assert.equal(r.code, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /^vault session-start failed: [^\n]+; see \.state\/errors\.log\n$/);
  assert.match(v.read('.state/errors.log'), /session-start: SyntaxError/);
});

test('release removes only the lock its own call took', async t => {
  const v = makeVault(t);
  const { withLock } = await v.import('lib/vault.mjs');
  const file = v.at('.state', 'x.lock');
  fs.mkdirSync(v.at('.state'), { recursive: true });
  withLock(file, () => fs.writeFileSync(file, '99999999:someone-else'));
  assert.equal(fs.readFileSync(file, 'utf8'), '99999999:someone-else');
  fs.rmSync(file);
  withLock(file, () => {});
  assert.equal(fs.existsSync(file), false, 'its own lock is removed');
});

test('a lock held by a live process is not taken, however old, and one left by a dead process is', async t => {
  const v = makeVault(t);
  const { withLock } = await v.import('lib/vault.mjs');
  const file = v.at('.state', 'y.lock');
  fs.mkdirSync(v.at('.state'), { recursive: true });
  const mine = `${process.pid}:held`;
  fs.writeFileSync(file, mine);
  const old = new Date(Date.now() - 60e3);
  fs.utimesSync(file, old, old);
  assert.throws(() => withLock(file, () => {}, { waitMs: 200 }), /held by another process/);
  assert.equal(fs.readFileSync(file, 'utf8'), mine, 'the live holder keeps its lock');

  const dead = spawnSync(process.execPath, ['-e', ''], {}).pid;
  fs.writeFileSync(file, `${dead}:gone`);
  assert.equal(withLock(file, () => 'ran', { waitMs: 2000 }), 'ran');
});

const oldSession = (v, id, markers) => {
  for (let i = 0; i < markers; i++) v.write(`.state/gate/${id}/m${i}`, 'x');
  const old = new Date(Date.now() - 40 * DAY);
  fs.utimesSync(v.at('.state', 'gate', id), old, old);
};
const left = (v, ids) => ids.reduce((n, id) => n + (v.exists(`.state/gate/${id}`) ? fs.readdirSync(v.at('.state', 'gate', id)).length : 0), 0);

test('session start tidies at most delivery.tidyMaxMarkers markers a run, and /lint tidies the rest', t => {
  const v = makeVault(t, { config: { delivery: { tidyMaxMarkers: 5 } } });
  const ids = ['s1', 's2', 's3', 's4'];
  for (const id of ids) oldSession(v, id, 4);
  assert.equal(left(v, ids), 16);
  v.startSession(sessionId());
  const after = left(v, ids);
  assert.ok(after < 16 && after >= 11, `${16 - after} markers removed`);
  v.startSession(sessionId());
  assert.ok(left(v, ids) < after, 'the next session start carries on');
  for (let i = 0; i < 4 && left(v, ids); i++) v.startSession(sessionId());
  assert.equal(left(v, ids), 0, 'a few runs clear the backlog');

  for (const id of ['s5', 's6']) oldSession(v, id, 12);
  const r = v.run('review.mjs', ['status']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(left(v, ['s5', 's6']), 0, '/lint removes them all in one run');
});
