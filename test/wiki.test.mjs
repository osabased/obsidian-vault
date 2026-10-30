import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeVault, ruleNote, pageNote as page, userTurn, assistantTurn } from './fixture.mjs';

const SID = '9f8e7d6c-0000-4000-8000-000000000004';
const SID8 = SID.slice(0, 8);

const lintFound = async (v, re) => (await v.import('lib/lint.mjs')).lint().filter(f => f.file.startsWith('wiki/') && re.test(f.msg));
const sourcePage = (source, body = ['## You said', '', "## Agent's reading", '', '## Rules'], extra = []) => page({ kind: 'source', extra: [`source: ${source}`, ...extra], body });

test('the index lists a topic\'s pages by kind, each but a source page with how many sources it draws on', async t => {
  const v = makeVault(t);
  v.write('raw/refs/notes.md', 'notes');
  v.write('wiki/demo/source-changelog.md', sourcePage('https://example.com/changelog'));
  v.write('wiki/demo/source-notes.md', sourcePage('raw/refs/notes.md'));
  v.write('wiki/demo/strict-mode.md', page({ kind: 'synthesis', body: ['Typed.[^1]', '', '[^1]: https://example.com/changelog · dated 2026-09-30'] }));
  v.write('wiki/demo/luau-types.md', page({ kind: 'concept', body: ['Typed.[^1] Strict.[^2]', '', '[^1]: raw/refs/notes.md', '[^2]: https://example.com/strict'] }));
  v.write('wiki/demo/code.md', page({
    kind: 'topic', body: ['From [[wiki/demo/source-changelog|source-changelog]] and [[source-notes]].[^1]', '', '[^1]: https://example.com/changelog', '', '## Rules'],
  }));
  v.write('wiki/demo/roblox.md', page({ kind: 'entity' }));
  v.write('wiki/demo/some-rule.md', ruleNote({ keywords: ['x'] }));
  const rules = await v.import('lib/rules.mjs');
  const lines = rules.renderIndex(rules.loadNotes()).split('\n').filter(l => l.startsWith('- '));
  assert.deepEqual(lines.slice(0, 6).map(l => l.split(' · ').slice(0, 3).join(' · ')), [
    '- [[wiki/demo/code|code]] · topic page · 2 sources',
    '- [[wiki/demo/luau-types|luau-types]] · concept page · 2 sources',
    '- [[wiki/demo/roblox|roblox]] · entity page · no sources',
    '- [[wiki/demo/strict-mode|strict-mode]] · synthesis page · 1 source',
    '- [[wiki/demo/source-changelog|source-changelog]] · source page · What we know.',
    '- [[wiki/demo/source-notes|source-notes]] · source page · What we know.',
  ]);
  assert.match(lines[6], /^- \[\[wiki\/demo\/some-rule\|some-rule\]\] · /);
});

test('lint warns on a page missing a section its kind has, or holding a source field only a source page takes', async t => {
  const v = makeVault(t);
  v.write('wiki/demo/source-shop.md', sourcePage('https://example.com/shop', ['## You said', '', 'Shows a shop.']));
  v.write('wiki/demo/source-full.md', sourcePage('https://example.com/full'));
  v.write('wiki/demo/code.md', page({ kind: 'topic' }));
  v.write('wiki/demo/layout.md', page({ kind: 'topic', topic: 'layout', body: ['## Rules'] }));
  v.write('wiki/demo/luau-types.md', page({ kind: 'concept', extra: ['source: https://example.com/x', 'source_date: 2026-09-30'] }));
  v.write('wiki/demo/roblox.md', page({ kind: 'entity', extra: ['source: notes.md'] }));
  const found = await lintFound(v, /section|for source pages/);
  assert.deepEqual((await lintFound(v, /./)).filter(f => f.level === 'error'), []);
  assert.deepEqual(found.map(f => [f.file, f.msg]).sort(), [
    ['wiki/demo/code.md', 'no ## Rules section. A topic page has ## Rules, even when it is empty'],
    ['wiki/demo/luau-types.md', 'source and source_date are for source pages. Cite a source with a footnote instead'],
    ['wiki/demo/roblox.md', 'source is for source pages. Cite a source with a footnote instead'],
    ['wiki/demo/source-shop.md', "no ## Agent's reading or ## Rules section. A source page has ## You said, ## Agent's reading and ## Rules, even when one is empty"],
  ]);
  assert.ok(found.every(f => f.level === 'warn'));
});

test('lint warns on a footnote that names no source, one cited but never written, and one written but never cited', async t => {
  const v = makeVault(t);
  v.write('raw/refs/shop.png', 'png');
  v.write('wiki/demo/luau-types.md', page({
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
  assert.ok(found.every(f => f.level === 'warn' && f.file === 'wiki/demo/luau-types.md'));
});

test('lint warns on a page no other note links, except a topic page or a note with an error', async t => {
  const v = makeVault(t);
  v.write('wiki/demo/code.md', page({ kind: 'topic', body: ['See [[luau-types]] and [the store](../demo/source-store.md).', '', '## Rules'] }));
  v.write('wiki/demo/luau-types.md', page({ kind: 'concept' }));
  v.write('wiki/demo/source-store.md', sourcePage('https://example.com/store'));
  v.write('wiki/demo/roblox.md', page({ kind: 'entity', body: ['Itself: [[roblox]].'] }));
  v.write('wiki/demo/strict-mode.md', page({ kind: 'synthesis' }));
  v.write('wiki/demo/source-quoted.md', sourcePage('https://example.com/q'));
  v.write('wiki/demo/source-shop.md', sourcePage('https://example.com/shop', ['## You said', '- 2026-10-22 · session 00000000 · "see [[source-quoted]]"', '', "## Agent's reading", '', '## Rules']));
  v.write('wiki/demo/elsewhere.md', page({ kind: 'concept', domain: 'other' }));
  v.write('wiki/demo/some-rule.md', ruleNote({ keywords: ['x'] }).replace('## Examples\n', '## Examples\n- [[wiki/demo/strict-mode|strict-mode]]\n'));
  const found = await lintFound(v, /no other note links/);
  assert.deepEqual(found.map(f => [f.level, f.file, f.msg]).sort(), [
    ['warn', 'wiki/demo/roblox.md', "no other note links this page. Link it from its topic's page"],
    ['warn', 'wiki/demo/source-quoted.md', "no other note links this page. Link it from its topic's page"],
    ['warn', 'wiki/demo/source-shop.md', "no other note links this page. Link it from its topic's page"],
  ]);
});

test('lint warns when a source page on a topic page\'s topic changes after it, and not on other pages', async t => {
  const v = makeVault(t);
  // Saved before the fixture's updated date, so each page's day stays 2026-10-01 whenever the test runs.
  const saved = new Date(2026, 8, 1);
  const old = rel => fs.utimesSync(v.at(...rel.split('/')), saved, saved);
  v.write('wiki/demo/code.md', page({ kind: 'topic', body: ['## Rules'] }));
  v.write('wiki/demo/luau-types.md', page({ kind: 'concept' }));
  v.write('wiki/demo/layout.md', page({ kind: 'topic', topic: 'layout', body: ['## Rules'] }));
  v.write('wiki/demo/source-grid.md', sourcePage('https://example.com/grid').replace('topic: code', 'topic: layout'));
  ['wiki/demo/code.md', 'wiki/demo/luau-types.md', 'wiki/demo/layout.md', 'wiki/demo/source-grid.md'].forEach(old);
  v.write('wiki/demo/source-shop.md', sourcePage('https://example.com/shop'));
  const found = await lintFound(v, /after this page/);
  assert.deepEqual(found.map(f => [f.level, f.file]), [['warn', 'wiki/demo/code.md']]);
  assert.match(found[0].msg, /^demo\/source-shop changed on \d{4}-\d\d-\d\d, after this page \(2026-10-01\)\. Check the page still matches it, then set updated$/);
});

test('lint warns on a quote under You said that the user did not type in its session, and skips a session it has no transcript for', async t => {
  const v = makeVault(t);
  v.startSession(SID, { cwd: v.root, transcript: v.transcript(SID, [userTurn('the cards breathe, the tabs feel cramped'), assistantTurn('the tabs look tight')]) });
  v.write('wiki/demo/source-shop.md', sourcePage('https://example.com/shop', [
    '## You said',
    `- 2026-10-22 · session ${SID8} · "the cards breathe … feel cramped"`,
    `- 2026-10-22 · session ${SID8} · "the tabs look tight"`,
    '- 2026-10-22 · session 00000000 · "said in a session long gone"',
    '- 2026-10-22 · the cards breathe',
    '', "## Agent's reading", '', '## Rules',
  ]));
  const found = await lintFound(v, /typed|form/);
  assert.deepEqual(found.map(f => [f.level, f.file, f.msg]), [
    ['warn', 'wiki/demo/source-shop.md', `"the tabs look tight" isn't in what the user typed in session ${SID8}. Quote their exact words, with … where you leave some out`],
    ['warn', 'wiki/demo/source-shop.md', `a line under ## You said isn't in the form - <date> · session <id> · "<their exact words>", so lint can't check it: - 2026-10-22 · the cards breathe`],
  ]);
});

const logged = v => v.read('log.md').trim().split('\n').map(l => l.replace(/^- \d{4}-\d\d-\d\d \d\d:\d\d · /, ''));

test('log.mjs logs a page, an ingest, a batch ingest and a filed-back query as one line each', t => {
  const v = makeVault(t);
  v.write('raw/refs/shop.png', 'png');
  v.write('wiki/demo/source-shop.md', sourcePage('raw/refs/shop.png'));
  v.write('wiki/demo/code.md', page({ kind: 'topic', body: ['## Rules'] }));
  const env = { CLAUDE_CODE_SESSION_ID: SID };
  for (const args of [
    ['wiki/demo/code.md'],
    ['ingest', 'raw/refs/shop.png', 'wiki/demo/source-shop.md', v.at('wiki', 'demo', 'code.md')],
    ['ingest', '--batch', 'https://example.com/notes', 'wiki/demo/code.md'],
    ['query', 'How should tab bars space their tabs?', 'wiki/demo/code.md'],
  ]) {
    const r = v.run('log.mjs', args, { env });
    assert.equal(r.code, 0, `${args.join(' ')}: ${r.stderr}`);
  }
  assert.deepEqual(logged(v), [
    `wrote page demo/code · session ${SID8}`,
    `ingest raw/refs/shop.png · pages demo/source-shop, demo/code · session ${SID8}`,
    `ingest https://example.com/notes · batch · pages demo/code · session ${SID8}`,
    `query "How should tab bars space their tabs?" · filed in demo/code · session ${SID8}`,
  ]);
  assert.ok(v.exists('index.md'));
});

test('log.mjs logs nothing when the source or a page is wrong, or no page is named', t => {
  const v = makeVault(t);
  v.write('raw/refs/shop.png', 'png');
  v.write('wiki/demo/code.md', page({ kind: 'topic', body: ['## Rules'] }));
  v.write('wiki/demo/some-rule.md', ruleNote({ keywords: ['x'] }));
  for (const [args, code] of [
    [['ingest', 'raw/refs/missing.png', 'wiki/demo/code.md'], 1],
    [['ingest', 'notes.md', 'wiki/demo/code.md'], 1],
    [['ingest', 'raw/refs/shop.png', 'wiki/demo/code.md', 'wiki/demo/nope.md'], 1],
    [['ingest', 'raw/refs/shop.png', 'wiki/demo/some-rule.md'], 1],
    [['query', '  ', 'wiki/demo/code.md'], 2],
    [['query', 'How?'], 2],
    [['ingest', '--batch', 'raw/refs/shop.png'], 2],
  ]) assert.equal(v.run('log.mjs', args).code, code, args.join(' '));
  assert.equal(v.exists('log.md'), false);
  assert.equal(v.run('log.mjs', ['ingest', 'raw/refs/shop.png', 'wiki/demo/code.md']).code, 0);
  assert.deepEqual(logged(v), ['ingest raw/refs/shop.png · pages demo/code']);
});

test('review status logs its lint tally', t => {
  const v = makeVault(t);
  v.write('wiki/demo/code.md', page({ kind: 'topic', body: ['## Rules'] }));
  const tally = v.run('review.mjs', ['status']).stdout.match(/^Lint: (.*)$/m)[1];
  assert.match(tally, /^\d+ errors?, \d+ warnings?$/);
  assert.deepEqual(logged(v), [`lint · ${tally}`]);
});
