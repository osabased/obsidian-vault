import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { makeVault, ruleNote, pageNote, sessionId, cleanEnv, denied, editFile as edit, prompt, lintFound } from './fixture.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const context = out => out?.hookSpecificOutput?.additionalContext ?? '';

function hookIn(root, name, input, env = {}) {
  const r = spawnSync(process.execPath, [path.join(root, 'tools', 'hooks', `${name}.mjs`)], { input: JSON.stringify(input), env: cleanEnv(env), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const log = path.join(root, '.state', 'errors.log');
  assert.ok(!fs.existsSync(log), fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '');
  return r.stdout.trim() ? JSON.parse(r.stdout) : null;
}

test('6.6d: on a fresh clone with an empty .state/, every committed note applies at once', t => {
  const v = makeVault(t, { presets: ['glim'] });
  v.write('wiki/glim/concepts/quartz.md', pageNote({ kind: 'concept', keywords: ['quartz'] }));
  v.write('wiki/glim/topics/layout.md', pageNote({ topic: 'layout', keywords: ['prism'] }));
  v.checkout();
  const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-clone-'));
  t.after(() => fs.rmSync(clone, { recursive: true, force: true }));
  execFileSync('git', ['clone', '-q', v.root, clone], { env: cleanEnv({ GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }), stdio: 'pipe' });
  assert.ok(!fs.existsSync(path.join(clone, '.state')));

  const sid = sessionId();
  const start = hookIn(clone, 'session-start', { session_id: sid, cwd: v.project, hook_event_name: 'SessionStart', source: 'startup' });
  assert.match(context(start), /glim\/always-rule: Do: Open each glim file with a purpose line\./);
  const gated = hookIn(clone, 'edit', { session_id: sid, cwd: v.project, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(v.project, 'src', 'a.zq'), old_string: 'a', new_string: 'set x to 1' } });
  assert.match(denied(gated), /glim\/zq-trigger: Do: Set values through a named step\./);
  assert.match(denied(gated), /glim\/zq-files \(concept page\)/);
  const said = context(hookIn(clone, 'prompt', { session_id: sid, cwd: v.project, hook_event_name: 'UserPromptSubmit', prompt: 'the shimmer, the quartz and the prism' }));
  assert.match(said, /glim\/keyword-rule: Do: Fade a shimmer in over two frames\./);
  assert.match(said, /glim\/quartz \(concept page\)/);
  assert.match(said, /glim\/layout \(topic page\)/);
});

test('6.6d: a note dated in the future is delivered once its text has held for settleSeconds, and lint warns on it', async t => {
  const v = makeVault(t, { presets: ['glim'], config: { delivery: { settleSeconds: 1 } } });
  const rel = 'wiki/glim/rules/keyword-rule.md';
  v.write(rel, v.read(rel), { saved: new Date(Date.now() + 86400e3) });
  const sid = sessionId();
  v.startSession(sid);
  assert.equal(prompt(v, sid, 'the shimmer'), null, 'its text has only just been seen');
  await sleep(1500);
  assert.match(context(prompt(v, sid, 'the shimmer')), /glim\/keyword-rule: Do: Fade a shimmer in over two frames\./);
  assert.equal((await lintFound(v, /in the future, so the hooks wait until its text has gone 1 second unchanged/)).length, 1);
});

test('a note saved again with new text waits for settleSeconds, however old its last text was', async t => {
  const v = makeVault(t, { config: { delivery: { settleSeconds: 1 } } });
  v.write('wiki/glim/rules/word.md', ruleNote({ keywords: ['zebra'], doLine: 'Mind the zebra.' }));
  assert.match(context(prompt(v, sessionId(), 'the zebra')), /Mind the zebra\./);
  v.write('wiki/glim/rules/word.md', ruleNote({ keywords: ['zebra'], doLine: 'Feed the zebra.' }), { settled: false });
  assert.equal(prompt(v, sessionId(), 'the zebra'), null);
  await sleep(1500);
  assert.match(context(prompt(v, sessionId(), 'the zebra')), /Feed the zebra\./);
});

test("the hooks walk only the session's domains and wiki/global/", t => {
  const v = makeVault(t, { domains: { other: { title: 'Other', markers: ['other.project'] } } });
  v.write('wiki/glim/rules/gate.md', ruleNote({ applies_to: ['src/**'] }));
  v.write('wiki/global/rules/word.md', ruleNote({ domain: 'global', keywords: ['zebra'] }));
  v.write('wiki/other/rules/far.md', ruleNote({ domain: 'other', applies_to: ['**'] }));
  const cached = () => (fs.existsSync(v.at('.state', 'cache')) ? fs.readdirSync(v.at('.state', 'cache')).sort() : []);
  assert.ok(denied(edit(v, sessionId(), 'src/a.txt')));
  const sid = sessionId();
  prompt(v, sid, 'the zebra');
  assert.deepEqual(cached(), ['glim.json', 'global.json']);
  // The first session start builds, which reads every note; the next, with nothing changed, walks its own domains.
  v.startSession(sessionId());
  fs.rmSync(v.at('.state', 'cache', 'other.json'));
  v.startSession(sessionId());
  assert.deepEqual(cached(), ['.built.json', 'glim.json', 'global.json']);
});

test('session start builds only when a note changed since the last build', t => {
  const v = makeVault(t);
  v.write('wiki/glim/rules/word.md', ruleNote({ keywords: ['zebra'], doLine: 'Mind the zebra.' }));
  v.startSession(sessionId());
  assert.match(v.read('index.md'), /Mind the zebra|glim\/word|word/);
  fs.rmSync(v.at('index.md'));
  v.startSession(sessionId());
  assert.ok(!v.exists('index.md'), 'nothing changed, so nothing was built');
  v.write('wiki/glim/rules/word.md', ruleNote({ keywords: ['zebra'], doLine: 'Feed the zebra.' }));
  v.startSession(sessionId());
  assert.ok(v.exists('index.md'), 'a changed note builds again');
  fs.rmSync(v.at('index.md'));
  fs.rmSync(v.at('wiki', 'glim', 'rules', 'word.md'));
  v.startSession(sessionId());
  assert.ok(v.exists('index.md'), 'a deleted note builds again');
});

test('a hook past its deadline stops and logs why', t => {
  const v = makeVault(t);
  v.write('wiki/glim/rules/gate.md', ruleNote({ applies_to: ['src/**'] }));
  const r = v.run('hooks/edit.mjs', [], {
    input: { session_id: sessionId(), cwd: v.project, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(v.project, 'src', 'a.txt'), old_string: 'a', new_string: 'b' } },
    cwd: v.project, env: { VAULT_HOOK_TIMEOUT: '0.001' },
  });
  assert.equal(r.code, 1);
  assert.equal(r.stderr, 'vault edit failed: stopped at its deadline, 0.0002 s before the 0.001 s hook timeout; see .state/errors.log\n');
  assert.match(v.read('.state/errors.log'), /edit: Error: stopped at its deadline, 0\.0002 s before the 0\.001 s hook timeout/);
});

test('lint refuses node:child_process anywhere but lib/git.mjs', async t => {
  const v = makeVault(t);
  v.write('tools/lib/runner.mjs', "import { execFileSync } from 'node:child_process';\nexport const run = () => execFileSync('ls');\n");
  const { lint } = await v.import('lib/lint.mjs');
  const found = lint().filter(f => f.file.startsWith('tools/') && /child_process/.test(f.msg));
  assert.deepEqual(found.map(f => [f.file, f.msg]), [['tools/lib/runner.mjs', 'imports node:child_process; only lib/git.mjs runs another program, git status']]);
});

test('guarded rethrows a deadline error, and git stops at the time left', async t => {
  const v = makeVault(t);
  v.checkout();
  const { guarded } = await v.import('lib/vault.mjs');
  const { armDeadline, checkDeadline, remaining } = await v.import('lib/deadline.mjs');
  const { changedFiles } = await v.import('lib/git.mjs');
  assert.equal(remaining(), Infinity, 'an unarmed process has no deadline');
  assert.equal(guarded('x', () => { throw new Error('plain'); }, 'fell back'), 'fell back');
  const env = process.env.VAULT_HOOK_TIMEOUT;
  process.env.VAULT_HOOK_TIMEOUT = '0.001';
  try {
    armDeadline();
    assert.ok(remaining() <= 0);
    assert.throws(() => guarded('x', checkDeadline, 'fell back'), /stopped at its deadline/);
    assert.throws(() => changedFiles(v.root), /stopped at its deadline/);
  } finally {
    if (env === undefined) delete process.env.VAULT_HOOK_TIMEOUT; else process.env.VAULT_HOOK_TIMEOUT = env;
  }
});

test('a domain named built keeps its cache apart from the build record', t => {
  const v = makeVault(t, { domain: 'built' });
  v.write('wiki/built/rules/word.md', ruleNote({ domain: 'built', keywords: ['zebra'] }));
  v.startSession(sessionId());
  fs.rmSync(v.at('index.md'));
  v.startSession(sessionId());
  assert.ok(!v.exists('index.md'), 'nothing changed, so nothing was built');
});

test('a domain folder stored NFD is walked by its NFC name in vault.config.json', async t => {
  const name = 'café';
  const v = makeVault(t, { domain: name });
  v.write(`wiki/${name.normalize('NFD')}/rules/word.md`, ruleNote({ domain: name, keywords: ['zebra'] }));
  const { loadNotes } = await v.import('lib/rules.mjs');
  assert.deepEqual(loadNotes([name]).map(n => n.key), [`${name}/word`]);
  assert.deepEqual(loadNotes().map(n => n.key), [`${name}/word`]);
  assert.equal(fs.readdirSync(v.at('.state', 'cache')).length, 1, 'the scoped and the full walk share one cache file');
});

test('a note dated in the future is read once, not on every call', async t => {
  const v = makeVault(t);
  v.write('wiki/glim/rules/word.md', ruleNote({ keywords: ['zebra'] }), { saved: new Date(Date.now() + 3600e3) });
  const { loadNotes } = await v.import('lib/rules.mjs');
  loadNotes();
  const before = v.read('.state/cache/glim.json');
  await sleep(20);
  loadNotes();
  assert.equal(v.read('.state/cache/glim.json'), before);
});

test('a cache that cannot be written leaves the hooks working, and is logged once', t => {
  const v = makeVault(t);
  v.write('wiki/glim/rules/gate.md', ruleNote({ applies_to: ['src/**'], doLine: 'Gate it.' }));
  v.write('wiki/global/rules/word.md', ruleNote({ domain: 'global', keywords: ['zebra'] }));
  for (const b of ['glim', 'global']) fs.mkdirSync(v.at('.state', 'cache', `${b}.json`), { recursive: true });
  const r = v.run('hooks/edit.mjs', [], {
    input: { session_id: sessionId(), cwd: v.project, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(v.project, 'src', 'a.txt'), old_string: 'a', new_string: 'b' } },
    cwd: v.project,
  });
  assert.equal(r.code, 0, r.stderr);
  assert.match(denied(JSON.parse(r.stdout)), /glim\/gate: Do: Gate it\./);
  assert.equal(v.read('.state/errors.log').match(/^\S+ note cache: /gm).length, 1);
});

test('a note that cannot be read for a moment keeps its last entry, and a note never read fails the call', async t => {
  const v = makeVault(t);
  v.write('wiki/glim/rules/a.md', ruleNote({ keywords: ['x'], doLine: 'Do a.' }));
  v.write('wiki/glim/rules/b.md', ruleNote({ keywords: ['y'], doLine: 'Do b.' }));
  const { loadNotes } = await v.import('lib/rules.mjs');
  const seen = loadNotes().find(n => n.key === 'glim/b').seen;
  const halfHourAgo = new Date(Date.now() - 1800e3);
  fs.utimesSync(v.at('wiki', 'glim', 'rules', 'b.md'), halfHourAgo, halfHourAgo);
  v.write('wiki/glim/rules/c.md', ruleNote({ keywords: ['z'], doLine: 'Do c.' }));
  const read = fs.readFileSync;
  const busy = new Set(['b.md', 'c.md']);
  t.mock.method(fs, 'readFileSync', function (p, ...rest) {
    if (busy.has(path.basename(String(p)))) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    return read.call(this, p, ...rest);
  });
  assert.throws(() => loadNotes(), { code: 'EBUSY' });
  busy.delete('c.md');
  const notes = loadNotes();
  assert.deepEqual(notes.map(n => n.key), ['glim/a', 'glim/b', 'glim/c']);
  assert.equal(notes.find(n => n.key === 'glim/b').seen, seen);
});

test('a walk stopped at the deadline keeps the notes it read', async t => {
  const v = makeVault(t);
  for (let i = 0; i < 5; i++) v.write(`wiki/glim/rules/r${i}.md`, ruleNote({ keywords: [`k${i}`], doLine: `Do ${i}.` }));
  const { cachedNotes } = await v.import('lib/cache.mjs');
  const { armDeadline } = await v.import('lib/deadline.mjs');
  const given = process.env.VAULT_HOOK_TIMEOUT;
  process.env.VAULT_HOOK_TIMEOUT = '0.001';
  t.after(() => { if (given === undefined) delete process.env.VAULT_HOOK_TIMEOUT; else process.env.VAULT_HOOK_TIMEOUT = given; });
  let reads = 0;
  // The third read arms the deadline, which has long passed, so the walk stops at the fourth note.
  const read = () => { if (++reads === 3) armDeadline(); return {}; };
  assert.throws(() => cachedNotes(['glim'], read, 'stamp'), /stopped at its deadline/);
  assert.equal(Object.keys(JSON.parse(v.read('.state/cache/glim.json')).notes).length, 3);
});

test('a change to cache.mjs reads every note again', t => {
  const v = makeVault(t);
  v.write('wiki/glim/rules/word.md', ruleNote({ keywords: ['zebra'] }));
  const stamp = () => JSON.parse(v.read('.state/cache/glim.json')).stamp;
  prompt(v, sessionId(), 'the zebra');
  const before = stamp();
  fs.appendFileSync(v.at('tools', 'lib', 'cache.mjs'), '\n// another shape\n');
  prompt(v, sessionId(), 'the zebra');
  assert.notEqual(stamp(), before);
});

test('session start builds when vault.config.json changed, and not after another tool built', t => {
  const v = makeVault(t);
  v.write('wiki/glim/rules/word.md', ruleNote({ keywords: ['zebra'] }));
  v.startSession(sessionId());
  const cfg = JSON.parse(v.read('vault.config.json'));
  cfg.domains.glim.title = 'Renamed';
  cfg.domains.more = { title: 'More', topics: ['x'] };
  v.write('vault.config.json', JSON.stringify(cfg, null, 2));
  v.startSession(sessionId());
  const check = v.run('build.mjs', ['--check']);
  assert.equal(check.code, 0, check.stdout + check.stderr);

  v.write('wiki/glim/rules/other.md', ruleNote({ keywords: ['okapi'], doLine: 'Mind the okapi.' }));
  assert.equal(v.run('build.mjs').code, 0);
  fs.rmSync(v.at('index.md'));
  v.startSession(sessionId());
  assert.ok(!v.exists('index.md'), 'build.mjs recorded its build');
});

test('a build waits for one already running, and session start skips its build rather than wait long', async t => {
  const v = makeVault(t);
  v.write('wiki/glim/rules/word.md', ruleNote({ keywords: ['zebra'] }));
  fs.mkdirSync(v.at('.state'), { recursive: true });
  fs.writeFileSync(v.at('.state', 'build.lock'), `${process.pid}:0123456789ab`);
  const { build } = await v.import('lib/build.mjs');
  assert.throws(() => build({ waitMs: 100 }), e => e.code === 'ELOCKED' && /build\.lock is held by another process/.test(e.message));
  v.startSession(sessionId());
  assert.ok(!v.exists('index.md'));
  fs.rmSync(v.at('.state', 'build.lock'));
  v.startSession(sessionId());
  assert.ok(v.exists('index.md'), 'the next start builds');
});
