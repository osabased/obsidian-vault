import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeVault, sessionId, ruleNote, sourcePage, sha256, sectionOf, withFields, serve, gitRepo, LEDGER_GUIDE } from './fixture.mjs';
import { today } from '../tools/lib/vault.mjs';

// What refresh does to raw/refs/ and .state/derived.json (design §8 item 4). Every server is one the test starts on
// 127.0.0.1, and every git source a repository in a temp folder.

const filesUnder = (v, dir) => Object.fromEntries(fs.readdirSync(v.at(...dir.split('/')), { recursive: true, withFileTypes: true })
  .filter(e => e.isFile()).map(e => [path.relative(v.root, path.join(e.parentPath, e.name)).replace(/\\/g, '/'), sha256(fs.readFileSync(path.join(e.parentPath, e.name)))]));
const derived = v => JSON.parse(v.read('.state/derived.json'));
const lines = r => r.stdout.trimEnd().split('\n');
const refresh = async (v, opts) => {
  const r = await v.runAsync('refresh.mjs', [], opts);
  assert.equal(r.code, 0, `refresh exited ${r.code}: ${r.stderr}`);
  return r;
};
const saved = (v, rel, fields, body) => v.write(rel, withFields(fields, body));
const knowledgeRule = (domain, ref, quote, extra = []) => ruleNote({
  domain, topic: 'code', kind: 'knowledge', basis: 'source', applies_to: ['src/**'], extra: ['as_of: 2026-10-01', ...extra],
  doLine: 'Use what the source says.', notLine: 'Guess.', because: 'The source says so.',
  evidence: [`- 2026-10-01 · source · session 1a2b3c4d · ${ref} · dated 2026-10-01 · "${quote}" (a-00000009)`],
});

async function closedPort() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('each failed URL check records its reason, keeps checked and writes nothing under raw/', async t => {
  const server = await serve(t, {
    '/hang': { hang: true },
    '/moved': { status: 301, location: '/elsewhere' },
    '/big': { body: 'x'.repeat(200) },
    '/latin': { body: Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]) },
  });
  const v = makeVault(t, { config: { refresh: { timeoutSeconds: 1, maxBytes: 64 } } });
  const urls = {
    closed: `http://127.0.0.1:${await closedPort()}/gone`, hang: server.url('/hang'), missing: server.url('/missing'),
    moved: server.url('/moved'), big: server.url('/big'), latin: server.url('/latin'),
  };
  for (const [name, url] of Object.entries(urls)) saved(v, `raw/refs/${name}.md`, { url, fetched: '2026-10-01', sha256: sha256('Old text.\n') }, 'Old text.\n');
  const before = filesUnder(v, 'raw');
  const r = await refresh(v);
  const reasons = {
    closed: 'fetch failed: ECONNREFUSED', hang: 'no answer in 1 s', missing: 'HTTP 404', moved: 'redirected to /elsewhere',
    big: 'body over 64 bytes', latin: "body isn't UTF-8 text",
  };
  for (const [name, why] of Object.entries(reasons)) {
    assert.ok(lines(r).includes(`failed ${urls[name]}: ${why}`), `no failed line for ${name}:\n${r.stdout}`);
    const got = derived(v).sources[urls[name]];
    assert.deepEqual([got.result, got.why, got.checked], ['failed', why, '2026-10-01'], name);
  }
  assert.equal(lines(r).at(-1), '6 sources: 0 unchanged, 0 changed, 0 baseline, 6 failed. 0 notes unverified.');
  assert.deepEqual(filesUnder(v, 'raw'), before, 'a failed check wrote under raw/');
  const failed = sectionOf(v.run('review.mjs', ['status']).stdout, 'Source checks that failed') ?? [];
  assert.ok(failed.includes(`- ${urls.missing}: last checked 2026-10-01 · HTTP 404`), failed.join('\n'));
  assert.equal(failed.length, 6);
});

test('each failed git check records its reason and writes nothing under raw/', async t => {
  const repo = gitRepo(t, { 'docs/a.md': 'Alpha.\n', 'docs/b.md': 'Beta.\n' });
  const v = makeVault(t);
  saved(v, 'raw/refs/a.md', { repo: repo.dir, path: 'docs/a.md', commit: 'f'.repeat(40), fetched: '2026-10-01' }, 'Alpha.\n');
  saved(v, 'raw/refs/b.md', { repo: repo.dir, path: 'docs/b.md', commit: repo.commit, fetched: '2026-10-01' }, 'Beta.\n');
  const removed = repo.change({ 'docs/b.md': null });
  const before = filesUnder(v, 'raw');
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-nogit-'));
  t.after(() => fs.rmSync(bare, { recursive: true, force: true }));
  const pathKey = Object.keys(process.env).find(k => /^path$/i.test(k)) ?? 'PATH';
  let r = await refresh(v, { env: { [pathKey]: bare } });
  assert.ok(lines(r).includes(`failed ${repo.dir} docs/a.md: git not found`), r.stdout);
  assert.ok(lines(r).includes(`failed ${repo.dir} docs/b.md: git not found`), r.stdout);
  r = await refresh(v);
  assert.ok(lines(r).includes(`failed ${repo.dir} docs/a.md: commit ${'f'.repeat(40)} isn't in ${repo.dir}`), r.stdout);
  assert.ok(lines(r).includes(`failed ${repo.dir} docs/b.md: docs/b.md is gone at ${removed.slice(0, 8)}`), r.stdout);
  assert.equal(derived(v).sources[`${repo.dir} docs/b.md`].checked, '2026-10-01');
  assert.deepEqual(filesUnder(v, 'raw'), before, 'a failed check wrote under raw/');
});

test('a source saved with no sha256 gets a baseline copy, which marks nothing unverified, and later checks compare with it', async t => {
  const server = await serve(t, { '/notes': { body: 'Served text.\n' } });
  const v = makeVault(t);
  const url = server.url('/notes');
  saved(v, 'raw/refs/notes.md', { url, fetched: '2026-10-01' }, 'Old text.\n');
  v.write('wiki/glim/rules/notes-fact.md', knowledgeRule('glim', 'raw/refs/notes.md', 'Old text'));
  let r = await refresh(v);
  const base = `raw/refs/notes.${sha256('Served text.\n').slice(0, 8)}.md`;
  assert.ok(lines(r).includes(`baseline ${url}: ${base}`), r.stdout);
  assert.match(v.read(base), /^baseline: true$/m);
  assert.match(v.read(base), /^replaces: '?raw\/refs\/notes\.md'?$/m);
  assert.deepEqual(derived(v).unverified, {});
  r = await refresh(v);
  assert.ok(lines(r).includes(`unchanged ${url}`), r.stdout);
  server.set('/notes', { body: 'Newer text.\n' });
  r = await refresh(v);
  const copy = `raw/refs/notes.${sha256('Newer text.\n').slice(0, 8)}.md`;
  assert.ok(lines(r).includes(`changed ${url}: ${copy}`), r.stdout);
  assert.deepEqual(derived(v).sources[url].chain, ['raw/refs/notes.md', base, copy]);
  assert.deepEqual(derived(v).unverified['glim/notes-fact'].sources, [url]);
  assert.equal(derived(v).unverified['glim/notes-fact'].since, today());
});

test('copies from one day go in the order their replaces gives, whatever their names', async t => {
  const server = await serve(t, { '/guide': { body: 'Third.\n' } });
  const v = makeVault(t);
  const url = server.url('/guide');
  const day = today();
  saved(v, 'raw/refs/guide.md', { url, fetched: day, sha256: sha256('First.\n') }, 'First.\n');
  saved(v, 'raw/refs/guide.bbbbbbbb.md', { url, fetched: day, sha256: sha256('Second.\n'), replaces: 'raw/refs/guide.md' }, 'Second.\n');
  saved(v, 'raw/refs/guide.aaaaaaaa.md', { url, fetched: day, sha256: sha256('Third.\n'), replaces: 'raw/refs/guide.bbbbbbbb.md' }, 'Third.\n');
  const r = await refresh(v);
  assert.ok(lines(r).includes(`unchanged ${url}`), `refresh compared with a copy other than the last in the chain:\n${r.stdout}`);
  assert.deepEqual(derived(v).sources[url].chain, ['raw/refs/guide.md', 'raw/refs/guide.bbbbbbbb.md', 'raw/refs/guide.aaaaaaaa.md']);
});

test('a body that comes back to an earlier version is saved again under a name with -2', async t => {
  const one = 'One.\n';
  const two = 'Two.\n';
  const server = await serve(t, {});
  const v = makeVault(t);
  const url = server.url('/page');
  saved(v, 'raw/refs/page.md', { url, fetched: '2026-10-01', sha256: sha256(one) }, one);
  const name = (body, n = '') => `raw/refs/page.${sha256(body).slice(0, 8)}${n}.md`;
  for (const body of [two, one, two]) {
    server.set('/page', { body });
    await refresh(v);
  }
  assert.deepEqual(derived(v).sources[url].chain, ['raw/refs/page.md', name(two), name(one), name(two, '-2')]);
  assert.match(v.read(name(two, '-2')), new RegExp(`^replaces: '?${name(one).replace(/\./g, '\\.')}'?$`, 'm'));
  assert.equal(v.read(name(two, '-2')).split('---\n').at(-1), two);
});

test("a doc set's changed manifest gets a copy, and its line counts the links and names the saved pages it dropped", async t => {
  const server = await serve(t, {});
  const page = p => server.url(`/docs/${p}`);
  const manifest = links => `# pkg\n\n${links.map(p => `- [${p}](${page(p)})`).join('\n')}\n`;
  const old = manifest(['one.md', 'two.md']);
  const now = manifest(['two.md', 'three.md']);
  server.set('/llms.txt', { body: now });
  server.set('/docs/one.md', { body: 'Page one.\n' });
  const v = makeVault(t);
  saved(v, 'raw/refs/docs/llms.txt', { url: server.url('/llms.txt'), fetched: '2026-10-01', sha256: sha256(old) }, old);
  saved(v, 'raw/refs/docs/one.md', { url: page('one.md'), fetched: '2026-10-01', sha256: sha256('Page one.\n') }, 'Page one.\n');
  v.write('wiki/glim/rules/page-one.md', knowledgeRule('glim', 'raw/refs/docs/one.md', 'Page one'));
  const r = await refresh(v);
  const copy = `llms.${sha256(now).slice(0, 8)}.txt`;
  assert.ok(lines(r).includes(`changed raw/refs/docs: ${copy}, 1 link added, 1 removed; cited pages no longer listed: one.md`), r.stdout);
  assert.ok(lines(r).includes(`unchanged ${page('one.md')}`), r.stdout);
  assert.equal(v.read(`raw/refs/docs/${copy}`).split('---\n').at(-1), now);
  assert.deepEqual(derived(v).domains.glim, [page('one.md'), 'raw/refs/docs']);
  const listed = v.run('review.mjs', ['sources']).stdout.trimEnd().split('\n');
  assert.deepEqual(listed.filter(l => l.startsWith('raw/refs/docs')), ['raw/refs/docs'], 'the doc set is listed once');
});

test('review status names a source page in another domain whose source is a later copy a knowledge rule cites', async t => {
  const server = await serve(t, { '/ledger': { body: `${LEDGER_GUIDE}In pkg 4, openLedger is gone.\n`, etag: '"ledger-2"' } });
  const repo = gitRepo(t, { 'docs/ledger.md': 'openLedger returns the ledger it opened.\n' });
  const v = makeVault(t, { presets: ['almanac'], sources: { url: server.url('/ledger'), repo: repo.dir, commit: repo.commit } });
  const r = await refresh(v);
  const copy = lines(r).find(l => l.startsWith('changed ')).split(': ').at(-1);
  v.write('wiki/glim/sources/source-ledger-news.md', sourcePage({ domain: 'glim', topic: 'layout', summary: "'What the newer guide says.'", source: copy }));
  const newer = sectionOf(v.run('review.mjs', ['status'], { cwd: v.projects.almanac }).stdout, 'Knowledge rules a newer source on their topic may override') ?? [];
  assert.match(newer.join('\n'), /^- almanac\/ledger-v2, as of \d{4}-\d\d-\d\d: glim\/source-ledger-news \(a later copy\)$/m);
  assert.match(newer.join('\n'), /^- almanac\/ledger-v3, as of \d{4}-\d\d-\d\d: glim\/source-ledger-news \(a later copy\)$/m);
});

test('sessions hear how many cited sources are past checkAfterDays until a refresh checks them', async t => {
  const server = await serve(t, { '/ledger': { body: LEDGER_GUIDE, etag: '"ledger-1"' } });
  const repo = gitRepo(t, { 'docs/ledger.md': 'openLedger returns the ledger it opened.\n' });
  const v = makeVault(t, { presets: ['almanac'], sources: { url: server.url('/ledger'), repo: repo.dir, commit: repo.commit } });
  const cwd = v.projects.almanac;
  const context = source => v.startSession(sessionId(), { cwd, source })?.hookSpecificOutput.additionalContext ?? '';
  const line = `Taste vault: 2 sources the almanac notes cite haven't been checked in 14 days. Remind the user to run /lint in \`${v.root.replace(/\\/g, '/')}\`, which refreshes them.`;
  assert.ok(context('startup').split('\n').includes(line), context('startup'));
  assert.doesNotMatch(context('compact'), /haven't been checked/);
  await refresh(v);
  assert.doesNotMatch(context('startup'), /haven't been checked/);
});

test('a session in the vault folder, which hears every domain, hears of their stale sources too', t => {
  const v = makeVault(t, { presets: ['almanac'] });
  const context = v.startSession(sessionId(), { cwd: v.root })?.hookSpecificOutput.additionalContext ?? '';
  assert.match(context, /^Taste vault: 2 sources the almanac notes cite haven't been checked in 14 days\./m);
});

test("a domain's knowledge settings override the vault's, and a check that goes through keeps a rule from going stale", async t => {
  const server = await serve(t, { '/ledger': { body: LEDGER_GUIDE, etag: '"ledger-1"' } });
  const repo = gitRepo(t, { 'docs/ledger.md': 'openLedger returns the ledger it opened.\n' });
  const sources = { url: server.url('/ledger'), repo: repo.dir, commit: repo.commit };
  const stale = v => v.run('lint.mjs').stdout.split('\n').filter(l => l.startsWith('warn wiki/almanac/rules/ledger-v2.md') && /days (?:old|ago)/.test(l));
  const strict = makeVault(t, { presets: ['almanac'], sources, config: { knowledge: { staleAfterDays: 10 } } });
  assert.equal(stale(strict).length, 1, 'a rule 30 days past as_of with staleAfterDays 10 has no age warning');
  assert.match(stale(strict)[0], /as_of is 30 days old/);
  await refresh(strict);
  assert.deepEqual(stale(strict), [], 'the rule is stale though every source it cites was checked today');
  const lenient = makeVault(t, { presets: ['almanac'], sources, config: { knowledge: { staleAfterDays: 10 } }, domains: { almanac: { knowledge: { staleAfterDays: 60, checkAfterDays: 60 } } } });
  assert.deepEqual(stale(lenient), []);
  const ctx = lenient.startSession(sessionId(), { cwd: lenient.projects.almanac })?.hookSpecificOutput.additionalContext ?? '';
  assert.doesNotMatch(ctx, /haven't been checked/);
});

test('lint warns on a replaces that names no copy, a copy of another source or a copy another file replaces, and on a baseline not true', t => {
  const v = makeVault(t);
  const h = (name, fields) => saved(v, `raw/refs/${name}.md`, { url: 'https://pkg.invalid/h', fetched: '2026-10-01', sha256: sha256('H.\n'), ...fields }, 'H.\n');
  h('h');
  saved(v, 'raw/refs/k.md', { url: 'https://pkg.invalid/k', fetched: '2026-10-01', sha256: sha256('H.\n') }, 'H.\n');
  h('h.11111111', { replaces: 'raw/refs/nope.md' });
  h('h.22222222', { replaces: 'raw/refs/k.md' });
  h('h.33333333', { replaces: 'raw/refs/h.md' });
  h('h.44444444', { replaces: 'raw/refs/h.md' });
  h('h.55555555', { baseline: 'yes' });
  const found = v.run('lint.mjs').stdout.split('\n').filter(l => l.startsWith('warn raw/refs/'));
  const has = (file, re) => assert.ok(found.some(l => l.startsWith(`warn ${file}: `) && re.test(l)), `no warning on ${file} matching ${re}:\n${found.join('\n')}`);
  has('raw/refs/h.11111111.md', /replaces names raw\/refs\/nope\.md, which isn't a file in raw\/refs\//);
  has('raw/refs/h.22222222.md', /replaces names raw\/refs\/k\.md, which is a copy of another source/);
  has('raw/refs/h.33333333.md', /raw\/refs\/h\.44444444\.md replaces raw\/refs\/h\.md too/);
  has('raw/refs/h.44444444.md', /raw\/refs\/h\.33333333\.md replaces raw\/refs\/h\.md too/);
  has('raw/refs/h.55555555.md', /baseline must be true when present/);
  assert.equal(found.filter(l => /replaces|baseline/.test(l)).length, 5, found.join('\n'));
});

test("lint warns that a domain's feeds do nothing yet", t => {
  const v = makeVault(t, { domains: { glim: { feeds: [{ url: 'https://pkg.invalid/feed.xml', parser: 'atom' }] } } });
  assert.ok(v.run('lint.mjs').stdout.split('\n').includes('warn vault.config.json: glim.feeds does nothing yet: no feed parser ships, so refresh reads no feeds'));
});

test('refresh takes no arguments', t => {
  const v = makeVault(t);
  const r = v.run('refresh.mjs', ['--all']);
  assert.equal(r.code, 2);
  assert.equal(r.stderr, 'usage: node tools/refresh.mjs\n');
});
