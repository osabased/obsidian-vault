import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeVault, PRESETS, ruleNote, pageNote, denied, sessionId, editFile as edit, prompt } from './fixture.mjs';

const withTriggers = (text, ...res) => text.replace('triggers: []', `triggers:\n${res.map(r => `  - '${r}'`).join('\n')}`);

test('edit hook refuses the first matching edit and lets the retry through', t => {
  const v = makeVault(t);
  const sid = sessionId();
  v.write('wiki/glim/ui-rule.md', ruleNote({ applies_to: ['src/**/*.zq'], doLine: 'Name each step.', notLine: 'Leave steps unnamed.' }));
  const first = denied(edit(v, sid, 'src/ui/main.zq'));
  assert.match(first, /^Taste rules apply to src\/ui\/main\.zq:\n- glim\/ui-rule: Do: Name each step\. Not: Leave steps unnamed\.\nRevise this edit to follow them, then retry\. The retry is allowed\.$/);
  assert.equal(edit(v, sid, 'src/ui/main.zq'), null);
});

test('the marker is per rule, file and session', t => {
  const v = makeVault(t);
  const [s1, s2] = [sessionId(), sessionId()];
  v.write('wiki/glim/ui-rule.md', ruleNote({ applies_to: ['src/**/*.zq'] }));
  assert.ok(denied(edit(v, s1, 'src/a.zq')));
  assert.equal(edit(v, s1, 'src/a.zq'), null);
  assert.ok(denied(edit(v, s1, 'src/b.zq')), 'another file is gated again');
  assert.ok(denied(edit(v, s2, 'src/a.zq')), 'another session is gated again');
  assert.equal(edit(v, s1, 'src/other.md'), null, 'a non-matching file is not gated');
});

test('Write is gated too, other tools are not', t => {
  const v = makeVault(t);
  v.write('wiki/glim/ui-rule.md', ruleNote({ applies_to: ['src/**'] }));
  assert.ok(denied(edit(v, sessionId(), 'src/a.zq', { tool: 'Write' })));
  assert.equal(edit(v, sessionId(), 'src/a.zq', { tool: 'Read' }), null);
});

test('a note saved within the settle window does not gate', t => {
  const v = makeVault(t);
  v.write('wiki/glim/ui-rule.md', ruleNote({ applies_to: ['src/**'] }), { settled: false });
  assert.equal(edit(v, sessionId(), 'src/a.zq'), null);
});

test('triggers narrow the rule to edits whose new text matches', t => {
  const v = makeVault(t);
  const sid = sessionId();
  v.write('wiki/glim/ui-rule.md', withTriggers(ruleNote({ applies_to: ['src/**'] }), 'pause\\(', 'hold\\('));
  assert.equal(edit(v, sid, 'src/a.zq', { text: 'set x to 1' }), null);
  assert.ok(denied(edit(v, sid, 'src/a.zq', { text: 'step.pause(1)' })));
  assert.equal(edit(v, sid, 'src/a.zq', { text: 'step.pause(1)' }), null);
  assert.ok(denied(edit(v, sid, 'src/b.zq', { text: 'hold(1)' })));
});

test('a more specific rule is listed first and the list is capped', t => {
  const v = makeVault(t);
  v.write('wiki/glim/broad.md', ruleNote({ applies_to: ['**/*.zq'], doLine: 'Broad.' }));
  v.write('wiki/glim/narrow.md', ruleNote({ applies_to: ['src/ui/*.zq'], doLine: 'Narrow.' }));
  const why = denied(edit(v, sessionId(), 'src/ui/a.zq'));
  assert.ok(why.indexOf('glim/narrow') < why.indexOf('glim/broad'));
});

test('edits inside the vault wiki/ and raw/ are not gated by rules', t => {
  const v = makeVault(t);
  v.write('wiki/glim/ui-rule.md', ruleNote({ applies_to: ['**'] }));
  const sid = sessionId();
  assert.equal(edit(v, sid, '', { abs: v.at('wiki', 'glim', 'other.md'), cwd: v.root }), null);
  assert.equal(edit(v, sid, '', { abs: v.at('raw', 'refs', 'new.md') }), null);
  assert.ok(denied(edit(v, sid, 'src/a.zq')), 'project files still are');
});

test('the vault guard refuses edits to generated files, .state and existing raw files', t => {
  const v = makeVault(t);
  const sid = sessionId();
  v.write('raw/refs/old.md', 'x');
  v.write('raw/inbox/2026-10-01.jsonl', '{}\n');
  v.write('.state/sessions.json', '{}');
  const guard = rel => denied(edit(v, sid, '', { abs: v.at(...rel.split('/')) }));
  assert.equal(guard('index.md'), "index.md is generated from the notes. Outside the vault folder, rules and pages change only through the vault's `propose` tool.");
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
  assert.equal(denied(edit(v, sid, '', { abs: v.at('wiki', 'glim', 'note.md'), cwd: v.root })), null);
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
  v.write('wiki/glim/kw-rule.md', ruleNote({ keywords: ['strict mode'], doLine: 'Use strict.', notLine: 'Skip strict.' }));
  assert.equal(prompt(v, s1, 'nothing relevant here'), null);
  const out = prompt(v, s1, 'please turn on Strict Mode in the shop');
  assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.equal(out.hookSpecificOutput.additionalContext, 'Taste rules that may apply to this request:\n- glim/kw-rule: Do: Use strict. Not: Skip strict.');
  assert.equal(prompt(v, s1, 'strict mode again'), null);
  assert.ok(prompt(v, s2, 'strict mode'), 'another session sees it');
});

test('prompt keywords match whole words only and the prompt outside a domain gets only global rules', t => {
  const v = makeVault(t);
  v.write('wiki/glim/kw-rule.md', ruleNote({ keywords: ['strict'] }));
  assert.equal(prompt(v, sessionId(), 'a strictly worded prompt'), null);
  v.write('wiki/global/g-rule.md', ruleNote({ domain: 'global', keywords: ['strict'] }));
  // Not os.tmpdir() itself: every test vault's project, with its marker, sits one folder below it.
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const elsewhere = { session_id: sessionId(), cwd: outside, prompt: 'strict' };
  const out = v.hook('prompt', elsewhere);
  assert.match(out.hookSpecificOutput.additionalContext, /global\/g-rule/);
  assert.ok(!out.hookSpecificOutput.additionalContext.includes('glim/kw-rule'));
});

test('session-start delivers always rules and the next prompt does not repeat them', t => {
  const v = makeVault(t);
  const sid = sessionId();
  v.write('wiki/glim/always-rule.md', ruleNote({ always: true, doLine: 'Be brief.', notLine: 'Ramble.' }));
  v.write('wiki/glim/quiet-rule.md', ruleNote({ keywords: ['quiet'], doLine: 'Hush.', notLine: 'Shout.' }));
  const ctx = v.startSession(sid).hookSpecificOutput.additionalContext;
  assert.match(ctx, /^# Taste rules\n/);
  assert.match(ctx, /## glim\n- glim\/always-rule: Do: Be brief\. Not: Ramble\./);
  assert.ok(!ctx.includes('quiet-rule'));
  assert.match(ctx, /Taste vault: propose a rule/);
  assert.equal(prompt(v, sid, 'hello'), null);
});

test('an always rule written after session start reaches the next prompt', t => {
  const v = makeVault(t);
  const sid = sessionId();
  v.startSession(sid);
  v.write('wiki/glim/late-rule.md', ruleNote({ always: true, doLine: 'Be late.', notLine: 'Be early.' }));
  const out = prompt(v, sid, 'hello');
  assert.match(out.hookSpecificOutput.additionalContext, /^Taste rules that apply for the rest of this session:\n- glim\/late-rule:/);
  assert.equal(prompt(v, sid, 'hello'), null);
});

test('a compact or clear start clears the markers so the edit gate and prompt refuse again', t => {
  const v = makeVault(t);
  v.write('wiki/glim/ui-rule.md', ruleNote({ applies_to: ['src/**'], keywords: ['strict'] }));
  for (const source of ['compact', 'clear']) {
    const sid = sessionId();
    v.startSession(sid);
    assert.ok(denied(edit(v, sid, 'src/a.zq')), source);
    assert.equal(edit(v, sid, 'src/a.zq'), null, source);
    assert.ok(prompt(v, sid, 'strict'), source);
    assert.equal(prompt(v, sid, 'strict'), null, source);

    v.startSession(sid, { source: 'resume' });
    assert.equal(edit(v, sid, 'src/a.zq'), null, `${source}: resume keeps the markers`);

    v.startSession(sid, { source });
    assert.ok(denied(edit(v, sid, 'src/a.zq')), source);
    assert.equal(edit(v, sid, 'src/a.zq'), null, source);
    assert.ok(prompt(v, sid, 'strict'), source);
  }
});

test('session start names the notes in its domains that an error keeps from delivery', t => {
  const v = makeVault(t, { domains: { other: { title: 'Other', markers: ['other.project'], topics: [] } } });
  v.write('wiki/glim/rules/bad.md', ruleNote({ basis: 'bogus', keywords: ['x'] }));
  v.write('wiki/global/rules/no-not.md', ruleNote({ domain: 'global', notLine: '', keywords: ['x'] }));
  v.write('wiki/other/rules/elsewhere.md', ruleNote({ domain: 'other', basis: 'bogus', keywords: ['x'] }));
  v.write('wiki/glim/rules/retired.md', ruleNote({ basis: 'bogus', extra: ['superseded_by: glim/bad'] }));
  v.write('wiki/glim/rules/typing.md', ruleNote({ basis: 'bogus' }), { settled: false });
  const context = (cwd, source) => v.startSession(sessionId(), { cwd, source })?.hookSpecificOutput.additionalContext ?? '';
  const line = /^Taste vault: (.*)\. Tell the user; \/lint in `.*` lists the fixes\.$/m;
  assert.equal(context(v.project).match(line)?.[1],
    "2 notes have an error and aren't delivered: glim/bad (basis must be stated, inferred, pick or reading), global/no-not (no **Not:** line)");
  assert.match(context(v.root).match(line)?.[1], /^3 notes have an error and aren't delivered: glim\/bad .*, global\/no-not .*, other\/elsewhere /);
  assert.doesNotMatch(context(v.project, 'compact'), line);
  v.write('wiki/glim/rules/bad.md', ruleNote({ keywords: ['x'] }));
  v.write('wiki/global/rules/no-not.md', ruleNote({ domain: 'global', keywords: ['x'] }));
  assert.doesNotMatch(context(v.project), line);
});

test('a rule with a lint error or superseded_by is never delivered', t => {
  const v = makeVault(t);
  v.write('wiki/glim/bad.md', ruleNote({ applies_to: ['src/**'], basis: 'bogus' }));
  v.write('wiki/glim/old.md', ruleNote({ applies_to: ['src/**'], extra: ['superseded_by: glim/new'] }));
  assert.equal(edit(v, sessionId(), 'src/a.zq'), null);
});

// glim's src/**/*.zq rule fires on editFile's default text, so each refusal names it.
const zqRule = /glim\/zq-trigger: Do: Set values through a named step\./;

test('6.3a: a subagent editing a file its parent was gated on is refused once more', t => {
  const v = makeVault(t, { presets: ['glim'] });
  const sid = sessionId();
  assert.match(denied(edit(v, sid, 'src/a.zq')) ?? '', zqRule, 'the parent is gated');
  assert.equal(edit(v, sid, 'src/a.zq'), null, 'the parent retry goes through');
  assert.match(denied(edit(v, sid, 'src/a.zq', { agent: 'agent-1' })) ?? '', zqRule, 'the subagent is gated on the same file');
  assert.equal(edit(v, sid, 'src/a.zq', { agent: 'agent-1' }), null, 'the subagent retry goes through');
});

test('6.3a: each agent is gated on a file once, whichever agent edited it first', t => {
  const v = makeVault(t, { presets: ['glim'] });
  const sid = sessionId();
  assert.match(denied(edit(v, sid, 'src/b.zq', { agent: 'agent-2' })) ?? '', zqRule, 'the first subagent is gated');
  assert.equal(edit(v, sid, 'src/b.zq', { agent: 'agent-2' }), null, 'the first subagent retry goes through');
  assert.match(denied(edit(v, sid, 'src/b.zq', { agent: 'agent-3' })) ?? '', zqRule, 'a second subagent is gated');
  assert.equal(edit(v, sid, 'src/b.zq', { agent: 'agent-3' }), null, 'the second subagent retry goes through');
  assert.match(denied(edit(v, sid, 'src/b.zq')) ?? '', zqRule, 'the parent is gated');
  assert.equal(edit(v, sid, 'src/b.zq'), null, 'the parent retry goes through');
});

test("6.3a: a subagent's first context holds the session's always rules and topics", t => {
  const v = makeVault(t, { presets: ['glim'] });
  const sid = sessionId();
  v.startSession(sid);
  const start = { session_id: sid, cwd: v.project, hook_event_name: 'SubagentStart', agent_type: 'general-purpose' };
  for (const agent_id of ['agent-1', 'agent-2']) {
    const out = v.hook('subagent-start', { ...start, agent_id }).hookSpecificOutput;
    assert.equal(out.hookEventName, 'SubagentStart');
    assert.match(out.additionalContext, /^# Taste rules\n[\s\S]*## glim\n- glim\/always-rule: Do: Open each glim file with a purpose line\. Not: Start a file straight with code\./, agent_id);
    assert.match(out.additionalContext, /Taste vault: when the task touches .*, read `[^`]*index\.md`/, agent_id);
    assert.ok(!out.additionalContext.includes('propose a rule'), agent_id);
  }
  v.write('wiki/glim/late-rule.md', ruleNote({ always: true, doLine: 'Be late.', notLine: 'Be early.' }));
  v.hook('subagent-start', { ...start, agent_id: 'agent-3' });
  assert.match(prompt(v, sid, 'hello').hookSpecificOutput.additionalContext, /glim\/late-rule/, "the parent still gets a rule a subagent was shown");
});

const checkedOut = t => {
  const v = makeVault(t, { presets: ['glim'] });
  v.checkout();
  return v;
};

test('6.6d: session start still delivers always rules after a checkout touches every note', t => {
  const v = checkedOut(t);
  const ctx = v.startSession(sessionId())?.hookSpecificOutput.additionalContext ?? '';
  assert.match(ctx, /glim\/always-rule: Do: Open each glim file with a purpose line\./);
});

test('6.6d: the gate still refuses after a checkout touches every note', t => {
  const v = checkedOut(t);
  assert.match(denied(edit(v, sessionId(), 'src/a.zq')) ?? '', zqRule);
});

test('6.5: 20 rules and 2 pages on one glob refuse the first edit of a file once, and the retry passes', t => {
  const v = makeVault(t, { presets: ['glim'] });
  const sid = sessionId();
  const keys = [];
  for (let i = 0; i < 20; i++) {
    v.write(`wiki/glim/rules/rule-${i}.md`, ruleNote({ applies_to: ['**/*.zq'], doLine: `Rule ${i}.` }));
    keys.push(`glim/rule-${i}`);
  }
  for (const slug of ['page-a', 'page-b']) {
    v.write(`wiki/glim/concepts/${slug}.md`, pageNote({ kind: 'concept', applies_to: ['**/*.zq'], summary: `'About ${slug}.'` }));
    keys.push(`glim/${slug}`);
  }
  const first = denied(edit(v, sid, 'src/x.zq')) ?? '';
  for (const key of keys) assert.match(first, new RegExp(`${key}(?![\\w-])`), `the first refusal names ${key}`);
  assert.equal(edit(v, sid, 'src/x.zq'), null, 'the retry passes');
});

test('a refusal writes its markers in one file per kind however many rules are due, and markers older tools wrote still count', async t => {
  const v = makeVault(t);
  const sid = sessionId();
  for (let i = 0; i < 30; i++) v.write(`wiki/glim/rules/rule-${i}.md`, ruleNote({ applies_to: ['**/*.txt'], doLine: `Rule ${i}.` }));
  assert.ok(denied(edit(v, sid, 'src/x.txt')));
  for (const kind of ['gate', 'delivered', 'excerpts']) assert.deepEqual(fs.readdirSync(v.at('.state', kind, sid)), ['keys.jsonl'], kind);

  const old = sessionId();
  const { shortHash } = await v.import('lib/vault.mjs');
  const { liveRules, loadNotes } = await v.import('lib/rules.mjs');
  for (const [key, { hash }] of Object.entries(liveRules(loadNotes()))) {
    const id = `${key}|${hash}|src/x.txt`;
    v.write(`.state/gate/${old}/${shortHash(id)}`, id);
  }
  assert.equal(edit(v, old, 'src/x.txt'), null, 'one-file markers from before still mark the file gated');
});

test('6.6c: a trigger with nested wildcards does not hold the edit hook up on a long line', async t => {
  const v = makeVault(t, { presets: ['glim'] });
  const trigger = 'make\\(.*,.*,.*,.*\\)';
  v.write('wiki/glim/rules/slow.md', withTriggers(ruleNote({ applies_to: ['src/**/*.zq'] }), trigger));
  assert.match(denied(edit(v, sessionId(), 'src/a.zq', { text: 'make(1,1,1,1)' })) ?? '', /glim\/slow:/, 'the trigger matches a short call');
  // Only the match is timed, in this process, so process start and a loaded machine don't count. A backtracking engine
  // takes seconds on this 820-character line, and the match runs synchronously, so nothing could stop it from outside.
  // The best of three keeps one pause from failing the test.
  const { tryRegex } = await v.import('lib/rules.mjs');
  const line = `make(${'1,'.repeat(407)}1`;
  const re = tryRegex(trigger);
  let best = Infinity;
  for (let i = 0; i < 3 && best >= 10; i++) {
    const start = performance.now();
    assert.equal(re.test(line), false);
    best = Math.min(best, performance.now() - start);
  }
  assert.ok(best < 10, `the match took ${best.toFixed(1)} ms`);
});

test('a file path with the long-path prefix is gated by the rules of its project', { skip: process.platform !== 'win32' && 'the prefix is a Windows spelling' }, t => {
  const v = makeVault(t);
  v.write('wiki/glim/rules/ui-rule.md', ruleNote({ applies_to: ['src/**/*.txt'] }));
  const file = path.join(v.project, 'src', 'a.txt');
  assert.ok(denied(edit(v, sessionId(), '', { abs: file })), 'the plain spelling is gated');
  assert.ok(denied(edit(v, sessionId(), '', { abs: `\\\\?\\${file}` })), 'the prefixed spelling is gated');
});

test('a negated glob in applies_to excludes the files it names from the gate', t => {
  const v = makeVault(t);
  const sid = sessionId();
  v.write('wiki/glim/rules/no-tests.md', ruleNote({ applies_to: ['src/**/*.zq', '!src/**/*.test.zq'] }));
  assert.ok(denied(edit(v, sid, 'src/a.zq')), 'a source file is gated');
  assert.equal(edit(v, sid, 'src/a.test.zq'), null, 'a test file is not');
});

const LIMIT = 8000;

test('6.6e: session start in the vault folder with 10 domains stays under the output budget and names what it left out', t => {
  const domains = Object.fromEntries(Array.from({ length: 5 }, (_, d) => [`area-${d}`, {
    title: `Area ${d}`, vaultOnly: true, topics: Array.from({ length: 120 }, (_, i) => `topic-${d}-${i}-padding`),
  }]));
  const v = makeVault(t, { presets: Object.keys(PRESETS), domains });
  const ctx = v.startSession(sessionId(), { cwd: v.root }).hookSpecificOutput.additionalContext;
  assert.ok(ctx.length <= LIMIT, `${ctx.length} characters`);
  assert.match(ctx, /^Taste vault: when the task touches layout, code, ledger, papers, days, words, topic-0-0-padding, /);
  // The presets' notes bring the lint reminder and the stale-sources line, which rank below the topics.
  assert.match(ctx, /\(Left out to stay within 8000 characters: \d+ topics and 2 notes\. `[^`]*index\.md` lists the rest\.\)$/);
});

test('sections left out under one noun are counted together', async t => {
  const { fitContext } = await makeVault(t).import('lib/rules.mjs');
  assert.match(fitContext(['a'.repeat(150), 'b'.repeat(150), 'c'.repeat(150)], { max: 400 }).text, /Left out to stay within 400 characters: 2 notes\./);
});

test('the output budget is delivery.maxContextChars, and the topics are the first to go', t => {
  const v = makeVault(t, { config: { delivery: { maxContextChars: 3000 } }, topics: Array.from({ length: 200 }, (_, i) => `topic-${i}-padding`) });
  v.write('wiki/glim/rules/brief.md', ruleNote({ always: true, doLine: 'Be brief.' }));
  const ctx = v.startSession(sessionId()).hookSpecificOutput.additionalContext;
  assert.ok(ctx.length <= 3000, `${ctx.length} characters`);
  assert.match(ctx, /glim\/brief: Do: Be brief\./, 'the always rule ranks above the topics');
  assert.match(ctx, /Taste vault: propose a rule/, 'the instructions rank above the topics');
  assert.match(ctx, /Left out to stay within 3000 characters: \d+ topics\b/);
});

test('the prompt hook fits the output budget, the always rules written since session start included', t => {
  const v = makeVault(t);
  const sid = sessionId();
  v.startSession(sid);
  for (let i = 0; i < 40; i++) v.write(`wiki/glim/rules/late-${i}.md`, ruleNote({ always: true, doLine: `Late rule ${i}. ${'Mind the detail. '.repeat(12)}` }));
  v.write('wiki/glim/rules/kw.md', ruleNote({ keywords: ['strict'], doLine: 'Use strict.' }));
  v.write('wiki/glim/concepts/strict-mode.md', pageNote({ kind: 'concept', keywords: ['strict'], summary: "'On strict mode.'" }));
  const ctx = prompt(v, sid, 'strict').hookSpecificOutput.additionalContext;
  assert.ok(ctx.length <= LIMIT, `${ctx.length} characters`);
  assert.match(ctx, /^Taste rules that apply for the rest of this session:\n- glim\/late-0:/);
  assert.match(ctx, /\(Left out to stay within 8000 characters: \d+ rules/);
  // What the budget cut arrives with the next prompt: the rest of the always rules, the keyword rule and the page.
  const named = text => new Set([...text.matchAll(/glim\/(late-\d+|kw|strict-mode)(?![\w-])/g)].map(m => m[1]));
  const first = named(ctx);
  assert.ok(!first.has('kw') && !first.has('strict-mode'), 'the keyword rule and the page were cut');
  const rest = named(prompt(v, sid, 'strict').hookSpecificOutput.additionalContext);
  assert.deepEqual([...first].filter(k => rest.has(k)), [], 'nothing shown first is shown again');
  assert.equal(first.size + rest.size, 42, 'everything cut arrives with the next prompt');
  assert.equal(prompt(v, sid, 'strict'), null);
});

test('a page the output budget leaves out of a refusal does not refuse the retry, and comes up on the next file it covers', t => {
  const v = makeVault(t);
  const sid = sessionId();
  for (let i = 0; i < 80; i++) v.write(`wiki/glim/rules/rule-${String(i).padStart(2, '0')}.md`, ruleNote({ applies_to: ['src/a.txt'], doLine: `Rule ${i}. ${'Mind the detail. '.repeat(8)}` }));
  for (let i = 0; i < 3; i++) v.write(`wiki/glim/concepts/page-${i}.md`, pageNote({ kind: 'concept', applies_to: ['src/**'], summary: `'Page ${i}.'` }));
  const pagesIn = text => [...text.matchAll(/glim\/page-\d/g)].map(m => m[0]);
  const first = denied(edit(v, sid, 'src/a.txt')) ?? '';
  assert.match(first, /\(Left out to stay within 8000 characters: .*3 pages/);
  assert.equal(edit(v, sid, 'src/a.txt'), null, 'the retry passes');
  assert.deepEqual(pagesIn(denied(edit(v, sid, 'src/b.txt')) ?? ''), ['glim/page-0', 'glim/page-1', 'glim/page-2']);
  assert.equal(edit(v, sid, 'src/b.txt'), null);
  assert.equal(edit(v, sid, 'src/c.txt'), null, 'a page shown once is not shown again');
});

test('a refusal counts the rules it shows in full or as pointers as shown, and not those it leaves out', t => {
  const v = makeVault(t);
  const sid = sessionId();
  for (let i = 0; i < 80; i++) v.write(`wiki/glim/rules/rule-${String(i).padStart(2, '0')}.md`, ruleNote({ applies_to: ['**/*.txt'], doLine: `Rule ${i}. ${'Mind the detail. '.repeat(8)}` }));
  const why = denied(edit(v, sid, 'src/a.txt')) ?? '';
  const named = [...new Set([...why.matchAll(/glim\/rule-\d\d/g)].map(m => m[0]))].sort();
  assert.ok(named.length > 3 && named.length < 80, `${named.length} rules named`);
  const shown = v.read(`.state/delivered/${sid}/keys.jsonl`).split('\n').filter(Boolean).map(l => JSON.parse(l)).sort();
  assert.deepEqual(shown, named);
});

test('an always block that higher-ranked lines leave no room for at session start reaches the next prompt', t => {
  const v = makeVault(t, { config: { delivery: { maxContextChars: 2000 } } });
  for (let i = 0; i < 8; i++) {
    v.write(`wiki/glim/rules/al-${i}.md`, ruleNote({ always: true, doLine: `Always do thing number ${i} with a fairly long sentence to fill the budget up nicely here.`, notLine: `Never skip thing ${i} whatever happens in the session today.` }));
  }
  // Notes an error keeps from delivery are named in a line that ranks above the always block.
  for (let i = 0; i < 3; i++) v.write(`wiki/glim/rules/bad-${i}.md`, ruleNote({ basis: 'bogus', keywords: ['x'] }));
  const sid = sessionId();
  const start = v.startSession(sid).hookSpecificOutput.additionalContext;
  assert.match(start, /glim\/bad-0/);
  assert.doesNotMatch(start, /glim\/al-0/, 'the always block was left out');
  assert.match(prompt(v, sid, 'hello')?.hookSpecificOutput.additionalContext ?? '', /glim\/al-0/);
});

test('an edit that goes through carries no page pointer', t => {
  const v = makeVault(t);
  const sid = sessionId();
  v.write('wiki/glim/concepts/grid.md', pageNote({ kind: 'concept', applies_to: ['**/*.txt'] }));
  assert.match(denied(edit(v, sid, 'src/a.txt')), /glim\/grid/);
  assert.equal(edit(v, sid, 'src/a.txt'), null);
  assert.equal(edit(v, sid, 'src/b.txt'), null);
});

// The glim preset's namespace glim-tree, its MCP tool that sets a property on a name in it, and its alias.
const setProperty = (v, sid, name, value = 'x', opts) => v.edit(sid, 'mcp__fixture__set_property', { path: name, value }, opts);

test('6.3b: a mapped call on a name is refused once by a rule on its namespace, then goes through', t => {
  const v = makeVault(t, { presets: ['glim'] });
  const sid = sessionId();
  v.startSession(sid);
  v.write('wiki/glim/tree-rule.md', ruleNote({ applies_to: ['glim-tree:A.**'], doLine: 'Name nodes plainly.' }));
  assert.match(denied(setProperty(v, sid, 'A.B.C')), /^Taste rules apply to glim-tree:A\.B\.C:\n- glim\/tree-rule: Do: Name nodes plainly\./);
  assert.equal(setProperty(v, sid, 'A.B.C'), null, 'the retry goes through');
  assert.equal(setProperty(v, sid, 'B.A.C'), null, 'a name outside the glob is not gated');
  assert.equal(setProperty(v, sid, 'a.B.C'), null, 'names match with case');
  assert.ok(denied(setProperty(v, sid, 'A.B.C', 'x', { agent: 'agent-1' })), 'a subagent is gated once more');
});

test("a mapped call's triggers test the new text the map names", t => {
  const v = makeVault(t, { presets: ['glim'] });
  const sid = sessionId();
  v.write('wiki/glim/tree-rule.md', withTriggers(ruleNote({ applies_to: ['glim-tree:A.**'] }), 'Color'));
  assert.equal(setProperty(v, sid, 'A.B', 'Size'), null);
  assert.ok(denied(setProperty(v, sid, 'A.B', { Color: 1 })), 'a value that is not text is matched as JSON');
});

test('6.3b: through the fixture alias a mapped call is also refused by a rule on the file the name maps to', t => {
  const v = makeVault(t, { presets: ['glim'] });
  const sid = sessionId();
  v.startSession(sid);
  v.write('wiki/glim/both-rule.md', ruleNote({ applies_to: ['glim-tree:A.**', 'src/**'], doLine: 'Both ways.' }));
  const before = denied(setProperty(v, sid, 'A.B.C', 'set x to 1'));
  assert.doesNotMatch(before, /zq-trigger/, 'the alias maps nothing where the project lacks what it reads');
  assert.match(before, /glim\/both-rule/);
  fs.writeFileSync(path.join(v.project, 'tree.json'), JSON.stringify({ A: 'src' }));
  const why = denied(setProperty(v, sid, 'A.B.D', 'set x to 1'));
  assert.match(why, zqRule, "the name's file src/B/D.zq fires glim's rule on src/**/*.zq");
  assert.match(why, /glim\/zq-files \(concept page\)/, 'and brings up its page');
  assert.equal(why.match(/glim\/both-rule/g)?.length, 1, 'a rule both namespaces match refuses once');
  assert.equal(setProperty(v, sid, 'A.B.D', 'set x to 1'), null, 'the retry goes through');
});

test('an unmapped MCP call with no rule on its name passes, and a mapped call without its path fails loudly', t => {
  const v = makeVault(t, { presets: ['glim'] });
  const sid = sessionId();
  v.write('wiki/glim/tree-rule.md', ruleNote({ applies_to: ['glim-tree:**', '**'] }));
  assert.equal(v.edit(sid, 'mcp__other__set_property', { path: 'A.B', value: 'x' }), null);
  assert.throws(() => v.edit(sid, 'mcp__fixture__set_property', { value: 'x' }), /editTools\.mcp__fixture__set_property\.path is tool_input\.path, which this call's input doesn't hold as text/);
});
