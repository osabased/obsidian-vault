import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeVault, ruleNote, denied, sessionId } from './fixture.mjs';

const SID = '9f8e7d6c-0000-4000-8000-000000000002';
const PAGE_REL = 'wiki/glim/source-shop.md';
const SAID = '- 2026-10-01 · session 1a2b3c4d · "the cards breathe, the tabs feel cramped"';
const READING = 'Cards sit on a 12px grid with roomy padding; the tab bar packs six tabs into the top strip.';

const PAGE = [
  '---', 'type: page', 'domain: glim', 'kind: source', 'topic: layout', 'summary: Shop screens where the tabs feel cramped.', 'source: raw/refs/shop.png',
  'created: 2026-10-01', 'updated: 2026-10-01', '---', '',
  '## You said', SAID, '- 2026-10-02 · session 1a2b3c4d · "more room around tabs"', '',
  "## Agent's reading", READING, 'The shop header uses the same accent as the buy buttons, and the prices sit right-aligned.', '',
  '## Rules', '- [[wiki/glim/roomy-cards|roomy-cards]]', '',
].join('\n');

function vault(t, files = { [PAGE_REL]: PAGE }) {
  const v = makeVault(t);
  for (const [rel, text] of Object.entries(files)) v.write(rel, text);
  return v;
}

const edit = (v, tool, rel, toolInput) => v.edit(SID, tool, { file_path: v.at(...rel.split('/')), ...toolInput }, { cwd: v.root });

test("an edit that removes the user's words is refused once, and the same edit retried goes through", t => {
  const v = vault(t);
  const cut = { old_string: `${SAID}\n`, new_string: '' };
  assert.match(denied(edit(v, 'Edit', PAGE_REL, cut)) ?? '', /the user's words[\s\S]*the tabs feel cramped/);
  assert.equal(denied(edit(v, 'Edit', PAGE_REL, cut)), null);
});

test('a different edit that still removes the words is refused again', t => {
  const v = vault(t);
  assert.ok(denied(edit(v, 'Edit', PAGE_REL, { old_string: `${SAID}\n`, new_string: '' })));
  assert.ok(denied(edit(v, 'Edit', PAGE_REL, { old_string: SAID, new_string: '- 2026-10-01 · "the cards breathe"' })));
});

test('an Evidence line removed from a rule note by Write is refused', t => {
  const evidence = ['- 2026-10-01 · stated · session 1a2b3c4d · "do the thing" (a-00000001)', '- 2026-10-03 · correction · session 5e6f7a8b · "no, do the thing" (a-00000002)'];
  const rule = ruleNote({ evidence });
  const v = vault(t, { 'wiki/glim/the-thing.md': rule });
  const out = edit(v, 'Write', 'wiki/glim/the-thing.md', { content: rule.replace(`${evidence[1]}\n`, '') });
  assert.match(denied(out) ?? '', /no, do the thing/);
});

test('adding, reordering or keeping quoted lines is allowed', t => {
  const v = vault(t);
  const added = `${SAID}\n- 2026-10-04 · session 1a2b3c4d · "and bigger prices"`;
  assert.equal(denied(edit(v, 'Edit', PAGE_REL, { old_string: SAID, new_string: added })), null);
  const lines = PAGE.split('\n');
  const i = lines.indexOf(SAID);
  [lines[i], lines[i + 1]] = [lines[i + 1], lines[i]];
  assert.equal(denied(edit(v, 'Write', PAGE_REL, { content: lines.join('\n') })), null);
  assert.equal(denied(edit(v, 'Edit', PAGE_REL, { old_string: READING, new_string: `${READING} The grid holds on phones.` })), null);
});

test('MultiEdit edits apply in order before the check', t => {
  const v = vault(t);
  const edits = [{ old_string: SAID, new_string: 'MARK' }, { old_string: 'MARK\n', new_string: '' }];
  assert.ok(denied(edit(v, 'MultiEdit', PAGE_REL, { edits })));
});

test('an Edit whose old_string matches twice is left to the tool unless it has replace_all', t => {
  const v = vault(t);
  const change = { old_string: 'tabs feel cramped', new_string: 'tabs feel tight' };
  assert.equal(denied(edit(v, 'Edit', PAGE_REL, change)), null);
  assert.ok(denied(edit(v, 'Edit', PAGE_REL, { ...change, replace_all: true })));
});

test('a page cut below 70% of its length is refused once', t => {
  const v = vault(t);
  const reading = PAGE.slice(PAGE.indexOf("## Agent's reading"), PAGE.indexOf('## Rules'));
  const cut = { old_string: reading, new_string: "## Agent's reading\nCards.\n\n" };
  assert.match(denied(edit(v, 'Edit', PAGE_REL, cut)) ?? '', /cuts wiki\/glim\/source-shop\.md to \d+%/);
  assert.equal(denied(edit(v, 'Edit', PAGE_REL, cut)), null);
});

test('a page trimmed by less than 30% is allowed', t => {
  const v = vault(t);
  assert.equal(denied(edit(v, 'Edit', PAGE_REL, { old_string: ', and the prices sit right-aligned', new_string: '' })), null);
});

test('a rule note may shrink', t => {
  const long = ruleNote({ because: 'A long reason that takes up most of the note, repeated for length. '.repeat(6) });
  const v = vault(t, { 'wiki/glim/long.md': long });
  assert.equal(denied(edit(v, 'Write', 'wiki/glim/long.md', { content: ruleNote({ because: 'Short.' }) })), null);
});

test('a new page, an edit that would not apply and files outside wiki/ are not checked', t => {
  const v = vault(t, { [PAGE_REL]: PAGE, 'notes/scratch.md': PAGE });
  assert.equal(denied(edit(v, 'Write', 'wiki/glim/source-new.md', { content: PAGE })), null);
  assert.equal(denied(edit(v, 'Edit', PAGE_REL, { old_string: 'not in the page', new_string: '' })), null);
  assert.equal(denied(edit(v, 'Write', 'notes/scratch.md', { content: '' })), null);
});

test('CRLF line endings and a byte order mark do not hide a removed quote or a cut page', t => {
  const v = vault(t, { [PAGE_REL]: `﻿${PAGE.replace(/\n/g, '\r\n')}` });
  assert.ok(denied(edit(v, 'Edit', PAGE_REL, { old_string: `${SAID}\n`, new_string: '' })));
  const reading = PAGE.slice(PAGE.indexOf("## Agent's reading"), PAGE.indexOf('## Rules'));
  assert.match(denied(edit(v, 'Edit', PAGE_REL, { old_string: reading, new_string: '' })) ?? '', /cuts/);
});

test('an old_string with straight quotes still finds curly ones, as the Edit tool does', t => {
  const curly = SAID.replace('"', '“').replace('"', '”');
  const v = vault(t, { [PAGE_REL]: PAGE.replace(SAID, curly) });
  assert.match(denied(edit(v, 'Edit', PAGE_REL, { old_string: `${SAID}\n`, new_string: '' })) ?? '', /the tabs feel cramped/);
});

const NEW_RULE = 'wiki/glim/rules/x.md';
const write = (v, sid, rel, cwd) => v.edit(sid, 'Write', { file_path: v.at(...rel.split('/')), content: ruleNote() }, { cwd });

test("a new rule file from a session outside the vault folder is refused with the way to propose it, and a rule that exists is not", t => {
  const v = vault(t, { 'wiki/glim/rules/old.md': ruleNote() });
  const why = denied(write(v, SID, NEW_RULE, v.project));
  assert.equal(why, "`wiki/glim/rules/x.md` would be a new rule. Outside the vault folder, rules are kept only through the vault's `propose` tool, so the user agrees to each one. Propose it there.");
  assert.ok(denied(write(v, SID, NEW_RULE, v.project)), 'the refusal repeats; it is not a one-time gate');
  assert.equal(denied(write(v, SID, 'wiki/glim/rules/old.md', v.project)), null);
  assert.ok(denied(write(v, SID, 'wiki/global/rules/x.md', v.project)));
});

const TOPIC_RULE = 'wiki/glim/topics/x.md';
const asRule = (v, sid, cwd) => v.edit(sid, 'Edit', { file_path: v.at(...PAGE_REL.split('/')), old_string: 'type: page', new_string: 'type: rule' }, { cwd });

test('a note outside rules/ that is a rule once written is refused, whether new or a page turned into one', t => {
  const v = vault(t);
  assert.match(denied(write(v, SID, TOPIC_RULE, v.project)) ?? '', /^`wiki\/glim\/topics\/x\.md` would be a new rule\./);
  assert.match(denied(asRule(v, SID, v.project)) ?? '', /^`wiki\/glim\/source-shop\.md` would be a new rule\./);
});

test('a new page outside rules/ and an edit to a note that is already a rule are allowed from a project session', t => {
  const v = vault(t, { 'wiki/glim/topics/old.md': ruleNote() });
  const page = v.edit(SID, 'Write', { file_path: v.at(...TOPIC_RULE.split('/')), content: PAGE }, { cwd: v.project });
  assert.equal(denied(page), null);
  const reword = v.edit(SID, 'Write', { file_path: v.at('wiki', 'glim', 'topics', 'old.md'), content: ruleNote({ because: 'Another reason.' }) }, { cwd: v.project });
  assert.equal(denied(reword), null);
});

test('a new rule file from a session in the vault folder is allowed', t => {
  const v = vault(t);
  assert.equal(denied(write(v, SID, NEW_RULE, v.root)), null);
  assert.equal(denied(write(v, SID, NEW_RULE, v.at('wiki'))), null);
  assert.equal(denied(write(v, SID, TOPIC_RULE, v.root)), null);
  assert.equal(denied(asRule(v, SID, v.root)), null);
});

test("the folder the session registered decides, not the folder of the edit", t => {
  const v = vault(t);
  v.startSession(SID, { cwd: v.project });
  assert.ok(denied(write(v, SID, NEW_RULE, v.root)));
  const inside = sessionId();
  v.startSession(inside, { cwd: v.root });
  assert.equal(denied(write(v, inside, NEW_RULE, v.project)), null);
});
