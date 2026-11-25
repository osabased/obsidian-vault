import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeVault, ruleNote, pageNote as page, sourcePage, userTurn, assistantTurn, lintFound } from './fixture.mjs';

const SID = '9f8e7d6c-0000-4000-8000-000000000004';
const SID8 = SID.slice(0, 8);

test('the index lists a topic\'s pages by kind, each but a source page with how many sources it draws on', async t => {
  const v = makeVault(t);
  v.write('raw/refs/notes.md', 'notes');
  v.write('wiki/glim/source-changelog.md', sourcePage({ source: 'https://example.com/changelog' }));
  v.write('wiki/glim/source-notes.md', sourcePage({ source: 'raw/refs/notes.md' }));
  v.write('wiki/glim/strict-mode.md', page({ kind: 'synthesis', body: ['Typed.[^1]', '', '[^1]: https://example.com/changelog · dated 2026-09-30'] }));
  v.write('wiki/glim/lit-types.md', page({ kind: 'concept', body: ['Typed.[^1] Strict.[^2]', '', '[^1]: raw/refs/notes.md', '[^2]: https://example.com/strict'] }));
  v.write('wiki/glim/code.md', page({
    kind: 'topic', body: ['From [[wiki/glim/source-changelog|source-changelog]] and [[source-notes]].[^1]', '', '[^1]: https://example.com/changelog', '', '## Rules'],
  }));
  v.write('wiki/glim/runner.md', page({ kind: 'entity' }));
  v.write('wiki/glim/some-rule.md', ruleNote({ keywords: ['x'] }));
  const rules = await v.import('lib/rules.mjs');
  const lines = rules.renderIndex(rules.loadNotes()).split('\n').filter(l => l.startsWith('- '));
  assert.deepEqual(lines.slice(0, 6).map(l => l.split(' · ').slice(0, 3).join(' · ')), [
    '- [[wiki/glim/code|code]] · topic page · 2 sources',
    '- [[wiki/glim/lit-types|lit-types]] · concept page · 2 sources',
    '- [[wiki/glim/runner|runner]] · entity page · no sources',
    '- [[wiki/glim/strict-mode|strict-mode]] · synthesis page · 1 source',
    '- [[wiki/glim/source-changelog|source-changelog]] · source page · What we know.',
    '- [[wiki/glim/source-notes|source-notes]] · source page · What we know.',
  ]);
  assert.match(lines[6], /^- \[\[wiki\/glim\/some-rule\|some-rule\]\] · /);
});

test('lint warns on a page missing a section its kind has, or holding a source field only a source page takes', async t => {
  const v = makeVault(t);
  v.write('wiki/glim/source-shop.md', sourcePage({ source: 'https://example.com/shop', body: ['## You said', '', 'Shows a shop.'] }));
  v.write('wiki/glim/source-full.md', sourcePage({ source: 'https://example.com/full' }));
  v.write('wiki/glim/code.md', page({ kind: 'topic' }));
  v.write('wiki/glim/layout.md', page({ kind: 'topic', topic: 'layout', body: ['## Rules'] }));
  v.write('wiki/glim/lit-types.md', page({ kind: 'concept', extra: ['source: https://example.com/x', 'source_date: 2026-09-30'] }));
  v.write('wiki/glim/runner.md', page({ kind: 'entity', extra: ['source: notes.md'] }));
  const found = await lintFound(v, /section|for source pages/);
  assert.deepEqual((await lintFound(v, /./)).filter(f => f.level === 'error'), []);
  assert.deepEqual(found.map(f => [f.file, f.msg]).sort(), [
    ['wiki/glim/code.md', 'no ## Rules section. A topic page has ## Rules, even when it is empty'],
    ['wiki/glim/lit-types.md', 'source and source_date are for source pages. Cite a source with a footnote instead'],
    ['wiki/glim/runner.md', 'source is for source pages. Cite a source with a footnote instead'],
    ['wiki/glim/source-shop.md', "no ## Agent's reading or ## Rules section. A source page has ## You said, ## Agent's reading and ## Rules, even when one is empty"],
  ]);
  assert.ok(found.every(f => f.level === 'warn'));
});

test('lint warns on a footnote that names no source, one cited but never written, and one written but never cited', async t => {
  const v = makeVault(t);
  v.write('raw/refs/shop.png', 'png');
  v.write('wiki/glim/lit-types.md', page({
    kind: 'concept', body: [
      'One.[^1] Two.[^2] Three.[^3] Four.[^4] Five.[^gone] In code: `[^code]`.', 'Tabs[^5]: home and shop.', '', '```', 'x[^fenced]', '```', '',
      '[^1]: raw/refs/shop.png · dated 2026-09-30', '[^2]: https://example.com/x', '[^3]: raw/refs/missing.png', '[^4]: ./raw/refs/shop.png',
      '[^5]: `https://example.com/tabs`',
      '[^spare]: https://example.com/spare',
    ],
  }));
  const found = await lintFound(v, /\[\^/);
  assert.deepEqual(found.map(f => f.msg).sort(), [
    'cites [^gone], which has no footnote',
    'footnote [^3] names raw/refs/missing.png. Cite a URL or a file under raw/ that exists',
    'footnote [^4] names ./raw/refs/shop.png. Write it as raw/refs/shop.png, the path from the vault root',
    'footnote [^spare] is never cited',
  ]);
  assert.ok(found.every(f => f.level === 'warn' && f.file === 'wiki/glim/lit-types.md'));
});

test('lint warns on a page no other note links, except a topic page or a note with an error', async t => {
  const v = makeVault(t);
  v.write('wiki/glim/code.md', page({ kind: 'topic', body: ['See [[lit-types]] and [the store](../glim/source-store.md).', '', '## Rules'] }));
  v.write('wiki/glim/lit-types.md', page({ kind: 'concept' }));
  v.write('wiki/glim/source-store.md', sourcePage({ source: 'https://example.com/store' }));
  v.write('wiki/glim/runner.md', page({ kind: 'entity', body: ['Itself: [[runner]].'] }));
  v.write('wiki/glim/strict-mode.md', page({ kind: 'synthesis' }));
  v.write('wiki/glim/source-quoted.md', sourcePage({ source: 'https://example.com/q' }));
  v.write('wiki/glim/source-shop.md', sourcePage({ source: 'https://example.com/shop', body: ['## You said', '- 2026-10-22 · session 00000000 · "see [[source-quoted]]"', '', "## Agent's reading", '', '## Rules'] }));
  v.write('wiki/glim/elsewhere.md', page({ kind: 'concept', domain: 'other' }));
  v.write('wiki/glim/some-rule.md', ruleNote({ keywords: ['x'] }).replace('## Examples\n', '## Examples\n- [[wiki/glim/strict-mode|strict-mode]]\n'));
  const found = await lintFound(v, /no other note links/);
  assert.deepEqual(found.map(f => [f.level, f.file, f.msg]).sort(), [
    ['warn', 'wiki/glim/runner.md', "no other note links this page. Link it from its topic's page"],
    ['warn', 'wiki/glim/source-quoted.md', "no other note links this page. Link it from its topic's page"],
    ['warn', 'wiki/glim/source-shop.md', "no other note links this page. Link it from its topic's page"],
  ]);
});

test('lint warns when a source page on a topic page\'s topic changes after it, and not on other pages', async t => {
  const v = makeVault(t);
  // Saved before the fixture's updated date, so each page's day stays 2026-10-01 whenever the test runs.
  const saved = new Date(2026, 8, 1);
  const old = rel => fs.utimesSync(v.at(...rel.split('/')), saved, saved);
  v.write('wiki/glim/code.md', page({ kind: 'topic', body: ['## Rules'] }));
  v.write('wiki/glim/lit-types.md', page({ kind: 'concept' }));
  v.write('wiki/glim/layout.md', page({ kind: 'topic', topic: 'layout', body: ['## Rules'] }));
  v.write('wiki/glim/source-grid.md', sourcePage({ source: 'https://example.com/grid', topic: 'layout' }));
  ['wiki/glim/code.md', 'wiki/glim/lit-types.md', 'wiki/glim/layout.md', 'wiki/glim/source-grid.md'].forEach(old);
  v.write('wiki/glim/source-shop.md', sourcePage({ source: 'https://example.com/shop' }));
  const found = await lintFound(v, /after this page/);
  assert.deepEqual(found.map(f => [f.level, f.file]), [['warn', 'wiki/glim/code.md']]);
  assert.match(found[0].msg, /^glim\/source-shop changed on \d{4}-\d\d-\d\d, after this page \(2026-10-01\)\. Check the page still matches it, then set updated$/);
});

test('lint warns when a source page another page cites, by footnote or link, changes after it', async t => {
  const v = makeVault(t);
  const saved = new Date(2026, 8, 1);
  const old = rel => fs.utimesSync(v.at(...rel.split('/')), saved, saved);
  v.write('raw/refs/shop.md', 'The shop.\n');
  v.write('wiki/glim/lit-types.md', page({ kind: 'concept', body: ['Typed.[^1]', '', '[^1]: raw/refs/shop.md'] }));
  v.write('wiki/glim/rune-set.md', page({ kind: 'entity', body: ['See [[source-shop]].'] }));
  v.write('wiki/glim/strict-mode.md', page({ kind: 'concept' }));
  ['wiki/glim/lit-types.md', 'wiki/glim/rune-set.md', 'wiki/glim/strict-mode.md'].forEach(old);
  v.write('wiki/glim/source-shop.md', sourcePage({ source: 'raw/refs/shop.md' }));
  const found = await lintFound(v, /after this page/);
  assert.deepEqual(found.map(f => f.file), ['wiki/glim/lit-types.md', 'wiki/glim/rune-set.md']);
  assert.match(found[0].msg, /^glim\/source-shop changed on/);
});

test('lint warns on a quote under You said that the user did not type in its session, and skips a session it has no transcript for', async t => {
  const v = makeVault(t);
  v.startSession(SID, { cwd: v.root, transcript: v.transcript(SID, [userTurn('the cards breathe, the tabs feel cramped'), assistantTurn('the tabs look tight')]) });
  v.write('wiki/glim/source-shop.md', sourcePage({ source: 'https://example.com/shop', body: [
    '## You said',
    `- 2026-10-22 · session ${SID8} · "the cards breathe … feel cramped"`,
    `- 2026-10-22 · session ${SID8} · "the tabs look tight"`,
    '- 2026-10-22 · session 00000000 · "said in a session long gone"',
    '- 2026-10-22 · the cards breathe',
    '', "## Agent's reading", '', '## Rules',
  ] }));
  const found = await lintFound(v, /typed|form/);
  assert.deepEqual(found.map(f => [f.level, f.file, f.msg]), [
    ['warn', 'wiki/glim/source-shop.md', `"the tabs look tight" isn't in what the user typed in session ${SID8}. Quote their exact words, with … where you leave some out`],
    ['warn', 'wiki/glim/source-shop.md', `a line under ## You said isn't in the form - <date> · session <id> · "<their exact words>", so lint can't check it: - 2026-10-22 · the cards breathe`],
  ]);
});

test('lint re-checks Evidence quotes against the session and the source, and skips the lines it has nothing to check against', async t => {
  const v = makeVault(t);
  v.startSession(SID, { cwd: v.root, transcript: v.transcript(SID, [userTurn('the cards breathe, the tabs feel cramped'), assistantTurn('the tabs look tight')]) });
  v.write('raw/refs/notes.md', 'The solver is on by default.\n');
  v.write('raw/refs/grid.html', '<p>The <b>grid</b> is 8&nbsp;px.</p>\n');
  v.write('raw/refs/guide.md', 'Use **strict mode** in the [shop](https://example.com/shop) scripts.\n');
  v.write('raw/picks/2026-09-01.jsonl', `${JSON.stringify({ id: 'q-1234abcd', at: '2026-09-01T10:00:00.000Z', source: 'pick', domain: 'glim', subject: 'cards', text: 'a comment on the cards', status: 'user' })}\n`);
  const line = (kind, rest, id = '(a-00000001)') => `- 2026-10-22 · ${kind} · session ${SID8} · ${rest} ${id}`.trimEnd();
  v.write('wiki/glim/cards.md', ruleNote({ keywords: ['cards'], evidence: [
    line('stated', '"the cards breathe … feel cramped"'),
    line('stated', '"the tabs feel cramped"', ''),
    line('correction', '"the tabs look tight"'),
    '- 2026-10-22 · stated · session 00000000 · "said in a session long gone" (a-00000001)',
    line('stated', '"a comment on the cards"', '(q-1234abcd; proposed as a-00000001)'),
    line('source', 'raw/refs/notes.md · dated 2026-10-01 · "The solver is on by default"'),
    line('source', 'raw/refs/notes.md · dated 2026-10-01 · "The solver is off"'),
    line('source', 'raw/refs/grid.html · dated 2026-10-01 · "The grid is 8 px"'),
    line('source', 'raw/refs/guide.md · dated 2026-10-01 · "Use strict mode in the shop scripts"'),
    line('source', 'raw/refs/guide.md · dated 2026-10-01 · "Use **strict mode**"'),
    line('source', 'https://example.com/blog · dated 2026-10-01 · "not saved anywhere"'),
    line('failure', 'src/a.zq · "boom" · fixed by: x'),
    line("agent's reading", 'The user rewrote it.'),
  ] }));
  const found = await lintFound(v, /isn't in/);
  assert.deepEqual(found.map(f => [f.level, f.file, f.msg]), [
    ['warn', 'wiki/glim/cards.md', `"the tabs look tight" isn't in what the user typed in session ${SID8}. Quote their exact words, with … where you leave some out`],
    ['warn', 'wiki/glim/cards.md', `"The solver is off" isn't in raw/refs/notes.md. Quote the file's own words, with … where you leave some out`],
  ]);
});

test('lint warns on an Evidence line it can\'t read, and on one whose source is no URL or file under raw/', async t => {
  const v = makeVault(t);
  v.startSession(SID, { cwd: v.root, transcript: v.transcript(SID, [userTurn('something else entirely')]) });
  const lines = [
    `- 2026-10-22 · Stated · session ${SID8} · "never typed" (a-00000001)`,
    `- 2026-10-22 · stated · Session ${SID8} · "never typed" (a-00000001)`,
    `- 2026-10-22 · stated · session ${SID8} · "never typed". (a-00000001)`,
    `- 2026-10-22 · stated · session ${SID8} · "never typed" (a-00000001) see chat`,
    `- 2026-10-22 · correction · session ${SID8} · 'never typed' (a-00000001)`,
    `- 2026-10-22 · stated · session ${SID8} · never typed (a-00000001)`,
    `- 2026-10-22 · stated · session ${SID8} · "never typed" (a-00000001; edited)`,
    `- 2026-10-22 · source · session ${SID8} · raw/refs/notes.md, dated 2026-10-01 · "anything"`,
  ];
  v.write('wiki/glim/cards.md', ruleNote({ keywords: ['cards'], evidence: [
    ...lines,
    `- 2026-10-22 · source · session ${SID8} · raw/refs/notse.md · dated 2026-10-01 · "anything" (a-00000001)`,
    `- 2026-10-22 · choice · session ${SID8} · "B, Grid", picked over "A" for "Which grid?" (q-1234abcd; proposed as a-00000001)`,
    `- 2026-10-22 · failure · session ${SID8} · src/a.zq · "boom" · fixed by: x (a-00000001)`,
    `- 2026-10-22 · agent's reading · session ${SID8} · The user rewrote it. (a-00000001)`,
  ] }));
  const found = await lintFound(v, /Evidence line/);
  assert.deepEqual(found.map(f => [f.level, f.msg]), [
    ...lines.map(l => ['warn', `an Evidence line isn't in a form reference/notes.md's Rule notes section gives, so lint can't check it: ${l}`]),
    ['warn', 'an Evidence line cites raw/refs/notse.md. Cite a URL or a file under raw/ that exists'],
  ]);
});

test('lint checks an Evidence line from a recorded row against the row\'s words', async t => {
  const v = makeVault(t);
  v.write('raw/picks/2026-09-01.jsonl', `${JSON.stringify({ id: 'q-1234abcd', at: '2026-09-01T10:00:00.000Z', source: 'pick', domain: 'glim', subject: 'cards', text: 'keep the cards roomy please', status: 'user' })}\n`);
  const pick = (quote, id) => `- 2026-09-01 · stated · session ${SID8} · "${quote}" (${id}; proposed as a-00000001)`;
  v.write('wiki/glim/cards.md', ruleNote({ keywords: ['cards'], evidence: [
    pick('keep the cards roomy', 'q-1234abcd'),
    pick('keep the tabs roomy', 'q-1234abcd'),
    pick('anything', 'q-99999999'),
  ] }));
  const found = await lintFound(v, /q-1234abcd|q-99999999/);
  assert.deepEqual(found.map(f => [f.level, f.msg]), [
    ['warn', `"keep the tabs roomy" isn't in what row q-1234abcd recorded. Quote the row's own words, with … where you leave some out`],
    ['warn', "an Evidence line cites q-99999999, which no row in raw/picks/ has"],
  ]);
});

test('lint passes an Evidence line over a raw/ file it can\'t read', { skip: process.platform !== 'win32' && 'needs a share-none lock, which only Windows has' }, async t => {
  const v = makeVault(t);
  const file = v.write('raw/refs/notes.md', 'The solver is on by default.\n');
  v.write('wiki/glim/cards.md', ruleNote({ keywords: ['cards'], evidence: [
    `- 2026-10-22 · source · session ${SID8} · raw/refs/notes.md · dated 2026-10-01 · "The solver is off" (a-00000001)`,
  ] }));
  // libuv's UV_FS_O_EXLOCK, which node doesn't export: no other handle can read the file until this one closes.
  const fd = fs.openSync(file, fs.constants.O_RDONLY | 0x10000000);
  let found;
  try { found = await lintFound(v, /notes\.md/); } finally { fs.closeSync(fd); }
  assert.deepEqual(found, []);
});

test('lint skips a session whose transcript it can\'t read', async t => {
  const v = makeVault(t);
  const transcript = v.at('.transcripts', 'unreadable');
  fs.mkdirSync(transcript, { recursive: true });
  v.startSession(SID, { cwd: v.root, transcript });
  v.write('wiki/glim/source-shop.md', sourcePage({ source: 'https://example.com/shop', body: [
    '## You said', `- 2026-10-22 · session ${SID8} · "the tabs look tight"`, '', "## Agent's reading", '', '## Rules',
  ] }));
  v.write('wiki/glim/cards.md', ruleNote({ keywords: ['cards'], evidence: [`- 2026-10-22 · stated · session ${SID8} · "the tabs look tight" (a-00000001)`] }));
  assert.deepEqual(await lintFound(v, /isn't in/), []);
});

test('a source page stales the pages that link it, and not those that link another source page on the same file', async t => {
  const v = makeVault(t, { domains: { other: { title: 'Other', vaultOnly: true, topics: ['code'] } } });
  const saved = new Date(2026, 8, 1);
  v.write('raw/refs/shop.md', 'The shop.\n');
  v.write('wiki/glim/source-shop.md', sourcePage({ source: 'raw/refs/shop.md' }));
  v.write('wiki/glim/rune-set.md', page({ kind: 'entity', body: ['See [[wiki/glim/source-shop|source-shop]].'] }));
  for (const f of ['wiki/glim/source-shop.md', 'wiki/glim/rune-set.md']) fs.utimesSync(v.at(...f.split('/')), saved, saved);
  v.write('wiki/other/source-shop-notes.md', sourcePage({ domain: 'other', source: 'raw/refs/shop.md' }));
  assert.deepEqual(await lintFound(v, /after this page/), []);
});

test('a URL footnote is the source page of the file saved from that URL, for staleness and the index count', async t => {
  const v = makeVault(t);
  const saved = new Date(2026, 8, 1);
  v.write('raw/refs/post.md', '---\nurl: https://example.com/post/\nfetched: 2026-10-01\n---\n\nThe post.\n');
  v.write('wiki/glim/lit-types.md', page({ kind: 'concept', body: ['Typed.[^1]', '', '[^1]: https://Example.com/post#intro · dated 2026-09-30'] }));
  v.write('wiki/glim/rune-set.md', page({ kind: 'entity', body: ['Typed.[^1] See [[source-post]].', '', '[^1]: https://example.com/post'] }));
  for (const f of ['wiki/glim/lit-types.md', 'wiki/glim/rune-set.md']) fs.utimesSync(v.at(...f.split('/')), saved, saved);
  v.write('wiki/glim/source-post.md', sourcePage({ source: 'raw/refs/post.md' }));
  const found = await lintFound(v, /after this page/);
  assert.deepEqual(found.map(f => f.file), ['wiki/glim/lit-types.md', 'wiki/glim/rune-set.md']);
  const rules = await v.import('lib/rules.mjs');
  assert.match(rules.renderIndex(rules.loadNotes()), /\[\[wiki\/glim\/rune-set\|rune-set\]\] · entity page · 1 source ·/);
});

const logged = v => v.read('log.md').trim().split('\n').map(l => l.replace(/^- \d{4}-\d\d-\d\d \d\d:\d\d · /, ''));

test('log.mjs logs a page, an ingest, a batch ingest and a filed-back query as one line each', t => {
  const v = makeVault(t);
  v.write('raw/refs/shop.png', 'png');
  v.write('wiki/glim/source-shop.md', sourcePage({ source: 'raw/refs/shop.png' }));
  v.write('wiki/glim/code.md', page({ kind: 'topic', body: ['## Rules'] }));
  const env = { CLAUDE_CODE_SESSION_ID: SID };
  for (const args of [
    ['wiki/glim/code.md'],
    ['ingest', 'raw/refs/shop.png', 'wiki/glim/source-shop.md', v.at('wiki', 'glim', 'code.md')],
    ['ingest', '--batch', 'https://example.com/notes', 'wiki/glim/code.md'],
    ['query', 'How should tab bars space their tabs?', 'wiki/glim/code.md'],
  ]) {
    const r = v.run('log.mjs', args, { env });
    assert.equal(r.code, 0, `${args.join(' ')}: ${r.stderr}`);
  }
  assert.deepEqual(logged(v), [
    `wrote page glim/code · session ${SID8}`,
    `ingest raw/refs/shop.png · pages glim/source-shop, glim/code · session ${SID8}`,
    `ingest https://example.com/notes · batch · pages glim/code · session ${SID8}`,
    `query "How should tab bars space their tabs?" · filed in glim/code · session ${SID8}`,
  ]);
  assert.ok(v.exists('index.md'));
});

test('log.mjs logs nothing when the source or a page is wrong, or no page is named', t => {
  const v = makeVault(t);
  v.write('raw/refs/shop.png', 'png');
  v.write('wiki/glim/code.md', page({ kind: 'topic', body: ['## Rules'] }));
  v.write('wiki/glim/some-rule.md', ruleNote({ keywords: ['x'] }));
  for (const [args, code] of [
    [['ingest', 'raw/refs/missing.png', 'wiki/glim/code.md'], 1],
    [['ingest', 'notes.md', 'wiki/glim/code.md'], 1],
    [['ingest', 'raw/refs/shop.png', 'wiki/glim/code.md', 'wiki/glim/nope.md'], 1],
    [['ingest', 'raw/refs/shop.png', 'wiki/glim/some-rule.md'], 1],
    [['query', '  ', 'wiki/glim/code.md'], 2],
    [['query', 'How?'], 2],
    [['ingest', '--batch', 'raw/refs/shop.png'], 2],
  ]) assert.equal(v.run('log.mjs', args).code, code, args.join(' '));
  assert.equal(v.exists('log.md'), false);
  assert.equal(v.run('log.mjs', ['ingest', 'raw/refs/shop.png', 'wiki/glim/code.md']).code, 0);
  assert.deepEqual(logged(v), ['ingest raw/refs/shop.png · pages glim/code']);
});

test('review status logs its lint tally', t => {
  const v = makeVault(t);
  v.write('wiki/glim/code.md', page({ kind: 'topic', body: ['## Rules'] }));
  const tally = v.run('review.mjs', ['status']).stdout.match(/^Lint: (.*)$/m)[1];
  assert.match(tally, /^\d+ errors?, \d+ warnings?$/);
  assert.deepEqual(logged(v), [`lint · ${tally}`]);
});

const library = (name, body = []) => page({ kind: 'entity', extra: ['package:', '  ecosystem: npm', `  name: ${name}`], body: ['A library.', '', ...body] });

test('lint warns on two entity pages that name one package', async t => {
  const v = makeVault(t);
  v.write('wiki/glim/entities/zq-lib.md', library('zq-lib'));
  v.write('wiki/global/entities/zq.md', library('zq-lib'));
  v.write('wiki/glim/entities/other.md', library('other-lib'));
  const found = await lintFound(v, /package/);
  assert.equal(found.length, 2, JSON.stringify(found));
  assert.ok(found.every(f => f.level === 'warn' && /npm\/zq-lib/.test(f.msg)));
  assert.deepEqual(found.map(f => f.file).sort(), ['wiki/glim/entities/zq-lib.md', 'wiki/global/entities/zq.md']);
});

test('lint warns on a package that is not an ecosystem and a name', async t => {
  const v = makeVault(t);
  v.write('wiki/glim/entities/zq-lib.md', page({ kind: 'entity', extra: ['package: zq-lib'] }));
  assert.equal((await lintFound(v, /package/)).length, 1);
});

test('lint warns on a ## Gotchas or ## Docs read line in another form', async t => {
  const v = makeVault(t);
  v.write('raw/refs/zq.md', 'zq docs');
  v.write('wiki/glim/entities/zq-lib.md', library('zq-lib', [
    '## Gotchas',
    '- 2026-11-03 · session 1a2b3c4d · `src/api/client.ts` · error: "zq: no screen" · fixed by: naming the screen · [[wiki/glim/entities/zq-lib|zq-lib]]',
    '- 2026-11-03 · session 1a2b3c4d · `src/x.ts` · error: "boom" · fixed by: a retry',
    '- It breaks on Tuesdays.',
    '',
    '## Docs read',
    '- https://example.com/zq · fetched 2026-11-03',
    '- raw/refs/zq.md · fetched 2026-11-02',
    '- the zq docs',
  ]));
  const found = await lintFound(v, /## Gotchas|## Docs read/);
  assert.deepEqual(found.map(f => f.msg.match(/It breaks on Tuesdays|the zq docs/)?.[0]).sort(), ['It breaks on Tuesdays', 'the zq docs']);
});

test('lint warns on a job outside an entity page and on compares that names fewer than two entity pages', async t => {
  const v = makeVault(t);
  v.write('wiki/glim/entities/zq-lib.md', page({ kind: 'entity', extra: ['job: parse screens'] }));
  v.write('wiki/glim/entities/zr-lib.md', page({ kind: 'entity', extra: ['job: parse screens'] }));
  v.write('wiki/glim/concepts/screens.md', page({ kind: 'concept', extra: ['job: parse screens'] }));
  v.write('wiki/glim/syntheses/zq-or-zr.md', page({ kind: 'synthesis', extra: ['compares: [glim/zq-lib, glim/zr-lib]'] }));
  v.write('wiki/glim/syntheses/zq-alone.md', page({ kind: 'synthesis', extra: ['compares: [glim/zq-lib, glim/screens]'] }));
  const found = await lintFound(v, /\bjob\b|compares/);
  assert.deepEqual(found.map(f => [f.file, f.msg]).sort(), [
    ['wiki/glim/concepts/screens.md', 'job is for entity pages, the task the library does'],
    ['wiki/glim/syntheses/zq-alone.md', 'compares must list two or more entity pages by key, such as [global/react, global/vue]'],
  ]);
});

test('lint warns on a synthesis page whose compares is empty, and goes on', async t => {
  const v = makeVault(t);
  v.write('wiki/glim/syntheses/empty.md', page({ kind: 'synthesis', extra: ['compares:'] }));
  assert.equal((await lintFound(v, /^compares must list two or more entity pages/)).length, 1);
});

test('a rule whose retired is not a day is listed as not delivered, and the session start and search name it', async t => {
  const v = makeVault(t);
  v.write('wiki/glim/rules/typo.md', ruleNote({ keywords: ['typo'], doLine: 'Spell the thing.', extra: ['retired: someday'] }));
  v.run('build.mjs');
  const line = v.read('index.md').split('\n').find(l => l.includes('typo|'));
  assert.match(line, / · not delivered: retired must be the day the rule was retired, as YYYY-MM-DD/);
  assert.doesNotMatch(line, /retired on/);
  assert.match(v.run('search.mjs', ['spell']).stdout, /glim\/typo .* · not delivered: retired must be the day/);
  const start = v.startSession('9f8e7d6c-0000-4000-8000-000000000005', { cwd: v.project });
  assert.match(start?.hookSpecificOutput?.additionalContext ?? '', /glim\/typo \(retired must be the day/);
});

test('lint checks what a rule says to sessions only while it is delivered, and checks its record after it is retired', async t => {
  const v = makeVault(t);
  const long = `Do the thing ${'very '.repeat(60)}carefully.`;
  v.write('wiki/glim/rules/live.md', ruleNote({ keywords: ['live'], doLine: long }));
  v.write('wiki/glim/rules/gone.md', ruleNote({ keywords: ['gone'], doLine: long, extra: ['retired: 2026-11-01', 'superseded_by: glim/nothing-here'] }));
  const of = async (re, rel) => (await lintFound(v, re)).filter(f => f.file === rel).length;
  for (const re of [/^empty \*\*Because:\*\*/, /come to \d+ characters/]) {
    assert.equal(await of(re, 'wiki/glim/rules/live.md'), 1, String(re));
    assert.equal(await of(re, 'wiki/glim/rules/gone.md'), 0, String(re));
  }
  assert.equal(await of(/superseded_by names glim\/nothing-here, which has no note/, 'wiki/glim/rules/gone.md'), 1);
});
