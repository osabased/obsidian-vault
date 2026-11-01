import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeVault, ruleNote, sessionId, editFile, prompt, denied, cleanEnv } from './fixture.mjs';

const withTriggers = (text, ...res) => text.replace('triggers: []', `triggers:\n${res.map(r => `  - '${r}'`).join('\n')}`);

// The user's git config stays out, as in the fixture's checkout(), so a hooks path or template there can't fail the commit.
function gitProject(v) {
  const env = cleanEnv({ GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: v.project, env, stdio: 'pipe' });
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'start');
}

const write = (v, rel, text, saved) => {
  const file = path.join(v.project, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  if (saved) fs.utimesSync(file, saved, saved);
  return file;
};

const stop = (v, sid, active = false) => v.hook('stop', { session_id: sid, cwd: v.project, hook_event_name: 'Stop', stop_hook_active: active });
const context = out => out?.hookSpecificOutput?.additionalContext ?? null;

test('a rule-covered file a shell command wrote this turn gets that rule once as Stop additionalContext', t => {
  const v = makeVault(t);
  gitProject(v);
  v.write('wiki/demo/rules/ui-rule.md', ruleNote({ applies_to: ['src/**/*.txt'], doLine: 'Start with strict.', notLine: 'Leave nonstrict.' }));
  const sid = sessionId();
  v.startSession(sid);
  prompt(v, sid, 'write the file with a script');
  write(v, 'src/a.txt', 'hello');
  write(v, 'notes.md', 'no rule covers this');
  const out = stop(v, sid);
  assert.equal(out.hookSpecificOutput.hookEventName, 'Stop');
  assert.equal(out.decision, undefined, 'the turn continues without a block');
  assert.equal(context(out), [
    'Taste rules apply to a file this turn wrote. Re-read the change against them before you stop.',
    'src/a.txt:',
    '- demo/ui-rule: Do: Start with strict. Not: Leave nonstrict.',
  ].join('\n'));
  assert.equal(stop(v, sid, true), null, 'the next stop passes');
  assert.equal(editFile(v, sid, 'src/a.txt'), null, 'a later edit of the file is not refused with the rule again');
});

test('files changed before the turn started are left to the user', t => {
  const v = makeVault(t);
  gitProject(v);
  v.write('wiki/demo/rules/ui-rule.md', ruleNote({ applies_to: ['src/**/*.txt'] }));
  const sid = sessionId();
  v.startSession(sid);
  write(v, 'src/a.txt', 'saved earlier', new Date(Date.now() - 60e3));
  prompt(v, sid, 'look around');
  assert.equal(stop(v, sid), null);
});

test('a file written through the gated Edit path is not taken for a shell write', t => {
  const v = makeVault(t);
  gitProject(v);
  v.write('wiki/demo/rules/ui-rule.md', ruleNote({ applies_to: ['src/**/*.txt'] }));
  // Its trigger misses the edit's new text but matches the file, so only the record of the edit keeps it out.
  v.write('wiki/demo/rules/todo-rule.md', withTriggers(ruleNote({ applies_to: ['src/**/*.txt'], doLine: 'Track work in issues.' }), 'TODO'));
  const sid = sessionId();
  v.startSession(sid);
  prompt(v, sid, 'edit the file');
  assert.ok(denied(editFile(v, sid, 'src/a.txt')));
  assert.equal(editFile(v, sid, 'src/a.txt'), null);
  write(v, 'src/a.txt', 'local x = 1\n-- TODO later\n');
  assert.equal(stop(v, sid), null);
});

test('a project that is not a git repository gets no Stop output', t => {
  const v = makeVault(t);
  v.write('wiki/demo/rules/ui-rule.md', ruleNote({ applies_to: ['src/**/*.txt'] }));
  const sid = sessionId();
  v.startSession(sid);
  prompt(v, sid, 'write the file with a script');
  write(v, 'src/a.txt', 'hello');
  assert.equal(stop(v, sid), null);
});

test('a shell-written file fires a rule by its triggers against the file as it is now', t => {
  const v = makeVault(t);
  gitProject(v);
  v.write('wiki/demo/rules/todo-rule.md', withTriggers(ruleNote({ applies_to: ['src/**/*.txt'], doLine: 'Track work in issues.' }), 'TODO'));
  const sid = sessionId();
  v.startSession(sid);
  prompt(v, sid, 'write files with a script');
  write(v, 'src/clean.txt', 'nothing to see');
  write(v, 'src/todo.txt', '-- TODO later');
  const ctx = context(stop(v, sid)) ?? '';
  assert.match(ctx, /^src\/todo\.txt:\n- demo\/todo-rule: Do: Track work in issues\./m);
  assert.doesNotMatch(ctx, /clean\.txt/);
});

test('a file a subagent wrote through the gated Edit path is not taken for a shell write at the parent\'s stop', t => {
  const v = makeVault(t);
  gitProject(v);
  v.write('wiki/demo/rules/ui-rule.md', ruleNote({ applies_to: ['src/**/*.txt'] }));
  const sid = sessionId();
  v.startSession(sid);
  prompt(v, sid, 'have a subagent edit the file');
  assert.ok(denied(editFile(v, sid, 'src/a.txt', { agent: 'agent-1' })));
  assert.equal(editFile(v, sid, 'src/a.txt', { agent: 'agent-1' }), null);
  write(v, 'src/a.txt', 'local x = 1');
  assert.equal(stop(v, sid), null);
});
