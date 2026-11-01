import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeVault, sessionId, editFile, denied, prompt, ruleNote, withFields, LEDGER_GUIDE } from './fixture.mjs';
import { compareSemver, inRange, fitOf } from '../tools/lib/versions.mjs';

const V2 = /almanac\/ledger-v2: Do: Call openLedger with the path\./;
const V3 = /almanac\/ledger-v3: Do: Call openLedger with \{ path \}\./;
const context = out => out?.hookSpecificOutput?.additionalContext ?? '';
const ledgerEdit = (v, sid, dir = v.projects.almanac) => denied(editFile(v, sid, 'src/ledger.txt', { abs: path.join(dir, 'src', 'ledger.txt'), cwd: dir })) ?? '';
const lockfile = v => path.join(v.projects.almanac, 'almanac.lock');
// The line a rule is delivered on, so a label is read off the rule it belongs to.
const lineOf = (text, key) => text.split('\n').find(l => l.includes(`${key}: `)) ?? '';

function folder(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-versions-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  return dir;
}

test('compareSemver follows SemVer 2.0.0 precedence', () => {
  const ordered = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.2.0', '1.10.0', '2.0.0'];
  for (let i = 0; i < ordered.length - 1; i++) {
    assert.ok(compareSemver(ordered[i], ordered[i + 1]) < 0, `${ordered[i]} comes before ${ordered[i + 1]}`);
    assert.ok(compareSemver(ordered[i + 1], ordered[i]) > 0, `${ordered[i + 1]} comes after ${ordered[i]}`);
  }
  assert.equal(compareSemver('1.0.0+build.1', '1.0.0+build.2'), 0, 'build metadata does not count');
  assert.equal(compareSemver('1.0.0-rc.1+x', '1.0.0-rc.1'), 0);
  assert.ok(compareSemver('99999999999999999999.0.0', '99999999999999999998.0.0') > 0, 'parts past 2^53 still compare');
  assert.throws(() => compareSemver('1.0', '1.0.0'), /not a semver version/);
});

test('OSV range events apply in order', () => {
  const at = (v, events) => inRange(v, events, compareSemver);
  assert.equal(at('0.0.1', [{ introduced: '0' }]), true, "introduced '0' opens from the start");
  assert.equal(at('2.4.0', [{ introduced: '2.0.0' }, { fixed: '3.0.0' }]), true);
  assert.equal(at('3.0.0', [{ introduced: '2.0.0' }, { fixed: '3.0.0' }]), false, 'fixed closes before its version');
  assert.equal(at('1.9.9', [{ introduced: '2.0.0' }, { fixed: '3.0.0' }]), false);
  assert.equal(at('3.0.0', [{ introduced: '2.0.0' }, { last_affected: '3.0.0' }]), true, 'last_affected closes after its version');
  assert.equal(at('3.0.1', [{ introduced: '2.0.0' }, { last_affected: '3.0.0' }]), false);
  assert.equal(at('3.0.0', [{ introduced: '2.0.0' }, { limit: '3.0.0' }]), false, 'limit closes before its version');
  assert.equal(at('3.0.0-rc.1', [{ introduced: '2.0.0' }, { fixed: '3.0.0' }]), true, 'a prerelease comes before its release');
  const twice = [{ introduced: '1.0.0' }, { fixed: '1.5.0' }, { introduced: '2.0.0' }, { fixed: '2.5.0' }];
  assert.deepEqual(['1.2.0', '1.7.0', '2.1.0', '2.6.0'].map(v => at(v, twice)), [true, false, true, false]);
});

test('with no lockfile both rules are delivered, labelled version unknown', t => {
  const v = makeVault(t, { presets: ['almanac'] });
  fs.rmSync(lockfile(v));
  const sid = sessionId();
  v.startSession(sid, { cwd: v.projects.almanac });
  const refusal = ledgerEdit(v, sid);
  assert.match(lineOf(refusal, 'almanac/ledger-v2'), / · version unknown$/);
  assert.match(lineOf(refusal, 'almanac/ledger-v3'), / · version unknown$/);
});

test('a lockfile changed to 3.1.0 delivers the v3 rule instead', t => {
  const v = makeVault(t, { presets: ['almanac'] });
  const first = sessionId();
  v.startSession(first, { cwd: v.projects.almanac });
  assert.doesNotMatch(ledgerEdit(v, first), V3);
  assert.ok(v.exists('.state/versions.json'), 'the versions read are cached');
  // The same size, and a time well clear of the cached read, so only the stat's mtime tells the cache it changed.
  fs.writeFileSync(lockfile(v), 'pkg 3.1.0\n');
  const later = new Date(Date.now() + 60e3);
  fs.utimesSync(lockfile(v), later, later);
  const second = sessionId();
  v.startSession(second, { cwd: v.projects.almanac });
  const refusal = ledgerEdit(v, second);
  assert.match(refusal, V3);
  assert.doesNotMatch(refusal, /almanac\/ledger-v2/);
  assert.doesNotMatch(refusal, /version unknown/);
});

test("a lockfile at a monorepo's root serves its packages, and the search stops at a folder holding .git", t => {
  const v = makeVault(t, { presets: ['almanac'] });
  const root = folder(t, { 'almanac.lock': 'pkg 2.4.0\n', 'packages/a/almanac.project': '', 'packages/b/almanac.project': '', 'packages/b/.git/HEAD': '' });
  const sid = sessionId();
  v.startSession(sid, { cwd: root });
  const a = ledgerEdit(v, sid, path.join(root, 'packages', 'a'));
  assert.match(a, V2);
  assert.doesNotMatch(a, /almanac\/ledger-v3|version unknown/);
  const b = ledgerEdit(v, sid, path.join(root, 'packages', 'b'));
  assert.match(lineOf(b, 'almanac/ledger-v2'), / · version unknown$/);
  assert.match(lineOf(b, 'almanac/ledger-v3'), / · version unknown$/);
});

test('a reader that throws gives version unknown and logs one error for the lockfile', t => {
  const v = makeVault(t, { presets: ['almanac'] });
  v.write('tools/ext/readers/fixture.mjs', [
    "export const ecosystem = 'fixture';",
    "export const lockfiles = ['almanac.lock'];",
    "export const scheme = 'SEMVER';",
    "export function read() { throw new Error('the lockfile is torn'); }",
    '',
  ].join('\n'));
  const log = () => (v.exists('.state/errors.log') ? v.read('.state/errors.log') : '');
  // The hook helper fails on any logged error, so these calls run the hook themselves.
  const edit = sid => {
    const r = v.run('hooks/edit.mjs', [], {
      input: { session_id: sid, cwd: v.projects.almanac, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(v.projects.almanac, 'src', 'ledger.txt'), old_string: '', new_string: 'x' } },
      cwd: v.projects.almanac,
    });
    assert.equal(r.code, 0, r.stderr);
    return denied(JSON.parse(r.stdout)) ?? '';
  };
  for (let i = 0; i < 3; i++) {
    const refusal = edit(sessionId());
    assert.match(lineOf(refusal, 'almanac/ledger-v2'), / · version unknown$/);
    assert.match(lineOf(refusal, 'almanac/ledger-v3'), / · version unknown$/);
  }
  assert.equal(log().split('reader fixture on ').length - 1, 1, log());
  assert.match(log(), /the lockfile is torn/);
});

test('lint reports a bad reader and a requires no reader answers', async t => {
  const reader = lines => [...lines, ''].join('\n');
  const v = makeVault(t, {
    presets: ['almanac'],
    domains: { almanac: { readers: ['fixture', 'twin', 'gone', 'odd', 'eco', 'noread', 'Bad Name'] }, glim: { readers: 'fixture' } },
  });
  v.write('tools/ext/readers/twin.mjs', reader(["export const ecosystem = 'fixture';", "export const lockfiles = ['twin.lock'];", "export const scheme = 'SEMVER';", 'export const read = () => ({});']));
  v.write('tools/ext/readers/odd.mjs', reader(["export const ecosystem = 'odd';", "export const lockfiles = ['odd.lock'];", "export const scheme = 'CALVER';", 'export const read = () => ({});']));
  v.write('tools/ext/readers/eco.mjs', reader(["export const ecosystem = 'eco';", "export const lockfiles = ['eco.lock'];", "export const scheme = 'ECOSYSTEM';", 'export const read = () => ({});']));
  v.write('tools/ext/readers/noread.mjs', reader(["export const ecosystem = 'noread';", "export const lockfiles = ['no/read.lock'];", "export const scheme = 'SEMVER';"]));
  v.write('wiki/almanac/rules/ledger-pages.md', ruleNote({
    domain: 'almanac', topic: 'ledger', kind: 'knowledge', basis: 'source', keywords: ['ledger pages'], doLine: 'Number ledger pages from 1.', notLine: 'Number them from 0.',
    extra: ['as_of: 2026-10-01', "requires: [{ package: { ecosystem: ledger, name: pages }, ranges: [{ type: SEMVER, events: [{ introduced: '0' }] }] }]"],
    evidence: ['- 2026-10-01 · source · session 1a2b3c4d · raw/refs/ledger-guide.md · dated 2026-10-01 · "openLedger takes a path" (a-00000003)'],
  }));
  const found = (await v.import('lib/lint.mjs')).lint();
  const config = found.filter(f => f.file === 'vault.config.json' && f.level === 'error').map(f => f.msg).join('\n');
  assert.match(config, /almanac\.readers: fixture and twin both read ecosystem fixture/);
  assert.match(config, /almanac\.readers names gone, and tools\/ext\/readers\/gone\.mjs doesn't exist/);
  assert.match(config, /tools\/ext\/readers\/odd\.mjs exports scheme "CALVER"; it must be 'SEMVER' or 'ECOSYSTEM'/);
  assert.match(config, /tools\/ext\/readers\/eco\.mjs has scheme 'ECOSYSTEM' and exports no compare function/);
  assert.match(config, /almanac\.readers: noread: tools\/ext\/readers\/noread\.mjs exports no read function/);
  assert.match(config, /almanac\.readers: "Bad Name" must name an extension/);
  assert.match(config, /glim\.readers must be a list of reader extension names/);
  const warned = found.filter(f => f.file === 'wiki/almanac/rules/ledger-pages.md').map(f => f.msg).join('\n');
  assert.match(warned, /requires names ecosystem ledger, and no reader in almanac\.readers reads it/);
  assert.equal(found.filter(f => f.file.startsWith('wiki/almanac/rules/ledger-v') && /no reader/.test(f.msg)).length, 0, 'the fixture reader answers for the preset rules');
});

test('a source changed since the note labels it while the note file is unchanged, and the label shows it again', t => {
  const v = makeVault(t, { presets: ['almanac'] });
  const rel = 'wiki/almanac/rules/ledger-v2.md';
  const hand = () => {
    const st = fs.statSync(v.at(...rel.split('/')));
    v.write('.state/derived.json', JSON.stringify({
      unverified: { 'almanac/ledger-v2': { mtime: st.mtimeMs, size: st.size, since: '2026-11-01', sources: ['https://pkg.invalid/ledger'] } },
    }), { saved: null });
  };
  const cwd = v.projects.almanac;
  const sid = sessionId();
  v.startSession(sid, { cwd });
  const before = context(prompt(v, sid, 'how do I call openLedger?', { cwd }));
  assert.match(before, V2);
  assert.doesNotMatch(before, /source changed on/);
  hand();
  const after = lineOf(context(prompt(v, sid, 'and openLedger again?', { cwd })), 'almanac/ledger-v2');
  assert.match(after, /Call openLedger with the path\..* · source changed on 2026-11-01$/, 'the label shows the rule again in the same session');
  assert.equal(context(prompt(v, sid, 'openLedger once more', { cwd })), '', 'the labelled rule is marked like any other');

  // A save that moves the note's mtime, or changes its size, drops the label before any build.
  const text = v.read(rel);
  v.write(rel, text, { saved: new Date(Date.now() - 2 * 3600e3) });
  const moved = sessionId();
  v.startSession(moved, { cwd });
  const retimed = lineOf(context(prompt(v, moved, 'openLedger?', { cwd })), 'almanac/ledger-v2');
  assert.match(retimed, V2);
  assert.doesNotMatch(retimed, /source changed on/);

  hand();
  const st = fs.statSync(v.at(...rel.split('/')));
  v.write(rel, `${text}\n`, { saved: new Date(st.mtimeMs) });
  assert.equal(fs.statSync(v.at(...rel.split('/'))).mtimeMs, st.mtimeMs, 'only the size changed');
  const grown = sessionId();
  v.startSession(grown, { cwd });
  const resized = lineOf(context(prompt(v, grown, 'openLedger?', { cwd })), 'almanac/ledger-v2');
  assert.match(resized, V2);
  assert.doesNotMatch(resized, /source changed on/);
});

test('an edit refusal carries the source changed label after the clipped rule', t => {
  const v = makeVault(t, { presets: ['almanac'] });
  const sid = sessionId();
  v.startSession(sid, { cwd: v.projects.almanac });
  // Session start builds, and build rewrites derived.json from the sources, so the hand-written entry goes in after it.
  const st = fs.statSync(v.at('wiki', 'almanac', 'rules', 'ledger-v2.md'));
  v.write('.state/derived.json', JSON.stringify({ unverified: { 'almanac/ledger-v2': { mtime: st.mtimeMs, size: st.size, since: '2026-11-01', sources: [] } } }), { saved: null });
  assert.match(ledgerEdit(v, sid), /- almanac\/ledger-v2: .* source changed on \d{4}-\d\d-\d\d/);
});

test('a corrupt derived.json fails the hook loudly', t => {
  const v = makeVault(t, { presets: ['almanac'] });
  const sid = sessionId();
  v.startSession(sid, { cwd: v.projects.almanac });
  v.write('.state/derived.json', '{ "unverified": ', { saved: null });
  assert.throws(() => ledgerEdit(v, sid), /the edit hook exited 1: .*Unexpected end of JSON input/);
  assert.throws(() => v.startSession(sessionId(), { cwd: v.projects.almanac }), /the session-start hook exited 1/);
});

test('OSV range events apply sorted by version, and limit caps the range apart from them', () => {
  const at = (v, events) => inRange(v, events, compareSemver);
  assert.equal(at('2.5.0', [{ fixed: '2.0.0' }, { introduced: '1.0.0' }]), false, 'a fixed listed first still closes the range');
  assert.equal(at('1.5.0', [{ fixed: '2.0.0' }, { introduced: '1.0.0' }]), true);
  const shuffled = [{ introduced: '3.0.0' }, { fixed: '4.0.0' }, { introduced: '1.0.0' }, { fixed: '2.0.0' }];
  assert.deepEqual(['1.5.0', '2.5.0', '3.5.0', '4.5.0'].map(v => at(v, shuffled)), [true, false, true, false]);
  assert.equal(at('0.5.0', [{ fixed: '1.0.0' }, { introduced: '0' }]), true, "introduced '0' sorts first");
  const capped = [{ introduced: '1.0.0' }, { limit: '2.0.0' }, { introduced: '3.0.0' }];
  assert.deepEqual(['1.5.0', '2.0.0', '3.5.0'].map(v => at(v, capped)), [true, false, false], 'nothing at or past a limit is in range, though an introduced follows it');
  assert.equal(at('1.5.0', [{ limit: '2.0.0' }, { introduced: '1.0.0' }, { limit: '1.2.0' }]), true, 'a version under any limit is in range');
});

test('a package named like an object property reads as missing from the lockfile', () => {
  const versions = new Map([['almanac', [new Map([['fixture', { versions: { pkg: '2.4.0' }, compare: compareSemver }]])]]]);
  const requires = name => [{ package: { ecosystem: 'fixture', name }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }] }] }];
  for (const name of ['constructor', 'toString', '__proto__']) assert.deepEqual(fitOf(requires(name), 'almanac', versions), { fit: 'mismatch', why: `no ${name}` });
});

// The hook helpers fail on any logged error, so these tests run the hooks themselves.
const hookRun = (v, name, input) => {
  const r = v.run(`hooks/${name}.mjs`, [], { input, cwd: input.cwd });
  assert.equal(r.code, 0, r.stderr);
  return r.stdout.trim() ? JSON.parse(r.stdout) : null;
};
const rawEdit = (v, sid, cwd = v.projects.almanac) => denied(hookRun(v, 'edit', {
  session_id: sid, cwd, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(cwd, 'src', 'ledger.txt'), old_string: '', new_string: 'x' },
})) ?? '';

test('a reader config names that is missing leaves its ecosystem unknown, logs once, and the hooks still gate', t => {
  const v = makeVault(t, { presets: ['almanac'], domains: { almanac: { readers: ['fixture', 'gone'] } } });
  const cwd = v.projects.almanac;
  const log = () => (v.exists('.state/errors.log') ? v.read('.state/errors.log') : '');
  for (let i = 0; i < 2; i++) {
    const sid = sessionId();
    hookRun(v, 'session-start', { session_id: sid, cwd, hook_event_name: 'SessionStart', source: 'startup' });
    const refusal = rawEdit(v, sid);
    assert.match(refusal, V2, 'the reader that loads still settles the fit');
    assert.doesNotMatch(refusal, /almanac\/ledger-v3|version unknown/);
  }
  assert.equal(log().split('reader gone').length - 1, 1, log());
  assert.match(log(), /tools\/ext\/readers\/gone\.mjs doesn't exist/);
});

test('propose writes a taste rule and builds though a reader is gone, since only a knowledge ranking reads versions', t => {
  const v = makeVault(t, { presets: ['almanac'] });
  const cwd = v.projects.almanac;
  const sid = sessionId();
  v.startSession(sid, { cwd });
  fs.rmSync(v.at('tools', 'ext', 'readers', 'fixture.mjs'));
  const propose = () => v.run('propose.mjs', [sid], {
    cwd,
    input: JSON.stringify({ domain: 'almanac', slug: 'zz-new', topic: 'ledger', basis: 'reading', reading: 'The user rewrote it.', do: 'Zebra quartz mango.', not: 'Plover lantern ember.', applies_to: ['src/**'] }),
  });
  // The first call lists the ledger rules it may repeat and refuses once; the second writes the note.
  const first = propose();
  assert.match(first.stderr, /may repeat/, JSON.stringify(first));
  const r = propose();
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /almanac\/zz-new/);
  assert.match(v.read('index.md'), /zz-new/, 'the build after the write ran');
  assert.doesNotMatch(v.exists('.state/errors.log') ? v.read('.state/errors.log') : '', /reader fixture/, 'propose read no versions');
});

test('review status from the vault folder, which reaches no project, ranks knowledge rules by as_of', t => {
  const v = makeVault(t, { presets: ['almanac'] });
  v.write('wiki/almanac/rules/ledger-old.md', ruleNote({ domain: 'almanac', topic: 'ledger', kind: 'knowledge', basis: 'source', applies_to: ['src/**'], extra: ['as_of: 2020-01-01'], doLine: 'Old fact zz.', notLine: 'Old not zz.' }));
  const pair = cwd => v.run('review.mjs', ['status'], { cwd }).stdout.split('\n').find(l => l.includes('ledger-old and almanac/ledger-v2')) ?? '';
  assert.match(pair(v.root), /almanac\/ledger-v2 ranks first: as_of \d{4}-\d\d-\d\d over 2020-01-01/);
  assert.match(pair(v.projects.almanac), /almanac\/ledger-v2 ranks first: as_of \d{4}-\d\d-\d\d over 2020-01-01/);
});

test("global's readers read the lockfile of each project a session reaches, so a global rule with requires gets a fit", t => {
  const v = makeVault(t, { presets: ['almanac'], domains: { global: { readers: ['fixture'] } } });
  const global = (slug, events, doLine) => v.write(`wiki/global/rules/${slug}.md`, ruleNote({
    domain: 'global', topic: 'ledger', kind: 'knowledge', basis: 'source', applies_to: ['src/**'], doLine, notLine: 'Guess the ledger.',
    extra: ['as_of: 2026-10-01', `requires: [{ package: { ecosystem: fixture, name: pkg }, ranges: [{ type: SEMVER, events: [${events}] }] }]`],
    evidence: ['- 2026-10-01 · source · session 1a2b3c4d · raw/refs/ledger-guide.md · dated 2026-10-01 · "openLedger takes a path and returns the ledger" (a-00000002)'],
  }));
  global('ledger-two', "{ introduced: '2.0.0' }, { fixed: '3.0.0' }", 'Close a pkg 2 ledger.');
  global('ledger-three', "{ introduced: '3.0.0' }", 'Close a pkg 3 ledger.');
  const sid = sessionId();
  v.startSession(sid, { cwd: v.projects.almanac });
  const refusal = ledgerEdit(v, sid);
  assert.match(lineOf(refusal, 'global/ledger-two'), /Close a pkg 2 ledger\./);
  assert.doesNotMatch(lineOf(refusal, 'global/ledger-two'), /version unknown/);
  assert.doesNotMatch(refusal, /global\/ledger-three/, 'the lockfile pins pkg 2.4.0');
});

test('a newer copy with no fetched day labels the rule source changed, as review lists it unverified', t => {
  const v = makeVault(t, { presets: ['almanac'] });
  v.write('raw/refs/ledger-guide.later.md', withFields({ url: 'https://pkg.invalid/ledger', replaces: 'raw/refs/ledger-guide.md' }, LEDGER_GUIDE.replace('takes a path and', 'takes a path or URL and')));
  const cwd = v.projects.almanac;
  const sid = sessionId();
  v.startSession(sid, { cwd });
  assert.match(lineOf(ledgerEdit(v, sid), 'almanac/ledger-v2'), / · source changed$/);
  assert.match(v.run('review.mjs', ['status'], { cwd }).stdout, /^- almanac\/ledger-v2: since \(no date\)/m);
});
