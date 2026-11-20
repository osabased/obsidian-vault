import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeVault, ruleNote, userTurn, sessionId, denied, editFile as edit, unrelatedRules, proposeAtOnce } from './fixture.mjs';
import { setField, parse } from '../tools/lib/frontmatter.mjs';
import { sessionVar } from '../tools/adapters/claude-code/adapter.mjs';
import { codexInput } from './codex.mjs';

function setup(t, { quote } = {}) {
  const v = makeVault(t);
  const sid = sessionId();
  v.startSession(sid, quote ? { transcript: v.transcript(sid, [userTurn(quote)]) } : {});
  return { v, sid };
}

const proposal = (o = {}) => ({
  domain: 'glim', slug: 'new-rule', kind: 'taste', topic: 'code', basis: 'reading', reading: 'The user rewrote the screen twice.',
  do: 'Zebra quartz mango.', not: 'Plover lantern ember.', applies_to: ['src/new/**'], ...o,
});
const inbox = v => fs.readdirSync(v.at('raw', 'inbox')).flatMap(f => v.read(`raw/inbox/${f}`).trim().split('\n').map(l => JSON.parse(l)));

test('a rule alone goes straight through and lands in the inbox', t => {
  const { v, sid } = setup(t);
  const r = v.propose(sid, proposal());
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^Wrote wiki\/glim\/rules\/new-rule\.md\./);
  assert.match(r.stdout, /\*\*New rule\*\* glim\/new-rule: Do: Zebra quartz mango\. Not: Plover lantern ember\./);
  assert.match(r.stdout, /It applies from now on\./);
  assert.ok(v.exists('wiki/glim/rules/new-rule.md'));
  assert.match(v.read('wiki/glim/rules/new-rule.md'), /· agent's reading · session a1b2c3d4 · The user rewrote the screen twice\. \(a-[0-9a-f]{8}\)/);
  const files = fs.readdirSync(v.at('raw', 'inbox'));
  assert.equal(files.length, 1);
  assert.match(files[0], /^\d{4}-\d\d-\d\d-a1b2c3d4\.jsonl$/);
  const [row] = inbox(v);
  assert.match(row.id, /^a-[0-9a-f]{8}$/);
  assert.equal(row.source, 'agent');
  assert.equal(row.kind, 'reading');
  assert.equal(row.text, 'The user rewrote the screen twice.');
  assert.equal(row.note, 'glim/new-rule');
  assert.equal(row.session, sid);
  assert.equal(row.domain, 'glim');
  assert.match(v.read('log.md'), /wrote glim\/new-rule · session a1b2c3d4/);
});

test('a shared glob refuses once with the list, the identical retry goes through', t => {
  const { v, sid } = setup(t);
  v.write('wiki/glim/old-rule.md', ruleNote({ topic: 'layout', applies_to: ['src/new/**'], doLine: 'Alpha bravo charlie.', notLine: 'Delta foxtrot golf.' }));
  const first = v.propose(sid, proposal());
  assert.equal(first.code, 1);
  assert.match(first.stderr, /^Not proposed: it may repeat these rules:/);
  assert.match(first.stderr, /- glim\/old-rule: Do: Alpha bravo charlie\. Not: Delta foxtrot golf\. \[not shown in this session\]/);
  assert.match(first.stderr, /"repeats": "<that rule's key>"/);
  assert.ok(!v.exists('wiki/glim/rules/new-rule.md'));
  assert.equal(fs.existsSync(v.at('raw', 'inbox')), false);

  const retry = v.propose(sid, proposal());
  assert.equal(retry.code, 0, retry.stderr);
  assert.match(retry.stdout, /It may overlap glim\/old-rule\./);
  assert.ok(v.exists('wiki/glim/rules/new-rule.md'));
});

test('a shared keyword lists the rule', t => {
  const { v, sid } = setup(t);
  v.write('wiki/glim/old-rule.md', ruleNote({ topic: 'layout', keywords: ['buttons'], doLine: 'Alpha bravo charlie.', notLine: 'Delta foxtrot golf.' }));
  const r = v.propose(sid, proposal({ applies_to: [], keywords: ['Buttons'] }));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /- glim\/old-rule:/);
  assert.equal(v.propose(sid, proposal({ applies_to: [], keywords: ['Buttons'] })).code, 0);
});

test('shared words alone list the rule', t => {
  const { v, sid } = setup(t);
  v.write('wiki/glim/old-rule.md', ruleNote({ topic: 'layout', keywords: ['cards'], doLine: 'Keep card spacing generous.', notLine: 'Cram cards together.' }));
  const p = proposal({ applies_to: ['src/other/**'], do: 'Keep card spacing generous.', not: 'Cram cards together tightly.' });
  const r = v.propose(sid, p);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /- glim\/old-rule:/);
  assert.equal(v.propose(sid, p).code, 0);
});

test('a rule on the same topic lists every rule of that topic even with nothing shared', t => {
  const { v, sid } = setup(t);
  v.write('wiki/glim/old-rule.md', ruleNote({ topic: 'code', keywords: ['other'], doLine: 'Alpha bravo charlie.', notLine: 'Delta foxtrot golf.' }));
  const r = v.propose(sid, proposal());
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Every glim rule on code:/);
  assert.match(r.stderr, /- glim\/old-rule:/);
  assert.equal(v.propose(sid, proposal()).code, 0);
});

test('an unrelated rule in another topic does not refuse', t => {
  const { v, sid } = setup(t);
  v.write('wiki/glim/old-rule.md', ruleNote({ topic: 'layout', keywords: ['other'], doLine: 'Alpha bravo charlie.', notLine: 'Delta foxtrot golf.' }));
  assert.equal(v.propose(sid, proposal()).code, 0);
});

test('a changed retry is refused again', t => {
  const { v, sid } = setup(t);
  v.write('wiki/glim/old-rule.md', ruleNote({ topic: 'layout', applies_to: ['src/new/**'], doLine: 'Alpha bravo charlie.', notLine: 'Delta foxtrot golf.' }));
  assert.equal(v.propose(sid, proposal()).code, 1);
  v.write('wiki/glim/another.md', ruleNote({ topic: 'layout', applies_to: ['src/new/**'], doLine: 'Hotel india juliet.', notLine: 'Kilo lima mike.' }));
  assert.equal(v.propose(sid, proposal()).code, 1);
});

test('repeats adds an Evidence line to the named note instead of writing a new one', t => {
  const { v, sid } = setup(t);
  v.write('wiki/glim/old-rule.md', ruleNote({ topic: 'layout', applies_to: ['src/new/**'], doLine: 'Alpha bravo charlie.', notLine: 'Delta foxtrot golf.' }));
  const r = v.propose(sid, proposal({ repeats: 'glim/old-rule' }));
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^Added the Evidence line to wiki\/glim\/old-rule\.md\./);
  assert.match(r.stdout, /\*\*Rule backed again\*\* glim\/old-rule: Do: Alpha bravo charlie\./);
  assert.ok(!v.exists('wiki/glim/rules/new-rule.md'));
  const note = v.read('wiki/glim/old-rule.md');
  const evidence = note.split('## Evidence\n')[1].trim().split('\n');
  assert.equal(evidence.length, 2);
  assert.match(evidence[0], /do the thing/);
  assert.match(evidence[1], /· agent's reading · session a1b2c3d4 · The user rewrote the screen twice\. \(a-[0-9a-f]{8}\)$/);
  const [row] = inbox(v);
  assert.equal(row.note, 'glim/old-rule');
  assert.match(v.read('log.md'), /added evidence to glim\/old-rule · session a1b2c3d4/);
});

test('a newer source repeating a knowledge rule moves its as_of up, and an older one leaves it', t => {
  const { v, sid } = setup(t);
  v.write('wiki/glim/old-api.md', ruleNote({ kind: 'knowledge', basis: 'source', applies_to: ['src/**'], extra: ['as_of: 2026-01-01'] }));
  v.write('raw/refs/notes.md', 'The solver is on by default. The old flag is gone.\n');
  const backed = (quote, date) => v.propose(sid, proposal({
    kind: 'knowledge', basis: 'source', source: 'raw/refs/notes.md', source_date: date, quote, repeats: 'glim/old-api',
  }));
  const newer = backed('The solver is on by default', '2026-09-01');
  assert.equal(newer.code, 0, newer.stderr);
  assert.match(newer.stdout, /\*\*Rule backed again\*\* glim\/old-api: .*As of 2026-09-01\.\nIts note has a new Evidence line, and as_of 2026-09-01\./);
  assert.match(v.read('wiki/glim/old-api.md'), /^as_of: 2026-09-01$/m);
  const older = backed('The old flag is gone', '2025-12-01');
  assert.equal(older.code, 0, older.stderr);
  assert.match(older.stdout, /Its note has a new Evidence line\./);
  assert.match(v.read('wiki/glim/old-api.md'), /^as_of: 2026-09-01$/m);
});

const oldApi = (v, extra = ['as_of: 2026-01-01'], examples = []) => {
  v.write('wiki/glim/old-api.md', ruleNote({ kind: 'knowledge', basis: 'source', applies_to: ['src/**'], extra }).replace('## Examples\n', ['## Examples', ...examples, ''].join('\n')));
  v.write('raw/refs/notes.md', 'The solver is on by default.\n');
};
const newerSource = o => proposal({
  kind: 'knowledge', basis: 'source', source: 'raw/refs/notes.md', source_date: '2026-09-01', quote: 'The solver is on by default', repeats: 'glim/old-api', ...o,
});

test('a stated repeat of a knowledge rule moves its as_of to today, whatever kind the proposal gives', async t => {
  const { v, sid } = setup(t, { quote: 'the solver is on by default now' });
  oldApi(v);
  const r = v.propose(sid, proposal({ basis: 'stated', quote: 'the solver is on by default now', repeats: 'glim/old-api' }));
  assert.equal(r.code, 0, r.stderr);
  const day = (await v.import('lib/vault.mjs')).today();
  assert.match(v.read('wiki/glim/old-api.md'), new RegExp(`^as_of: ${day}$`, 'm'));
  assert.match(r.stdout, new RegExp(`and as_of ${day}\\.`));
});

test('a repeat that moves as_of rebuilds index.md', t => {
  const { v, sid } = setup(t);
  oldApi(v);
  assert.equal(v.run('build.mjs').code, 0);
  const r = v.propose(sid, newerSource());
  assert.equal(r.code, 0, r.stderr);
  const check = v.run('build.mjs', ['--check']);
  assert.equal(check.code, 0, check.stdout + check.stderr);
  assert.match(v.read('index.md'), /knowledge as of 2026-09-01/);
});

test('as_of moves on the frontmatter line the note is read from, keeping its comment, and nowhere else', async t => {
  for (const [extra, examples = []] of [
    [['as_of : 2026-01-01'], ['as_of: 2025-05-05']],
    [['as_of: 2025-01-01', 'as_of: 2026-01-01']],
    [['as_of: 2026-01-01 # checked by hand']],
    [["as_of: '2026-01-01'"]],
  ]) {
    const { v, sid } = setup(t);
    oldApi(v, extra, examples);
    const r = v.propose(sid, newerSource());
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /, and as_of 2026-09-01\./, extra.join());
    const text = v.read('wiki/glim/old-api.md');
    assert.equal((await v.import('lib/rules.mjs')).parseNote(text, 'wiki/glim/old-api.md').as_of, '2026-09-01', extra.join());
    for (const line of examples) assert.ok(text.includes(`\n${line}\n`), `${extra.join()}: ${line} kept`);
    if (extra[0].includes('#')) assert.match(text, /^as_of: 2026-09-01 # checked by hand$/m);
    if (extra[0].includes("'")) assert.match(text, /^as_of: '2026-09-01'$/m);
  }
});

test('the session whose repeat moves as_of is not gated by the rule again, and other sessions are', t => {
  const { v, sid } = setup(t);
  const other = sessionId();
  v.startSession(other);
  oldApi(v);
  for (const s of [sid, other]) {
    assert.ok(denied(edit(v, s, 'src/a.zq')));
    assert.equal(edit(v, s, 'src/a.zq'), null);
  }
  const r = v.propose(sid, newerSource());
  assert.equal(r.code, 0, r.stderr);
  assert.equal(edit(v, sid, 'src/a.zq'), null);
  assert.ok(denied(edit(v, sid, 'src/b.zq')), 'a file it never gated still is');
  assert.ok(denied(edit(v, other, 'src/a.zq')));
});

test('repeats naming a rule that is not delivered is refused', t => {
  const { v, sid } = setup(t);
  const r = v.propose(sid, proposal({ repeats: 'glim/missing' }));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /repeats names glim\/missing, which isn't a delivered rule in glim or global/);
  const bad = v.propose(sid, proposal({ repeats: 'Not A Key' }));
  assert.match(bad.stderr, /repeats must be a rule key/);
});

test('the same stated words back two rules: refused once, then through', t => {
  const quote = 'always use flat buttons';
  const { v, sid } = setup(t, { quote });
  const stated = o => proposal({ basis: 'stated', quote, reading: undefined, ...o });
  assert.equal(v.propose(sid, stated({ slug: 'first-rule' })).code, 0);
  const second = stated({ slug: 'second-rule', applies_to: ['src/other/**'], do: 'Hotel india juliet.', not: 'Kilo lima mike.', topic: 'layout' });
  const r = v.propose(sid, second);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /these words already back glim\/first-rule\./);
  assert.equal(v.propose(sid, second).code, 0);
  assert.ok(v.exists('wiki/glim/rules/second-rule.md'));
});

test('always: true is refused', t => {
  const { v, sid } = setup(t);
  const r = v.propose(sid, proposal({ always: true }));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /^Not proposed: always is the user's to set in Obsidian\./);
  assert.ok(!v.exists('wiki/glim/rules/new-rule.md'));
});

test('a rule over 300 characters is refused', t => {
  const { v, sid } = setup(t);
  const r = v.propose(sid, proposal({ do: `${'Word '.repeat(70)}end.`, not: 'Plover lantern ember.' }));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Do, Not and Because come to \d+ characters; keep them under 300 together\./);
  assert.ok(!v.exists('wiki/glim/rules/new-rule.md'));
});

test('a taste rule with neither keywords nor applies_to is refused', t => {
  const { v, sid } = setup(t);
  const r = v.propose(sid, proposal({ applies_to: [] }));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /give it keywords or applies_to/);
});

test('an existing slug is refused', t => {
  const { v, sid } = setup(t);
  v.write('wiki/glim/new-rule.md', ruleNote({ topic: 'layout', keywords: ['zzz'] }));
  const r = v.propose(sid, proposal());
  assert.equal(r.code, 1);
  assert.match(r.stderr, /wiki\/glim\/new-rule\.md already exists/);
});

test('a session that never started is refused', t => {
  const v = makeVault(t);
  const r = v.propose(sessionId(), proposal());
  assert.equal(r.code, 1);
  assert.match(r.stderr, /has no session/);
});

test("with no session id given, propose takes the agent's own session, and refuses when there is none", t => {
  const { v, sid } = setup(t);
  const none = v.run('propose.mjs', [], { input: proposal() });
  assert.equal(none.code, 1);
  assert.match(none.stderr, /there's no session id to propose for\. The vault's tools pass the session id themselves\. From a shell, pass it as the first argument/);
  const r = v.run('propose.mjs', [], { input: proposal(), env: { [sessionVar]: sid } });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^Wrote wiki\/glim\/rules\/new-rule\.md\./);
});

test('setField changes a field in text that starts with a byte-order mark', () => {
  const text = '﻿---\ntype: rule\nas_of: 2026-01-01\n---\nbody\n';
  const set = setField(text, 'as_of', '2026-10-01');
  assert.equal(parse(set).data.as_of, '2026-10-01');
  assert.equal(set, text.replace('2026-01-01', '2026-10-01'));
});

test('three proposes at once all write their notes and inbox rows', async t => {
  const v = makeVault(t);
  const rules = unrelatedRules('glim', 'at-once');
  const results = await proposeAtOnce(v, rules, { timeout: 30e3 });
  assert.deepEqual(results.map(r => r.code), [0, 0, 0], results.map(r => r.stderr.trim()).filter(Boolean).join('\n'));
  for (const { slug } of rules) assert.ok(v.exists(`wiki/glim/rules/${slug}.md`), `${slug} was written`);
  assert.deepEqual(inbox(v).map(r => r.note).sort(), rules.map(r => `glim/${r.slug}`));
});

test('a field propose does not take is refused by name, and requires and tools are left to the note', t => {
  const { v, sid } = setup(t);
  for (const field of ['requires', 'tools']) {
    const r = v.propose(sid, proposal({ [field]: ['x'] }));
    assert.equal(r.code, 1);
    assert.equal(r.stderr, `Not proposed: ${field} isn't a field propose.mjs takes. Fields like requires and tools are added to the note by hand. The \`propose\` tool's schema lists the fields.\n`);
  }
  assert.equal(v.exists('wiki/glim/rules/new-rule.md'), false);
});

test('propose --help says the vault folder takes any domain that is not vaultOnly', t => {
  const { v } = setup(t);
  assert.match(v.run('propose.mjs', ['--help']).stdout, /in the vault folder, any domain that isn't vaultOnly/);
});

test('propose and pick refuse a missing or unknown session before they read their input', t => {
  const v = makeVault(t);
  for (const script of ['propose.mjs', 'pick.mjs']) {
    const none = v.run(script, [], { input: 'not json' });
    assert.equal(none.code, 1, script);
    assert.match(none.stderr, /there's no session id to (propose|record) for\./, script);
    const unknown = v.run(script, [sessionId()], { input: 'not json' });
    assert.equal(unknown.code, 1, script);
    assert.match(unknown.stderr, /has no session/, script);
  }
});

const ledgerFailure = o => ({
  domain: 'almanac', kind: 'knowledge', topic: 'ledger', basis: 'failure', error: 'TypeError: ledger.shut is not a function', fix: 'Called ledger.close.', file: 'src/ledger.txt',
  slug: 'ledger-shut', do: 'Close a ledger with ledger.close.', not: 'Call ledger.shut.', keywords: ['shutz'], ...o,
});
const checkedRule = (v, checked) => v.write('wiki/almanac/rules/ledger-close.md', ruleNote({
  domain: 'almanac', topic: 'ledger', kind: 'knowledge', basis: 'source', applies_to: ['src/**'], doLine: 'Close the ledger zz.', notLine: 'Leave the ledger open.',
  extra: ['as_of: 2026-10-01', 'package: { ecosystem: fixture, name: pkg }', `checked_with: '${checked}'`],
  evidence: ['- 2026-10-01 · source · session 1a2b3c4d · raw/refs/ledger-guide.md · dated 2026-10-01 · "openLedger takes a path and returns the ledger" (a-00000002)'],
}));

test('a session resumed in another folder reads the package version in the folder it is in now', t => {
  const v = makeVault(t, { presets: ['almanac'], config: { proposals: 'corrections' } });
  const away = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-first-'));
  t.after(() => fs.rmSync(away, { recursive: true, force: true }));
  const sid = sessionId();
  v.startSession(sid, { cwd: away });
  v.startSession(sid, { cwd: v.projects.almanac });
  const propose = () => v.propose(sid, ledgerFailure({ package: 'fixture/pkg' }));
  const first = propose();
  const r = /may repeat/.test(first.stderr) ? propose() : first;
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Checked with fixture\/pkg 2\.4\.0\./, r.stdout);
});

test("under corrections, evidence from a session that agrees by code and has no transcript is written without moving the rule's checked_with", t => {
  const v = makeVault(t, { presets: ['almanac'], config: { agents: ['claude-code', 'codex'], proposals: 'corrections' } });
  checkedRule(v, '2.1.0');
  const sid = '019a0fb1-cccc-7000-8000-000000000101';
  v.hook('session-start', codexInput('SessionStart', { session_id: sid, cwd: v.projects.almanac, transcript_path: null }), { agent: 'codex' });
  const r = v.propose(sid, ledgerFailure({ repeats: 'almanac/ledger-close' }));
  assert.equal(r.code, 0, r.stderr);
  const note = v.read('wiki/almanac/rules/ledger-close.md');
  assert.match(note, /· failure · .*TypeError: ledger\.shut is not a function/);
  assert.match(note, /^checked_with: '2\.1\.0'\r?$/m);
});
