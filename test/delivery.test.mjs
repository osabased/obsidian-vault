import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { makeVault, ruleNote, pageNote, denied, sessionId, editFile as edit, prompt } from './fixture.mjs';

const withTriggers = (text, ...res) => text.replace('triggers: []', `triggers:\n${res.map(r => `  - '${r}'`).join('\n')}`);

test('edit hook refuses the first matching edit and lets the retry through', t => {
  const v = makeVault(t);
  const sid = sessionId();
  v.write('wiki/demo/ui-rule.md', ruleNote({ applies_to: ['src/**/*.luau'], doLine: 'Start with strict.', notLine: 'Leave nonstrict.' }));
  const first = denied(edit(v, sid, 'src/ui/main.luau'));
  assert.match(first, /^Taste rules apply to src\/ui\/main\.luau:\n- demo\/ui-rule: Do: Start with strict\. Not: Leave nonstrict\.\nRevise this edit to follow them, then retry\. The retry is allowed\.$/);
  assert.equal(edit(v, sid, 'src/ui/main.luau'), null);
});

test('the marker is per rule, file and session', t => {
  const v = makeVault(t);
  const [s1, s2] = [sessionId(), sessionId()];
  v.write('wiki/demo/ui-rule.md', ruleNote({ applies_to: ['src/**/*.luau'] }));
  assert.ok(denied(edit(v, s1, 'src/a.luau')));
  assert.equal(edit(v, s1, 'src/a.luau'), null);
  assert.ok(denied(edit(v, s1, 'src/b.luau')), 'another file is gated again');
  assert.ok(denied(edit(v, s2, 'src/a.luau')), 'another session is gated again');
  assert.equal(edit(v, s1, 'src/other.md'), null, 'a non-matching file is not gated');
});

test('Write is gated too, other tools are not', t => {
  const v = makeVault(t);
  v.write('wiki/demo/ui-rule.md', ruleNote({ applies_to: ['src/**'] }));
  assert.ok(denied(edit(v, sessionId(), 'src/a.lua', { tool: 'Write' })));
  assert.equal(edit(v, sessionId(), 'src/a.lua', { tool: 'Read' }), null);
});

test('a note saved within the settle window does not gate', t => {
  const v = makeVault(t);
  v.write('wiki/demo/ui-rule.md', ruleNote({ applies_to: ['src/**'] }), { settled: false });
  assert.equal(edit(v, sessionId(), 'src/a.lua'), null);
});

test('triggers narrow the rule to edits whose new text matches', t => {
  const v = makeVault(t);
  const sid = sessionId();
  v.write('wiki/demo/ui-rule.md', withTriggers(ruleNote({ applies_to: ['src/**'] }), 'wait\\(', 'delay\\('));
  assert.equal(edit(v, sid, 'src/a.lua', { text: 'local x = 1' }), null);
  assert.ok(denied(edit(v, sid, 'src/a.lua', { text: 'task.wait(1)' })));
  assert.equal(edit(v, sid, 'src/a.lua', { text: 'task.wait(1)' }), null);
  assert.ok(denied(edit(v, sid, 'src/b.lua', { text: 'delay(1)' })));
});

test('a more specific rule is listed first and the list is capped', t => {
  const v = makeVault(t);
  v.write('wiki/demo/broad.md', ruleNote({ applies_to: ['**/*.lua'], doLine: 'Broad.' }));
  v.write('wiki/demo/narrow.md', ruleNote({ applies_to: ['src/ui/*.lua'], doLine: 'Narrow.' }));
  const why = denied(edit(v, sessionId(), 'src/ui/a.lua'));
  assert.ok(why.indexOf('demo/narrow') < why.indexOf('demo/broad'));
});

test('edits inside the vault wiki/ and raw/ are not gated by rules', t => {
  const v = makeVault(t);
  v.write('wiki/demo/ui-rule.md', ruleNote({ applies_to: ['**'] }));
  const sid = sessionId();
  assert.equal(edit(v, sid, '', { abs: v.at('wiki', 'demo', 'other.md') }), null);
  assert.equal(edit(v, sid, '', { abs: v.at('raw', 'refs', 'new.md') }), null);
  assert.ok(denied(edit(v, sid, 'src/a.lua')), 'project files still are');
});

test('the vault guard refuses edits to generated files, .state and existing raw files', t => {
  const v = makeVault(t);
  const sid = sessionId();
  v.write('raw/refs/old.md', 'x');
  v.write('raw/inbox/2026-10-01.jsonl', '{}\n');
  v.write('.state/sessions.json', '{}');
  const guard = rel => denied(edit(v, sid, '', { abs: v.at(...rel.split('/')) }));
  assert.match(guard('index.md'), /^index\.md is generated from the notes\. Edit the notes instead, then run `node tools\/build\.mjs`\.$/);
  assert.match(guard('active.md'), /^active\.md is generated/);
  assert.match(guard('decisions.md'), /^decisions\.md is generated from the picks/);
  assert.equal(guard('.state/sessions.json'), ".state/ is the hooks' own bookkeeping. Leave it to them.");
  assert.equal(guard('.live/tools/hooks/edit.mjs'), '`.live/` is a copy of `tools/` as of the last commit. Change `tools/` and commit instead.');
  assert.equal(guard('.LIVE'), guard('.live/tools/hooks/edit.mjs'));
  assert.equal(guard('.lively.md'), null);
  assert.match(guard('raw/refs/old.md'), /^raw\/ is append-only: raw\/refs\/old\.md already exists and can't be changed\./);
  assert.match(guard('raw/inbox/2026-10-01.jsonl'), /already exists/);
  assert.match(guard('raw/inbox/new.jsonl'), /^raw\/ is append-only\. New files go under raw\/refs\//);
  assert.equal(guard('raw/refs/new.md'), null);
  assert.equal(guard('wiki/demo/note.md'), null);
  assert.equal(guard('AGENTS.md'), null);
});

test('the vault guard is not retry-able', t => {
  const v = makeVault(t);
  const sid = sessionId();
  assert.ok(denied(edit(v, sid, '', { abs: v.at('index.md') })));
  assert.ok(denied(edit(v, sid, '', { abs: v.at('index.md') })));
});

test('prompt hook shows a rule whose keyword is in the prompt once per session', t => {
  const v = makeVault(t);
  const [s1, s2] = [sessionId(), sessionId()];
  v.write('wiki/demo/kw-rule.md', ruleNote({ keywords: ['strict mode'], doLine: 'Use strict.', notLine: 'Skip strict.' }));
  assert.equal(prompt(v, s1, 'nothing relevant here'), null);
  const out = prompt(v, s1, 'please turn on Strict Mode in the shop');
  assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.equal(out.hookSpecificOutput.additionalContext, 'Taste rules that may apply to this request:\n- demo/kw-rule: Do: Use strict. Not: Skip strict.');
  assert.equal(prompt(v, s1, 'strict mode again'), null);
  assert.ok(prompt(v, s2, 'strict mode'), 'another session sees it');
});

test('prompt keywords match whole words only and the prompt outside a domain gets only global rules', t => {
  const v = makeVault(t);
  v.write('wiki/demo/kw-rule.md', ruleNote({ keywords: ['strict'] }));
  assert.equal(prompt(v, sessionId(), 'a strictly worded prompt'), null);
  v.write('wiki/global/g-rule.md', ruleNote({ domain: 'global', keywords: ['strict'] }));
  const elsewhere = { session_id: sessionId(), cwd: os.tmpdir(), prompt: 'strict' };
  const out = v.hook('prompt', elsewhere);
  assert.match(out.hookSpecificOutput.additionalContext, /global\/g-rule/);
  assert.ok(!out.hookSpecificOutput.additionalContext.includes('demo/kw-rule'));
});

test('session-start delivers always rules and the next prompt does not repeat them', t => {
  const v = makeVault(t);
  const sid = sessionId();
  v.write('wiki/demo/always-rule.md', ruleNote({ always: true, doLine: 'Be brief.', notLine: 'Ramble.' }));
  v.write('wiki/demo/quiet-rule.md', ruleNote({ keywords: ['quiet'], doLine: 'Hush.', notLine: 'Shout.' }));
  const ctx = v.startSession(sid).hookSpecificOutput.additionalContext;
  assert.match(ctx, /^# Taste rules\n/);
  assert.match(ctx, /## demo\n- demo\/always-rule: Do: Be brief\. Not: Ramble\./);
  assert.ok(!ctx.includes('quiet-rule'));
  assert.match(ctx, /Taste vault: propose a rule/);
  assert.equal(prompt(v, sid, 'hello'), null);
});

test('an always rule written after session start reaches the next prompt', t => {
  const v = makeVault(t);
  const sid = sessionId();
  v.startSession(sid);
  v.write('wiki/demo/late-rule.md', ruleNote({ always: true, doLine: 'Be late.', notLine: 'Be early.' }));
  const out = prompt(v, sid, 'hello');
  assert.match(out.hookSpecificOutput.additionalContext, /^Taste rules that apply for the rest of this session:\n- demo\/late-rule:/);
  assert.equal(prompt(v, sid, 'hello'), null);
});

test('a compact or clear start clears the markers so the edit gate and prompt refuse again', t => {
  const v = makeVault(t);
  v.write('wiki/demo/ui-rule.md', ruleNote({ applies_to: ['src/**'], keywords: ['strict'] }));
  for (const source of ['compact', 'clear']) {
    const sid = sessionId();
    v.startSession(sid);
    assert.ok(denied(edit(v, sid, 'src/a.lua')), source);
    assert.equal(edit(v, sid, 'src/a.lua'), null, source);
    assert.ok(prompt(v, sid, 'strict'), source);
    assert.equal(prompt(v, sid, 'strict'), null, source);

    v.startSession(sid, { source: 'resume' });
    assert.equal(edit(v, sid, 'src/a.lua'), null, `${source}: resume keeps the markers`);

    v.startSession(sid, { source });
    assert.ok(denied(edit(v, sid, 'src/a.lua')), source);
    assert.equal(edit(v, sid, 'src/a.lua'), null, source);
    assert.ok(prompt(v, sid, 'strict'), source);
  }
});

test('session start names the notes in its domains that an error keeps from delivery', t => {
  const v = makeVault(t, { domains: { other: { title: 'Other', markers: ['other.project'], topics: [] } } });
  v.write('wiki/demo/rules/bad.md', ruleNote({ basis: 'bogus', keywords: ['x'] }));
  v.write('wiki/global/rules/no-not.md', ruleNote({ domain: 'global', notLine: '', keywords: ['x'] }));
  v.write('wiki/other/rules/elsewhere.md', ruleNote({ domain: 'other', basis: 'bogus', keywords: ['x'] }));
  v.write('wiki/demo/rules/retired.md', ruleNote({ basis: 'bogus', extra: ['superseded_by: demo/bad'] }));
  v.write('wiki/demo/rules/typing.md', ruleNote({ basis: 'bogus' }), { settled: false });
  const context = (cwd, source) => v.startSession(sessionId(), { cwd, source })?.hookSpecificOutput.additionalContext ?? '';
  const line = /^Taste vault: (.*)\. Tell the user; \/lint in `.*` lists the fixes\.$/m;
  assert.equal(context(v.project).match(line)?.[1],
    "2 notes have an error and aren't delivered: demo/bad (basis must be stated, inferred, pick or reading), global/no-not (no **Not:** line)");
  assert.match(context(v.root).match(line)?.[1], /^3 notes have an error and aren't delivered: demo\/bad .*, global\/no-not .*, other\/elsewhere /);
  assert.doesNotMatch(context(v.project, 'compact'), line);
  v.write('wiki/demo/rules/bad.md', ruleNote({ keywords: ['x'] }));
  v.write('wiki/global/rules/no-not.md', ruleNote({ domain: 'global', keywords: ['x'] }));
  assert.doesNotMatch(context(v.project), line);
});

test('a rule with a lint error or superseded_by is never delivered', t => {
  const v = makeVault(t);
  v.write('wiki/demo/bad.md', ruleNote({ applies_to: ['src/**'], basis: 'bogus' }));
  v.write('wiki/demo/old.md', ruleNote({ applies_to: ['src/**'], extra: ['superseded_by: demo/new'] }));
  assert.equal(edit(v, sessionId(), 'src/a.lua'), null);
});

const gatedOnTxt = t => {
  const v = makeVault(t);
  v.write('wiki/demo/ui-rule.md', ruleNote({ applies_to: ['src/**/*.txt'] }));
  return v;
};

test('a subagent editing a file its parent was gated on is refused once more', { todo: '6.3a' }, t => {
  const v = gatedOnTxt(t);
  const sid = sessionId();
  assert.ok(denied(edit(v, sid, 'src/a.txt')), 'the parent is gated');
  assert.equal(edit(v, sid, 'src/a.txt'), null, 'the parent retry goes through');
  assert.ok(denied(edit(v, sid, 'src/a.txt', { agent: 'agent-1' })), 'the subagent is gated on the same file');
  assert.equal(edit(v, sid, 'src/a.txt', { agent: 'agent-1' }), null, 'the subagent retry goes through');
});

test('each agent is gated on a file once, whichever agent edited it first', { todo: '6.3a' }, t => {
  const v = gatedOnTxt(t);
  const sid = sessionId();
  assert.ok(denied(edit(v, sid, 'src/b.txt', { agent: 'agent-2' })), 'the first subagent is gated');
  assert.equal(edit(v, sid, 'src/b.txt', { agent: 'agent-2' }), null, 'the first subagent retry goes through');
  assert.ok(denied(edit(v, sid, 'src/b.txt', { agent: 'agent-3' })), 'a second subagent is gated');
  assert.equal(edit(v, sid, 'src/b.txt', { agent: 'agent-3' }), null, 'the second subagent retry goes through');
  assert.ok(denied(edit(v, sid, 'src/b.txt')), 'the parent is gated');
  assert.equal(edit(v, sid, 'src/b.txt'), null, 'the parent retry goes through');
});

const checkedOut = (t, name, rule) => {
  const v = makeVault(t);
  v.write(`wiki/demo/rules/${name}.md`, rule);
  v.checkout();
  return v;
};

test('session start still delivers always rules after a checkout touches every note', { todo: '6.6d' }, t => {
  const v = checkedOut(t, 'always-rule', ruleNote({ always: true, doLine: 'Be brief.', notLine: 'Ramble.' }));
  const ctx = v.startSession(sessionId())?.hookSpecificOutput.additionalContext ?? '';
  assert.match(ctx, /demo\/always-rule: Do: Be brief\./);
});

test('the gate still refuses after a checkout touches every note', { todo: '6.6d' }, t => {
  const v = checkedOut(t, 'ui-rule', ruleNote({ applies_to: ['src/**/*.txt'] }));
  assert.ok(denied(edit(v, sessionId(), 'src/a.txt')));
});

test('20 rules and 2 pages on one glob refuse the first edit of a file once, and the retry passes', { todo: '6.5' }, t => {
  const v = makeVault(t);
  const sid = sessionId();
  const keys = [];
  for (let i = 0; i < 20; i++) {
    v.write(`wiki/demo/rules/rule-${i}.md`, ruleNote({ applies_to: ['**/*.txt'], doLine: `Rule ${i}.` }));
    keys.push(`demo/rule-${i}`);
  }
  for (const slug of ['page-a', 'page-b']) {
    v.write(`wiki/demo/concepts/${slug}.md`, pageNote({ kind: 'concept', applies_to: ['**/*.txt'], summary: `'About ${slug}.'` }));
    keys.push(`demo/${slug}`);
  }
  const first = denied(edit(v, sid, 'src/x.txt')) ?? '';
  for (const key of keys) assert.match(first, new RegExp(`${key}(?![\\w-])`), `the first refusal names ${key}`);
  assert.equal(edit(v, sid, 'src/x.txt'), null, 'the retry passes');
});

test('a trigger with nested wildcards does not hold the edit hook up on a long line', { todo: '6.6c' }, t => {
  const v = makeVault(t);
  const sid = sessionId();
  v.write('wiki/demo/rules/slow.md', withTriggers(ruleNote({ applies_to: ['src/**/*.txt'] }), 'make\\(.*,.*,.*,.*\\)'));
  const start = performance.now();
  assert.ok(denied(edit(v, sid, 'src/a.txt', { text: 'make(1,1,1,1)' })), 'the trigger matches a short call');
  // The hook's own run sets the scale, so a slow machine doesn't fail the test. Backtracking takes seconds here; the
  // match runs synchronously inside the hook, so a deadline on its process is the only way to stop it.
  const deadline = Math.max(500, 4 * (performance.now() - start));
  assert.equal(edit(v, sid, 'src/b.txt', { text: `make(${'1,'.repeat(407)}1`, timeout: deadline }), null);
});

test('a file path with the long-path prefix is gated by the rules of its project', { skip: process.platform !== 'win32' && 'the prefix is a Windows spelling' }, t => {
  const v = makeVault(t);
  v.write('wiki/demo/rules/ui-rule.md', ruleNote({ applies_to: ['src/**/*.txt'] }));
  const file = path.join(v.project, 'src', 'a.txt');
  assert.ok(denied(edit(v, sessionId(), '', { abs: file })), 'the plain spelling is gated');
  assert.ok(denied(edit(v, sessionId(), '', { abs: `\\\\?\\${file}` })), 'the prefixed spelling is gated');
});

test('a negated glob in applies_to excludes the files it names from the gate', t => {
  const v = makeVault(t);
  const sid = sessionId();
  v.write('wiki/demo/rules/no-tests.md', ruleNote({ applies_to: ['src/**/*.ts', '!src/**/*.test.ts'] }));
  assert.ok(denied(edit(v, sid, 'src/a.ts')), 'a source file is gated');
  assert.equal(edit(v, sid, 'src/a.test.ts'), null, 'a test file is not');
});
