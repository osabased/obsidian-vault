import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeVault, ruleNote, sessionId, userTurn } from './fixture.mjs';

const ALPHA = { title: 'Alpha', markers: ['alpha.project'], topics: ['code', 'naming'] };
const BETA = { title: 'Beta', markers: ['beta.project'], topics: ['code'] };

// A monorepo outside every configured path: each package holds one domain's marker, so only the markers below the
// session's folder put it in a domain.
function monorepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-rows-')).replace(/\\/g, '/');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const rel of ['packages/a/alpha.project', 'packages/b/beta.project']) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), '');
  }
  return dir;
}

// pick.mjs checks comments and notes against what the user typed, so each session starts with them typed.
const SAID = 'keep the cards roomy. first words, second words, alpha words, beta words, words for the other domain, words for glim, about a, about b. flat reads calmer';
function vault(t, opts) {
  const v = makeVault(t, opts);
  const start = v.startSession;
  v.startSession = (sid, o = {}) => start(sid, { transcript: v.transcript(sid, [userTurn(SAID)]), ...o });
  return v;
}

function setup(t, { mono = false } = {}) {
  const v = vault(t, mono ? { domains: { alpha: ALPHA, beta: BETA } } : {});
  const sid = sessionId();
  const root = mono ? monorepo(t) : null;
  v.startSession(sid, root ? { cwd: root } : {});
  return { v, sid, root };
}

const pick = (v, sid, input) => v.run('pick.mjs', [sid], { input });
const comment = (extra = {}) => ({ subject: 'cards', comment: 'keep the cards roomy', ...extra });
const provisional = (extra = {}) => ({
  subject: 'cards', question: 'Which card style?', options: [{ label: 'Flat' }, { label: 'Raised' }], pick: 'Flat', status: 'provisional', ...extra,
});
const rowsIn = (v, folder) => fs.readdirSync(v.at('raw', folder)).filter(f => f.endsWith('.jsonl')).sort()
  .flatMap(f => v.read(`raw/${folder}/${f}`).trim().split('\n').map(l => JSON.parse(l)));
const lower = p => p.replace(/\\/g, '/').toLowerCase();
const day = async v => (await v.import('lib/vault.mjs')).today();

test('a session with one domain records it, its project root, and a file of its own', async t => {
  const { v, sid } = setup(t);
  const r = pick(v, sid, comment());
  assert.equal(r.code, 0, r.stderr);
  const file = `${await day(v)}-${sid.slice(0, 8)}.jsonl`;
  assert.match(r.stdout, new RegExp(`^Recorded q-[0-9a-f]{8} in raw/picks/${file.replace('.', '\\.')}\\.`));
  assert.deepEqual(fs.readdirSync(v.at('raw', 'picks')), [file]);
  const [row] = rowsIn(v, 'picks');
  assert.equal(row.domain, 'glim');
  assert.equal(lower(row.project), lower(v.project));
});

test('two sessions on one day write to two files, and decisions.md lists both', t => {
  const { v, sid } = setup(t);
  const other = 'deadbeef-0000-4000-8000-000000000001';
  v.startSession(other);
  assert.equal(pick(v, sid, comment({ comment: 'first words' })).code, 0);
  assert.equal(pick(v, other, comment({ comment: 'second words' })).code, 0);
  assert.equal(fs.readdirSync(v.at('raw', 'picks')).length, 2);
  const decisions = v.read('decisions.md');
  assert.ok(decisions.indexOf('second words') < decisions.indexOf('first words'), 'newest first, whichever file holds it');
});

test('a session at a monorepo root picks for a package\'s domain, and must name one when it has several', t => {
  const { v, sid, root } = setup(t, { mono: true });
  const none = pick(v, sid, comment());
  assert.equal(none.code, 1);
  assert.equal(none.stderr, 'Not recorded: this session is in more than one domain: alpha and beta. Add domain with the one this is for.\n');
  const wrong = pick(v, sid, comment({ domain: 'glim' }));
  assert.equal(wrong.code, 1);
  assert.equal(wrong.stderr, "Not recorded: glim isn't a domain of this session. It has: alpha and beta.\n");
  assert.equal(pick(v, sid, comment({ domain: 'alpha' })).code, 0);
  assert.equal(pick(v, sid, comment({ domain: 'beta', comment: 'beta words' })).code, 0);
  const rows = rowsIn(v, 'picks');
  assert.deepEqual(rows.map(r => [r.domain, lower(r.project)]), [['alpha', lower(`${root}/packages/a`)], ['beta', lower(`${root}/packages/b`)]]);
  assert.equal(fs.readdirSync(v.at('raw', 'picks')).length, 1);
});

test('a session with one domain refuses another and lists the one it has', t => {
  const { v, sid } = setup(t);
  const r = pick(v, sid, comment({ domain: 'beta' }));
  assert.equal(r.code, 1);
  assert.equal(r.stderr, "Not recorded: beta isn't a domain of this session. It has: glim.\n");
  assert.equal(pick(v, sid, comment({ domain: 'glim' })).code, 0);
});

test('a confirmation takes the domain of the pick it confirms, and a pick in one domain is not replaced from another', t => {
  const { v, sid } = setup(t, { mono: true });
  assert.equal(pick(v, sid, provisional({ domain: 'alpha' })).code, 0);
  const [first] = rowsIn(v, 'picks');
  const confirmed = pick(v, sid, { confirms: first.id });
  assert.equal(confirmed.code, 0, confirmed.stderr);
  assert.equal(rowsIn(v, 'picks')[1].domain, 'alpha');
  assert.equal(pick(v, sid, provisional({ domain: 'beta', pick: 'Raised' })).code, 0);
  const [, , second] = rowsIn(v, 'picks');
  const across = pick(v, sid, provisional({ domain: 'alpha', replaces: second.id }));
  assert.equal(across.code, 1);
  assert.match(across.stderr, new RegExp(`${second.id} is for cards in beta, not alpha\\.`));
});

test('show takes the domain when the session has several', t => {
  const { v, sid } = setup(t, { mono: true });
  assert.equal(pick(v, sid, provisional({ domain: 'alpha' })).code, 0);
  const none = v.run('pick.mjs', ['show', sid, 'cards']);
  assert.equal(none.code, 1);
  assert.match(none.stderr, /^Not shown: this session is in more than one domain: alpha and beta\./);
  assert.match(v.run('pick.mjs', ['show', sid, 'cards', 'alpha']).stdout, /^Picks for cards in a, newest first:/);
  assert.match(v.run('pick.mjs', ['show', sid, 'cards', 'beta']).stdout, /^No picks for cards in b yet\./);
});

test('propose cites a pick in its own domain, and a row with no domain in any', t => {
  const { v, sid } = setup(t, { mono: true });
  assert.equal(pick(v, sid, comment({ domain: 'alpha', comment: 'alpha words' })).code, 0);
  const [row] = rowsIn(v, 'picks');
  v.write('raw/picks/2026-09-01.jsonl', `${JSON.stringify({ id: 'q-0000beef', at: '2026-09-01T10:00:00.000Z', source: 'pick', subject: 'cards', text: 'old words', status: 'user' })}\n`);
  const rule = (domain, slug, id) => ({ domain, slug, topic: 'code', basis: 'pick', pick: id, do: `Zebra quartz ${slug}.`, not: `Plover lantern ${slug}.`, applies_to: [`src/${slug}/**`] });
  const refused = v.propose(sid, rule('beta', 'one', row.id));
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, new RegExp(`${row.id} was recorded in alpha, not beta\\.`));
  assert.equal(v.propose(sid, rule('alpha', 'two', row.id)).code, 0);
  const old = v.propose(sid, rule('beta', 'three', 'q-0000beef'));
  assert.equal(old.code, 0, old.stderr);
  const files = fs.readdirSync(v.at('raw', 'inbox'));
  assert.deepEqual(files, [`${files[0].slice(0, 10)}-${sid.slice(0, 8)}.jsonl`]);
  assert.equal(rowsIn(v, 'inbox').length, 2);
});

test('the readers take the old per-day files and the per-session ones, and nothing else, in the order of the rows', async t => {
  const v = makeVault(t);
  const row = (id, at, extra = {}) => `${JSON.stringify({ id, at, source: 'pick', domain: 'glim', subject: 'cards', text: id, status: 'user', ...extra })}\n`;
  v.write('raw/picks/2026-10-01.jsonl', row('q-00000002', '2026-10-01T12:00:00.000Z'));
  v.write('raw/picks/2026-10-01-a1b2c3d4.jsonl', row('q-00000003', '2026-10-01T13:00:00.000Z') + row('q-00000001', '2026-10-01T09:00:00.000Z'));
  v.write('raw/picks/2026-10-01-cards.png', 'not rows');
  v.write('raw/picks/2026-10-01-a1b2c3d4.png', row('q-000000ff', '2026-10-01T08:00:00.000Z'));
  v.write('raw/picks/notes.jsonl', row('q-000000ee', '2026-10-01T08:00:00.000Z'));
  v.write('raw/inbox/2026-10-01-a1b2c3d4.jsonl', `${JSON.stringify({ id: 'a-00000001', at: '2026-10-01T10:00:00.000Z', source: 'agent', text: 'x' })}\n`);
  v.write('raw/inbox/2026-10-02.jsonl', `${JSON.stringify({ id: 'a-00000002', at: '2026-10-02T10:00:00.000Z', source: 'agent', text: 'y' })}\n`);
  const vault = await v.import('lib/vault.mjs');
  assert.deepEqual(vault.datedFiles('picks').map(f => f.file), ['raw/picks/2026-10-01-a1b2c3d4.jsonl', 'raw/picks/2026-10-01.jsonl']);
  assert.deepEqual(vault.pickRows().map(r => r.id), ['q-00000001', 'q-00000002', 'q-00000003']);
  assert.deepEqual(vault.proposalRows().map(r => r.id), ['a-00000001', 'a-00000002']);
});

test('a rule in a package\'s domain counts the sessions at the monorepo root in review status\'s never-shown list', t => {
  const { v } = setup(t, { mono: true });
  v.write('wiki/alpha/rules/roomy-cards.md', ruleNote({ domain: 'alpha', applies_to: ['src/**'] }));
  v.write('wiki/beta/rules/tight-cards.md', ruleNote({ domain: 'beta', applies_to: ['src/**'] }));
  const out = v.run('review.mjs', ['status']).stdout;
  const block = out.trimEnd().split('\n\n').find(b => b.startsWith('Rules no session was shown\n'));
  assert.deepEqual(block?.split('\n').slice(1), ['- alpha/roomy-cards: 1 session since 2026-10-01', '- beta/tight-cards: 1 session since 2026-10-01']);
});

test('show leaves out the picks of another domain in the same folder', t => {
  const v = vault(t, { domains: { other: { title: 'Other', topics: ['code'], markers: ['other.marker'] } } });
  fs.writeFileSync(path.join(v.project, 'other.marker'), '');
  const sid = sessionId();
  v.startSession(sid);
  assert.equal(pick(v, sid, comment({ domain: 'other', comment: 'words for the other domain' })).code, 0);
  assert.equal(pick(v, sid, comment({ domain: 'glim', comment: 'words for glim' })).code, 0);
  const glim = v.run('pick.mjs', ['show', sid, 'cards', 'glim']).stdout;
  assert.match(glim, /words for glim/);
  assert.doesNotMatch(glim, /words for the other domain/);
  assert.match(v.run('pick.mjs', ['show', sid, 'cards', 'other']).stdout, /words for the other domain/);
});

test("show lists the taste and knowledge rules of every domain in the project's folder", t => {
  const v = makeVault(t, { domains: { other: { title: 'Other', topics: ['code', 'naming'], markers: ['other.marker'], showSkipTopics: ['naming'] } } });
  fs.writeFileSync(path.join(v.project, 'other.marker'), '');
  v.write('wiki/glim/glim-taste.md', ruleNote({ keywords: ['x'], doLine: 'Glim taste.' }));
  v.write('wiki/other/other-taste.md', ruleNote({ domain: 'other', keywords: ['x'], doLine: 'Other taste.' }));
  v.write('wiki/other/other-fact.md', ruleNote({ domain: 'other', kind: 'knowledge', extra: ['as_of: 2026-10-01'], keywords: ['x'], doLine: 'Other fact.' }));
  v.write('wiki/other/other-name.md', ruleNote({ domain: 'other', topic: 'naming', keywords: ['x'], doLine: 'Other naming.' }));
  const sid = sessionId();
  v.startSession(sid);
  const out = v.run('pick.mjs', ['show', sid, 'cards', 'glim']).stdout;
  assert.match(out, /\nglim rules:\n- glim\/glim-taste: Do: Glim taste\./);
  assert.match(out, /\nother rules, leaving out naming:\n- other\/other-fact: Do: Other fact\.[^\n]*\n- other\/other-taste: Do: Other taste\./);
  assert.doesNotMatch(out, /other-name/);
  assert.ok(out.indexOf('glim rules') < out.indexOf('other rules'), 'the chosen domain comes first');
});

// Two packages that hold one domain's marker, under a root outside every configured path.
function twoPackages(t) {
  const v = vault(t, { domains: { mk: { title: 'Mk', topics: ['code'], markers: ['mk.marker'] } } });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-mono-')).replace(/\\/g, '/');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const p of ['a', 'b']) {
    fs.mkdirSync(`${root}/packages/${p}`, { recursive: true });
    fs.writeFileSync(`${root}/packages/${p}/mk.marker`, '');
  }
  const sid = sessionId();
  v.startSession(sid, { cwd: root });
  return { v, sid, root };
}

test('a domain with several projects in the session needs project, and names them when it is missing or wrong', t => {
  const { v, sid, root } = twoPackages(t);
  const rule = `${root}/packages/a and ${root}/packages/b`;
  const none = pick(v, sid, comment());
  assert.equal(none.code, 1);
  assert.equal(lower(none.stderr), lower(`Not recorded: mk has more than one project in this session: ${rule}. Add project with the one this is for.\n`));
  const wrong = pick(v, sid, comment({ project: `${root}/packages/c` }));
  assert.equal(wrong.code, 1);
  assert.equal(lower(wrong.stderr), lower(`Not recorded: ${root}/packages/c isn't a project of this session in mk. It has: ${rule}.\n`));
  assert.deepEqual(fs.existsSync(v.at('raw', 'picks')) ? fs.readdirSync(v.at('raw', 'picks')) : [], []);
  assert.equal(pick(v, sid, comment({ project: `${root}/packages/b`, comment: 'about b' })).code, 0);
  assert.equal(pick(v, sid, comment({ project: 'a', comment: 'about a' })).code, 0);
  assert.deepEqual(rowsIn(v, 'picks').map(r => [r.comment ?? r.text, lower(r.project)]), [['about b', lower(`${root}/packages/b`)], ['about a', lower(`${root}/packages/a`)]]);
});

test('a project is refused when it is not one of the domain\'s, even when the domain has only one', t => {
  const { v, sid } = setup(t);
  const r = pick(v, sid, comment({ project: 'elsewhere' }));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /^Not recorded: elsewhere isn't a project of this session in glim\. It has: /);
  assert.equal(pick(v, sid, comment({ project: v.project })).code, 0);
});

test('a confirmation and show take the project too, and a confirmation keeps the project of its pick', t => {
  const { v, sid, root } = twoPackages(t);
  assert.equal(pick(v, sid, provisional({ project: `${root}/packages/b` })).code, 0);
  const [first] = rowsIn(v, 'picks');
  assert.equal(pick(v, sid, { confirms: first.id }).code, 0);
  assert.equal(lower(rowsIn(v, 'picks')[1].project), lower(`${root}/packages/b`));
  const none = v.run('pick.mjs', ['show', sid, 'cards']);
  assert.equal(none.code, 1);
  assert.match(none.stderr, /^Not shown: mk has more than one project in this session: /);
  assert.match(v.run('pick.mjs', ['show', sid, 'cards', 'mk', `${root}/packages/b`]).stdout, /^Picks for cards in b, newest first:/);
  assert.match(v.run('pick.mjs', ['show', sid, 'cards', 'mk', 'a']).stdout, /^No picks for cards in a yet\./);
});

test('session start records each domain once, though it has several projects', t => {
  const { v, sid } = twoPackages(t);
  assert.deepEqual(JSON.parse(v.read(`.state/sessions/${sid}.json`)).reach.domains, ['mk']);
});

test('pick --help describes project', t => {
  const { v } = setup(t);
  assert.match(v.run('pick.mjs', ['--help']).stdout, /^  project      /m);
});

test('a pick in a domain reached by a path records that domain and the folder', t => {
  const v = vault(t, { presets: ['journal'] });
  v.write('wiki/journal/rules/always-j.md', ruleNote({ domain: 'journal', topic: 'days', always: true, doLine: 'Date each entry.' }));
  const sid = sessionId();
  const cwd = v.projects.journal;
  assert.match(v.startSession(sid, { cwd })?.hookSpecificOutput?.additionalContext ?? '', /journal\/always-j: Do: Date each entry\./);
  const r = pick(v, sid, comment());
  assert.equal(r.code, 0, r.stderr);
  const [row] = rowsIn(v, 'picks');
  assert.equal(row.domain, 'journal');
  assert.equal(lower(row.project), lower(cwd));
});

test("notes and a comment the user didn't type are refused, and nothing is recorded", t => {
  const { v, sid } = setup(t);
  const typed = pick(v, sid, provisional({ status: 'user', notes: 'flat reads calmer' }));
  assert.equal(typed.code, 0, typed.stderr);
  const notes = pick(v, sid, provisional({ status: 'user', notes: 'raised feels heavy' }));
  assert.equal(notes.code, 1);
  assert.equal(notes.stderr, "Not recorded: notes aren't in anything the user typed in this session. Put their exact words in notes, with … where you leave some out, or your own in reason.\n");
  assert.equal(pick(v, sid, provisional()).code, 0);
  const second = rowsIn(v, 'picks').at(-1);
  const confirmed = pick(v, sid, { confirms: second.id, notes: 'raised feels heavy' });
  assert.equal(confirmed.code, 1);
  assert.match(confirmed.stderr, /^Not recorded: notes aren't in anything the user typed in this session\./);
  const said = pick(v, sid, comment({ comment: 'the cards feel cramped' }));
  assert.equal(said.code, 1);
  assert.equal(said.stderr, "Not recorded: the comment isn't in anything the user typed in this session. Record their exact words, with … where you leave some out.\n");
  assert.equal(rowsIn(v, 'picks').length, 2);
  assert.equal(pick(v, sid, { confirms: second.id, notes: 'flat … calmer' }).code, 0);
});

test('with no transcript a comment and notes are refused, and a pick without notes is recorded', t => {
  const v = vault(t);
  const sid = sessionId();
  v.startSession(sid, { transcript: null });
  const none = "the taste vault has no transcript for this session, so it can't check these are the user's words.";
  const said = pick(v, sid, comment());
  assert.equal(said.code, 1);
  assert.equal(said.stderr, `Not recorded: ${none}\n`);
  const notes = pick(v, sid, provisional({ status: 'user', notes: 'flat reads calmer' }));
  assert.equal(notes.code, 1);
  assert.equal(notes.stderr, `Not recorded: ${none}\n`);
  assert.equal(fs.existsSync(v.at('raw', 'picks')) ? rowsIn(v, 'picks').length : 0, 0);
  const plain = pick(v, sid, provisional({ status: 'user' }));
  assert.equal(plain.code, 0, plain.stderr);
  assert.equal(pick(v, sid, provisional()).code, 0);
  assert.equal(pick(v, sid, { confirms: rowsIn(v, 'picks').at(-1).id }).code, 0);
  assert.equal(rowsIn(v, 'picks').length, 3);
});

test('a PDF sheet with derived text is taken, and one without is refused', async t => {
  const { v, sid } = setup(t);
  const sheet = v.write('raw/refs/cards.pdf', Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('Flat cards.\fRaised cards.\n'), Buffer.from([0xff, 0xfe])]));
  const refused = pick(v, sid, provisional({ sheet }));
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /sheet must be a \.png, \.jpg, \.jpeg or \.webp image, or a file with derived text \(node tools\/extract\.mjs\)\./);
  assert.equal(fs.existsSync(v.at('raw', 'picks')) ? fs.readdirSync(v.at('raw', 'picks')).length : 0, 0);
  const hash = (await v.import('lib/sources.mjs')).hashPath(sheet);
  v.write(`derived/${hash}.md`, '---\nkind: pdf\nextractor: fixture\nextractor_version: \'1.0\'\nsource: raw/refs/cards.pdf\n---\n[p. 1]\nFlat cards.\n[p. 2]\nRaised cards.\n');
  const r = pick(v, sid, provisional({ sheet }));
  assert.equal(r.code, 0, r.stderr);
  const [row] = rowsIn(v, 'picks');
  assert.match(row.sheet, /^raw\/picks\/\d{4}-\d\d-\d\d-cards\.pdf$/);
  assert.equal((await v.import('lib/sources.mjs')).hashFile(row.sheet), hash);
});
