import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeVault, cleanEnv, ruleNote, pageNote as page, sourcePage, userTurn, sessionId, sectionOf } from './fixture.mjs';


test('review sources lists the files in raw/refs/ no source page names, and status lists them too', t => {
  const v = makeVault(t);
  for (const f of ['raw/refs/named.md', 'raw/refs/shop.png', 'raw/refs/docs/strict.md', 'raw/refs/.obsidian-tmp']) v.write(f, 'x');
  v.write('wiki/glim/source-named.md', sourcePage({ source: 'raw/refs/named.md' }));
  v.write('wiki/glim/source-web.md', sourcePage({ source: 'https://example.com/web' }));
  v.write('wiki/glim/shop-grid.md', page({ kind: 'concept', body: ['A grid.[^1]', '', '[^1]: raw/refs/shop.png'] }));
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
  v.write('wiki/glim/source-named.md', sourcePage({ source: 'raw/refs/named.md' }));
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
  v.write('wiki/glim/source-shop.md', sourcePage({ source: 'raw/refs/shop.html' }));
  assert.equal(v.run('review.mjs', ['sources']).stdout, 'raw/refs/loose_files/b.png\nraw/refs/old.htm\n');
});

test('a copy saved from a URL is named by any source page on that URL', t => {
  const v = makeVault(t);
  const saved = url => `---\nurl: ${url}\nfetched: 2026-10-01\n---\nThe page.\n`;
  v.write('raw/refs/page.md', saved('https://example.com/page'));
  v.write('raw/refs/page-again.md', saved('https://example.com/page'));
  v.write('raw/refs/old.md', saved('https://example.com/old'));
  v.write('raw/refs/other.md', saved('https://example.com/other'));
  v.write('wiki/glim/source-page.md', sourcePage({ source: 'raw/refs/page-again.md' }));
  v.write('wiki/glim/source-old.md', sourcePage({ source: 'https://example.com/old' }));
  assert.equal(v.run('review.mjs', ['sources']).stdout, 'raw/refs/other.md\n');
});

test('review status lists the knowledge rules a newer source on their topic may override', t => {
  const v = makeVault(t);
  v.write('raw/refs/cited.md', 'x');
  const knowledge = opts => ruleNote({ kind: 'knowledge', basis: 'source', applies_to: ['src/**'], ...opts });
  v.write('wiki/glim/old-api.md', knowledge({
    extra: ['as_of: 2026-01-01'],
    evidence: ['- 2026-01-01 · source · session 1a2b3c4d · raw/refs/cited.md · dated 2026-01-01 · "x" (a-00000001)'],
  }).replace('## Examples', '## Examples\n- [[wiki/glim/source-linked|source-linked]]'));
  v.write('wiki/glim/prefix-api.md', knowledge({
    extra: ['as_of: 2026-01-01'],
    evidence: ['- 2026-01-01 · source · session 1a2b3c4d · https://example.com/newer · dated 2026-01-01 · "x" (a-00000002)'],
  }));
  v.write('wiki/glim/gone-api.md', knowledge({ extra: ['as_of: 2026-01-01', 'superseded_by: glim/old-api'] }));
  v.write('wiki/glim/source-newer.md', sourcePage({ source: 'https://example.com/newer', dated: '2026-10-10' }));
  v.write('wiki/glim/source-new.md', sourcePage({ source: 'https://example.com/new', dated: '2026-09-30' }));
  v.write('wiki/glim/source-linked.md', sourcePage({ source: 'https://example.com/linked', dated: '2026-09-30' }));
  v.write('wiki/glim/source-cited.md', sourcePage({ source: './raw/refs/cited.md', dated: '2026-05-01' }));
  v.write('wiki/glim/source-old.md', sourcePage({ source: 'https://example.com/old', dated: '2025-12-01' }));
  v.write('wiki/glim/source-undated.md', sourcePage({ source: 'https://example.com/undated' }));
  v.write('wiki/glim/source-layout.md', sourcePage({ source: 'https://example.com/layout', dated: '2026-09-30', topic: 'layout' }));
  v.write('wiki/global/source-global.md', sourcePage({ source: 'https://example.com/global', dated: '2026-09-30', domain: 'global' }));
  assert.deepEqual(sectionOf(v.run('review.mjs', ['status']).stdout, 'Knowledge rules a newer source on their topic may override'), [
    '- glim/old-api, as of 2026-01-01: glim/source-new (dated 2026-09-30) and glim/source-newer (dated 2026-10-10)',
    '- glim/prefix-api, as of 2026-01-01: glim/source-cited (dated 2026-05-01), glim/source-linked (dated 2026-09-30) and glim/source-new (dated 2026-09-30)',
  ]);
});

test('a source rule propose.mjs writes is not one its own source may override', t => {
  const v = makeVault(t);
  const sid = sessionId();
  v.startSession(sid, { transcript: v.transcript(sid, [userTurn('hi')]) });
  v.write('raw/refs/changelog.md', 'The new solver is on by default.\n');
  const r = v.propose(sid, {
    domain: 'glim', slug: 'new-solver', topic: 'code', kind: 'knowledge', basis: 'source', source: 'raw/refs/changelog.md', source_date: '2026-10-01',
    quote: 'The new solver is on by default', do: 'Expect the new solver.', not: 'Assume the old solver.', because: '', applies_to: ['src/**'],
  });
  assert.equal(r.code, 0, r.stderr);
  v.write('wiki/glim/source-changelog.md', sourcePage({ source: 'raw/refs/changelog.md', dated: '2026-10-05' }));
  v.write('wiki/glim/source-blog.md', sourcePage({ source: 'https://example.com/blog', dated: '2026-10-05' }));
  assert.deepEqual(sectionOf(v.run('review.mjs', ['status']).stdout, 'Knowledge rules a newer source on their topic may override'), [
    '- glim/new-solver, as of 2026-10-01: glim/source-blog (dated 2026-10-05)',
  ]);
});

test('review sources never lists derived text, which is not a source to ingest', t => {
  const v = makeVault(t);
  v.write(`derived/${'a'.repeat(64)}.md`, '---\nkind: pdf\n---\nx\n');
  assert.equal(v.run('review.mjs', ['sources']).stdout, 'Every file in raw/refs/ has a source page.\n');
});

test('a folder with a source.md is one source however many files it holds, named by its folder or any path in it', t => {
  const v = makeVault(t);
  for (const f of ['raw/refs/lib/src/a.c', 'raw/refs/lib/src/b.c', 'raw/refs/lib/README', 'raw/refs/other/x.c', 'raw/refs/other/y.c']) v.write(f, 'x');
  v.write('raw/refs/lib/source.md', '---\nurl: https://example.com/glim/lib\ncommit: a1b2c3d4e5f6\n---\n');
  v.write('raw/refs/other/source.md', '---\nurl: https://example.com/glim/other\ncommit: a1b2c3d4e5f6\n---\n');
  v.write('raw/refs/docs/guide.md', 'x');
  assert.equal(v.run('review.mjs', ['sources']).stdout, 'raw/refs/docs/guide.md\nraw/refs/lib\nraw/refs/other\n');
  v.write('wiki/glim/source-lib.md', sourcePage({ source: 'raw/refs/lib' }));
  v.write('wiki/glim/source-other.md', sourcePage({ source: 'raw/refs/other/x.c' }));
  assert.equal(v.run('review.mjs', ['sources']).stdout, 'raw/refs/docs/guide.md\n');
  assert.deepEqual(sectionOf(v.run('review.mjs', ['status']).stdout, 'Sources in raw/refs/ no source page names'), ['- raw/refs/docs/guide.md']);
});

test('a bundle at a new commit of the same URL is a new version, not a source already named', t => {
  const v = makeVault(t);
  const bundle = (name, commit) => {
    v.write(`raw/refs/${name}/a.c`, 'x');
    v.write(`raw/refs/${name}/source.md`, `---\nurl: https://example.com/glim/lib\ncommit: ${commit}\n---\n`);
  };
  bundle('lib-1', 'a1b2c3d');
  bundle('lib-1-again', 'a1b2c3d');
  bundle('lib-2', 'b2c3d4e');
  v.write('wiki/glim/source-lib.md', sourcePage({ source: 'raw/refs/lib-1' }));
  assert.equal(v.run('review.mjs', ['sources']).stdout, 'raw/refs/lib-2\n');
});

test('a file re-fetched from the same URL with a new sha256 is a new version, and one with the same sha256 is not', t => {
  const v = makeVault(t);
  const hex = c => c.repeat(64);
  const saved = (url, sha256) => `---\nurl: ${url}\nfetched: 2026-10-01\n${sha256 ? `sha256: ${sha256}\n` : ''}---\nThe page.\n`;
  v.write('raw/refs/page-v1.md', saved('https://example.com/page', hex('a')));
  v.write('raw/refs/page-v1-again.md', saved('https://example.com/page', hex('a')));
  v.write('raw/refs/page-v2.md', saved('https://example.com/page', hex('b')));
  v.write('raw/refs/old-v1.md', saved('https://example.com/old', hex('c')));
  v.write('raw/refs/old-v2.md', saved('https://example.com/old', hex('d')));
  v.write('raw/refs/plain-1.md', saved('https://example.com/plain'));
  v.write('raw/refs/plain-2.md', saved('https://example.com/plain'));
  v.write('wiki/glim/source-page.md', sourcePage({ source: 'raw/refs/page-v1.md' }));
  v.write('wiki/glim/source-old.md', sourcePage({ source: 'https://example.com/old' }));
  v.write('wiki/glim/source-plain.md', sourcePage({ source: 'raw/refs/plain-1.md' }));
  assert.equal(v.run('review.mjs', ['sources']).stdout, 'raw/refs/old-v1.md\nraw/refs/old-v2.md\nraw/refs/page-v2.md\n', 'a page on the bare URL names only copies with no sha256; a page on a file names it and copies with its sha256');
});

test('a fresh checkout with core.autocrlf=true leaves the files in raw/ as they were saved', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-eol-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = cleanEnv({ GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.autocrlf=true', '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, env, stdio: 'pipe' });
  const [origin, clone] = ['origin', 'clone'].map(n => path.join(dir, n));
  fs.mkdirSync(path.join(origin, 'raw', 'refs'), { recursive: true });
  fs.copyFileSync(path.resolve(import.meta.dirname, '..', '.gitattributes'), path.join(origin, '.gitattributes'));
  const saved = Buffer.from('---\nurl: https://example.com/a\n---\nOne line.\nAnother.\n');
  fs.writeFileSync(path.join(origin, 'raw', 'refs', 'a.md'), saved);
  git(origin, 'init', '-q');
  git(origin, 'add', '-A');
  git(origin, 'commit', '-q', '-m', 'save a');
  git(dir, 'clone', '-q', origin, clone);
  assert.deepEqual(fs.readFileSync(path.join(clone, 'raw', 'refs', 'a.md')), saved);
});

test("a rule citing a file in a bundle isn't told the bundle's source page is newer", t => {
  const v = makeVault(t);
  v.write('raw/refs/lib/source.md', '---\nurl: https://example.com/lib\ncommit: a1b2c3d4e5f6\n---\n');
  v.write('raw/refs/lib/a.md', 'x');
  v.write('wiki/glim/bundle-api.md', ruleNote({
    kind: 'knowledge', basis: 'source', applies_to: ['src/**'], extra: ['as_of: 2026-01-01'],
    evidence: ['- 2026-01-01 · source · session 1a2b3c4d · raw/refs/lib/a.md · dated 2026-01-01 · "x" (a-00000001)'],
  }));
  v.write('wiki/glim/source-lib.md', sourcePage({ source: 'raw/refs/lib', dated: '2026-10-10' }));
  assert.deepEqual(sectionOf(v.run('review.mjs', ['status']).stdout, 'Knowledge rules a newer source on their topic may override'), ['None.']);
});
