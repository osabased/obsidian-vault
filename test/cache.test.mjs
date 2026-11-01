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

test('on a fresh clone with an empty .state/, every committed note applies at once', t => {
  const v = makeVault(t);
  v.write('wiki/demo/rules/brief.md', ruleNote({ always: true, doLine: 'Be brief.', notLine: 'Ramble.' }));
  v.write('wiki/demo/rules/gate.md', ruleNote({ applies_to: ['src/**/*.txt'], doLine: 'Gate it.' }));
  v.write('wiki/demo/rules/word.md', ruleNote({ keywords: ['zebra'], doLine: 'Mind the zebra.' }));
  v.write('wiki/demo/topics/code.md', pageNote({ keywords: ['quartz'] }));
  v.checkout();
  const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-clone-'));
  t.after(() => fs.rmSync(clone, { recursive: true, force: true }));
  execFileSync('git', ['clone', '-q', v.root, clone], { env: cleanEnv({ GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }), stdio: 'pipe' });
  assert.ok(!fs.existsSync(path.join(clone, '.state')));

  const sid = sessionId();
  const start = hookIn(clone, 'session-start', { session_id: sid, cwd: v.project, hook_event_name: 'SessionStart', source: 'startup' });
  assert.match(context(start), /demo\/brief: Do: Be brief\./);
  const gated = hookIn(clone, 'edit', { session_id: sid, cwd: v.project, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(v.project, 'src', 'a.txt'), old_string: 'a', new_string: 'b' } });
  assert.match(denied(gated), /demo\/gate: Do: Gate it\./);
  const said = context(hookIn(clone, 'prompt', { session_id: sid, cwd: v.project, hook_event_name: 'UserPromptSubmit', prompt: 'the zebra and the quartz' }));
  assert.match(said, /demo\/word: Do: Mind the zebra\./);
  assert.match(said, /demo\/code \(topic page\)/);
});

test('a note dated in the future is delivered once its text has held for settleSeconds, and lint warns on it', async t => {
  const v = makeVault(t, { config: { delivery: { settleSeconds: 1 } } });
  v.write('wiki/demo/rules/word.md', ruleNote({ keywords: ['zebra'], doLine: 'Mind the zebra.' }), { saved: new Date(Date.now() + 86400e3) });
  assert.equal(prompt(v, sessionId(), 'the zebra'), null, 'its text has only just been seen');
  await sleep(1500);
  assert.match(context(prompt(v, sessionId(), 'the zebra')), /demo\/word: Do: Mind the zebra\./);
  assert.equal((await lintFound(v, /in the future, so the hooks wait until its text has gone 1 second unchanged/)).length, 1);
});

test('a note saved again with new text waits for settleSeconds, however old its last text was', async t => {
  const v = makeVault(t, { config: { delivery: { settleSeconds: 1 } } });
  v.write('wiki/demo/rules/word.md', ruleNote({ keywords: ['zebra'], doLine: 'Mind the zebra.' }));
  assert.match(context(prompt(v, sessionId(), 'the zebra')), /Mind the zebra\./);
  v.write('wiki/demo/rules/word.md', ruleNote({ keywords: ['zebra'], doLine: 'Feed the zebra.' }), { settled: false });
  assert.equal(prompt(v, sessionId(), 'the zebra'), null);
  await sleep(1500);
  assert.match(context(prompt(v, sessionId(), 'the zebra')), /Feed the zebra\./);
});

test("the hooks walk only the session's domains and wiki/global/", t => {
  const v = makeVault(t, { domains: { other: { title: 'Other', markers: ['other.project'] } } });
  v.write('wiki/demo/rules/gate.md', ruleNote({ applies_to: ['src/**'] }));
  v.write('wiki/global/rules/word.md', ruleNote({ domain: 'global', keywords: ['zebra'] }));
  v.write('wiki/other/rules/far.md', ruleNote({ domain: 'other', applies_to: ['**'] }));
  const cached = () => (fs.existsSync(v.at('.state', 'cache')) ? fs.readdirSync(v.at('.state', 'cache')).sort() : []);
  assert.ok(denied(edit(v, sessionId(), 'src/a.txt')));
  const sid = sessionId();
  prompt(v, sid, 'the zebra');
  assert.deepEqual(cached(), ['demo.json', 'global.json']);
  // The first session start builds, which reads every note; the next, with nothing changed, walks its own domains.
  v.startSession(sessionId());
  fs.rmSync(v.at('.state', 'cache', 'other.json'));
  v.startSession(sessionId());
  assert.deepEqual(cached(), ['built.json', 'demo.json', 'global.json']);
});

test('session start builds only when a note changed since the last build', t => {
  const v = makeVault(t);
  v.write('wiki/demo/rules/word.md', ruleNote({ keywords: ['zebra'], doLine: 'Mind the zebra.' }));
  v.startSession(sessionId());
  assert.match(v.read('index.md'), /Mind the zebra|demo\/word|word/);
  fs.rmSync(v.at('index.md'));
  v.startSession(sessionId());
  assert.ok(!v.exists('index.md'), 'nothing changed, so nothing was built');
  v.write('wiki/demo/rules/word.md', ruleNote({ keywords: ['zebra'], doLine: 'Feed the zebra.' }));
  v.startSession(sessionId());
  assert.ok(v.exists('index.md'), 'a changed note builds again');
  fs.rmSync(v.at('index.md'));
  fs.rmSync(v.at('wiki', 'demo', 'rules', 'word.md'));
  v.startSession(sessionId());
  assert.ok(v.exists('index.md'), 'a deleted note builds again');
});

test('a hook past its deadline stops and logs why', t => {
  const v = makeVault(t);
  v.write('wiki/demo/rules/gate.md', ruleNote({ applies_to: ['src/**'] }));
  v.run('hooks/edit.mjs', [], {
    input: { session_id: sessionId(), cwd: v.project, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(v.project, 'src', 'a.txt'), old_string: 'a', new_string: 'b' } },
    cwd: v.project, env: { VAULT_HOOK_TIMEOUT: '0.001' },
  });
  assert.match(v.read('.state/errors.log'), /edit: Error: stopped at its deadline, 0\.0002 s before the 0\.001 s hook timeout/);
});

test('lint refuses node:child_process anywhere but lib/git.mjs', async t => {
  const v = makeVault(t);
  v.write('tools/lib/runner.mjs', "import { execFileSync } from 'node:child_process';\nexport const run = () => execFileSync('ls');\n");
  const { lint } = await v.import('lib/lint.mjs');
  const found = lint().filter(f => f.file.startsWith('tools/') && /child_process/.test(f.msg));
  assert.deepEqual(found.map(f => [f.file, f.msg]), [['tools/lib/runner.mjs', 'imports node:child_process; only lib/git.mjs runs another program, git status']]);
});
