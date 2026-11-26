import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeVault, sessionId, userTurn, assistantTurn, recordedCall, keepAllowed, offerOf, sha256 } from './fixture.mjs';

// vault.config.json ships with the repo, and the repo may be public, so what is the user's own (their domains, their
// proposals mode, their privacy allow ids) goes in the untracked vault.local.json, which wins over it.
const typed = said => said.flatMap(s => [userTurn(s), assistantTurn('Noted.')]);
const lintLines = v => v.run('lint.mjs').stdout.split('\n').filter(Boolean);
const lintErrors = v => lintLines(v).filter(l => l.startsWith('error '));
const local = v => JSON.parse(v.read('vault.local.json'));

function started(v, cwd, said) {
  const sid = sessionId();
  v.startSession(sid, { cwd, transcript: v.transcript(sid, typed(said)) });
  return sid;
}

function folder(t, files = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-local-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const rel of files) fs.writeFileSync(path.join(dir, rel), '');
  return dir;
}

test('the domain tool writes a new domain to vault.local.json and leaves vault.config.json as it was', t => {
  const v = makeVault(t);
  const shared = v.read('vault.config.json');
  const dir = folder(t, ['quill.project']);
  const sid = started(v, dir, ['yes, start a quill domain']);
  const input = { name: 'quill', title: 'Quill', topics: ['code'], marker: 'quill.project' };
  const r = v.run('domain.mjs', [sid], { input });
  assert.equal(r.code, 0, r.stderr);
  const o = offerOf(r.stdout);
  const k = keepAllowed(v, sid, o.id, o.text);
  assert.equal(k.code, 0, k.stderr);
  assert.equal(v.read('vault.config.json'), shared);
  assert.deepEqual(local(v).domains.quill, { title: 'Quill', topics: ['code'], markers: ['quill.project'] });
  assert.match(k.stdout, /vault\.local\.json/);
  assert.doesNotMatch(k.stdout, /vault\.config\.json|committed and pulled/);
  assert.deepEqual(lintErrors(v), []);
  const again = v.run('domain.mjs', [started(v, dir, ['start quill again'])], { input });
  assert.equal(again.code, 1);
  assert.match(again.stderr, /already has a domain quill/);
});

test('the proposals tool writes the mode to vault.local.json, for every domain or one, and leaves vault.config.json as it was', t => {
  const v = makeVault(t, { config: { proposals: 'ask' } });
  const shared = v.read('vault.config.json');
  const sid = started(v, v.project, ['switch rules to off', 'glim, corrections']);
  const set = input => v.run('proposals.mjs', [sid, recordedCall(v, sid, { tool: 'proposals', input })], { input });
  const off = set({ mode: 'off' });
  assert.equal(off.code, 0, off.stderr);
  const glim = set({ mode: 'corrections', domain: 'glim' });
  assert.equal(glim.code, 0, glim.stderr);
  assert.equal(v.read('vault.config.json'), shared);
  assert.equal(local(v).proposals, 'off');
  assert.equal(local(v).domains.glim.proposals, 'corrections');
  assert.match(off.stdout, /vault\.local\.json/);
  assert.deepEqual(lintErrors(v), []);
});

test('vault.local.json wins over vault.config.json, and a domain it declares is a domain', t => {
  const v = makeVault(t, {
    config: { proposals: 'corrections' },
    local: { solo: { title: 'Solo', topics: ['code'], vaultOnly: true } },
  });
  v.write('vault.local.json', JSON.stringify({ ...local(v), proposals: 'off' }));
  const r = v.propose(started(v, v.project, ['hi']), {
    domain: 'glim', slug: 'tidy-names', topic: 'code', basis: 'stated', quote: 'hi',
    do: 'Name widgets after their screen.', not: 'Leave widget names bare.', keywords: ['widgetz'],
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /only when the user asks/);
  assert.deepEqual(lintErrors(v), []);
  assert.doesNotMatch(lintLines(v).join('\n'), /solo isn't a domain/);
});

test('a domain vault.local.json gives only paths, which no file declares, is still an error there', t => {
  const v = makeVault(t, { local: { typo: { paths: [os.tmpdir()] } } });
  assert.ok(lintErrors(v).some(l => l.startsWith('error vault.local.json') && /typo/.test(l)), lintErrors(v).join('\n'));
});

test('lint names the file that holds a bad value', t => {
  const v = makeVault(t, { local: { glim: { proposals: 'sometimes' } } });
  const errors = lintErrors(v);
  assert.ok(errors.some(l => l.startsWith('error vault.local.json') && /sometimes/.test(l)), errors.join('\n'));
  assert.ok(!errors.some(l => l.startsWith('error vault.config.json')), errors.join('\n'));
});

test('privacy.allow in vault.local.json lets a listed value through', t => {
  const token = 'Zq3xV9pL2mK8wR4tY7uN1bC6dF0gH5jS';
  const v = makeVault(t);
  v.write('raw/refs/notes.md', `---\nurl: https://example.com\nfetched: 2026-01-01\n---\ncurl -H "Authorization: Bearer ${token}"\n`);
  assert.equal(v.run('scan.mjs', ['raw/refs/notes.md']).code, 1);
  v.write('vault.local.json', JSON.stringify({ ...local(v), privacy: { allow: [sha256(token).slice(0, 16)] } }));
  const r = v.run('scan.mjs', ['raw/refs/notes.md']);
  assert.equal(r.code, 0, r.stdout);
});

test('lint reports a domain vault.config.json sets to null rather than failing', t => {
  const v = makeVault(t);
  v.write('vault.config.json', JSON.stringify({ ...JSON.parse(v.read('vault.config.json')), domains: { ...JSON.parse(v.read('vault.config.json')).domains, ghost: null } }));
  const r = v.run('lint.mjs');
  assert.doesNotMatch(r.stdout + r.stderr, /lint failed/);
  assert.match(r.stdout, /ghost/);
});

test('a domain entry in vault.local.json that is a list or a string is an error, not a domain', t => {
  const v = makeVault(t);
  v.write('vault.local.json', JSON.stringify({ ...local(v), domains: { ...local(v).domains, listed: [os.tmpdir()], named: 'x' } }));
  const errors = lintErrors(v);
  for (const d of ['listed', 'named']) assert.ok(errors.some(l => l.startsWith('error vault.local.json') && l.includes(`${d} must be an object`)), errors.join('\n'));
});

test('a domain named after an object built-in keeps its settings when vault.local.json has domains', t => {
  const v = makeVault(t);
  const shared = JSON.parse(v.read('vault.config.json'));
  v.write('vault.config.json', JSON.stringify({ ...shared, domains: { ...shared.domains, constructor: { title: 'C', topics: ['code'], markers: ['c.txt'] } } }));
  assert.doesNotMatch(lintLines(v).join('\n'), /constructor reaches no project/);
});

test('a broken vault.local.json still leaves vault.config.json checked', t => {
  const v = makeVault(t);
  const shared = JSON.parse(v.read('vault.config.json'));
  v.write('vault.config.json', JSON.stringify({ ...shared, domains: { ...shared.domains, glim: { ...shared.domains.glim, markers: 'x.txt' } } }));
  v.write('vault.local.json', '{ broken');
  const errors = lintErrors(v);
  assert.ok(errors.some(l => l.startsWith('error vault.local.json') && /must be a JSON object/.test(l)), errors.join('\n'));
  assert.ok(errors.some(l => l.startsWith('error vault.config.json') && /glim: markers/.test(l)), errors.join('\n'));
});

test('a global entry in vault.local.json without paths is not told it takes no paths', t => {
  const v = makeVault(t);
  v.write('vault.local.json', JSON.stringify({ ...local(v), domains: { ...local(v).domains, global: { proposals: 'off' } } }));
  const errors = lintErrors(v);
  assert.ok(errors.some(l => l.startsWith('error vault.local.json') && /global is built in/.test(l)), errors.join('\n'));
  assert.ok(!errors.some(l => /takes no paths/.test(l)), errors.join('\n'));
});
