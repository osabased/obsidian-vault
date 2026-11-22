import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeVault, ruleNote, denied, sessionId, editVault } from './fixture.mjs';
import { codexInput, codexPatch } from './codex.mjs';

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

const edit = (v, tool, rel, toolInput) => editVault(v, SID, rel, tool, toolInput);

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
  const examples = n => ruleNote().replace('## Examples\n', `## Examples\n${'A long example that takes up most of the note, repeated for length. '.repeat(n)}\n`);
  const v = vault(t, { 'wiki/glim/long.md': examples(6) });
  assert.equal(denied(edit(v, 'Write', 'wiki/glim/long.md', { content: examples(1) })), null);
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
const write = (v, sid, rel, cwd) => editVault(v, sid, rel, 'Write', { content: ruleNote() }, cwd);

test("a new rule file from a session outside the vault folder is refused with the way to propose it, and so is a rule that exists", t => {
  const v = vault(t, { 'wiki/glim/rules/old.md': ruleNote() });
  const why = denied(write(v, SID, NEW_RULE, v.project));
  assert.equal(why, "`wiki/glim/rules/x.md` would be a new rule. Outside the vault folder, rules are kept only through the vault's `propose` tool, so the user agrees to each one. Propose it there.");
  assert.ok(denied(write(v, SID, NEW_RULE, v.project)), 'the refusal repeats; it is not a one-time gate');
  assert.match(denied(write(v, SID, 'wiki/glim/rules/old.md', v.project)) ?? '', /^`wiki\/glim\/rules\/old\.md` is a rule\. Outside the vault folder/);
  assert.ok(denied(write(v, SID, 'wiki/global/rules/x.md', v.project)));
});

const TOPIC_RULE = 'wiki/glim/topics/x.md';
const asRule = (v, sid, cwd) => editVault(v, sid, PAGE_REL, 'Edit', { old_string: 'type: page', new_string: 'type: rule' }, cwd);

test('a note outside rules/ that is a rule once written is refused, whether new or a page turned into one', t => {
  const v = vault(t);
  assert.match(denied(write(v, SID, TOPIC_RULE, v.project)) ?? '', /^`wiki\/glim\/topics\/x\.md` would be a new rule\./);
  assert.match(denied(asRule(v, SID, v.project)) ?? '', /^`wiki\/glim\/source-shop\.md` would be a new rule\./);
});

const ENTITY = 'wiki/global/entities/x.md';
const writePage = (v, sid, rel, cwd, content = PAGE) => editVault(v, sid, rel, 'Write', { content }, cwd);

test('from a project session, a Write to a page under wiki/ is refused and pointed to propose, new or not', t => {
  const v = vault(t);
  assert.equal(denied(writePage(v, SID, ENTITY, v.project)),
    "`wiki/global/entities/x.md` is a vault page. Outside the vault folder, pages change only through the vault's `propose` tool with `page` and `text`, so the user agrees to each change.");
  assert.ok(denied(writePage(v, SID, ENTITY, v.project)), 'the refusal repeats; it is not a one-time gate');
  const more = editVault(v, SID, PAGE_REL, 'Edit', { old_string: READING, new_string: `${READING} More.` }, v.project);
  assert.match(denied(more) ?? '', /^`wiki\/glim\/source-shop\.md` is a vault page\./);
});

test('from a project session, an edit to a rule that exists is refused too, even one that only adds evidence', t => {
  const v = vault(t, { 'wiki/glim/rules/old.md': ruleNote() });
  const file = v.at('wiki', 'glim', 'rules', 'old.md');
  const add = { old_string: '(a-00000001)\n', new_string: '(a-00000001)\n- 2026-10-02 · stated · session 1a2b3c4d · "and again" (a-00000002)\n' };
  assert.match(denied(v.edit(SID, 'Edit', { file_path: file, ...add }, { cwd: v.project })) ?? '', /^`wiki\/glim\/rules\/old\.md` is a rule\./);
  assert.match(denied(v.edit(SID, 'Write', { file_path: file, content: ruleNote({ because: 'Another reason.' }) }, { cwd: v.project })) ?? '', /`propose`/);
});

const RULE = 'wiki/glim/rules/old.md';
const ruleEdit = (v, sid, change, cwd) => editVault(v, sid, RULE, 'Edit', change, cwd);

test("from a vault-folder session, a change to a rule's Do, Not, Because or frontmatter is refused, and an added Evidence line is not", t => {
  const v = vault(t, { [RULE]: ruleNote({ keywords: ['widgetz'] }) });
  assert.equal(denied(ruleEdit(v, SID, { old_string: 'Do the thing.', new_string: 'Do the other thing.' })),
    "`wiki/glim/rules/old.md` is a rule. Its Do, Not, Because and frontmatter change only through the vault's `propose` tool with `key`, so the user agrees to each change. Add Evidence lines as before.");
  assert.ok(denied(ruleEdit(v, SID, { old_string: 'Do the thing.', new_string: 'Do the other thing.' })), 'a retry is refused too');
  assert.ok(denied(ruleEdit(v, SID, { old_string: 'Skip the thing.', new_string: 'Skip it.' })));
  assert.ok(denied(ruleEdit(v, SID, { old_string: '**Because:**', new_string: '**Because:** It reads better.' })));
  assert.ok(denied(ruleEdit(v, SID, { old_string: "- 'widgetz'", new_string: "- 'gadgetz'" })));
  assert.ok(denied(ruleEdit(v, SID, { old_string: 'type: rule', new_string: 'type: page' })), 'a rule turned into a page changes its frontmatter');
  const add = { old_string: '(a-00000001)\n', new_string: '(a-00000001)\n- 2026-10-02 · stated · session 1a2b3c4d · "and again" (a-00000002)\n' };
  assert.equal(denied(ruleEdit(v, SID, add)), null);
  assert.equal(denied(ruleEdit(v, SID, { old_string: '## Examples\n', new_string: '## Examples\n- `src/shop.zq` names its widgets after the screen.\n' })), null);
});

test('from a vault-folder session, a Write that changes a rule\'s Do or frontmatter is refused, and one that only adds an Evidence line is not', t => {
  const evidence = '- 2026-10-02 · stated · session 1a2b3c4d · "and again" (a-00000002)';
  const original = ruleNote();
  const writeRule = (v, content) => editVault(v, SID, RULE, 'Write', { content });
  const crlf = s => `﻿${s.replace(/\n/g, '\r\n')}`;
  for (const [name, wrap] of [['LF', s => s], ['CRLF with a byte order mark', crlf]]) {
    const v = vault(t, { [RULE]: wrap(original) });
    const reworded = wrap(ruleNote({ doLine: 'Do the other thing.' }));
    assert.match(denied(writeRule(v, reworded)) ?? '', /^`wiki\/glim\/rules\/old\.md` is a rule\. Its Do, Not, Because and frontmatter change only through/, `Do line, ${name}`);
    assert.ok(denied(writeRule(v, wrap(ruleNote({ basis: 'inferred' })))), `frontmatter, ${name}`);
    const added = wrap(ruleNote({ evidence: ['- 2026-10-01 · stated · session 1a2b3c4d · "do the thing" (a-00000001)', evidence] }));
    assert.equal(denied(writeRule(v, added)), null, `Evidence line, ${name}`);
  }
});

test('from a vault-folder session, an existing wiki note that cannot be read is refused rather than let through', t => {
  const v = vault(t);
  fs.mkdirSync(v.at('wiki', 'glim', 'rules', 'unreadable.md'), { recursive: true });
  const out = editVault(v, SID, 'wiki/glim/rules/unreadable.md', 'Write', { content: ruleNote({ doLine: 'Do the other thing.' }) });
  assert.match(denied(out) ?? '', /^`wiki\/glim\/rules\/unreadable\.md` is a rule\./);
});

test('from a vault-folder session, queue.md is refused as a generated file, as active.md is', t => {
  const v = vault(t, { 'queue.md': 'generated\n', 'active.md': 'generated\n' });
  const write = rel => editVault(v, SID, rel, 'Write', { content: 'by hand\n' });
  assert.equal(denied(write('active.md')), 'active.md is generated from the notes. Edit the notes instead, then run `node tools/build.mjs`.');
  assert.equal(denied(write('queue.md')), 'queue.md is generated from the entries in raw/queue/. Use tools/queue.mjs instead.');
});

test('from a vault-folder session, a new rule file, or a page turned into a rule, is refused and pointed to propose', t => {
  const v = vault(t);
  for (const out of [write(v, SID, NEW_RULE, v.root), write(v, SID, NEW_RULE, v.at('wiki')), write(v, SID, TOPIC_RULE, v.root), asRule(v, SID, v.root)]) {
    assert.match(denied(out) ?? '', /would be a new rule\. Rules are kept only through the vault's `propose` tool/);
  }
  assert.equal(denied(writePage(v, SID, ENTITY, v.root)), null, 'pages are still written directly in the vault folder');
});

test("the folder the session registered decides, not the folder of the edit", t => {
  const v = vault(t);
  v.startSession(SID, { cwd: v.project });
  assert.ok(denied(writePage(v, SID, ENTITY, v.root)));
  const inside = sessionId();
  v.startSession(inside, { cwd: v.root });
  assert.equal(denied(writePage(v, inside, ENTITY, v.project)), null);
});

const LOG = ['## Log', '- 2026-11-19 · kept · spark burst', '- 2026-11-19 · rejected · spark trail', ''];
const OPEN_PAGE = `${PAGE.replace('updated: 2026-10-01\n', 'updated: 2026-10-01\nopen: true\n')}\n${LOG.join('\n')}`;
const KEPT = '- 2026-11-19 · kept · spark burst';
const fromProject = (v, tool, input, rel = PAGE_REL) => editVault(v, SID, rel, tool, input, v.project);
const bodyOnly = rel => `\`${rel}\` is an open page. Outside the vault folder, its body may be edited directly, but its frontmatter stays as it is and the page stays where it is. Change only the body; a frontmatter change goes through the vault's \`propose\` tool with \`page\` and \`text\`, so the user agrees to it.`;
const unfollowed = rel => `\`${rel}\` is an open page, but this edit can't be followed to check that it changes only the body. Write the page's whole new text instead.`;
const openSet = rel => `${rel} would have open set in its frontmatter. The user sets open themselves; the agent proposes it through the vault's \`propose\` tool with \`page\` and \`text\`.`;

test('from a project session, an open page takes body edits directly through Write, Edit, replace_all and MultiEdit', t => {
  const v = vault(t, { [PAGE_REL]: OPEN_PAGE });
  const more = `${KEPT}\n- 2026-11-20 · kept · ember ring`;
  assert.equal(denied(fromProject(v, 'Edit', { old_string: KEPT, new_string: more })), null, 'Edit');
  assert.equal(denied(fromProject(v, 'Edit', { old_string: 'spark', new_string: 'ember', replace_all: true })), null, 'Edit with replace_all');
  assert.equal(denied(fromProject(v, 'MultiEdit', { edits: [{ old_string: KEPT, new_string: more }, { old_string: 'ember ring', new_string: 'ember halo' }] })), null, 'MultiEdit');
  assert.equal(denied(fromProject(v, 'Write', { content: OPEN_PAGE.replace(KEPT, more) })), null, 'Write');
});

test("from a project session, any change to an open page's frontmatter is refused, every time", t => {
  const v = vault(t, { [PAGE_REL]: OPEN_PAGE });
  const changes = {
    updated: { old_string: 'updated: 2026-10-01', new_string: 'updated: 2026-11-20' },
    topic: { old_string: 'topic: layout', new_string: 'topic: code' },
    'open removed': { old_string: 'open: true\n', new_string: '' },
    'closing --- broken': { old_string: 'open: true\n---', new_string: 'open: true\n--' },
    'leading --- indented': { old_string: '---\ntype: page', new_string: ' ---\ntype: page' },
  };
  for (const [name, change] of Object.entries(changes)) {
    assert.equal(denied(fromProject(v, 'Edit', change)), bodyOnly(PAGE_REL), name);
    assert.equal(denied(fromProject(v, 'Edit', change)), bodyOnly(PAGE_REL), `${name}, retried`);
  }
});

test('from a project session, an edit to an open page the hook cannot follow is refused', t => {
  const v = vault(t, { [PAGE_REL]: OPEN_PAGE });
  assert.equal(denied(fromProject(v, 'Edit', { old_string: 'not in the page', new_string: '' })), unfollowed(PAGE_REL));
  assert.equal(denied(v.edit(SID, 'NotebookEdit', { notebook_path: v.at(...PAGE_REL.split('/')), new_source: 'x' }, { cwd: v.project })), unfollowed(PAGE_REL));
});

test("from a project session, an open page still may not become a rule, and dropping the user's words is refused once", t => {
  const v = vault(t, { [PAGE_REL]: OPEN_PAGE });
  assert.match(denied(asRule(v, SID, v.project)) ?? '', /^`wiki\/glim\/source-shop\.md` would be a new rule\./);
  const cut = { old_string: `${SAID}\n`, new_string: '' };
  assert.match(denied(fromProject(v, 'Edit', cut)) ?? '', /the user's words[\s\S]*the tabs feel cramped/);
  assert.equal(denied(fromProject(v, 'Edit', cut)), null, 'the same edit retried goes through');
});

test('from a project session, an open page the user wrote takes only lines under ## Agent notes', t => {
  const mine = `${OPEN_PAGE.replace('open: true\n', 'open: true\nauthor: user\n')}\n## Agent notes\n- first note\n`;
  const v = vault(t, { [PAGE_REL]: mine });
  assert.equal(denied(fromProject(v, 'Edit', { old_string: '- first note\n', new_string: '- first note\n- second note\n' })), null);
  assert.equal(denied(fromProject(v, 'Edit', { old_string: KEPT, new_string: `${KEPT}!` })),
    "wiki/glim/source-shop.md is the user's own writing, so it stays as they wrote it. Add notes as new lines under ## Agent notes, and change nothing else in the file.");
});

test('from a project session, an open page with CRLF line endings and a byte order mark is guarded the same way', t => {
  const v = vault(t, { [PAGE_REL]: `﻿${OPEN_PAGE.replace(/\n/g, '\r\n')}` });
  assert.equal(denied(fromProject(v, 'Edit', { old_string: KEPT, new_string: `${KEPT}\n- 2026-11-20 · kept · ember ring` })), null, 'a body edit');
  assert.equal(denied(fromProject(v, 'Edit', { old_string: '## You said', new_string: 'Shop notes.\n\n## You said' })), null, 'an edit at the start of the body');
  assert.equal(denied(fromProject(v, 'Edit', { old_string: 'topic: layout', new_string: 'topic: code' })), bodyOnly(PAGE_REL), 'a frontmatter edit');
  assert.match(denied(fromProject(v, 'Edit', { old_string: `${SAID}\n`, new_string: '' })) ?? '', /the user's words/, 'a dropped quote');
});

test('from a project session, a closed page is refused as before, and an edit or a new page that sets open names who opens a page', t => {
  const v = vault(t);
  assert.match(denied(fromProject(v, 'Edit', { old_string: READING, new_string: `${READING} More.` })) ?? '', /^`wiki\/glim\/source-shop\.md` is a vault page\./);
  for (const line of ['open: true', 'open: True', 'Open: true']) {
    assert.equal(denied(fromProject(v, 'Edit', { old_string: 'updated: 2026-10-01\n', new_string: `updated: 2026-10-01\n${line}\n` })), openSet(PAGE_REL), line);
  }
  assert.equal(denied(writePage(v, SID, ENTITY, v.project, OPEN_PAGE)), openSet(ENTITY), 'a new page');
});

test('from a vault-folder session, setting open in any spelling is refused, in a new page too, and removing it is allowed', t => {
  const opened = 'wiki/glim/opened.md';
  const unticked = 'wiki/glim/unticked.md';
  const v = vault(t, { [PAGE_REL]: PAGE, [opened]: OPEN_PAGE, [unticked]: OPEN_PAGE.replace('open: true', 'open: false') });
  const add = line => editVault(v, SID, PAGE_REL, 'Edit', { old_string: 'updated: 2026-10-01\n', new_string: `updated: 2026-10-01\n${line}\n` });
  for (const line of ['open: true', 'open: True', 'Open: true', 'open: false', 'OPEN: yes']) assert.equal(denied(add(line)), openSet(PAGE_REL), line);
  assert.equal(denied(writePage(v, SID, ENTITY, v.root, OPEN_PAGE)), openSet(ENTITY), 'a new page');
  assert.equal(denied(editVault(v, SID, opened, 'Edit', { old_string: 'open: true\n', new_string: 'open: true\nopen: true\n' })), openSet(opened), 'a second open key');
  assert.equal(denied(editVault(v, SID, unticked, 'Edit', { old_string: 'open: false', new_string: 'open: true' })), openSet(unticked), 'false turned to true');
  assert.equal(denied(editVault(v, SID, opened, 'Edit', { old_string: 'open: true\n', new_string: '' })), null, 'removing it');
});

const codexEdit = (v, ops) => v.hook('edit', codexInput('PreToolUse', { session_id: SID, cwd: v.project, tool_input: { command: codexPatch(ops) } }), { agent: 'codex' });
const abs = (v, rel) => v.at(...rel.split('/')).replace(/\\/g, '/');

test("Codex, from a project session: an update to an open page's body passes, and a delete or a move of it is refused", t => {
  const v = makeVault(t, { config: { agents: ['claude-code', 'codex'] } });
  v.write(PAGE_REL, OPEN_PAGE);
  assert.equal(denied(codexEdit(v, [{ update: abs(v, PAGE_REL), chunks: [{ context: '## Log', lines: [` ${KEPT}`, '+- 2026-11-20 · kept · ember ring'] }] }])), null, 'a body update');
  assert.equal(denied(codexEdit(v, [{ update: abs(v, PAGE_REL), chunks: [{ lines: ['-updated: 2026-10-01', '+updated: 2026-11-20'] }] }])), bodyOnly(PAGE_REL), 'a frontmatter update');
  assert.equal(denied(codexEdit(v, [{ delete: abs(v, PAGE_REL) }])), bodyOnly(PAGE_REL), 'a delete');
  const moved = 'wiki/glim/source-shop-2.md';
  const why = denied(codexEdit(v, [{ update: abs(v, PAGE_REL), moveTo: abs(v, moved), chunks: [{ context: '## Log', lines: [` ${KEPT}`, '+- more'] }] }])) ?? '';
  assert.ok(why.includes(bodyOnly(PAGE_REL)), `the move's source: ${why}`);
  assert.ok(why.includes(openSet(moved)), `the move's destination: ${why}`);
});
