import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeVault, ruleNote, pageNote, sessionId, prompt, editFile, userTurn } from './fixture.mjs';

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
  // No keyword or glob brings this page up, so no session gets it.
  v.write('wiki/glim/concepts/quiet-page.md', pageNote({ kind: 'concept' }));
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
  assert.equal(v.startSession(sessionId(), { cwd: v.root }).systemMessage, 'vault: vault folder · 1 global rule · 1 page (every domain) · proposals: ask', "glim's rules don't reach the vault folder, its pages do");
});

test("an everywhere domain's keyword rules count where they reach, and its always rules don't", t => {
  const v = filled(t);
  const config = JSON.parse(v.read('vault.config.json'));
  config.domains.wide = { title: 'Wide', topics: ['code'], everywhere: true };
  v.write('vault.config.json', JSON.stringify(config));
  v.write('wiki/wide/rules/terse.md', ruleNote({ domain: 'wide', keywords: ['terse'], doLine: 'Be terse.', notLine: 'Pad.' }));
  v.write('wiki/wide/rules/calm.md', ruleNote({ domain: 'wide', always: true, doLine: 'Stay calm.', notLine: 'Panic.' }));
  const dir = folder(t, 'vault-status-');
  assert.match(v.startSession(sessionId(), { cwd: dir }).systemMessage, /^vault: no domain here · 2 rules · proposals/);
});

test('the proposals mode is the one propose.mjs keeps to, by the folder the session began in', t => {
  const v = filled(t);
  const config = JSON.parse(v.read('vault.config.json'));
  config.domains.glim.proposals = 'ask';
  v.write('vault.config.json', JSON.stringify(config));
  const first = out => out.stdout.split('\n')[0];
  const project = sessionId();
  v.startSession(project);
  assert.match(v.startSession(project, { source: 'resume', cwd: v.root }).systemMessage, /^vault: vault folder · .* · proposals: global corrections, glim ask$/);
  assert.match(first(v.run('status.mjs', [project])), /proposals: global corrections, glim ask$/);
  const vault = sessionId();
  v.startSession(vault, { cwd: v.root });
  assert.match(v.startSession(vault, { source: 'resume' }).systemMessage, /^vault: glim · .* · proposals: ask$/);
  assert.match(first(v.run('status.mjs', [vault])), /proposals: ask$/);
});

test("a tools rule counts when the session's agent sends its edit hook a tool it names, other than a file tool", t => {
  const v = filled(t);
  for (const [slug, tool] of [['asks', 'AskUserQuestion'], ['edits', 'Edit'], ['shell', 'Bash']]) {
    v.write(`wiki/glim/rules/${slug}.md`, ruleNote({ doLine: `Do ${slug}.`, notLine: `Skip ${slug}.`, extra: ['tools:', `  - ${tool}`] }));
  }
  const sid = sessionId();
  assert.equal(v.startSession(sid).systemMessage, 'vault: glim · 4 rules (1 always) · 1 page · proposals: corrections');
  assert.match(v.run('status.mjs', [sid]).stdout, /^vault: glim · 4 rules /);
});

test('/vault status counts for the folder the latest prompt came from', t => {
  const v = filled(t);
  const sid = sessionId();
  v.startSession(sid);
  prompt(v, sid, 'hello', { cwd: folder(t, 'vault-status-') });
  assert.match(v.run('status.mjs', [sid]).stdout, /^vault: no domain here · 1 global rule · /);
});

test('a resumed start shows the line again, and a compact or clear start shows none, since the session already saw it', t => {
  const v = filled(t);
  const sid = sessionId();
  v.startSession(sid);
  assert.match(v.startSession(sid, { source: 'resume' }).systemMessage, /^vault: glim/);
  for (const source of ['compact', 'clear']) assert.equal(v.startSession(sid, { source })?.systemMessage, undefined);
});

test('after compaction or /clear, a session holding vault offers is told to release them', t => {
  const v = filled(t);
  const sid = sessionId();
  v.startSession(sid, { transcript: v.transcript(sid, [userTurn('zq names follow the screen')]) });
  const hold = slug => v.propose(sid, {
    domain: 'glim', slug, topic: 'plumbing', kind: 'knowledge', basis: 'failure', error: `zq: ${slug} failed`, fix: 'renamed it', file: 'src/a.zq',
    do: `Zebra ${slug}.`, not: `Plover ${slug}.`, applies_to: [`src/${slug}/**`], hold: true,
  });
  const contextOf = out => out?.hookSpecificOutput?.additionalContext ?? '';
  assert.doesNotMatch(contextOf(v.startSession(sid, { source: 'compact' })), /vault offer/);
  const q = hold('quartz');
  assert.equal(q.code, 0, q.stderr);
  assert.match(contextOf(v.startSession(sid, { source: 'compact' })), /You hold 1 vault offer from before the compaction\. Call `propose` with `release: true` before your final reply\./);
  const m = hold('mango');
  assert.equal(m.code, 0, m.stderr);
  assert.match(contextOf(v.startSession(sid, { source: 'clear' })), /You hold 2 vault offers from before the compaction\. /);
  assert.doesNotMatch(contextOf(v.startSession(sid, { source: 'resume' })), /vault offer/);
});

test('a quiet folder keeps the offer to propose to global and drops the domain pitch', t => {
  const v = makeVault(t, { quiet: [`${posix(os.tmpdir())}/vault-quiet-*`] });
  const quiet = folder(t, 'vault-quiet-');
  const loud = folder(t, 'vault-loud-');
  const hushed = context(v.startSession(sessionId(), { cwd: quiet }));
  assert.match(hushed, /Taste vault: this project is in no domain\./);
  assert.match(hushed, /`global`/);
  assert.doesNotMatch(hushed, /suggest a domain|domain\.mjs/);
  assert.match(context(v.startSession(sessionId(), { cwd: loud })), /suggest a domain to the user/);
});

const QUIET_ERROR = /quiet must be a list of globs over absolute folder paths/;

test('lint takes a quiet glob over an absolute path and reports one that is not', t => {
  assert.doesNotMatch(makeVault(t, { quiet: [`${posix(os.tmpdir())}/scratch/**`] }).run('lint.mjs').stdout, QUIET_ERROR);
  assert.match(makeVault(t, { quiet: ['scratch/**'] }).run('lint.mjs').stdout, QUIET_ERROR);
  if (process.platform === 'win32') assert.match(makeVault(t, { quiet: ['/scratch/**'] }).run('lint.mjs').stdout, QUIET_ERROR, 'a path with no drive never matches a folder');
});

// A vault with a rule or page on every route from three domains: the session's own, an everywhere one, and one the
// session isn't in. Each route is driven through the hooks that deliver it.
function routed(t) {
  const v = makeVault(t, { domains: { wide: { title: 'Wide', topics: ['code'], everywhere: true }, other: { title: 'Other', topics: ['code'], markers: ['other.project'] } } });
  const rule = (key, opts) => {
    const [domain, slug] = key.split('/');
    v.write(`wiki/${domain}/rules/${slug}.md`, ruleNote({ domain, doLine: `Do ${slug}.`, notLine: `Skip ${slug}.`, ...opts }));
  };
  const asks = ['tools:', '  - AskUserQuestion'];
  rule('glim/brief', { always: true });
  rule('glim/prism', { keywords: ['prism'] });
  rule('glim/ask', { extra: asks });
  rule('glim/edits', { applies_to: ['src/**'] });
  rule('global/plain', { keywords: ['plain'] });
  rule('global/files', { applies_to: ['src/**'] });
  rule('wide/calm', { always: true, keywords: ['calm'] });
  rule('wide/terse', { keywords: ['terse'] });
  rule('wide/asks', { extra: asks });
  rule('wide/sweep', { always: true });
  rule('wide/edits', { applies_to: ['src/**'] });
  rule('other/quill', { keywords: ['quill'] });
  rule('other/asks', { extra: asks });
  for (const [domain, word] of [['glim', 'quartz'], ['wide', 'opal'], ['other', 'jade']]) {
    v.write(`wiki/${domain}/topics/code.md`, pageNote({ domain, keywords: [word] }));
    v.write(`wiki/${domain}/concepts/files.md`, pageNote({ domain, kind: 'concept', extra: ['applies_to:', "  - 'src/**'"] }));
  }
  return v;
}

function drive(v, sid, cwd) {
  v.startSession(sid, { cwd });
  for (const word of ['prism', 'plain', 'calm', 'terse', 'quill', 'quartz', 'opal', 'jade']) prompt(v, sid, `the ${word}`, { cwd });
  v.edit(sid, 'AskUserQuestion', { questions: [] }, { cwd });
  editFile(v, sid, 'src/a.zq', { abs: path.join(cwd, 'src', 'a.zq'), cwd });
  const [line, shown] = v.run('status.mjs', [sid]).stdout.trim().split('\n');
  const keys = noun => (new RegExp(`\\d+ ${noun}s?, ([^;]+)`).exec(shown)?.[1] ?? '').split(/, | and /).filter(Boolean).sort();
  return { line, rules: keys('rule'), pages: keys('page') };
}

const counted = (line, noun) => Number(new RegExp(`(\\d+) ${noun}`).exec(line)?.[1] ?? 0);

test('the status line counts exactly the rules and pages the hooks deliver, in each kind of folder', t => {
  const v = routed(t);
  const own = ['glim/ask', 'glim/brief', 'glim/edits', 'glim/prism', 'global/files', 'global/plain'];
  const wide = ['wide/asks', 'wide/calm', 'wide/terse'];
  const cases = [
    { name: 'project', cwd: v.project, rules: [...own, ...wide], pages: ['glim/code', 'glim/files', 'wide/code', 'wide/files'], line: /^vault: glim · 9 rules \(1 always\) · 4 pages · / },
    { name: 'no domain', cwd: folder(t, 'vault-routes-'), rules: ['global/files', 'global/plain', ...wide], pages: ['wide/code', 'wide/files'], line: /^vault: no domain here · 5 rules · 2 pages · / },
    { name: 'vault folder', cwd: v.root, rules: ['global/files', 'global/plain', ...wide], pages: ['glim/code', 'other/code', 'wide/code', 'wide/files'], line: /^vault: vault folder · 5 rules · 4 pages \(every domain\) · / },
  ];
  for (const c of cases) {
    const got = drive(v, sessionId(), c.cwd);
    assert.deepEqual(got.rules, [...c.rules].sort(), `${c.name}: rules delivered`);
    assert.deepEqual(got.pages, c.pages, `${c.name}: pages delivered`);
    assert.equal(counted(got.line, 'rule'), got.rules.length, `${c.name}: ${got.line}`);
    assert.equal(counted(got.line, 'page'), got.pages.length, `${c.name}: ${got.line}`);
    assert.match(got.line, c.line);
  }
});

test('status.mjs prints the line and what the session was shown', t => {
  const v = filled(t);
  const sid = sessionId();
  v.startSession(sid);
  const SHOWN = 'shown since the session started or was last compacted: ';
  assert.equal(v.run('status.mjs', [sid]).stdout.split('\n')[1], `${SHOWN}1 rule, glim/brief`);
  prompt(v, sid, 'make the prism and the quartz plain');
  const r = v.run('status.mjs', [sid]);
  assert.equal(r.code, 0, r.stderr);
  const [line, shown] = r.stdout.trim().split('\n');
  assert.equal(line, 'vault: glim · 3 rules (1 always) · 1 page · proposals: corrections');
  assert.equal(shown, `${SHOWN}3 rules, glim/brief, glim/prism and global/plain; 1 page, glim/code`);
  v.startSession(sid, { source: 'compact' });
  assert.equal(v.run('status.mjs', [sid]).stdout.split('\n')[1], `${SHOWN}1 rule, glim/brief`, 'rules and pages both start again');
  assert.equal(v.run('status.mjs', ['no-such-session']).code, 1);
});
