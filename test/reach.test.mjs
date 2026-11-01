import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeVault, ruleNote, pageNote, sessionId, denied, editFile as edit, prompt } from './fixture.mjs';

const ALPHA = { title: 'Alpha', markers: ['alpha.project'], topics: ['code', 'naming'] };
const BETA = { title: 'Beta', markers: ['beta.project'], topics: ['code'] };

// A folder outside every configured path, with the files given, so only markers can put it in a domain.
function folder(t, files = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-reach-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const rel of files) {
    const file = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
  }
  return dir;
}

const context = out => out?.hookSpecificOutput?.additionalContext ?? '';
const writeLocal = (v, domains) => v.write('vault.local.json', `${JSON.stringify({ domains }, null, 2)}\n`);
const reachFound = async v => (await v.import('lib/lint.mjs')).lint()
  .filter(f => /^vault\.(?:config|local)\.json$/.test(f.file)).map(f => [f.level, f.file, f.msg]);

test('6.1a: a session in an unlisted folder holding a domain\'s marker gets its rules and can propose', t => {
  const v = makeVault(t, { presets: ['glim'], domains: { glim: { topics: ['layout', 'code', 'naming'] } } });
  const dir = folder(t, ['glim.project', 'src/x.zq']);
  const sid = sessionId();
  const start = context(v.startSession(sid, { cwd: dir }));
  assert.match(start, /glim\/always-rule: Do: Open each glim file with a purpose line\./);
  assert.match(start, /propose\.mjs/);
  assert.match(denied(edit(v, sid, '', { abs: path.join(dir, 'src', 'x.zq'), cwd: dir })) ?? '', /glim\/zq-trigger/);
  const r = v.propose(sid, {
    domain: v.domain, slug: 'name-steps', topic: 'naming', basis: 'reading', reading: 'The user renamed the steps.',
    do: 'Name steps after their screen.', not: 'Leave step names bare.', applies_to: ['docs/**/*.md'],
  });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(v.exists('wiki/glim/rules/name-steps.md'));
});

test('6.1a: in a monorepo each package\'s edits get its own domain, and a session at the root hears both', t => {
  const v = makeVault(t, { presets: ['glim', 'almanac'] });
  v.write('wiki/almanac/rules/always-a.md', ruleNote({ domain: 'almanac', topic: 'ledger', always: true, doLine: 'Almanac always.' }));
  const root = folder(t, ['packages/a/glim.project', 'packages/b/almanac.project']);
  const sid = sessionId();
  const start = context(v.startSession(sid, { cwd: root }));
  assert.match(start, /glim\/always-rule/);
  assert.match(start, /almanac\/always-a/);
  const said = context(prompt(v, sid, 'make the shimmer call openLedger', { cwd: root }));
  assert.match(said, /glim\/keyword-rule/);
  assert.match(said, /almanac\/ledger-v2/);
  const a = denied(edit(v, sid, '', { abs: path.join(root, 'packages', 'a', 'src', 'x.zq'), cwd: root })) ?? '';
  assert.match(a, /glim\/zq-trigger/);
  assert.doesNotMatch(a, /almanac\//);
  const b = denied(edit(v, sid, '', { abs: path.join(root, 'packages', 'b', 'src', 'x.zq'), cwd: root })) ?? '';
  assert.match(b, /almanac\/ledger-v2/);
  assert.doesNotMatch(b, /glim\//);
});

test('session start looks below its folder only to reach.markerDepth, past dot-folders and ignored folders', t => {
  const v = makeVault(t, { domains: { alpha: ALPHA, beta: BETA, gamma: { title: 'Gamma', markers: ['gamma.project'], topics: [] } } });
  for (const d of ['alpha', 'beta', 'gamma']) v.write(`wiki/${d}/rules/always.md`, ruleNote({ domain: d, always: true }));
  const root = folder(t, ['one/two/three/alpha.project', 'one/two/three/four/gamma.project', '.hidden/beta.project', 'deps/beta.project', 'out/x/gamma.project']);
  fs.writeFileSync(path.join(root, '.gitignore'), '# built\n/deps/\nout\n');
  const start = context(v.startSession(sessionId(), { cwd: root }));
  assert.match(start, /alpha\/always/);
  assert.doesNotMatch(start, /beta\/always/);
  assert.doesNotMatch(start, /gamma\/always/);
});

test('a domain\'s paths in vault.local.json put a folder in it, and edits there get its rules', t => {
  const v = makeVault(t, { presets: ['journal'] });
  v.write('wiki/journal/rules/gate-j.md', ruleNote({ domain: 'journal', topic: 'days', applies_to: ['src/**'] }));
  const dir = v.projects.journal;
  assert.match(denied(edit(v, sessionId(), '', { abs: path.join(dir, 'src', 'x.txt'), cwd: dir })) ?? '', /journal\/gate-j/);
});

test('6.1a: an everywhere domain\'s pages and keyword rules reach any folder, and its glob and always rules do not', t => {
  const v = makeVault(t, { presets: ['commons'] });
  v.write('wiki/commons/concepts/files.md', pageNote({ domain: 'commons', kind: 'concept', topic: 'words', applies_to: ['**/*.txt'] }));
  v.write('wiki/commons/rules/gate.md', ruleNote({ domain: 'commons', topic: 'words', applies_to: ['**/*.txt'], doLine: 'Gate rule.' }));
  v.write('wiki/commons/rules/always.md', ruleNote({ domain: 'commons', topic: 'words', always: true, doLine: 'Always rule.' }));
  const dir = folder(t);
  const sid = sessionId();
  assert.doesNotMatch(context(v.startSession(sid, { cwd: dir })), /commons\/always/);
  const said = context(prompt(v, sid, 'speak in plainspeak', { cwd: dir }));
  assert.match(said, /commons\/plain-words/);
  assert.match(said, /commons\/plain-rule/);
  assert.doesNotMatch(said, /commons\/always/);
  const out = edit(v, sid, '', { abs: path.join(dir, 'a.txt'), cwd: dir });
  assert.match(denied(out), /commons\/files/);
  assert.doesNotMatch(denied(out), /commons\/gate/);
});

test('lint reports a missing path as an error and a domain that reaches no project as a warning', async t => {
  const v = makeVault(t, { domains: { alpha: { title: 'Alpha', topics: [] }, beta: { title: 'Beta', topics: [] } } });
  writeLocal(v, { glim: { paths: [v.project.replace(/\\/g, '/')] }, beta: { paths: ['C:/nowhere/beta'] } });
  assert.deepEqual(await reachFound(v), [
    ['error', 'vault.local.json', "beta's path C:/nowhere/beta doesn't exist on this machine. Fix it or remove it"],
    ['warn', 'vault.config.json', "alpha reaches no project on this machine. Add its folders to vault.local.json as paths, give it markers, or set vaultOnly: true if it holds only pages"],
  ]);
});

test('lint refuses a marker with a backslash in it, which the hooks never match', async t => {
  const v = makeVault(t, { domains: { alpha: { title: 'Alpha', markers: ['sub\\alpha.project'], topics: [] } } });
  assert.deepEqual((await reachFound(v)).filter(([level]) => level === 'error'), [
    ['error', 'vault.config.json', 'alpha: markers must be a list of file names, with no folders in them'],
  ]);
});

test('lint checks the shape of markers, everywhere, vaultOnly and vault.local.json', async t => {
  const v = makeVault(t, {
    domains: {
      alpha: { title: 'Alpha', markers: ['', 'sub/alpha.project'], topics: [] },
      beta: { title: 'Beta', everywhere: 'yes', vaultOnly: 1, topics: [] },
      gamma: { title: 'Gamma', vaultOnly: true, markers: ['gamma.project'], everywhere: true, topics: [] },
      delta: { title: 'Delta', vaultOnly: true, topics: [] },
      old: { title: 'Old', projects: ['C:/old'], markers: ['old.project'], topics: [] },
    },
  });
  writeLocal(v, { glim: { paths: [v.project.replace(/\\/g, '/')] }, alpha: { paths: 'x' }, delta: { paths: [v.project.replace(/\\/g, '/')] }, nobody: { paths: [] } });
  assert.deepEqual(await reachFound(v), [
    ['error', 'vault.config.json', 'alpha: markers must be a list of file names, with no folders in them'],
    ['error', 'vault.config.json', 'beta: everywhere must be true or false'],
    ['error', 'vault.config.json', 'beta: vaultOnly must be true or false'],
    ['error', 'vault.config.json', 'gamma is vaultOnly, so it holds only pages and takes no markers or everywhere'],
    ['error', 'vault.local.json', 'alpha: paths must be a list of absolute folder paths'],
    ['error', 'vault.local.json', 'delta is vaultOnly in vault.config.json, so it takes no paths'],
    ['error', 'vault.local.json', "nobody isn't a domain in vault.config.json"],
    ['warn', 'vault.config.json', 'beta reaches no project on this machine. Add its folders to vault.local.json as paths, give it markers, or set vaultOnly: true if it holds only pages'],
    ['warn', 'vault.config.json', 'old: projects does nothing. Put its folders in vault.local.json as paths, or give it markers'],
  ]);
});

test('a missing vault.local.json gives a paths-only domain a warning, not an error', async t => {
  const v = makeVault(t, { domains: { glim: { markers: [] } } });
  fs.rmSync(v.at('vault.local.json'));
  assert.deepEqual(await reachFound(v), [
    ['warn', 'vault.config.json', "glim reaches no project on this machine. Add its folders to vault.local.json as paths, give it markers, or set vaultOnly: true if it holds only pages"],
  ]);
});

test('a rule in a vaultOnly domain is an error', async t => {
  const v = makeVault(t, { domains: { reading: { title: 'Reading', vaultOnly: true, topics: ['solvers'] } } });
  const rules = await v.import('lib/rules.mjs');
  const rule = rules.parseNote(ruleNote({ domain: 'reading', keywords: ['solver'] }), 'wiki/reading/x.md');
  assert.deepEqual(rules.noteErrors(rule), ['reading is vault-only, so it holds pages only. Put the rule in a domain that reaches projects, or in global']);
});

test('the edit hook refuses an edit to vault.local.json', t => {
  const v = makeVault(t);
  assert.match(denied(v.edit(sessionId(), 'Edit', { file_path: v.at('vault.local.json'), old_string: 'a', new_string: 'b' })) ?? '', /vault\.local\.json/);
});

test('a folder\'s domains are the nearest marker folder\'s and the paths that hold it, each with its project root', async t => {
  const v = makeVault(t, { domains: { alpha: ALPHA, beta: BETA } });
  const root = folder(t, ['alpha.project', 'beta.project', 'pkg/beta.project']);
  const { domainsFor, toPosix } = await v.import('lib/vault.mjs');
  const at = (...xs) => toPosix(path.join(root, ...xs));
  assert.deepEqual(domainsFor(path.join(root, 'src', 'new.txt')), [
    { domain: 'alpha', root: at(), rel: 'src/new.txt' },
    { domain: 'beta', root: at(), rel: 'src/new.txt' },
  ]);
  assert.deepEqual(domainsFor(path.join(root, 'pkg')), [{ domain: 'beta', root: at('pkg'), rel: '' }]);
});

test('a session in the vault folder takes no domain from a marker inside raw/refs', t => {
  const v = makeVault(t, { domains: { alpha: ALPHA } });
  v.write('raw/refs/somerepo/alpha.project', '');
  const sid = sessionId();
  v.startSession(sid, { cwd: v.root });
  assert.deepEqual(JSON.parse(v.read(`.state/sessions/${sid}.json`)).reach.domains, []);
  const below = sessionId();
  v.startSession(below, { cwd: folder(t, ['sub/alpha.project']) });
  assert.deepEqual(JSON.parse(v.read(`.state/sessions/${below}.json`)).reach.domains, ['alpha']);
});

const reachOf = (v, sid) => JSON.parse(v.read(`.state/sessions/${sid}.json`)).reach;
const widgetRule = domain => ({
  domain, slug: 'name-widgets', topic: 'code', basis: 'reading', reading: 'The user renamed the widgets.',
  do: 'Name widgets after their screen.', not: 'Leave widget names bare.', keywords: ['widgetz'],
});
const pickFor = (v, sid, domain) => v.run('pick.mjs', [sid], { input: { subject: 'shop', comment: 'cards breathe', domain } });

test('pick and propose reach the domains of the latest session start and of the folder the session began in', t => {
  const v = makeVault(t, { domains: { alpha: ALPHA, beta: BETA } });
  const mono = folder(t, ['a/alpha.project', 'b/beta.project']);
  const compacted = sessionId();
  v.startSession(compacted, { cwd: mono });
  v.startSession(compacted, { cwd: path.join(mono, 'a'), source: 'compact' });
  const kept = pickFor(v, compacted, 'beta');
  assert.equal(kept.code, 0, kept.stderr);
  const moved = sessionId();
  v.startSession(moved);
  v.startSession(moved, { cwd: mono, source: 'compact' });
  for (const domain of ['glim', 'beta']) {
    const p = pickFor(v, moved, domain);
    assert.equal(p.code, 0, `${domain}: ${p.stderr}`);
  }
  const r = v.propose(moved, widgetRule('beta'));
  assert.equal(r.code, 0, r.stderr);
  const inA = sessionId();
  v.startSession(inA, { cwd: path.join(mono, 'a') });
  assert.notEqual(pickFor(v, inA, 'beta').code, 0);
  assert.match(v.propose(inA, widgetRule('beta')).stderr, /domain must be alpha or global/);
});

test('in the vault folder propose takes any domain but a vault-only one', t => {
  const v = makeVault(t, { domains: { reading: { title: 'Reading', vaultOnly: true, topics: ['code'] }, alpha: ALPHA } });
  const sid = sessionId();
  v.startSession(sid, { cwd: v.root });
  const r = v.propose(sid, widgetRule('nope'));
  assert.equal(r.stderr, 'Not proposed: domain must be glim, alpha or global.\n');
});

test('a marker in a worktree of a project makes the main checkout the project root', async t => {
  const v = makeVault(t, { domains: { alpha: ALPHA, beta: BETA } });
  const root = folder(t, ['alpha.project', '.claude/worktrees/w1/alpha.project', '.claude/worktrees/w1/pkg/beta.project']);
  const { domainsFor, sessionReach, toPosix } = await v.import('lib/vault.mjs');
  const at = (...xs) => toPosix(path.join(root, ...xs));
  assert.deepEqual(domainsFor(path.join(root, '.claude', 'worktrees', 'w1', 'src', 'a.txt')), [{ domain: 'alpha', root: at(), rel: 'src/a.txt' }]);
  assert.deepEqual(sessionReach(path.join(root, '.claude', 'worktrees', 'w1')), [{ domain: 'alpha', root: at(), rel: '' }, { domain: 'beta', root: at('pkg') }]);
});

test("a marker is a file: a folder with a marker's name marks nothing, and a link to a file counts", async t => {
  const v = makeVault(t, { domains: { alpha: ALPHA } });
  const dir = folder(t, ['alpha.project/readme.txt', 'src/a.txt', 'pkg/alpha.project/readme.txt']);
  const { domainsFor, sessionReach } = await v.import('lib/vault.mjs');
  assert.deepEqual(domainsFor(path.join(dir, 'src', 'a.txt')), []);
  assert.deepEqual(sessionReach(dir), []);
  const linked = folder(t, ['target.txt', 'pkg/src/a.txt']);
  try {
    fs.symlinkSync(path.join(linked, 'target.txt'), path.join(linked, 'pkg', 'alpha.project'), 'file');
  } catch (e) {
    if (e.code === 'EPERM') return t.skip('making a link needs Developer Mode on Windows');
    throw e;
  }
  assert.deepEqual(domainsFor(path.join(linked, 'pkg', 'src', 'a.txt')).map(h => h.domain), ['alpha']);
  assert.deepEqual(sessionReach(linked).map(h => h.domain), ['alpha']);
});

test('a marker named . or .. is no file name, so it marks nothing and lint reports it', async t => {
  const v = makeVault(t, { domains: { alpha: { ...ALPHA, markers: ['.', '..'] } } });
  const dir = folder(t, ['src/a.txt']);
  const { domainsFor } = await v.import('lib/vault.mjs');
  assert.deepEqual(domainsFor(path.join(dir, 'src', 'a.txt')), []);
  assert.ok((await reachFound(v)).some(([level, , msg]) => level === 'error' && msg === 'alpha: markers must be a list of file names, with no folders in them'));
});

test('a session in the folder above the vault takes no domain from a marker inside the vault', async t => {
  const parent = folder(t, ['pkg/alpha.project']);
  const v = makeVault(t, { domains: { alpha: ALPHA, beta: BETA }, under: parent });
  v.write('raw/refs/beta.project', '');
  const sid = sessionId();
  v.startSession(sid, { cwd: parent });
  assert.deepEqual(reachOf(v, sid).domains, ['alpha']);
});
