import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeVault, ruleNote, pageNote, sessionId, prompt } from './fixture.mjs';

// The status line the user sees at session start, /vault status, and folders the user keeps quiet.
const context = out => out?.hookSpecificOutput?.additionalContext ?? '';
const posix = p => String(p).replace(/\\/g, '/');

function folder(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function filled(t) {
  const v = makeVault(t);
  v.write('wiki/glim/rules/brief.md', ruleNote({ always: true, doLine: 'Be brief.', notLine: 'Ramble.' }));
  v.write('wiki/glim/rules/prism.md', ruleNote({ keywords: ['prism'], doLine: 'Bend light.', notLine: 'Block it.' }));
  v.write('wiki/global/rules/plain.md', ruleNote({ domain: 'global', keywords: ['plain'], doLine: 'Write plainly.', notLine: 'Ornament.' }));
  v.write('wiki/glim/topics/code.md', pageNote({ keywords: ['quartz'] }));
  return v;
}

test("a session start shows the user one line: the domains, the rules and pages that reach it, and the proposals mode", t => {
  const v = filled(t);
  const out = v.startSession(sessionId());
  assert.equal(out.systemMessage, 'vault: glim · 3 rules (1 always) · 1 page · proposals: corrections');
  assert.doesNotMatch(context(out), /vault: glim/, "the agent's context doesn't carry the line");
});

test('a start no domain reaches counts the global rules, and domains with their own mode are named', t => {
  const v = filled(t);
  const dir = folder(t, 'vault-status-');
  assert.equal(v.startSession(sessionId(), { cwd: dir }).systemMessage, 'vault: no domain here · 1 global rule · proposals: corrections');
  const config = JSON.parse(v.read('vault.config.json'));
  config.domains.glim.proposals = 'off';
  v.write('vault.config.json', JSON.stringify(config));
  assert.match(v.startSession(sessionId()).systemMessage, /proposals: global corrections, glim off$/);
  assert.equal(v.startSession(sessionId(), { cwd: v.root }).systemMessage, 'vault: vault folder, every domain · 3 rules (1 always) · 1 page · proposals: corrections');
});

test('a compact or clear start shows no line, since the session already saw it', t => {
  const v = filled(t);
  const sid = sessionId();
  v.startSession(sid);
  for (const source of ['compact', 'clear']) assert.equal(v.startSession(sid, { source })?.systemMessage, undefined);
});

test('a quiet folder keeps the offer to propose to global and drops the domain pitch', t => {
  const v = makeVault(t, { quiet: [`${posix(os.tmpdir())}/vault-quiet-*`] });
  const quiet = folder(t, 'vault-quiet-');
  const loud = folder(t, 'vault-loud-');
  const hushed = context(v.startSession(sessionId(), { cwd: quiet }));
  assert.match(hushed, /Taste vault: this folder is in no domain\./);
  assert.match(hushed, /`global`/);
  assert.doesNotMatch(hushed, /suggest a domain|domain\.mjs/);
  assert.match(context(v.startSession(sessionId(), { cwd: loud })), /suggest a domain to the user/);
});

test('lint reports a quiet entry that is no glob over an absolute path', t => {
  const v = makeVault(t, { quiet: ['scratch/**'] });
  assert.match(v.run('lint.mjs').stdout, /quiet must be a list of globs over absolute folder paths/);
});

test('status.mjs prints the line and what the session was shown', t => {
  const v = filled(t);
  const sid = sessionId();
  v.startSession(sid);
  assert.equal(v.run('status.mjs', [sid]).stdout.split('\n')[1], 'shown this session: 1 rule, glim/brief');
  prompt(v, sid, 'make the prism and the quartz plain');
  const r = v.run('status.mjs', [sid]);
  assert.equal(r.code, 0, r.stderr);
  const [line, shown] = r.stdout.trim().split('\n');
  assert.equal(line, 'vault: glim · 3 rules (1 always) · 1 page · proposals: corrections');
  assert.match(shown, /^shown this session: 3 rules, glim\/brief, glim\/prism and global\/plain; 1 page, glim\/code$/);
  assert.equal(v.run('status.mjs', ['no-such-session']).code, 1);
});
