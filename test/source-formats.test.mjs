import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeVault, pageNote as page, sourcePage, denied, sessionId, editFile as edit } from './fixture.mjs';

const sha = data => createHash('sha256').update(data).digest('hex');
const found = async v => (await v.import('lib/lint.mjs')).lint();
const msgsFor = async (v, prefix) => (await found(v)).filter(f => f.file.startsWith(prefix)).map(f => f.msg).sort();
const footnoteMsgs = async v => (await found(v)).filter(f => f.file.startsWith('wiki/') && /\[\^/.test(f.msg)).map(f => f.msg).sort();
const cite = (...targets) => page({
  kind: 'concept',
  body: [targets.map((_, i) => `Fact ${i + 1}.[^${i + 1}]`).join(' '), '', ...targets.map((t, i) => `[^${i + 1}]: ${t}`)],
});
const saved = (fields, body = 'The page.\n') => `---\n${Object.entries(fields).map(([k, val]) => `${k}: ${val}`).join('\n')}\n---\n${body}`;
const derived = (fields, body) => `---\n${Object.entries(fields).map(([k, val]) => `${k}: ${val}`).join('\n')}\n---\n${body}`;

test('a saved source with well-formed fields has no findings, and every field is checked when it is present', async t => {
  const v = makeVault(t);
  const body = 'The page.\n';
  v.write('raw/refs/good.md', saved({ url: 'https://example.com/a', fetched: '2026-10-01', etag: '"abc"', last_modified: 'Tue, 15 Sep 2026 08:12:31 GMT', sha256: sha(body) }, body));
  v.write('raw/refs/bare.md', saved({ url: 'https://example.com/b', fetched: '2026-10-01' }));
  assert.deepEqual(await msgsFor(v, 'raw/refs/'), []);

  v.write('raw/refs/bad.md', saved({ url: 'example.com/a', fetched: 'yesterday', etag: "''", last_modified: 'soon', sha256: 'abc123' }));
  v.write('raw/refs/nofetch.md', saved({ url: 'https://example.com/c' }));
  v.write('raw/refs/changed.md', saved({ url: 'https://example.com/d', fetched: '2026-10-01', sha256: sha('another body\n') }));
  const all = (await found(v)).filter(f => f.file.startsWith('raw/refs/'));
  const of = file => all.filter(f => f.file === file).map(f => f.msg).sort();
  assert.deepEqual(of('raw/refs/bad.md'), [
    'etag must be text',
    'fetched must be a date as YYYY-MM-DD',
    'last_modified must be a date',
    'sha256 must be 64 lowercase hex digits',
    'url must be a URL starting http:// or https://',
  ]);
  assert.deepEqual(of('raw/refs/nofetch.md'), ['no fetched. A source saved from a URL gives the day it was fetched']);
  assert.deepEqual(of('raw/refs/changed.md'), ["sha256 doesn't match the text below the frontmatter, so the file changed after it was saved"]);
  assert.ok(all.every(f => f.level === 'warn'), 'raw/ is append-only, so a fix is a new file, not an error');
});

test('the sha256 of a saved source covers its body whatever the line endings', async t => {
  const v = makeVault(t);
  v.write('raw/refs/crlf.md', saved({ url: 'https://example.com/a', fetched: '2026-10-01', sha256: sha('One.\nTwo.\n') }, 'One.\r\nTwo.\r\n').replace(/---\n/g, '---\r\n'));
  assert.deepEqual(await msgsFor(v, 'raw/refs/'), []);
});

test('a git source gives repo, path and commit', async t => {
  const v = makeVault(t);
  v.write('raw/refs/ok.md', saved({ repo: 'https://example.com/demo/lib.git', path: 'src/main.c', commit: 'a1b2c3d' }));
  v.write('raw/refs/partial.md', saved({ repo: 'demo/lib', commit: 'zzz' }));
  v.write('raw/refs/escape.md', saved({ repo: 'demo/lib', path: '../secret', commit: 'a1b2c3d4e5f6' }));
  const all = (await found(v)).filter(f => f.file.startsWith('raw/refs/'));
  const of = file => all.filter(f => f.file === file).map(f => f.msg).sort();
  assert.deepEqual(of('raw/refs/ok.md'), []);
  assert.deepEqual(of('raw/refs/partial.md'), ['commit must be 7 to 64 hex digits', 'no path. A git source gives repo, path and commit']);
  assert.deepEqual(of('raw/refs/escape.md'), ['path must be a relative path inside the repo']);
});

test('a footnote may end its source with a page, time or line locator, and lint checks the syntax', async t => {
  const v = makeVault(t);
  for (const f of ['doc.pdf', 'talk.mp4', 'code.js']) v.write(`raw/refs/${f}`, 'a\nb\nc\n');
  v.write('wiki/demo/ok.md', cite(
    'raw/refs/doc.pdf#page=3', 'raw/refs/talk.mp4#t=00:12:31', 'raw/refs/talk.mp4#t=90', 'raw/refs/talk.mp4#t=npt:1:02,1:30', 'raw/refs/talk.mp4#t=,20',
    'raw/refs/talk.mp4#t=clock:2026-10-01T11:19:01Z,2026-10-01T11:20:01Z', 'raw/refs/code.js#L2', 'raw/refs/code.js#L1-L3', '`raw/refs/doc.pdf#page=3` · dated 2026-10-01',
    'https://example.com/doc.pdf#page=3', 'https://example.com/guide#install', 'https://example.com/lib.js#L10-L20',
  ));
  assert.deepEqual(await footnoteMsgs(v), []);

  v.write('wiki/demo/ok.md', cite(
    'raw/refs/doc.pdf#page=0', 'raw/refs/doc.pdf#page=two', 'raw/refs/talk.mp4#t=12:99', 'raw/refs/talk.mp4#t=30,10', 'raw/refs/code.js#L3-L1', 'raw/refs/code.js#L0',
    'raw/refs/code.js#L1-3', 'raw/refs/doc.pdf#intro', 'raw/refs/doc.pdf#', 'https://example.com/doc.pdf#page=x',
  ));
  const hint = 'Use #page=3, #t=00:12:31 or #L10-L20';
  assert.deepEqual(await footnoteMsgs(v), [
    `footnote [^10] has #page=x. A page is a number of 1 or more, as #page=3`,
    `footnote [^2] has #page=two. A page is a number of 1 or more, as #page=3`,
    `footnote [^1] has #page=0. A page is a number of 1 or more, as #page=3`,
    `footnote [^3] has #t=12:99. Write a time as #t=hh:mm:ss, or in seconds`,
    `footnote [^4] has #t=30,10. A time range ends after it starts`,
    `footnote [^5] has #L3-L1. A line range ends after it starts, as #L10-L20`,
    `footnote [^6] has #L0. Lines count from 1, as #L10 or #L10-L20`,
    `footnote [^7] has #L1-3. Write a line range as #L10-L20`,
    `footnote [^8] ends with #intro, which isn't a locator. ${hint}`,
    `footnote [^9] ends with #, which isn't a locator. ${hint}`,
  ].sort());
});

test('a line range must exist in a text source, and a bundle file is located by path and line', async t => {
  const v = makeVault(t);
  v.write('raw/refs/code.js', 'one\ntwo\nthree\n');
  v.write('raw/refs/blob.bin', Buffer.from([0xff, 0xfe, 0x00, 0x01]));
  v.write('wiki/demo/lines.md', cite('raw/refs/code.js#L3', 'raw/refs/code.js#L2-L4', 'raw/refs/code.js#L4', 'raw/refs/blob.bin#L9999'));
  assert.deepEqual(await footnoteMsgs(v), [
    'footnote [^2] cites lines 2-4 of raw/refs/code.js, which has 3 lines',
    'footnote [^3] cites line 4 of raw/refs/code.js, which has 3 lines',
  ]);
});

test('a page or time anchor must exist in the derived text of its source, and a source without derived text is not checked', async t => {
  const v = makeVault(t);
  const pdf = 'pdf bytes';
  const mp4 = 'mp4 bytes';
  v.write('raw/refs/doc.pdf', pdf);
  v.write('raw/refs/talk.mp4', mp4);
  v.write('raw/refs/other.pdf', 'other bytes');
  v.write(`derived/${sha(pdf)}.md`, derived({ kind: 'pdf', extractor: 'demo-extract', extractor_version: '1.0', source: 'raw/refs/doc.pdf' }, '[p. 1]\nFirst.\n[p. 2]\nSecond.\n'));
  v.write(`derived/${sha(mp4)}.md`, derived({ kind: 'video', extractor: 'demo-transcribe', extractor_version: '2', source: 'raw/refs/talk.mp4' }, '[t=00:00:05]\nHello.\n[t=00:12:31]\nWorld.\n'));
  v.write('wiki/demo/anchors.md', cite(
    'raw/refs/doc.pdf#page=2', 'raw/refs/doc.pdf#page=7', 'raw/refs/talk.mp4#t=00:12:31', 'raw/refs/talk.mp4#t=751', 'raw/refs/talk.mp4#t=00:12:31,00:12:45',
    'raw/refs/talk.mp4#t=00:13:00', 'raw/refs/other.pdf#page=99',
  ));
  assert.deepEqual(await footnoteMsgs(v), [
    'footnote [^2] cites page 7 of raw/refs/doc.pdf, and its derived text has no [p. 7]',
    'footnote [^6] cites 00:13:00 of raw/refs/talk.mp4, and its derived text has no [t=00:13:00]',
  ]);
  assert.deepEqual(await msgsFor(v, 'derived/'), []);
});

test('derived text is named by the hash of its binary, with a valid kind, its extractor and well-formed anchors', async t => {
  const v = makeVault(t);
  const pdf = 'pdf bytes';
  v.write('raw/refs/doc.pdf', pdf);
  const meta = { kind: 'pdf', extractor: 'demo-extract', extractor_version: '1.0', source: 'raw/refs/doc.pdf' };
  v.write(`derived/${sha(pdf)}.md`, derived(meta, '[p. 1]\nA.\n[t=00:00:05]\nB.\n'));
  assert.deepEqual(await msgsFor(v, 'derived/'), []);

  const stale = sha('older bytes');
  v.write(`derived/${stale}.md`, derived(meta, 'x'));
  v.write('derived/notes.md', derived(meta, 'x'));
  v.write(`derived/${sha('gone')}.md`, derived({ ...meta, source: 'raw/refs/gone.pdf' }, 'x'));
  v.write(`derived/${sha('kinds')}.md`, derived({ kind: 'book', source: 'raw/refs/doc.pdf' }, 'x'));
  v.write(`derived/${sha('plain')}.md`, 'just text\n');
  v.write(`derived/${sha('anchors')}.md`, derived({ ...meta, source: 'raw/refs/doc.pdf' }, '[p.3]\n[p. 0]\n[t=0:12:31]\n[t=00:61:00]\n[p. 4]\n[t=00:00:09]\n'));
  const all = (await found(v)).filter(f => f.file.startsWith('derived/'));
  const of = name => all.filter(f => f.file === `derived/${name}.md`).map(f => f.msg).sort();
  assert.deepEqual(of(stale), [`source raw/refs/doc.pdf has changed: its SHA-256 isn't ${stale}. Extract the text again for the new file`]);
  assert.deepEqual(of('notes'), ['named notes.md. Derived text is derived/<sha256>.md, the SHA-256 of the file it was taken from']);
  assert.deepEqual(of(sha('gone')), ["source raw/refs/gone.pdf is gone, so the text can't be checked against it"]);
  assert.deepEqual(of(sha('kinds')), [
    'kind must be pdf, video, audio or image',
    'no extractor. Name the program that made the text',
    'no extractor_version. Give the version of the program that made the text',
    `source raw/refs/doc.pdf has changed: its SHA-256 isn't ${sha('kinds')}. Extract the text again for the new file`,
  ].sort());
  assert.deepEqual(of(sha('plain')), ['no frontmatter. Derived text starts with kind, extractor, extractor_version and source']);
  assert.deepEqual(of(sha('anchors')), [
    `source raw/refs/doc.pdf has changed: its SHA-256 isn't ${sha('anchors')}. Extract the text again for the new file`,
    "anchor [p. 0] isn't [p. N] or [t=hh:mm:ss]",
    "anchor [p.3] isn't [p. N] or [t=hh:mm:ss]",
    "anchor [t=00:61:00] isn't [p. N] or [t=hh:mm:ss]",
    "anchor [t=0:12:31] isn't [p. N] or [t=hh:mm:ss]",
  ].sort());
  assert.ok(all.every(f => f.level === 'warn'));
});

test('the vault guard refuses edits to derived/, which extraction writes', t => {
  const v = makeVault(t);
  const sid = sessionId();
  v.write(`derived/${sha('x')}.md`, 'x');
  const guard = rel => denied(edit(v, sid, '', { abs: v.at(...rel.split('/')) }));
  const why = 'derived/ is written by extraction, not edited by hand. A better extraction replaces the file.';
  assert.equal(guard(`derived/${sha('x')}.md`), why);
  assert.equal(guard(`derived/${sha('new')}.md`), why);
  assert.equal(guard('DERIVED/x.md'), why);
  assert.equal(guard('derived.md'), null);
});

const manifest = (fields, body = '') => `---\n${Object.entries(fields).map(([k, val]) => (Array.isArray(val) ? `${k}:\n${val.map(x => `  - '${x}'`).join('\n')}` : `${k}: ${val}`)).join('\n')}\n---\n${body}`;

test('a folder under raw/refs/ with a source.md is a source, and its manifest is checked', async t => {
  const v = makeVault(t);
  const lib = 'int main() {}\n';
  v.write('raw/refs/lib/src/main.c', lib);
  v.write('raw/refs/lib/README', 'Readme.\n');
  v.write('raw/refs/lib/source.md', manifest({ url: 'https://example.com/demo/lib', fetched: '2026-10-01', sha256: [`${sha(lib)}  src/main.c`, `${sha('Readme.\n')}  ./README`] }));
  v.write('raw/refs/pinned/a.txt', 'a');
  v.write('raw/refs/pinned/source.md', manifest({ url: 'https://example.com/demo/pinned', commit: 'a1b2c3d4e5f6' }));
  v.write('wiki/demo/source-lib.md', sourcePage({ source: 'raw/refs/lib' }));
  v.write('wiki/demo/source-pinned.md', sourcePage({ source: 'raw/refs/pinned' }));
  v.write('wiki/demo/cites.md', cite('raw/refs/lib', 'raw/refs/lib/src/main.c#L1', 'raw/refs/pinned/a.txt#L1'));
  const all = await found(v);
  assert.deepEqual(all.filter(f => f.file.startsWith('raw/') || (f.level === 'error' && f.file.startsWith('wiki/'))).map(f => `${f.file}: ${f.msg}`), []);
  assert.deepEqual(await footnoteMsgs(v), []);
});

test('a bundle manifest that pins nothing, lists a bad line or a hash that does not match its file is warned about', async t => {
  const v = makeVault(t);
  v.write('raw/refs/loose/a.txt', 'a');
  v.write('raw/refs/loose/source.md', manifest({ url: 'https://example.com/demo/loose' }));
  v.write('raw/refs/nocommit/a.txt', 'a');
  v.write('raw/refs/nocommit/source.md', manifest({ commit: 'a1b2c3d4e5f6' }));
  v.write('raw/refs/hashes/a.txt', 'a');
  v.write('raw/refs/hashes/b.txt', 'b');
  v.write('raw/refs/hashes/source.md', manifest({ url: 'https://example.com/demo/hashes', sha256: [`${sha('a')}  a.txt`, `${sha('not b')}  b.txt`, `${sha('c')}  c.txt`, 'abc  d.txt', `${sha('a')} a.txt`] }));
  v.write('raw/refs/scalar/a.txt', 'a');
  v.write('raw/refs/scalar/source.md', manifest({ url: 'https://example.com/demo/scalar', sha256: sha('a') }));
  const all = (await found(v)).filter(f => f.file.startsWith('raw/refs/'));
  const of = dir => all.filter(f => f.file === `raw/refs/${dir}/source.md`).map(f => f.msg).sort();
  assert.deepEqual(of('loose'), ["no commit or sha256. A bundle's source.md pins the folder with a commit, or a sha256 line for each file"]);
  assert.deepEqual(of('nocommit'), ['a commit needs a url or repo. Say where the folder came from']);
  assert.deepEqual(of('hashes'), [
    "b.txt doesn't match its sha256 line in source.md",
    "sha256 line \"abc  d.txt\" isn't '<64 hex>  <path in the folder>', as sha256sum writes it",
    `sha256 line "${sha('a')} a.txt" isn't '<64 hex>  <path in the folder>', as sha256sum writes it`,
    'sha256 lists c.txt, which isn\'t a file in the folder',
  ].sort());
  assert.deepEqual(of('scalar'), ["sha256 must be a list of '<64 hex>  <path>' lines, as sha256sum writes them"]);
});

test('a footnote may cite a line range inside a bundle by its path', async t => {
  const v = makeVault(t);
  v.write('raw/refs/lib/src/main.c', 'a\nb\nc\n');
  v.write('raw/refs/lib/source.md', manifest({ url: 'https://example.com/demo/lib', commit: 'a1b2c3d4e5f6' }));
  v.write('wiki/demo/lines.md', cite('raw/refs/lib/src/main.c#L1-L3', 'raw/refs/lib/src/main.c#L2-L9', 'raw/refs/lib/src/gone.c#L1'));
  assert.deepEqual(await footnoteMsgs(v), [
    'footnote [^2] cites lines 2-9 of raw/refs/lib/src/main.c, which has 3 lines',
    'footnote [^3] names raw/refs/lib/src/gone.c#L1. Cite a URL or a file under raw/ that exists',
  ]);
});

test('a source page names a bundle by its folder, written as the disk spells it', async t => {
  const v = makeVault(t);
  v.write('raw/refs/lib/a.txt', 'a');
  v.write('raw/refs/lib/source.md', manifest({ url: 'https://example.com/demo/lib', commit: 'a1b2c3d4e5f6' }));
  v.write('raw/refs/plain/a.txt', 'a');
  v.write('wiki/demo/source-slash.md', sourcePage({ source: 'raw/refs/lib/' }));
  v.write('wiki/demo/source-plain.md', sourcePage({ source: 'raw/refs/plain' }));
  v.write('wiki/demo/source-inside.md', sourcePage({ source: 'raw/refs/lib/a.txt' }));
  const errors = (await found(v)).filter(f => f.level === 'error' && f.file.startsWith('wiki/'));
  assert.deepEqual(errors.map(f => `${f.file}: ${f.msg}`).sort(), [
    'wiki/demo/source-inside.md: write source as raw/refs/lib, the bundle it is in',
    'wiki/demo/source-plain.md: source must be a URL, a file under raw/ that exists, or a folder under raw/refs/ with a source.md',
    'wiki/demo/source-slash.md: write source as raw/refs/lib, the path from the vault root',
  ]);
});

test('a footnote with a locator, or inside a bundle, cites the source page of its file or bundle', async t => {
  const v = makeVault(t);
  v.write('raw/refs/doc.pdf', 'pdf bytes');
  v.write('raw/refs/lib/src/main.c', 'a\n');
  v.write('raw/refs/lib/source.md', manifest({ url: 'https://example.com/demo/lib', commit: 'a1b2c3d4e5f6' }));
  v.write('wiki/demo/source-doc.md', sourcePage({ source: 'raw/refs/doc.pdf' }));
  v.write('wiki/demo/source-lib.md', sourcePage({ source: 'raw/refs/lib' }));
  v.write('wiki/demo/guide.md', cite('raw/refs/doc.pdf#page=3', 'raw/refs/lib/src/main.c#L1'));
  const { loadNotes, citedSources, resolver } = await v.import('lib/rules.mjs');
  const notes = loadNotes();
  const { pages } = citedSources(notes, resolver(notes))(notes.find(n => n.key === 'demo/guide'));
  assert.deepEqual([...pages].sort(), ['demo/source-doc', 'demo/source-lib']);
});

test('a sha256 line YAML reads as a key and value is warned about, and lint checks the rest', async t => {
  const v = makeVault(t);
  const line = `${sha('a')}  Notes: draft.txt`;
  v.write('raw/refs/lib/a.txt', 'a');
  v.write('raw/refs/lib/source.md', `---\nurl: https://example.com/demo/lib\nsha256:\n  - ${line}\n  - true\n---\n`);
  assert.deepEqual(await msgsFor(v, 'raw/refs/lib/'), [
    `sha256 item ${line} reads as a key and value, not text. Single-quote an item that holds ": ", as in '${line}'`,
    "sha256 item true isn't text. Single-quote it, as in 'true'",
  ]);
});

// Denies reading the file's bytes while its name and size still show, as a file another program holds open does.
function unreadable(t, file) {
  if (process.platform === 'win32') {
    t.after(() => { try { execFileSync('icacls', [file, '/remove:d', process.env.USERNAME]); } catch {} });
    execFileSync('icacls', [file, '/deny', `${process.env.USERNAME}:(RD)`]);
  } else {
    t.after(() => { try { fs.chmodSync(file, 0o644); } catch {} });
    fs.chmodSync(file, 0);
  }
}

test("a source lint can't read is skipped, not reported as changed", async t => {
  if (process.getuid?.() === 0) return t.skip('root reads any file');
  const v = makeVault(t);
  v.write('raw/refs/doc.txt', 'hello source');
  v.write(`derived/${sha('hello source')}.md`, derived({ kind: 'pdf', extractor: 'x', extractor_version: "'1'", source: 'raw/refs/doc.txt' }, '[p. 1] hi\n'));
  v.write('raw/refs/lib/a.txt', 'a');
  v.write('raw/refs/lib/source.md', `---\nurl: https://example.com/demo/lib\nsha256:\n  - '${sha('a')}  a.txt'\n---\n`);
  unreadable(t, v.at('raw', 'refs', 'doc.txt'));
  unreadable(t, v.at('raw', 'refs', 'lib', 'a.txt'));
  assert.deepEqual((await found(v)).filter(f => /has changed|doesn't match/.test(f.msg)), []);
});
