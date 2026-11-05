import fs from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeVault, pageNote, denied, lintFound, editVault } from './fixture.mjs';

const SID = '9f8e7d6c-0000-4000-8000-000000000003';
const REL = 'wiki/glim/concepts/journal.md';
const AGENT_REL = 'wiki/glim/concepts/agent-journal.md';
const SEEN = '- the shop screen packs six tabs into one strip';
const BODY = ['Cards need room to breathe.', 'Tabs should never feel cramped.', '', '## Agent notes', SEEN];
const mine = (body = BODY, extra = ['author: user']) => pageNote({ kind: 'concept', topic: "''", summary: "''", extra, body });

function vault(t, { text = mine(), rel = REL } = {}) {
  const v = makeVault(t);
  v.write(rel, text);
  return v;
}

// Only a session in the vault folder edits a page by hand; elsewhere a page changes through an offer.
const edit = (v, tool, toolInput, rel = REL) => editVault(v, SID, rel, tool, toolInput);
const change = (old_string, new_string) => ({ old_string, new_string });

// The journal preset's page is the user's own, with an empty ## Agent notes section.
const JOURNAL = 'wiki/journal/concepts/morning-pages.md';
const journal = t => {
  const v = makeVault(t, { presets: ['journal'] });
  v.startSession(SID, { cwd: v.root });
  return v;
};

test("6.1f: an Edit that changes the body of a user's page is denied, with no retry", t => {
  const v = journal(t);
  const bad = change('three pages before', 'two pages before');
  const out = edit(v, 'Edit', bad, JOURNAL);
  assert.match(denied(out) ?? '', /wiki\/journal\/concepts\/morning-pages\.md is the user's own writing[\s\S]*new lines under ## Agent notes/);
  assert.doesNotMatch(denied(out), /retry/);
  assert.ok(denied(edit(v, 'Edit', bad, JOURNAL)));
});

test('6.1f: an Edit that adds a line under ## Agent notes passes', t => {
  const v = journal(t);
  const heading = '## Agent notes\n';
  assert.equal(denied(edit(v, 'Edit', change(heading, `${heading}- she writes by hand\n`), JOURNAL)), null);
  v.write(JOURNAL, v.read(JOURNAL).replace(heading, `${heading}- she writes by hand\n`));
  assert.equal(denied(edit(v, 'MultiEdit', { edits: [change('by hand', 'by hand\n- first'), change('- first', '- first\n- second')] }, JOURNAL)), null);
});

test('a Write that keeps the page and adds lines under ## Agent notes passes', t => {
  const v = vault(t);
  assert.equal(denied(edit(v, 'Write', { content: `${mine().trimEnd()}\n- the grid is 12px\n` })), null);
});

test('a line added above ## Agent notes, or a new heading, is denied', t => {
  const v = vault(t);
  assert.ok(denied(edit(v, 'Edit', change('## Agent notes', '- slipped in\n## Agent notes'))));
  assert.ok(denied(edit(v, 'Edit', change(SEEN, `${SEEN}\n## Another section\n- also slipped in`))));
  assert.ok(denied(edit(v, 'Edit', change(SEEN, `${SEEN}\n# A title`))));
});

test('one Edit that adds a note and also changes the body is denied', t => {
  const v = vault(t);
  const both = mine().replace('Cards need', 'Cards want').replace(SEEN, `${SEEN}\n- the grid is 12px`);
  assert.ok(denied(edit(v, 'Write', { content: both })));
});

test('appending ## Agent notes with lines at the end of a page without one passes', t => {
  const v = vault(t, { text: mine(BODY.slice(0, 2)) });
  assert.equal(denied(edit(v, 'Edit', change('feel cramped.', `feel cramped.\n\n## Agent notes\n${SEEN}`))), null);
  assert.equal(denied(edit(v, 'Write', { content: `${mine(BODY.slice(0, 2))}\n## Agent notes\n${SEEN}\n` })), null);
});

test('adding the heading anywhere but the end, or with no lines, is denied', t => {
  const v = vault(t, { text: mine(BODY.slice(0, 2)) });
  assert.ok(denied(edit(v, 'Edit', change('Cards need', `## Agent notes\n${SEEN}\n\nCards need`))));
  assert.ok(denied(edit(v, 'Edit', change('feel cramped.', 'feel cramped.\n\n## Agent notes'))));
});

test('changing, removing or reordering an existing agent-notes line is denied', t => {
  const v = vault(t, { text: mine([...BODY, '- the tab bar is at the top']) });
  assert.ok(denied(edit(v, 'Edit', change(SEEN, '- the shop screen has six tabs'))));
  assert.ok(denied(edit(v, 'Edit', change(`${SEEN}\n`, ''))));
  assert.ok(denied(edit(v, 'Edit', change(`${SEEN}\n- the tab bar is at the top`, `- the tab bar is at the top\n${SEEN}`))));
});

test("a Write that rewrites a user page's frontmatter is denied", t => {
  const v = vault(t);
  assert.match(denied(edit(v, 'Write', { content: mine().replace("summary: ''", 'summary: Notes on the shop.') })) ?? '', /the user's own writing/);
  assert.ok(denied(edit(v, 'Write', { content: mine(BODY, ['author: agent']) })));
  assert.ok(denied(edit(v, 'Edit', change('author: user', 'author: agent'))));
});

test('a Write that creates a page with author: user is denied, and so is an Edit that flips author: agent to user', t => {
  const v = vault(t, { text: mine(BODY, []), rel: AGENT_REL });
  const created = denied(edit(v, 'Write', { content: mine() }, 'wiki/glim/concepts/new.md'));
  assert.match(created ?? '', /sets author: user themselves/);
  const flipped = denied(edit(v, 'Edit', change('summary: \'\'', "summary: ''\nauthor: user"), AGENT_REL));
  assert.match(flipped ?? '', /sets author: user themselves/);
  assert.match(denied(edit(v, 'Write', { content: mine() }, AGENT_REL)) ?? '', /sets author: user themselves/);
});

test('a page without author: user is edited as before', t => {
  const v = vault(t, { text: mine(BODY, []) });
  assert.equal(denied(edit(v, 'Edit', change('Tabs should never feel cramped.', 'Tabs may feel cramped.'))), null);
  assert.equal(denied(edit(v, 'Write', { content: mine(BODY, ['author: agent']) })), null);
  assert.equal(denied(edit(v, 'Write', { content: mine(BODY, []) }, 'wiki/glim/concepts/new.md')), null);
});

const rule = (extra = {}) => ({
  domain: 'glim', slug: 'roomy-cards', topic: 'layout', basis: 'stated', page: REL, quote: 'Cards need room to breathe',
  do: 'Leave 12px around cards.', not: 'Pack cards edge to edge.', because: '', applies_to: ['src/**/*.zq'], ...extra,
});

function proposer(t, opts) {
  const v = vault(t, opts);
  v.startSession(SID);
  return v;
}

test("propose writes a rule quoting a user's page, naming the page's path in the Evidence line", t => {
  const v = proposer(t);
  const r = v.propose(SID, rule());
  assert.equal(r.code, 0, r.stderr);
  assert.match(v.read('wiki/glim/rules/roomy-cards.md'), /^- \d{4}-\d\d-\d\d · stated · wiki\/glim\/concepts\/journal\.md · "Cards need room to breathe" \(a-[0-9a-f]{8}\)$/m);
});

test('the quote may leave words out with … and is matched by the transcript rules', t => {
  const v = proposer(t);
  assert.equal(v.propose(SID, rule({ quote: 'cards  NEED room … breathe' })).code, 0);
  const r = v.propose(SID, rule({ slug: 'other-rule', quote: 'breathe … Cards need' }));
  assert.equal(r.code, 1);
});

test('a knowledge rule may cite the page the same way', t => {
  const v = proposer(t);
  const r = v.propose(SID, rule({ kind: 'knowledge', slug: 'card-spacing', quote: 'Tabs should never feel cramped' }));
  assert.equal(r.code, 0, r.stderr);
  assert.match(v.read('wiki/glim/rules/card-spacing.md'), / · stated · wiki\/glim\/concepts\/journal\.md · "Tabs should never feel cramped"/);
});

test('6.1f: a quote the user note does not hold is refused', t => {
  const v = journal(t);
  const mine = { domain: 'journal', slug: 'pages-first', topic: 'days', basis: 'stated', page: JOURNAL, do: 'Leave mail until after the pages.', not: 'Open mail first.', because: '', applies_to: ['notes/**'] };
  const ok = v.propose(SID, { ...mine, quote: 'three pages before I open any mail' });
  assert.equal(ok.code, 0, ok.stderr);
  const r = v.propose(SID, { ...mine, slug: 'no-mail', quote: 'I never open mail' });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /the quote isn't in wiki\/journal\/concepts\/morning-pages\.md/);
  assert.equal(v.exists('wiki/journal/rules/no-mail.md'), false);
});

test("a quote only in ## Agent notes, or only in the page's frontmatter, is refused", t => {
  const v = proposer(t, { text: pageNote({ kind: 'concept', topic: 'layout', summary: 'Shop notes', extra: ['author: user'], body: BODY }) });
  for (const [slug, quote] of [['from-notes', 'packs six tabs'], ['from-summary', 'Shop notes'], ['from-topic', 'layout']]) {
    const r = v.propose(SID, rule({ slug, quote }));
    assert.equal(r.code, 1, quote);
    assert.match(r.stderr, /the quote isn't in wiki\/glim\/concepts\/journal\.md/);
  }
});

test('a page that is not author: user, or is not there, is refused', t => {
  const v = proposer(t, { text: mine(BODY, []) });
  const agent = v.propose(SID, rule());
  assert.equal(agent.code, 1);
  assert.match(agent.stderr, /isn't an author: user page/);
  v.write('wiki/glim/rules/some-rule.md', '---\ntype: rule\ndomain: glim\n---\n\nCards need room to breathe\n');
  assert.match(v.propose(SID, rule({ page: 'wiki/glim/rules/some-rule.md' })).stderr, /isn't an author: user page/);
  assert.match(v.propose(SID, rule({ page: 'wiki/glim/concepts/gone.md' })).stderr, /there's no file at wiki\/glim\/concepts\/gone\.md/);
  assert.match(v.propose(SID, rule({ page: 'raw/refs/x.md' })).stderr, /page must be a page under wiki\//);
});

test('page is for basis stated only', t => {
  const v = proposer(t);
  const r = v.propose(SID, rule({ basis: 'reading', reading: 'The user likes cards.' }));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /page is only for basis stated/);
});

test('a repeat adds the Evidence line with the path to the rule it repeats', t => {
  const v = proposer(t);
  assert.equal(v.propose(SID, rule()).code, 0);
  const r = v.propose(SID, rule({ slug: 'again', quote: 'Tabs should never feel cramped', repeats: 'glim/roomy-cards' }));
  assert.equal(r.code, 0, r.stderr);
  const text = v.read('wiki/glim/rules/roomy-cards.md');
  assert.match(text, /· stated · wiki\/glim\/concepts\/journal\.md · "Cards need room to breathe"/);
  assert.match(text, /· stated · wiki\/glim\/concepts\/journal\.md · "Tabs should never feel cramped"/);
});

test('Evidence lines naming a page are read as lines without a session', async t => {
  const v = proposer(t);
  assert.equal(v.propose(SID, rule()).code, 0);
  const rules = await v.import('lib/rules.mjs');
  const n = rules.readNote('glim/roomy-cards');
  assert.deepEqual(rules.evidenceSessions(n), []);
  const [{ id, ...quote }, ...more] = rules.evidenceQuotes(n);
  assert.deepEqual([quote, ...more], [{ session: undefined, note: 'wiki/glim/concepts/journal.md', source: undefined, quote: 'Cards need room to breathe' }]);
  assert.match(id, /^a-[0-9a-f]{8}$/);
});

test('lint checks the quote against the page and warns when the sentence is gone', async t => {
  const v = proposer(t);
  assert.equal(v.propose(SID, rule()).code, 0);
  assert.deepEqual(await lintFound(v, /Evidence|isn't in/), []);
  v.write(REL, mine(['Cards can be tight.', '', '## Agent notes', 'Cards need room to breathe, the user said.']));
  const found = await lintFound(v, /isn't in/);
  assert.equal(found.length, 1);
  assert.equal(found[0].file, 'wiki/glim/rules/roomy-cards.md');
  assert.match(found[0].msg, /"Cards need room to breathe" isn't in wiki\/glim\/concepts\/journal\.md/);
});

test('lint warns when the cited page is gone or is no longer the user\'s', async t => {
  const v = proposer(t);
  assert.equal(v.propose(SID, rule()).code, 0);
  v.write(REL, mine(BODY, []));
  assert.match((await lintFound(v, /Evidence/))[0]?.msg ?? '', /cites wiki\/glim\/concepts\/journal\.md, which isn't an author: user page/);
  v.write(REL, 'nothing');
  assert.equal((await lintFound(v, /Evidence/)).length, 1);
});

test('the inbox row of a rule quoting a page names the page, for a new rule and for a repeat', t => {
  const v = proposer(t);
  assert.equal(v.propose(SID, rule()).code, 0);
  assert.equal(v.propose(SID, rule({ slug: 'again', quote: 'Tabs should never feel cramped', repeats: 'glim/roomy-cards' })).code, 0);
  const rows = fs.readdirSync(v.at('raw', 'inbox')).flatMap(f => v.read(`raw/inbox/${f}`).trim().split(/\r?\n/).map(l => JSON.parse(l)));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(r => r.page), [REL, REL]);
  assert.deepEqual(rows.map(r => r.text), ['Cards need room to breathe', 'Tabs should never feel cramped']);
});

test('a # heading ends ## Agent notes, so lines under it stay the user\'s', async t => {
  const v = vault(t, { text: mine(['My words.', '', '## Agent notes', '- n', '', '# Later', 'User later words.']) });
  assert.ok(denied(edit(v, 'Edit', change('User later words.', 'User later words.\n- slipped into the user section'))));
  assert.equal(denied(edit(v, 'Edit', change('- n', '- n\n- added'))), null);
  const { userWords } = await v.import('lib/rules.mjs');
  assert.match(userWords(v.read(REL)), /# Later\nUser later words\./);
});

test('a ### heading may be added under ## Agent notes', t => {
  const v = vault(t);
  assert.equal(denied(edit(v, 'Edit', change(SEEN, `${SEEN}\n### Shop\n- the grid is 12px`))), null);
});

test('an added line that moves the end of ## Agent notes, such as an unclosed fence, is denied', t => {
  const v = vault(t, { text: mine(['Mine.', '', '## Agent notes', '- n', '', '## Mine too', 'theirs']) });
  assert.ok(denied(edit(v, 'Edit', change('- n', '- n\n```'))));
  assert.ok(denied(edit(v, 'Edit', change('- n', '- n\n~~~~'))));
  assert.equal(denied(edit(v, 'Edit', change('- n', '- n\n```\ncode\n```'))), null);
  const fenced = vault(t, { text: mine(['Mine.', '```', 'code']) });
  assert.ok(denied(edit(fenced, 'Edit', change('code', `code\n\n## Agent notes\n${SEEN}`))));
});

test('a Write that only drops or adds a byte order mark, or adds a note too, is compared without it', t => {
  const text = mine();
  const v = vault(t, { text: `\uFEFF${text}` });
  assert.equal(denied(edit(v, 'Write', { content: text })), null);
  assert.equal(denied(edit(v, 'Write', { content: `${text.trimEnd()}\n- added\n` })), null);
  assert.equal(denied(edit(v, 'Write', { content: `\uFEFF${text.trimEnd()}\n- added\n` })), null);
  const plain = vault(t);
  assert.equal(denied(edit(plain, 'Write', { content: `\uFEFF${text}` })), null);
  assert.ok(denied(edit(plain, 'Write', { content: `\uFEFF${text.replace('Cards need', 'Cards want')}` })));
});

test('a file in a worktree of the vault is guarded as the same file in the vault', t => {
  const rel = `.claude/worktrees/w1/${REL}`;
  const v = vault(t, { rel });
  assert.match(denied(edit(v, 'Edit', change('Tabs should never feel cramped.', 'Tabs may feel cramped.'), rel)) ?? '', /^wiki\/glim\/concepts\/journal\.md is the user's own writing/);
  v.write('.claude/worktrees/w1/raw/refs/a.md', 'x');
  assert.match(denied(edit(v, 'Write', { content: 'y' }, '.claude/worktrees/w1/raw/refs/a.md')) ?? '', /raw\/ is append-only: raw\/refs\/a\.md already exists/);
  assert.match(denied(edit(v, 'Write', { content: 'y' }, '.claude/worktrees/w1/index.md')) ?? '', /^index\.md is generated/);
});

test("an Edit with an empty old_string, which writes the whole file, may not make a page the user's", t => {
  const v = makeVault(t);
  assert.match(denied(edit(v, 'Edit', change('', mine()))) ?? '', /would be marked author: user/);
  v.write(REL, '\n');
  assert.match(denied(edit(v, 'Edit', change('', mine()))) ?? '', /would be marked author: user/);
});

test('an old_string that spells a character as \\uXXXX is matched as Claude Code matches it, and an edit the guard cannot follow is denied', t => {
  const cafe = ['Café menus stay short.', '', '## Agent notes', SEEN];
  const v = vault(t, { text: mine(cafe) });
  assert.ok(denied(edit(v, 'Edit', change('Caf\\u00e9 menus stay short.', 'Menus can be long.'))));
  assert.equal(denied(edit(v, 'Edit', change(`Caf\\u00e9 menus stay short.\n\n## Agent notes\n${SEEN}`, `${cafe.join('\n')}\n- the grid is 12px`))), null);
  const escaped = vault(t, { text: mine(['Caf\\u00e9 menus stay short.', '', '## Agent notes', SEEN]) });
  assert.match(denied(edit(escaped, 'Edit', change('Café menus stay short.', 'Menus can be long.'))) ?? '', /is the user's own writing/);
});

test("frontmatter lines that read as a heading or a fence don't move ## Agent notes", t => {
  const head = ['---', 'type: page', 'domain: glim', 'kind: concept', "topic: ''", "summary: ''", 'author: user'];
  const commented = vault(t, { text: [...head, '## Agent notes', '---', '# Journal', 'Cards need room.', ''].join('\n') });
  assert.ok(denied(edit(commented, 'Edit', change('## Agent notes\n---', '## Agent notes\nstatus: draft\n---'))));
  assert.ok(denied(edit(commented, 'Edit', change('## Agent notes\n---', '## Agent notes\nauthor: agent\n---'))));
  assert.ok(denied(edit(commented, 'Edit', change('---\n# Journal', '---\nThe agent wrote this.\n# Journal'))));
  const fenced = vault(t, { text: [...head, 'note: |', '  ```js', '  x', '---', 'Cards need room.', '', '## Agent notes', SEEN, ''].join('\n') });
  assert.equal(denied(edit(fenced, 'Edit', change(`${SEEN}\n`, `${SEEN}\n- the grid is 12px\n`))), null);
});

test("author: user as a one-item list, or in capitals, still marks the page as the user's", async t => {
  for (const extra of [['author:', '  - user'], ['author: [user]'], ['author: User']]) {
    const v = vault(t, { text: mine(BODY, extra) });
    assert.ok(denied(edit(v, 'Edit', change('Tabs should never feel cramped.', 'Tabs may feel cramped.'))), extra.join(' '));
  }
  assert.deepEqual(await lintFound(vault(t, { text: mine(BODY, ['author:', '  - user']) }), /^(?:author|no topic|no summary)/), []);
  assert.deepEqual((await lintFound(vault(t, { text: mine(BODY, ['author: User']) }), /author/)).map(f => [f.level, f.msg]), [['error', 'author must be user or agent']]);
});

test("a tool editTools maps to the file namespace is denied on a user's page rather than failing the hook", t => {
  const v = makeVault(t, { config: { editTools: { mcp__fixture__write_page: { namespace: 'file', path: 'tool_input.path', after: 'tool_input.text' } } } });
  v.write(REL, mine());
  const out = v.edit(SID, 'mcp__fixture__write_page', { path: v.at(...REL.split('/')), text: 'Cards may be cramped.\n' }, { cwd: v.root });
  assert.match(denied(out) ?? '', /^wiki\/glim\/concepts\/journal\.md is the user's own writing/);
});
