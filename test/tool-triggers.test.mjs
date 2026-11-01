import test from 'node:test';
import assert from 'node:assert/strict';
import { makeVault, ruleNote, pageNote, sessionId, denied, lintFound } from './fixture.mjs';

const ask = (v, sid, question = 'Which card layout?', opts) => v.edit(sid, 'AskUserQuestion', { questions: [{
  question, header: 'Layout', multiSelect: false,
  options: [{ label: 'Grid', description: 'Cards in an even grid.' }, { label: 'Shelf', description: 'One featured card above a row.' }],
}] }, opts);
const toolRule = (domain, doLine, triggers = []) => ruleNote({ domain, topic: 'layout', extra: ['tools:', '  - AskUserQuestion'], triggers, doLine });
const named = out => [...(denied(out) ?? '').matchAll(/^- (\S+): Do:/gm)].map(m => m[1]).sort();

test('an everywhere domain\'s tools rule reaches a session outside its projects, and the vault folder gets every domain\'s', t => {
  const v = makeVault(t, {
    domains: {
      house: { title: 'House', everywhere: true, topics: ['layout'] },
      other: { title: 'Other', markers: ['other.project'], topics: ['layout'] },
    },
  });
  v.write('wiki/house/rules/house-ask.md', toolRule('house', 'Offer two options.'));
  v.write('wiki/other/rules/other-ask.md', toolRule('other', 'Offer three options.'));
  v.write('wiki/glim/rules/glim-ask.md', toolRule('glim', 'Offer four options.'));
  const sid = sessionId();
  v.startSession(sid);
  const out = ask(v, sid);
  assert.match(denied(out) ?? '', /^Taste rules apply to AskUserQuestion:\n/);
  assert.match(denied(out), /\nRevise this call to follow them, then retry\. The retry is allowed\.$/);
  assert.deepEqual(named(out), ['glim/glim-ask', 'house/house-ask']);
  assert.equal(ask(v, sid), null, 'the retry goes through');
  const inVault = sessionId();
  v.startSession(inVault, { cwd: v.root });
  assert.deepEqual(named(ask(v, inVault, undefined, { cwd: v.root })), ['glim/glim-ask', 'house/house-ask', 'other/other-ask']);
});

test('a second agent of the session is refused once too, and a reworded rule is refused again', t => {
  const v = makeVault(t, { presets: ['glim'] });
  const sid = sessionId();
  v.startSession(sid);
  assert.deepEqual(named(ask(v, sid)), ['glim/ask-rule']);
  assert.equal(ask(v, sid), null);
  assert.deepEqual(named(ask(v, sid, undefined, { agent: 'agent-1' })), ['glim/ask-rule'], 'a subagent is refused once');
  assert.equal(ask(v, sid, undefined, { agent: 'agent-1' }), null);
  v.write('wiki/glim/rules/ask-rule.md', ruleNote({ topic: 'layout', extra: ['tools:', "  - 'AskUserQuestion'"], doLine: 'Offer layouts as two or three options.' }));
  assert.match(denied(ask(v, sid)) ?? '', /glim\/ask-rule: Do: Offer layouts as two or three options\./, 'the reworded rule is refused again');
});

test('a rule with tools and triggers fires only when the call\'s input matches', t => {
  const v = makeVault(t);
  v.write('wiki/glim/rules/color-ask.md', toolRule('glim', 'Show each color as a swatch.', ['\\bcolou?rs?\\b']));
  const sid = sessionId();
  v.startSession(sid);
  assert.equal(ask(v, sid, 'Which card layout?'), null, 'a question without the trigger passes');
  assert.deepEqual(named(ask(v, sid, 'Which colors for the cards?')), ['glim/color-ask']);
});

test('a mapped MCP tool reached by a glob and by tools refuses once', t => {
  const v = makeVault(t, { presets: ['glim'] });
  v.write('wiki/glim/rules/tree-tool.md', ruleNote({ applies_to: ['glim-tree:A.**'], extra: ['tools:', '  - mcp__fixture__set_property'], doLine: 'Name nodes plainly.' }));
  const sid = sessionId();
  v.startSession(sid);
  const set = name => v.edit(sid, 'mcp__fixture__set_property', { path: name, value: 'x' });
  const first = denied(set('A.B.C')) ?? '';
  assert.equal(first.match(/glim\/tree-tool/g)?.length, 1, `the rule is listed once:\n${first}`);
  assert.equal(set('A.B.C'), null, 'the retry goes through');
  assert.deepEqual(named(set('B.A.C')), ['glim/tree-tool'], 'tools reaches a name outside the glob');
  assert.equal(set('B.A.C'), null);
});

test('a rule a glob and tools both reach fires when its trigger matches the target or the whole input', t => {
  const v = makeVault(t, { presets: ['glim'] });
  v.write('wiki/glim/rules/tree-tool.md', ruleNote({ applies_to: ['glim-tree:A.**'], triggers: ['A\\.B'], extra: ['tools:', '  - mcp__fixture__set_property'], doLine: 'Name nodes plainly.' }));
  const sid = sessionId();
  v.startSession(sid);
  const set = name => v.edit(sid, 'mcp__fixture__set_property', { path: name, value: 'x' });
  assert.deepEqual(named(set('Z.A.B')), ['glim/tree-tool'], 'tools alone reaches it, and the input holds A.B');
  assert.deepEqual(named(set('A.B.C')), ['glim/tree-tool'], 'both reach it, and only the input holds A.B');
  assert.equal(set('A.B.C'), null, 'the retry goes through');
  assert.equal(set('Z.A.B'), null);
});

test('a mapped call refused by a tools rule reads as a call, with its pages on the target', t => {
  const v = makeVault(t, { presets: ['glim'] });
  v.write('wiki/glim/rules/tree-tool.md', ruleNote({ extra: ['tools:', '  - mcp__fixture__set_property'], doLine: 'Name nodes plainly.' }));
  v.write('wiki/glim/concepts/tree-page.md', pageNote({ kind: 'concept', summary: "'The tree.'", applies_to: ['glim-tree:A.**'] }));
  const sid = sessionId();
  v.startSession(sid);
  const out = denied(v.edit(sid, 'mcp__fixture__set_property', { path: 'A.B.C', value: 'x' })) ?? '';
  assert.match(out, /^Taste rules apply to mcp__fixture__set_property:\n/);
  assert.match(out, /\nVault pages on glim-tree:A\.B\.C\. Read the ones that bear on this work:\n/);
  assert.match(out, /\nRevise this call to follow them and the pages, then retry\. The retry is allowed\.$/);
});

test('a call with no rule on its name passes', t => {
  const v = makeVault(t, { presets: ['glim'] });
  const sid = sessionId();
  v.startSession(sid);
  assert.equal(v.edit(sid, 'mcp__pkg__lookup', { query: 'layout' }), null);
  assert.equal(v.edit(sid, 'mcp__fixture__set_property', { path: 'B.A.C', value: 'x' }), null);
  const bare = makeVault(t);
  const s = sessionId();
  bare.startSession(s);
  assert.equal(ask(bare, s), null);
});

test('lint errors on a tools name the matcher never sends and on one that edits a file', async t => {
  const v = makeVault(t);
  v.write('wiki/glim/rules/shell.md', ruleNote({ extra: ['tools: [Bash]'] }));
  v.write('wiki/glim/rules/file.md', ruleNote({ extra: ['tools: [Edit]'] }));
  v.write('wiki/glim/rules/todo.md', ruleNote({ extra: ['tools: [TodoWrite]'] }));
  assert.deepEqual((await lintFound(v, /^tools names/)).map(f => [f.level, f.file, f.msg]), [
    ['error', 'wiki/glim/rules/file.md', 'tools names Edit, which edits a file; give the rule applies_to instead'],
    ['error', 'wiki/glim/rules/shell.md', "tools names Bash, which the edit hook's matcher, ^(?:Edit|Write|MultiEdit|NotebookEdit|AskUserQuestion|mcp__.*)$, never sends to the hook, so it would never bring the rule up"],
    ['error', 'wiki/glim/rules/todo.md', "tools names TodoWrite, which the edit hook's matcher, ^(?:Edit|Write|MultiEdit|NotebookEdit|AskUserQuestion|mcp__.*)$, never sends to the hook, so it would never bring the rule up"],
  ]);
});
