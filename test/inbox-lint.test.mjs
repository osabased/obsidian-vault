import test from 'node:test';
import assert from 'node:assert/strict';
import { makeVault } from './fixture.mjs';

// raw/ is append-only, so lint can only warn on an inbox row that records consent in a shape the vault doesn't write.

const FILE = 'raw/inbox/2026-11-03-1a2b3c4d.jsonl';
const row = (id, extra = {}) => ({
  id, at: '2026-11-03T10:00:00.000Z', source: 'agent', kind: 'stated', text: 'tabs', note: 'glim/tidy-names',
  session: '1a2b3c4d-0000-4000-8000-000000000001', transcript: null, cwd: null, domain: 'glim', ...extra,
});

async function warnings(t, rows) {
  const v = makeVault(t);
  v.write(FILE, `${rows.map(r => JSON.stringify(r)).join('\n')}\n`);
  return (await v.import('lib/lint.mjs')).lint().filter(f => f.file === FILE).map(f => `${f.level}: ${f.msg}`);
}

test('lint passes rows that record consent as the prompt, or as a typed code with the reply', async t => {
  assert.deepEqual(await warnings(t, [
    row('a-00000001', { consent: 'prompt' }),
    row('a-00000002', { consent: 'code', approved: 'yes, KQ7M' }),
    row('a-00000003', { approved: 'keep it' }),
    row('a-00000004'),
  ]), []);
});

test('lint warns on a consent other than prompt or code', async t => {
  const found = await warnings(t, [row('a-00000001', { consent: 'words' })]);
  assert.equal(found.length, 1);
  assert.match(found[0], /^warn: a-00000001 records consent "words", which is neither "prompt" nor "code"/);
});

test('lint warns on code consent with no approved reply', async t => {
  const found = await warnings(t, [row('a-00000001', { consent: 'code' }), row('a-00000002', { consent: 'code', approved: '' })]);
  assert.equal(found.length, 2);
  assert.match(found[0], /^warn: a-00000001 records consent "code" with no approved/);
});
