import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeVault, ruleNote, pageNote as page, sourcePage, userTurn, sessionId } from './fixture.mjs';

const sectionOf = (out, title) => out.trimEnd().split('\n\n').find(b => b.startsWith(`${title}\n`))?.split('\n').slice(1);

test('review sources lists the files in raw/refs/ no source page names, and status lists them too', t => {
  const v = makeVault(t);
  for (const f of ['raw/refs/named.md', 'raw/refs/shop.png', 'raw/refs/docs/strict.md', 'raw/refs/.obsidian-tmp']) v.write(f, 'x');
  v.write('wiki/demo/source-named.md', sourcePage({ source: 'raw/refs/named.md' }));
  v.write('wiki/demo/source-web.md', sourcePage({ source: 'https://example.com/web' }));
  v.write('wiki/demo/shop-grid.md', page({ kind: 'concept', body: ['A grid.[^1]', '', '[^1]: raw/refs/shop.png'] }));
  const r = v.run('review.mjs', ['sources']);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'raw/refs/docs/strict.md\nraw/refs/shop.png\n', 'a footnote cites a source but does not ingest it');
  assert.equal(v.exists('log.md'), false, 'listing the sources is not a /lint run');
  assert.deepEqual(sectionOf(v.run('review.mjs', ['status']).stdout, 'Sources in raw/refs/ no source page names'), [
    '- raw/refs/docs/strict.md', '- raw/refs/shop.png',
  ]);
});

test('review sources says so when every source has a page, and takes no other arguments', t => {
  const v = makeVault(t);
  const done = { code: 0, stdout: 'Every file in raw/refs/ has a source page.\n', stderr: '' };
  assert.deepEqual(v.run('review.mjs', ['sources']), done);
  v.write('raw/refs/named.md', 'x');
  v.write('wiki/demo/source-named.md', sourcePage({ source: 'raw/refs/named.md' }));
  assert.deepEqual(v.run('review.mjs', ['sources']), done);
  assert.equal(v.run('review.mjs', ['sources', 'raw/refs']).code, 2);
  assert.deepEqual(v.run('review.mjs', []), { code: 2, stdout: '', stderr: 'usage: node tools/review.mjs status\n       node tools/review.mjs done\n       node tools/review.mjs sources\n' });
});

test('review sources leaves out the files other tools drop in raw/refs/, and links to folders', t => {
  const v = makeVault(t);
  for (const f of ['raw/refs/kept.md', 'raw/refs/desktop.ini', 'raw/refs/Thumbs.db', 'raw/refs/~$notes.docx', 'raw/refs/big.pdf.crdownload', 'raw/refs/save.tmp']) v.write(f, 'x');
  v.write('elsewhere/inside.md', 'x');
  fs.symlinkSync(v.at('elsewhere'), v.at('raw', 'refs', 'linked'), 'junction');
  assert.equal(v.run('review.mjs', ['sources']).stdout, 'raw/refs/kept.md\n');
});

test('a web page a browser saved whole is one source, its _files folder going with its .html', t => {
  const v = makeVault(t);
  for (const f of ['raw/refs/shop.html', 'raw/refs/shop_files/app.css', 'raw/refs/shop_files/img/logo.png', 'raw/refs/old.htm', 'raw/refs/old_files/a.css', 'raw/refs/loose_files/b.png']) v.write(f, 'x');
  assert.equal(v.run('review.mjs', ['sources']).stdout, 'raw/refs/loose_files/b.png\nraw/refs/old.htm\nraw/refs/shop.html\n');
  v.write('wiki/demo/source-shop.md', sourcePage({ source: 'raw/refs/shop.html' }));
  assert.equal(v.run('review.mjs', ['sources']).stdout, 'raw/refs/loose_files/b.png\nraw/refs/old.htm\n');
});

test('a copy saved from a URL is named by any source page on that URL', t => {
  const v = makeVault(t);
  const saved = url => `---\nurl: ${url}\nfetched: 2026-10-01\n---\nThe page.\n`;
  v.write('raw/refs/page.md', saved('https://example.com/page'));
  v.write('raw/refs/page-again.md', saved('https://example.com/page'));
  v.write('raw/refs/old.md', saved('https://example.com/old'));
  v.write('raw/refs/other.md', saved('https://example.com/other'));
  v.write('wiki/demo/source-page.md', sourcePage({ source: 'raw/refs/page-again.md' }));
  v.write('wiki/demo/source-old.md', sourcePage({ source: 'https://example.com/old' }));
  assert.equal(v.run('review.mjs', ['sources']).stdout, 'raw/refs/other.md\n');
});

test('review status lists the knowledge rules a newer source on their topic may override', t => {
  const v = makeVault(t);
  v.write('raw/refs/cited.md', 'x');
  const knowledge = opts => ruleNote({ kind: 'knowledge', basis: 'source', applies_to: ['src/**'], ...opts });
  v.write('wiki/demo/old-api.md', knowledge({
    extra: ['as_of: 2026-01-01'],
    evidence: ['- 2026-01-01 · source · session 1a2b3c4d · raw/refs/cited.md · dated 2026-01-01 · "x" (a-00000001)'],
  }).replace('## Examples', '## Examples\n- [[wiki/demo/source-linked|source-linked]]'));
  v.write('wiki/demo/prefix-api.md', knowledge({
    extra: ['as_of: 2026-01-01'],
    evidence: ['- 2026-01-01 · source · session 1a2b3c4d · https://example.com/newer · dated 2026-01-01 · "x" (a-00000002)'],
  }));
  v.write('wiki/demo/gone-api.md', knowledge({ extra: ['as_of: 2026-01-01', 'superseded_by: demo/old-api'] }));
  v.write('wiki/demo/source-newer.md', sourcePage({ source: 'https://example.com/newer', dated: '2026-10-10' }));
  v.write('wiki/demo/source-new.md', sourcePage({ source: 'https://example.com/new', dated: '2026-09-30' }));
  v.write('wiki/demo/source-linked.md', sourcePage({ source: 'https://example.com/linked', dated: '2026-09-30' }));
  v.write('wiki/demo/source-cited.md', sourcePage({ source: './raw/refs/cited.md', dated: '2026-05-01' }));
  v.write('wiki/demo/source-old.md', sourcePage({ source: 'https://example.com/old', dated: '2025-12-01' }));
  v.write('wiki/demo/source-undated.md', sourcePage({ source: 'https://example.com/undated' }));
  v.write('wiki/demo/source-layout.md', sourcePage({ source: 'https://example.com/layout', dated: '2026-09-30', topic: 'layout' }));
  v.write('wiki/global/source-global.md', sourcePage({ source: 'https://example.com/global', dated: '2026-09-30', domain: 'global' }));
  assert.deepEqual(sectionOf(v.run('review.mjs', ['status']).stdout, 'Knowledge rules a newer source on their topic may override'), [
    '- demo/old-api, as of 2026-01-01: demo/source-new (dated 2026-09-30) and demo/source-newer (dated 2026-10-10)',
    '- demo/prefix-api, as of 2026-01-01: demo/source-cited (dated 2026-05-01), demo/source-linked (dated 2026-09-30) and demo/source-new (dated 2026-09-30)',
  ]);
});

test('a source rule propose.mjs writes is not one its own source may override', t => {
  const v = makeVault(t);
  const sid = sessionId();
  v.startSession(sid, { transcript: v.transcript(sid, [userTurn('hi')]) });
  v.write('raw/refs/changelog.md', 'The new solver is on by default.\n');
  const r = v.propose(sid, {
    domain: 'demo', slug: 'new-solver', topic: 'code', kind: 'knowledge', basis: 'source', source: 'raw/refs/changelog.md', source_date: '2026-10-01',
    quote: 'The new solver is on by default', do: 'Expect the new solver.', not: 'Assume the old solver.', because: '', applies_to: ['src/**'],
  });
  assert.equal(r.code, 0, r.stderr);
  v.write('wiki/demo/source-changelog.md', sourcePage({ source: 'raw/refs/changelog.md', dated: '2026-10-05' }));
  v.write('wiki/demo/source-blog.md', sourcePage({ source: 'https://example.com/blog', dated: '2026-10-05' }));
  assert.deepEqual(sectionOf(v.run('review.mjs', ['status']).stdout, 'Knowledge rules a newer source on their topic may override'), [
    '- demo/new-solver, as of 2026-10-01: demo/source-blog (dated 2026-10-05)',
  ]);
});
