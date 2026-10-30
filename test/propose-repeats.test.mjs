import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeVault, ruleNote, userTurn, sessionId, denied, editFile as edit } from './fixture.mjs';

function setup(t, { quote } = {}) {
  const v = makeVault(t);
  const sid = sessionId();
  v.startSession(sid, quote ? { transcript: v.transcript(sid, [userTurn(quote)]) } : {});
  return { v, sid };
}

const proposal = (o = {}) => ({
  domain: 'demo', slug: 'new-rule', topic: 'code', basis: 'reading', reading: 'The user rewrote the screen twice.',
  do: 'Zebra quartz mango.', not: 'Plover lantern ember.', applies_to: ['src/new/**'], ...o,
});
const inbox = v => fs.readdirSync(v.at('raw', 'inbox')).flatMap(f => v.read(`raw/inbox/${f}`).trim().split('\n').map(l => JSON.parse(l)));

test('a rule alone goes straight through and lands in the inbox', t => {
  const { v, sid } = setup(t);
  const r = v.propose(sid, proposal());
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^Wrote wiki\/demo\/new-rule\.md\./);
  assert.match(r.stdout, /\*\*New rule\*\* demo\/new-rule: Do: Zebra quartz mango\. Not: Plover lantern ember\./);
  assert.match(r.stdout, /It applies from now on\./);
  assert.ok(v.exists('wiki/demo/new-rule.md'));
  assert.match(v.read('wiki/demo/new-rule.md'), /· agent's reading · session a1b2c3d4 · The user rewrote the screen twice\. \(a-[0-9a-f]{8}\)/);
  const files = fs.readdirSync(v.at('raw', 'inbox'));
  assert.equal(files.length, 1);
  assert.match(files[0], /^\d{4}-\d\d-\d\d\.jsonl$/);
  const [row] = inbox(v);
  assert.match(row.id, /^a-[0-9a-f]{8}$/);
  assert.equal(row.source, 'agent');
  assert.equal(row.kind, 'reading');
  assert.equal(row.text, 'The user rewrote the screen twice.');
  assert.equal(row.note, 'demo/new-rule');
  assert.equal(row.session, sid);
  assert.equal(row.domain, 'demo');
  assert.match(v.read('log.md'), /wrote demo\/new-rule · session a1b2c3d4/);
});

test('a shared glob refuses once with the list, the identical retry goes through', t => {
  const { v, sid } = setup(t);
  v.write('wiki/demo/old-rule.md', ruleNote({ topic: 'layout', applies_to: ['src/new/**'], doLine: 'Alpha bravo charlie.', notLine: 'Delta foxtrot golf.' }));
  const first = v.propose(sid, proposal());
  assert.equal(first.code, 1);
  assert.match(first.stderr, /^Not proposed: it may repeat these rules:/);
  assert.match(first.stderr, /- demo\/old-rule: Do: Alpha bravo charlie\. Not: Delta foxtrot golf\. \[not shown in this session\]/);
  assert.match(first.stderr, /"repeats": "<that rule's key>"/);
  assert.ok(!v.exists('wiki/demo/new-rule.md'));
  assert.equal(fs.existsSync(v.at('raw', 'inbox')), false);

  const retry = v.propose(sid, proposal());
  assert.equal(retry.code, 0, retry.stderr);
  assert.match(retry.stdout, /It may overlap demo\/old-rule\./);
  assert.ok(v.exists('wiki/demo/new-rule.md'));
});

test('a shared keyword lists the rule', t => {
  const { v, sid } = setup(t);
  v.write('wiki/demo/old-rule.md', ruleNote({ topic: 'layout', keywords: ['buttons'], doLine: 'Alpha bravo charlie.', notLine: 'Delta foxtrot golf.' }));
  const r = v.propose(sid, proposal({ applies_to: [], keywords: ['Buttons'] }));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /- demo\/old-rule:/);
  assert.equal(v.propose(sid, proposal({ applies_to: [], keywords: ['Buttons'] })).code, 0);
});

test('shared words alone list the rule', t => {
  const { v, sid } = setup(t);
  v.write('wiki/demo/old-rule.md', ruleNote({ topic: 'layout', keywords: ['cards'], doLine: 'Keep card spacing generous.', notLine: 'Cram cards together.' }));
  const p = proposal({ applies_to: ['src/other/**'], do: 'Keep card spacing generous.', not: 'Cram cards together tightly.' });
  const r = v.propose(sid, p);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /- demo\/old-rule:/);
  assert.equal(v.propose(sid, p).code, 0);
});

test('a rule on the same topic lists every rule of that topic even with nothing shared', t => {
  const { v, sid } = setup(t);
  v.write('wiki/demo/old-rule.md', ruleNote({ topic: 'code', keywords: ['other'], doLine: 'Alpha bravo charlie.', notLine: 'Delta foxtrot golf.' }));
  const r = v.propose(sid, proposal());
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Every demo rule on code:/);
  assert.match(r.stderr, /- demo\/old-rule:/);
  assert.equal(v.propose(sid, proposal()).code, 0);
});

test('an unrelated rule in another topic does not refuse', t => {
  const { v, sid } = setup(t);
  v.write('wiki/demo/old-rule.md', ruleNote({ topic: 'layout', keywords: ['other'], doLine: 'Alpha bravo charlie.', notLine: 'Delta foxtrot golf.' }));
  assert.equal(v.propose(sid, proposal()).code, 0);
});

test('a changed retry is refused again', t => {
  const { v, sid } = setup(t);
  v.write('wiki/demo/old-rule.md', ruleNote({ topic: 'layout', applies_to: ['src/new/**'], doLine: 'Alpha bravo charlie.', notLine: 'Delta foxtrot golf.' }));
  assert.equal(v.propose(sid, proposal()).code, 1);
  v.write('wiki/demo/another.md', ruleNote({ topic: 'layout', applies_to: ['src/new/**'], doLine: 'Hotel india juliet.', notLine: 'Kilo lima mike.' }));
  assert.equal(v.propose(sid, proposal()).code, 1);
});

test('repeats adds an Evidence line to the named note instead of writing a new one', t => {
  const { v, sid } = setup(t);
  v.write('wiki/demo/old-rule.md', ruleNote({ topic: 'layout', applies_to: ['src/new/**'], doLine: 'Alpha bravo charlie.', notLine: 'Delta foxtrot golf.' }));
  const r = v.propose(sid, proposal({ repeats: 'demo/old-rule' }));
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^Added the Evidence line to wiki\/demo\/old-rule\.md\./);
  assert.match(r.stdout, /\*\*Rule backed again\*\* demo\/old-rule: Do: Alpha bravo charlie\./);
  assert.ok(!v.exists('wiki/demo/new-rule.md'));
  const note = v.read('wiki/demo/old-rule.md');
  const evidence = note.split('## Evidence\n')[1].trim().split('\n');
  assert.equal(evidence.length, 2);
  assert.match(evidence[0], /do the thing/);
  assert.match(evidence[1], /· agent's reading · session a1b2c3d4 · The user rewrote the screen twice\. \(a-[0-9a-f]{8}\)$/);
  const [row] = inbox(v);
  assert.equal(row.note, 'demo/old-rule');
  assert.match(v.read('log.md'), /added evidence to demo\/old-rule · session a1b2c3d4/);
});

test('a newer source repeating a knowledge rule moves its as_of up, and an older one leaves it', t => {
  const { v, sid } = setup(t);
  v.write('wiki/demo/old-api.md', ruleNote({ kind: 'knowledge', basis: 'source', applies_to: ['src/**'], extra: ['as_of: 2026-01-01'] }));
  v.write('raw/refs/notes.md', 'The solver is on by default. The old flag is gone.\n');
  const backed = (quote, date) => v.propose(sid, proposal({
    kind: 'knowledge', basis: 'source', source: 'raw/refs/notes.md', source_date: date, quote, repeats: 'demo/old-api',
  }));
  const newer = backed('The solver is on by default', '2026-09-01');
  assert.equal(newer.code, 0, newer.stderr);
  assert.match(newer.stdout, /\*\*Rule backed again\*\* demo\/old-api: .*As of 2026-09-01\.\nIts note has a new Evidence line, and as_of 2026-09-01\./);
  assert.match(v.read('wiki/demo/old-api.md'), /^as_of: 2026-09-01$/m);
  const older = backed('The old flag is gone', '2025-12-01');
  assert.equal(older.code, 0, older.stderr);
  assert.match(older.stdout, /Its note has a new Evidence line\./);
  assert.match(v.read('wiki/demo/old-api.md'), /^as_of: 2026-09-01$/m);
});

const oldApi = (v, extra = ['as_of: 2026-01-01'], examples = []) => {
  v.write('wiki/demo/old-api.md', ruleNote({ kind: 'knowledge', basis: 'source', applies_to: ['src/**'], extra }).replace('## Examples\n', ['## Examples', ...examples, ''].join('\n')));
  v.write('raw/refs/notes.md', 'The solver is on by default.\n');
};
const newerSource = o => proposal({
  kind: 'knowledge', basis: 'source', source: 'raw/refs/notes.md', source_date: '2026-09-01', quote: 'The solver is on by default', repeats: 'demo/old-api', ...o,
});

test('a stated repeat of a knowledge rule moves its as_of to today, whatever kind the proposal gives', async t => {
  const { v, sid } = setup(t, { quote: 'the solver is on by default now' });
  oldApi(v);
  const r = v.propose(sid, proposal({ basis: 'stated', quote: 'the solver is on by default now', repeats: 'demo/old-api' }));
  assert.equal(r.code, 0, r.stderr);
  const day = (await v.import('lib/vault.mjs')).today();
  assert.match(v.read('wiki/demo/old-api.md'), new RegExp(`^as_of: ${day}$`, 'm'));
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
    const text = v.read('wiki/demo/old-api.md');
    assert.equal((await v.import('lib/rules.mjs')).parseNote(text, 'wiki/demo/old-api.md').as_of, '2026-09-01', extra.join());
    for (const line of examples) assert.ok(text.includes(`\n${line}\n`), `${extra.join()}: ${line} kept`);
    if (extra[0].includes('#')) assert.match(text, /^as_of: 2026-09-01 # checked by hand$/m);
  }
});

test('the session whose repeat moves as_of is not gated by the rule again, and other sessions are', t => {
  const { v, sid } = setup(t);
  const other = sessionId();
  v.startSession(other);
  oldApi(v);
  for (const s of [sid, other]) {
    assert.ok(denied(edit(v, s, 'src/a.lua')));
    assert.equal(edit(v, s, 'src/a.lua'), null);
  }
  const r = v.propose(sid, newerSource());
  assert.equal(r.code, 0, r.stderr);
  assert.equal(edit(v, sid, 'src/a.lua'), null);
  assert.ok(denied(edit(v, sid, 'src/b.lua')), 'a file it never gated still is');
  assert.ok(denied(edit(v, other, 'src/a.lua')));
});

test('repeats naming a rule that is not delivered is refused', t => {
  const { v, sid } = setup(t);
  const r = v.propose(sid, proposal({ repeats: 'demo/missing' }));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /repeats names demo\/missing, which isn't a delivered rule in demo or global/);
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
  assert.match(r.stderr, /these words already back demo\/first-rule\./);
  assert.equal(v.propose(sid, second).code, 0);
  assert.ok(v.exists('wiki/demo/second-rule.md'));
});

test('always: true is refused', t => {
  const { v, sid } = setup(t);
  const r = v.propose(sid, proposal({ always: true }));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /^Not proposed: always is the user's to set in Obsidian\./);
  assert.ok(!v.exists('wiki/demo/new-rule.md'));
});

test('a rule over 300 characters is refused', t => {
  const { v, sid } = setup(t);
  const r = v.propose(sid, proposal({ do: `${'Word '.repeat(70)}end.`, not: 'Plover lantern ember.' }));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Do, Not and Because come to \d+ characters; keep them under 300 together\./);
  assert.ok(!v.exists('wiki/demo/new-rule.md'));
});

test('a taste rule with neither keywords nor applies_to is refused', t => {
  const { v, sid } = setup(t);
  const r = v.propose(sid, proposal({ applies_to: [] }));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /give it keywords or applies_to/);
});

test('an existing slug is refused', t => {
  const { v, sid } = setup(t);
  v.write('wiki/demo/new-rule.md', ruleNote({ topic: 'layout', keywords: ['zzz'] }));
  const r = v.propose(sid, proposal());
  assert.equal(r.code, 1);
  assert.match(r.stderr, /wiki\/demo\/new-rule\.md already exists/);
});

test('a session that never started is refused', t => {
  const v = makeVault(t);
  const r = v.propose(sessionId(), proposal());
  assert.equal(r.code, 1);
  assert.match(r.stderr, /has no session/);
});
