import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeVault, sha256 } from './fixture.mjs';

const bundle = (v, args) => v.run('bundle.mjs', args);
const files = { 'raw/refs/lib/src/main.c': 'int main;\n', 'raw/refs/lib/README': 'Readme.\n', 'raw/refs/lib/b.txt': 'b\n' };
const withLib = t => {
  const v = makeVault(t);
  for (const [rel, text] of Object.entries(files)) v.write(rel, text);
  return v;
};
const bundleFound = async v => (await v.import('lib/lint.mjs')).lint().filter(f => f.file.startsWith('raw/refs/'));

test('with --url or --repo, --commit is needed and source.md holds those fields; otherwise a sorted sha256 line per file', async t => {
  const v = withLib(t);
  const r = bundle(v, ['raw/refs/lib']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(v.read('raw/refs/lib/source.md'), [
    '---', 'sha256:',
    `  - '${sha256('Readme.\n')}  README'`, `  - '${sha256('b\n')}  b.txt'`, `  - '${sha256('int main;\n')}  src/main.c'`,
    '---', '',
  ].join('\n'));
  v.write('raw/refs/pinned/a.txt', 'a\n');
  assert.equal(bundle(v, ['raw/refs/pinned', '--url', 'https://example.com/glim/pinned', '--commit', '0123456']).code, 0);
  assert.equal(v.read('raw/refs/pinned/source.md'), "---\nurl: https://example.com/glim/pinned\ncommit: '0123456'\n---\n");
  v.write('raw/refs/git/a.txt', 'a\n');
  assert.equal(bundle(v, ['raw/refs/git', '--commit', 'a1b2c3d4e5f6', '--repo', 'pkg/ledger']).code, 0);
  assert.equal(v.read('raw/refs/git/source.md'), "---\nrepo: pkg/ledger\ncommit: 'a1b2c3d4e5f6'\n---\n");
  for (const args of [['--url', 'https://example.com/glim/x'], ['--repo', 'pkg/x'], ['--commit', 'a1b2c3d4e5f6'], ['--url', 'https://example.com/x', '--repo', 'pkg/x', '--commit', 'a1b2c3d4e5f6']]) {
    v.write('raw/refs/more/a.txt', 'a\n');
    const bad = bundle(v, ['raw/refs/more', ...args]);
    assert.equal(bad.code, 2, args.join(' '));
    assert.equal(fs.existsSync(v.at('raw', 'refs', 'more', 'source.md')), false);
  }
});

test('it prints what it wrote and exits 0, refuses with 1 and writes nothing, and exits 2 on a bad path or flag', t => {
  const v = withLib(t);
  const r = bundle(v, [v.at('raw', 'refs', 'lib')]);
  assert.deepEqual([r.code, r.stdout], [0, 'wrote raw/refs/lib/source.md: 3 files\n']);
  const before = v.read('raw/refs/lib/source.md');
  const again = bundle(v, ['raw/refs/lib']);
  assert.deepEqual([again.code, again.stderr], [1, 'Not written: raw/refs/lib already has a source.md, and raw/ is append-only.\n']);
  assert.equal(v.read('raw/refs/lib/source.md'), before);
  const inner = bundle(v, ['raw/refs/lib/src']);
  assert.deepEqual([inner.code, inner.stderr], [1, 'Not written: raw/refs/lib/src is inside raw/refs/lib, which is one source already.\n']);
  assert.equal(fs.existsSync(v.at('raw', 'refs', 'lib', 'src', 'source.md')), false);
  fs.mkdirSync(v.at('raw', 'refs', 'empty'), { recursive: true });
  const empty = bundle(v, ['raw/refs/empty']);
  assert.deepEqual([empty.code, empty.stderr], [1, 'Not written: raw/refs/empty holds no files.\n']);
  assert.deepEqual(fs.readdirSync(v.at('raw', 'refs', 'empty')), []);
  v.write('raw/picks/a/x.txt', 'x\n');
  for (const args of [['raw/picks/a'], ['raw/refs'], ['raw/refs/missing'], ['raw/refs/lib/README'], [], ['raw/refs/lib', '--sha'], ['raw/refs/lib', 'raw/refs/empty'], ['raw/refs/lib', '--url', 'not a url', '--commit', 'a1b2c3d4']]) {
    assert.equal(bundle(v, args).code, 2, args.join(' '));
  }
  assert.equal(fs.existsSync(v.at('raw', 'picks', 'a', 'source.md')), false);
});

test('it writes with writeText, and lint checks the result as it checks any bundle', async t => {
  const v = withLib(t);
  assert.equal(bundle(v, ['raw/refs/lib']).code, 0);
  assert.deepEqual(fs.readdirSync(v.at('raw', 'refs', 'lib')).filter(f => f.endsWith('.tmp')), []);
  v.write('raw/refs/pinned/a.txt', 'a\n');
  assert.equal(bundle(v, ['raw/refs/pinned', '--url', 'https://example.com/glim/pinned', '--commit', 'a1b2c3d4e5f6']).code, 0);
  assert.deepEqual(await bundleFound(v), []);
  const { refSources } = await v.import('lib/sources.mjs');
  assert.deepEqual(refSources(), { loose: [], bundles: ['raw/refs/lib', 'raw/refs/pinned'] });
  fs.writeFileSync(v.at('raw', 'refs', 'lib', 'b.txt'), 'changed\n');
  assert.deepEqual((await bundleFound(v)).map(f => [f.file, f.msg]), [['raw/refs/lib/source.md', "b.txt doesn't match its sha256 line in source.md"]]);
});
