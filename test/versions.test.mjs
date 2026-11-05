import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeVault, sessionId, denied, editFile, ledgerEdit, prompt, ruleNote, withFields, LEDGER_GUIDE, sha256, sectionOf, keepAllowed, offerOf } from './fixture.mjs';
import { compareSemver, inRange, fitOf } from '../tools/lib/versions.mjs';

const V2 = /almanac\/ledger-v2: Do: Call openLedger with the path\./;
const V3 = /almanac\/ledger-v3: Do: Call openLedger with \{ path \}\./;
const context = out => out?.hookSpecificOutput?.additionalContext ?? '';
const lockfile = v => path.join(v.projects.almanac, 'almanac.lock');
// The line a rule is delivered on, so a label is read off the rule it belongs to.
const lineOf = (text, key) => text.split('\n').find(l => l.includes(`${key}: `)) ?? '';
// The hash loadNotes gives a note's text, which an unverified entry holds.
const textHash = text => sha256(text).slice(0, 16);

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

test('OSV range events: introduced opens a range and fixed, last_affected and limit close it', () => {
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
  const root = folder(t, { '.git/HEAD': '', 'almanac.lock': 'pkg 2.4.0\n', 'packages/a/almanac.project': '', 'packages/b/almanac.project': '', 'packages/b/.git/HEAD': '' });
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

test('a source changed since the note labels it while the note text is unchanged, and the label shows it again', t => {
  const v = makeVault(t, { presets: ['almanac'] });
  const rel = 'wiki/almanac/rules/ledger-v2.md';
  const hand = (text = v.read(rel)) => {
    v.write('.state/derived.json', JSON.stringify({
      unverified: { 'almanac/ledger-v2': { contentHash: textHash(text), since: '2026-11-01', sources: ['https://pkg.invalid/ledger'] } },
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

  // A save that only moves the note's mtime, as a sync or a checkout does, keeps the label.
  const text = v.read(rel);
  v.write(rel, text, { saved: new Date(Date.now() - 2 * 3600e3) });
  const moved = sessionId();
  v.startSession(moved, { cwd });
  const retimed = lineOf(context(prompt(v, moved, 'openLedger?', { cwd })), 'almanac/ledger-v2');
  assert.match(retimed, /Call openLedger with the path\..* · source changed on 2026-11-01$/, 'a save with the same text kept the label');

  // An edit drops the label before any build. The session starts first, since a session start builds and the build
  // rewrites derived.json, and the entry then holds the text from before the edit.
  const grown = sessionId();
  v.startSession(grown, { cwd });
  v.write(rel, `${text}\n`);
  hand(text);
  const resized = lineOf(context(prompt(v, grown, 'openLedger?', { cwd })), 'almanac/ledger-v2');
  assert.match(resized, V2);
  assert.doesNotMatch(resized, /source changed on/);
});

test('an edit refusal carries the source changed label after the clipped rule', t => {
  const v = makeVault(t, { presets: ['almanac'] });
  const sid = sessionId();
  v.startSession(sid, { cwd: v.projects.almanac });
  // Session start builds, and build rewrites derived.json from the sources, so the hand-written entry goes in after it.
  const contentHash = textHash(v.read('wiki/almanac/rules/ledger-v2.md'));
  v.write('.state/derived.json', JSON.stringify({ unverified: { 'almanac/ledger-v2': { contentHash, since: '2026-11-01', sources: [] } } }), { saved: null });
  assert.match(ledgerEdit(v, sid), /- almanac\/ledger-v2: .* source changed on \d{4}-\d\d-\d\d/);
});

test('a corrupt derived.json reads as empty in the hooks, is logged by name, and the next build rewrites it', t => {
  const v = makeVault(t, { presets: ['almanac'] });
  const sid = sessionId();
  v.startSession(sid, { cwd: v.projects.almanac });
  v.write('.state/derived.json', '{ "unverified": ', { saved: null });
  const cwd = v.projects.almanac;
  // v.hook throws on any logged error, and this one is meant to be logged, so the hooks run bare.
  const hook = (name, input) => v.run(`hooks/${name}.mjs`, [], { input: { session_id: sid, cwd, ...input }, cwd });
  const edit = hook('edit', { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(cwd, 'src', 'ledger.txt'), old_string: 'a', new_string: 'b' } });
  assert.equal(edit.code, 0, edit.stderr);
  assert.match(denied(JSON.parse(edit.stdout)), V2, 'the edit hook still gates the edit with its rules');
  const start = hook('session-start', { session_id: sessionId(), hook_event_name: 'SessionStart', source: 'startup' });
  assert.equal(start.code, 0, start.stderr);
  const errors = v.read('.state/errors.log').trimEnd().split('\n').filter(l => /^\d{4}-/.test(l));
  assert.equal(errors.length, 2, `each hook logs one error:\n${errors.join('\n')}`);
  assert.ok(errors.every(l => l.includes('.state/derived.json is corrupt')), errors.join('\n'));
  const r = v.run('build.mjs');
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(Object.keys(JSON.parse(v.read('.state/derived.json'))).sort(), ['domains', 'sources', 'unverified', 'version']);
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

// A project of the almanac domain, or with marker false a plain folder, whose lockfile pins pkg at version.
function almanacAt(t, version, { marker = true, lock = `pkg ${version}\n` } = {}) {
  const dir = folder(t, { 'almanac.lock': lock, ...(marker ? { 'almanac.project': '' } : {}) });
  return dir;
}
const EVIDENCE = '- 2026-10-01 · source · session 1a2b3c4d · raw/refs/ledger-guide.md · dated 2026-10-01 · "openLedger takes a path and returns the ledger" (a-00000002)';
const checkedRule = (v, slug, { domain = 'almanac', checked, pkg = 'fixture, name: pkg', extra = [], doLine = 'Close the ledger zz.' } = {}) => v.write(`wiki/${domain}/rules/${slug}.md`, ruleNote({
  domain, topic: 'ledger', kind: 'knowledge', basis: 'source', applies_to: ['src/**'], doLine, notLine: 'Leave the ledger open.',
  extra: ['as_of: 2026-10-01', `package: { ecosystem: ${pkg} }`, ...(checked ? [`checked_with: '${checked}'`] : []), ...extra],
  evidence: [EVIDENCE],
}));
const deliveredAt = (v, dir) => {
  const sid = sessionId();
  v.startSession(sid, { cwd: dir });
  return ledgerEdit(v, sid, dir);
};

test('a rule checked with 1.4.0 is delivered at 1.9.0 and not at 2.0.0, a 0.x rule stops at the next minor, and a project without the package gets none', t => {
  const v = makeVault(t, { presets: ['almanac'] });
  checkedRule(v, 'ledger-close', { checked: '1.4.0' });
  checkedRule(v, 'ledger-early', { checked: '0.3.1', doLine: 'Flush the early ledger zz.' });
  const at = version => deliveredAt(v, almanacAt(t, version));
  assert.match(lineOf(at('1.9.0'), 'almanac/ledger-close'), /Close the ledger zz./);
  assert.equal(lineOf(at('2.0.0'), 'almanac/ledger-close'), '', 'a newer major has moved on under knowledge.movedOn major');
  assert.match(lineOf(at('0.3.9'), 'almanac/ledger-early'), /Flush the early ledger zz./);
  assert.equal(lineOf(at('0.4.0'), 'almanac/ledger-early'), '', 'below 1.0 a newer minor has moved on');
  assert.match(lineOf(at('1.2.0'), 'almanac/ledger-close'), /Close the ledger zz./, 'an older version is still delivered');
  const without = deliveredAt(v, almanacAt(t, null, { lock: 'other 1.0.0\n' }));
  assert.equal(lineOf(without, 'almanac/ledger-close'), '', 'a lockfile the reader read without the package rules the note out');
});

test("a rule no reader reads the package of is delivered labelled version unknown, and a hand-written requires wins over checked_with", t => {
  const v = makeVault(t, { presets: ['almanac'] });
  checkedRule(v, 'ledger-other', { checked: '1.4.0', pkg: 'elsewhere, name: pkg', doLine: 'Close the other ledger zz.' });
  checkedRule(v, 'ledger-pinned', { checked: '1.4.0', doLine: 'Pin the ledger zz.', extra: ["requires: [{ package: { ecosystem: fixture, name: pkg }, ranges: [{ type: SEMVER, events: [{ introduced: '1.0.0' }] }] }]"] });
  const refusal = deliveredAt(v, almanacAt(t, '2.4.0'));
  assert.match(lineOf(refusal, 'almanac/ledger-other'), / · version unknown$/);
  assert.match(lineOf(refusal, 'almanac/ledger-pinned'), /Pin the ledger zz./, 'requires matches 2.4.0, so checked_with 1.4.0 is not read');
});

test("a session in no domain reads its git root's lockfile through global's readers", t => {
  const v = makeVault(t, { presets: ['almanac'], domains: { global: { readers: ['fixture'] } } });
  checkedRule(v, 'ledger-old', { domain: 'global', checked: '1.0.0', doLine: 'Open the old ledger zz.' });
  checkedRule(v, 'ledger-now', { domain: 'global', checked: '2.1.0', doLine: 'Open the current ledger zz.' });
  const root = almanacAt(t, '2.4.0', { marker: false });
  fs.mkdirSync(path.join(root, '.git'));
  const cwd = path.join(root, 'app');
  fs.mkdirSync(cwd);
  const refusal = deliveredAt(v, cwd);
  assert.equal(lineOf(refusal, 'global/ledger-old'), '', 'pkg 2.4.0 has moved on from 1.0.0');
  assert.match(lineOf(refusal, 'global/ledger-now'), /Open the current ledger zz./);
  assert.doesNotMatch(refusal, /version unknown/);
});

test('propose with package records checked_with from the lockfile, or says version unknown where none reads it', t => {
  const v = makeVault(t, { presets: ['almanac'] });
  const cwd = v.projects.almanac;
  const sid = sessionId();
  v.startSession(sid, { cwd });
  const rule = o => ({
    domain: 'almanac', kind: 'knowledge', topic: 'ledger', basis: 'failure', error: 'TypeError: ledger.shut is not a function', fix: 'Called ledger.close.', file: 'src/ledger.txt',
    do: 'Close a ledger with ledger.close.', not: 'Call ledger.shut.', keywords: ['shutz'], ...o,
  });
  const run = input => v.run('propose.mjs', [sid], { cwd, input: JSON.stringify(input) });
  // The first call lists the ledger rules it may repeat and refuses once.
  run(rule({ slug: 'ledger-shut', package: 'fixture/pkg' }));
  const r = run(rule({ slug: 'ledger-shut', package: 'fixture/pkg' }));
  assert.equal(r.code, 0, r.stderr);
  const note = v.read('wiki/almanac/rules/ledger-shut.md');
  assert.match(note, /^package: \{ ecosystem: fixture, name: pkg \}$/m);
  assert.match(note, /^checked_with: '2\.4\.0'$/m);
  assert.match(r.stdout, /Checked with fixture\/pkg 2\.4\.0\./);
  run(rule({ slug: 'ledger-gone', package: 'fixture/nope', do: 'Drop the nope ledger.', keywords: ['nopez'] }));
  const u = run(rule({ slug: 'ledger-gone', package: 'fixture/nope', do: 'Drop the nope ledger.', keywords: ['nopez'] }));
  assert.equal(u.code, 0, u.stderr);
  assert.doesNotMatch(v.read('wiki/almanac/rules/ledger-gone.md'), /checked_with/);
  assert.match(u.stdout, /fixture\/nope: version unknown/);
  assert.match(run(rule({ slug: 'ledger-bad', package: 'pkg' })).stderr, /package must be ecosystem\/name/);
  assert.match(run(rule({ slug: 'ledger-taste', kind: 'taste', basis: 'reading', reading: 'Seen.', package: 'fixture/pkg' })).stderr, /package is for knowledge rules/);
});

test('review status says no readers are set, then lists a rule with no checked_with and one a project has moved past', t => {
  const bare = makeVault(t);
  checkedRule(bare, 'ledger-open', {});
  assert.deepEqual(sectionOf(bare.run('review.mjs', ['status']).stdout, 'Knowledge rules with a package and no checked_with'), ['No version readers set.']);

  const v = makeVault(t, { presets: ['almanac'] });
  checkedRule(v, 'ledger-close', { checked: '1.4.0' });
  checkedRule(v, 'ledger-open', { doLine: 'Open the ledger zz.' });
  deliveredAt(v, almanacAt(t, '1.9.0'));
  deliveredAt(v, almanacAt(t, '2.0.0'));
  const out = v.run('review.mjs', ['status']).stdout;
  assert.deepEqual(sectionOf(out, 'Knowledge rules with a package and no checked_with'), ['- almanac/ledger-open: fixture/pkg'], out);
  const past = sectionOf(out, 'Rules past their version in a project');
  assert.equal(past.length, 1, out);
  assert.match(past[0], /^- almanac\/ledger-close: checked with 1\.4\.0 · fixture\/pkg 2\.0\.0 in \S+$/);
});

test("the status line counts the rules past their version in the session's projects, and says when no version readers are set", t => {
  const v = makeVault(t, { presets: ['almanac'] });
  checkedRule(v, 'ledger-close', { checked: '1.4.0' });
  const status = dir => v.startSession(sessionId(), { cwd: dir }).systemMessage;
  assert.doesNotMatch(status(almanacAt(t, '1.9.0')), /version/);
  assert.match(status(almanacAt(t, '2.0.0')), / · 1 rule past its version here$/);
  checkedRule(v, 'ledger-flush', { checked: '1.2.0', doLine: 'Flush the ledger zz.' });
  // A requires the user wrote wins over checked_with, as at delivery, and 2.0.0 is in its range.
  checkedRule(v, 'ledger-pinned', { checked: '1.4.0', doLine: 'Pin the ledger zz.', extra: ["requires: [{ package: { ecosystem: fixture, name: pkg }, ranges: [{ type: SEMVER, events: [{ introduced: '1.0.0' }] }] }]"] });
  checkedRule(v, 'ledger-taken', { checked: '1.4.0', doLine: 'Take the ledger zz.', extra: ['retired: 2026-11-01', 'retired_because: Replaced.'] });
  assert.match(status(almanacAt(t, '2.0.0')), / · 2 rules past their version here$/);
  const sid = sessionId();
  v.startSession(sid, { cwd: almanacAt(t, '2.0.0') });
  assert.match(v.run('status.mjs', [sid]).stdout, / · 2 rules past their version here$/m, '/vault status counts them too');
  assert.doesNotMatch(status(almanacAt(t, null, { lock: 'other 1.0.0\n' })), /past/, "a project without the package isn't past a version of it");
  assert.doesNotMatch(status(v.root), /past|readers/, 'the vault folder reaches no project');

  const bare = makeVault(t);
  assert.doesNotMatch(bare.startSession(sessionId()).systemMessage, /readers/, 'no rule names a package');
  checkedRule(bare, 'ledger-open', { domain: 'global' });
  assert.match(bare.startSession(sessionId()).systemMessage, / · proposals: corrections · no version readers set$/);
});

test('/lint drafts the checked_with a rule lacks as a reword with no basis, and keeping it writes the version and no Evidence line', t => {
  const v = makeVault(t, { presets: ['almanac'] });
  checkedRule(v, 'ledger-open', { doLine: 'Open the ledger zz.' });
  const rel = 'wiki/almanac/rules/ledger-open.md';
  const sid = sessionId();
  v.startSession(sid, { cwd: v.root });
  const env = { CLAUDE_CODE_SESSION_ID: sid };
  const draft = input => v.run('queue.mjs', ['draft'], { input: JSON.stringify({ change: 'reword', key: 'almanac/ledger-open', ...input }), env });
  assert.match(draft({ checked_with: '1.9.0', basis: 'reading', reading: 'The lockfile says 1.9.0.' }).stderr, /knowledge rule/, 'with a basis it is an ordinary reword, which a knowledge rule takes no reading for');
  const d = draft({ checked_with: '1.9.0' });
  assert.equal(d.code, 0, d.stderr);
  const queued = v.read(fs.readdirSync(v.at('raw', 'queue')).map(f => `raw/queue/${f}`)[0]).trim().split('\n').map(l => JSON.parse(l));
  const r = v.propose(sid, { queued: queued[0].id });
  assert.equal(r.code, 0, r.stderr);
  const o = offerOf(r.stdout);
  assert.equal(o.text, '**Change this rule?** almanac/ledger-open: Do: Open the ledger zz. Not: Leave the ledger open. As of 2026-10-01.\nWas: Package fixture/pkg: version unknown.\nNow: Checked with fixture/pkg 1.9.0.');
  const before = v.read(rel);
  const k = keepAllowed(v, sid, o.id, o.text);
  assert.equal(k.code, 0, k.stderr);
  const after = v.read(rel);
  assert.match(after, /^checked_with: '?1\.9\.0'?$/m);
  assert.equal(after.split('## Evidence')[1], before.split('## Evidence')[1], 'the version cites no one, so the note gets no Evidence line');
  assert.match(v.propose(sid, { change: 'reword', key: 'almanac/ledger-open', checked_with: '1.9.0' }).stderr, /leaves almanac\/ledger-open as it is/);
});

test('a reword that gives checked_with alone is an offer even under corrections', t => {
  const v = makeVault(t, { presets: ['almanac'], config: { proposals: 'corrections' } });
  checkedRule(v, 'ledger-open', { doLine: 'Open the ledger zz.' });
  const rel = 'wiki/almanac/rules/ledger-open.md';
  const before = v.read(rel);
  const sid = sessionId();
  v.startSession(sid, { cwd: v.projects.almanac });
  const r = v.run('propose.mjs', [sid], { cwd: v.projects.almanac, input: JSON.stringify({ change: 'reword', key: 'almanac/ledger-open', checked_with: '2.4.0' }) });
  assert.equal(r.code, 0, r.stderr);
  assert.match(offerOf(r.stdout)?.text ?? '', /Now: Checked with fixture\/pkg 2\.4\.0\./, r.stdout);
  assert.equal(v.read(rel), before, 'the version decides which projects the rule reaches, so the user agrees to it first');
});

const failureRule = o => ({
  domain: 'almanac', kind: 'knowledge', topic: 'ledger', basis: 'failure', error: 'TypeError: ledger.shut is not a function', fix: 'Called ledger.close.', file: 'src/ledger.txt',
  slug: 'ledger-shut', do: 'Close a ledger with ledger.close.', not: 'Call ledger.shut.', keywords: ['shutz'], ...o,
});

test('evidence through repeats from a project on a newer version offers to move checked_with up, and keeping it writes the version', t => {
  const v = makeVault(t, { presets: ['almanac'], config: { proposals: 'corrections' } });
  checkedRule(v, 'ledger-close', { checked: '2.1.0' });
  const rel = 'wiki/almanac/rules/ledger-close.md';
  const cwd = v.projects.almanac;
  const sid = sessionId();
  v.startSession(sid, { cwd });
  const r = v.run('propose.mjs', [sid], { cwd, input: JSON.stringify(failureRule({ repeats: 'almanac/ledger-close' })) });
  assert.equal(r.code, 0, r.stderr);
  const o = offerOf(r.stdout);
  assert.match(o?.text ?? '', /Its checked_with would move from 2\.1\.0 to 2\.4\.0, the version of fixture\/pkg here\./, r.stdout);
  assert.match(v.read(rel), /^checked_with: '2\.1\.0'$/m, 'moving the version is an offer even under corrections');
  const k = keepAllowed(v, sid, o.id, o.text);
  assert.equal(k.code, 0, k.stderr);
  assert.match(v.read(rel), /^checked_with: '?2\.4\.0'?$/m);
});

test('a queued rule proposed again with repeats leaves the version it was offered with out of the evidence', t => {
  const v = makeVault(t, { presets: ['almanac'] });
  checkedRule(v, 'ledger-close', { checked: '1.4.0' });
  const sid = sessionId();
  v.startSession(sid, { cwd: v.root });
  const fields = { ...failureRule(), package: 'fixture/pkg', checked_with: '1.0.0' };
  v.write('raw/queue/2026-11-01-0badc0de.jsonl', `${JSON.stringify({
    id: 'u-0badc0de', at: '2026-11-01T10:00:00.000Z', kind: 'rule', why: 'ignored', unattended: 'left', from: 'o-0badc0de',
    session: '0badc0de-0000-4000-8000-000000000001', agent: null, transcript: null, cwd: v.projects.almanac, domain: 'almanac', key: 'almanac/ledger-shut',
    fields, text: '**Keep this rule?** almanac/ledger-shut', quote: null, checked: '2026-11-01',
  })}\n`);
  const r = v.propose(sid, { queued: 'u-0badc0de', repeats: 'almanac/ledger-close' });
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /checked_with would move/, 'the queued version was read for another rule, so it moves nothing');
});

test('a rule with a package names the missing entity page once its library has entityAfterRules rules', t => {
  const v = makeVault(t, { presets: ['almanac'], config: { proposals: 'corrections' } });
  checkedRule(v, 'ledger-close', { checked: '2.4.0' });
  checkedRule(v, 'ledger-open', { checked: '2.4.0', doLine: 'Open the ledger zz.' });
  const cwd = v.projects.almanac;
  const sid = sessionId();
  v.startSession(sid, { cwd });
  const run = input => v.run('propose.mjs', [sid], { cwd, input: JSON.stringify(input) });
  run(failureRule({ package: 'fixture/pkg' }));
  const r = run(failureRule({ package: 'fixture/pkg' }));
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /3 live rules now name fixture\/pkg, and no entity page does\. Hold a page change that adds wiki\/almanac\/entities\/<library>\.md with kind: entity and this package, and release it before your final reply\./);
});

const globalLedger = (v, slug, checked, doLine) => v.write(`wiki/global/rules/${slug}.md`, ruleNote({
  domain: 'global', topic: 'ledger', kind: 'knowledge', basis: 'source', applies_to: ['**/ledger.txt'], doLine, notLine: 'Leave the ledger open.',
  extra: ['as_of: 2026-10-01', 'package: { ecosystem: fixture, name: pkg }', `checked_with: '${checked}'`], evidence: [EVIDENCE],
}));

test("an edit in no domain, in a repository nested below the session's folder, reads that repository's lockfile", t => {
  const v = makeVault(t, { presets: ['almanac'], domains: { global: { readers: ['fixture'] } } });
  globalLedger(v, 'ledger-old', '1.0.0', 'Open the old ledger zz.');
  const home = almanacAt(t, '2.4.0', { marker: false });
  fs.mkdirSync(path.join(home, '.git'));
  const sub = path.join(home, 'sub');
  fs.mkdirSync(path.join(sub, '.git'), { recursive: true });
  fs.writeFileSync(path.join(sub, 'almanac.lock'), 'pkg 1.2.0\n');
  const sid = sessionId();
  v.startSession(sid, { cwd: home });
  const edit = rel => denied(editFile(v, sid, rel, { abs: path.join(home, ...rel.split('/')), cwd: home })) ?? '';
  assert.match(lineOf(edit('sub/src/ledger.txt'), 'global/ledger-old'), /Open the old ledger zz\./, 'sub holds pkg 1.2.0, which has not moved on from 1.0.0');
  assert.equal(lineOf(edit('src/ledger.txt'), 'global/ledger-old'), '', "the session folder's own repository holds pkg 2.4.0");
});

test('outside any repository, a lockfile above the session folder is not its project', t => {
  const v = makeVault(t, { presets: ['almanac'], domains: { global: { readers: ['fixture'] } } });
  globalLedger(v, 'ledger-old', '1.0.0', 'Open the old ledger zz.');
  const above = almanacAt(t, '2.4.0', { marker: false });
  const cwd = path.join(above, 'app');
  fs.mkdirSync(cwd);
  const refusal = deliveredAt(v, cwd);
  assert.match(lineOf(refusal, 'global/ledger-old'), /Open the old ledger zz\..* · version unknown$/, refusal);
});

test("outside any repository, a lockfile above a domain's project is not its own", t => {
  const v = makeVault(t, { presets: ['almanac'] });
  const root = folder(t, { 'almanac.lock': 'pkg 2.4.0\n', 'app/almanac.project': '' });
  const sid = sessionId();
  v.startSession(sid, { cwd: root });
  const app = ledgerEdit(v, sid, path.join(root, 'app'));
  assert.match(lineOf(app, 'almanac/ledger-v2'), / · version unknown$/, app);
});

test("a rule's package name is read trimmed when its version is checked", t => {
  const v = makeVault(t, { presets: ['almanac'] });
  checkedRule(v, 'ledger-close', { checked: '1.4.0', pkg: "fixture, name: ' pkg '" });
  const at = version => deliveredAt(v, almanacAt(t, version));
  assert.match(lineOf(at('1.9.0'), 'almanac/ledger-close'), /Close the ledger zz\.[^·]*$/, 'pkg 1.9.0 is read for the name, so the version is known');
  assert.equal(lineOf(at('2.0.0'), 'almanac/ledger-close'), '');
});

test('one project reached by two spellings of its folder is one project in versions.json and in review status', { skip: !['win32', 'darwin'].includes(process.platform) }, t => {
  const v = makeVault(t, { presets: ['almanac'] });
  checkedRule(v, 'ledger-close', { checked: '1.4.0' });
  const dir = path.join(almanacAt(t, '2.0.0', { marker: false }), 'Proj');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'almanac.lock'), 'pkg 2.0.0\n');
  fs.writeFileSync(path.join(dir, 'almanac.project'), '');
  deliveredAt(v, dir);
  deliveredAt(v, path.join(path.dirname(dir), 'proj'));
  const keys = Object.keys(JSON.parse(v.read('.state/versions.json'))).filter(k => k.endsWith('|fixture'));
  assert.equal(keys.length, 1, keys.join('\n'));
  const past = sectionOf(v.run('review.mjs', ['status']).stdout, 'Rules past their version in a project');
  assert.equal(past.length, 1);
  assert.match(past[0], /^- almanac\/ledger-close: checked with 1\.4\.0 · fixture\/pkg 2\.0\.0 in \S+\/Proj$/);
});

test('review status forgets a project whose folder is gone', t => {
  const v = makeVault(t, { presets: ['almanac'] });
  checkedRule(v, 'ledger-close', { checked: '1.4.0' });
  const dir = almanacAt(t, '2.0.0');
  deliveredAt(v, dir);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.deepEqual(sectionOf(v.run('review.mjs', ['status']).stdout, 'Rules past their version in a project'), ['None.']);
  const posix = dir.replace(/\\/g, '/').toLowerCase();
  assert.ok(!Object.keys(JSON.parse(v.read('.state/versions.json'))).some(k => k.toLowerCase().startsWith(posix)), 'the gone root is dropped');
});
