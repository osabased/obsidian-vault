import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeVault, sessionId, userTurn, assistantTurn, recordedCall, keepAllowed, offerOf, prompt, cleanEnv, sectionOf, zqEntityPage as zqPage, ruleNote } from './fixture.mjs';
import { today } from '../tools/lib/vault.mjs';
import { codexInput } from './codex.mjs';

// Offers no one answered go to the review queue in raw/queue/ once their session has gone quiet: the sweep at another
// session's start reads .state/offers/ and the session registry, never a transcript. A Deny is the user's no and isn't
// queued.
const rule = (o = {}) => ({
  domain: 'glim', slug: 'tidy-names', topic: 'code', basis: 'stated', quote: 'call them by their screen',
  do: 'Name widgets after their screen.', not: 'Leave widget names bare.', because: 'A screen says what a widget is for.', keywords: ['widgetz'], applies_to: ['src/**/*.zq'], ...o,
});
const typed = said => said.flatMap(s => [userTurn(s), assistantTurn('Noted.')]);

function started(v, said = ['call them by their screen']) {
  const sid = sessionId();
  v.startSession(sid, { transcript: v.transcript(sid, typed(said)) });
  return sid;
}

const queueRows = v => (fs.existsSync(v.at('raw', 'queue'))
  ? fs.readdirSync(v.at('raw', 'queue')).flatMap(f => v.read(`raw/queue/${f}`).trim().split('\n').filter(Boolean).map(l => JSON.parse(l)))
  : []);
const inboxRows = v => (fs.existsSync(v.at('raw', 'inbox'))
  ? fs.readdirSync(v.at('raw', 'inbox')).flatMap(f => v.read(`raw/inbox/${f}`).trim().split('\n').map(l => JSON.parse(l)))
  : []);
const offerAt = (v, id) => (v.exists(`.state/offers/${id}.json`) ? JSON.parse(v.read(`.state/offers/${id}.json`)) : null);
const registryOf = (v, sid) => JSON.parse(v.read(`.state/sessions/${sid}.json`));

// The session's last start or prompt moved back past queue.sweepAfterHours (12 by default).
function quiet(v, sid, hours = 13) {
  const entry = registryOf(v, sid);
  v.write(`.state/sessions/${sid}.json`, JSON.stringify({ ...entry, last_seen: new Date(Date.now() - hours * 3600e3).toISOString() }));
}

function setMode(v, mode) {
  const cfg = JSON.parse(v.read('vault.config.json'));
  v.write('vault.config.json', JSON.stringify({ ...cfg, proposals: mode }));
}

const entries = v => queueRows(v).filter(r => !r.decides);
// What the tools write has to pass lint's checks on raw/queue/.
const queueLint = async v => (await v.import('lib/lint.mjs')).lint().filter(f => f.file.startsWith('raw/queue/'));

function backdate(v, id, days) {
  const o = offerAt(v, id);
  v.write(`.state/offers/${id}.json`, JSON.stringify({ ...o, at: new Date(Date.now() - days * 864e5).toISOString() }));
}

function offered(r) {
  assert.equal(r.code, 0, r.stderr);
  const o = offerOf(r.stdout);
  assert.ok(o, r.stdout);
  return o;
}

const heldId = r => {
  assert.equal(r.code, 0, r.stderr);
  const id = /^Held `(o-[0-9a-f]{8})`/.exec(r.stdout)?.[1];
  assert.ok(id, r.stdout);
  return id;
};

test('(a) a pending offer of a session quiet past sweepAfterHours becomes an entry, without its transcript', t => {
  const v = makeVault(t, { config: { proposals: 'ask' } });
  const a = started(v);
  const o = offered(v.propose(a, rule()));
  const entry = registryOf(v, a);
  // Gone, so the sweep can only have read the offer and the registry.
  fs.rmSync(entry.transcript);
  quiet(v, a);
  started(v);
  const rows = queueRows(v);
  assert.equal(rows.length, 1, JSON.stringify(rows));
  const [row] = rows;
  assert.equal(row.id, `u-${o.id.slice(2)}`);
  assert.ok(!Number.isNaN(Date.parse(row.at)));
  assert.deepEqual({ ...row, at: undefined }, {
    id: `u-${o.id.slice(2)}`, at: undefined, kind: 'rule', why: 'ignored', unattended: 'left', from: o.id, session: a, agent: 'claude-code',
    transcript: entry.transcript, cwd: entry.cwd, domain: 'glim', key: 'glim/tidy-names', fields: rule(), text: o.text,
    quote: 'call them by their screen', checked: today(),
  });
  assert.equal(offerAt(v, o.id).state, 'queued');
  assert.ok(fs.readdirSync(v.at('raw', 'queue')).every(f => /^\d{4}-\d\d-\d\d-[\w-]{1,8}\.jsonl$/.test(f)));
});

test('a session that is not quiet yet keeps its offers, and its own start never sweeps them', t => {
  const v = makeVault(t, { config: { proposals: 'ask' } });
  const a = started(v);
  const o = offered(v.propose(a, rule()));
  quiet(v, a, 11);
  started(v);
  v.startSession(a, { source: 'resume' });
  assert.deepEqual(queueRows(v), []);
  assert.equal(offerAt(v, o.id).state, 'pending');
});

test('(b) a held offer never released becomes why: unreleased', t => {
  const v = makeVault(t, { config: { proposals: 'ask' } });
  const a = started(v);
  const id = heldId(v.propose(a, rule({ hold: true })));
  quiet(v, a);
  started(v);
  const [row] = queueRows(v);
  assert.equal(row.why, 'unreleased');
  assert.equal(row.unattended, null);
  assert.equal(row.from, id);
  assert.equal(offerAt(v, id).state, 'queued');
});

test('(c) an offer whose keep was denied is marked denied on the next prompt, is not queued, and the purge deletes it', t => {
  const v = makeVault(t, { config: { proposals: 'ask' } });
  const a = started(v);
  const o = offered(v.propose(a, rule()));
  recordedCall(v, a, { offer: o.id, allow: false, input: { id: o.id, offer: o.text } });
  prompt(v, a, 'no, leave it');
  assert.equal(offerAt(v, o.id).state, 'denied');
  quiet(v, a);
  const b = started(v);
  assert.deepEqual(queueRows(v), []);
  backdate(v, o.id, 8);
  offered(v.propose(b, rule({ slug: 'other-names', do: 'Prefix widget names with zq.', not: 'Name widgets freely.' })));
  assert.equal(offerAt(v, o.id), null, 'the purge left a denied offer');
});

test('a denied keep the user never answered with a message is still not queued', t => {
  const v = makeVault(t, { config: { proposals: 'ask' } });
  const a = started(v);
  const o = offered(v.propose(a, rule()));
  recordedCall(v, a, { offer: o.id, allow: false, input: { id: o.id, offer: o.text } });
  quiet(v, a);
  started(v);
  assert.deepEqual(queueRows(v), []);
  assert.equal(offerAt(v, o.id).state, 'denied');
});

test('(d) sweeps at once write one row per offer', async t => {
  const v = makeVault(t, { config: { proposals: 'ask' } });
  const a = started(v);
  const o = offerAt(v, offered(v.propose(a, rule())).id);
  // Many offers keep each sweep busy long enough for the parallel ones to overlap.
  for (let i = 0; i < 40; i++) {
    const id = `o-${(0x10000000 + i).toString(16)}`;
    v.write(`.state/offers/${id}.json`, JSON.stringify({ ...o, id }));
  }
  quiet(v, a);
  const lib = pathToFileURL(v.at('tools', 'lib', 'queue.mjs')).href;
  const code = `const q = await import(${JSON.stringify(lib)}); q.sweep(process.argv[1]);`;
  const run = sid => promisify(execFile)(process.execPath, ['--input-type=module', '-e', code, sid], { env: cleanEnv() });
  await Promise.all(Array.from({ length: 6 }, () => run(sessionId())));
  const ids = entries(v).map(r => r.id);
  assert.equal(ids.length, 41);
  assert.equal(new Set(ids).size, 41);
});

test('(e) an 8-day-old pending offer outlives the purge and is queued', t => {
  const v = makeVault(t, { config: { proposals: 'ask' } });
  const a = started(v);
  const o = offered(v.propose(a, rule()));
  backdate(v, o.id, 8);
  const b = started(v);
  offered(v.propose(b, rule({ slug: 'other-names', do: 'Prefix widget names with zq.', not: 'Name widgets freely.' })));
  assert.equal(offerAt(v, o.id)?.state, 'pending', 'the purge deleted a pending offer');
  quiet(v, a);
  started(v);
  assert.deepEqual(queueRows(v).map(r => [r.from, r.why]), [[o.id, 'ignored']]);
});

test('(f) a session resumed after the offer with no typed message since gives ignored; one typed message gives skipped', t => {
  const v = makeVault(t, { config: { proposals: 'ask' } });
  const a = started(v);
  const ignored = offered(v.propose(a, rule()));
  v.startSession(a, { source: 'resume' });
  quiet(v, a);
  started(v);
  const c = started(v);
  const skipped = offered(v.propose(c, rule({ slug: 'other-names', do: 'Prefix widget names with zq.', not: 'Name widgets freely.' })));
  prompt(v, c, 'something else now');
  quiet(v, c);
  started(v);
  const why = Object.fromEntries(queueRows(v).map(r => [r.from, [r.why, r.unattended]]));
  assert.deepEqual(why, { [ignored.id]: ['ignored', 'left'], [skipped.id]: ['skipped', null] });
});

test('keep of a queued offer points to its entry, and propose with queued offers it again and records the kept decision', async t => {
  const v = makeVault(t, { config: { proposals: 'ask' } });
  const a = started(v);
  const o = offered(v.propose(a, rule()));
  fs.rmSync(registryOf(v, a).transcript);
  quiet(v, a);
  const b = started(v, ['something unrelated']);
  const u = `u-${o.id.slice(2)}`;
  const k = keepAllowed(v, a, o.id, o.text);
  assert.equal(k.code, 1);
  assert.equal(k.stderr, `Not kept: Offer \`${o.id}\` went to the review queue as \`${u}\`. Propose it again with \`queued: "${u}"\`.\n`);

  const again = offered(v.propose(b, { queued: u }));
  assert.equal(again.text, o.text);
  const kept = keepAllowed(v, b, again.id, again.text);
  assert.equal(kept.code, 0, kept.stderr);
  const note = v.read('wiki/glim/rules/tidy-names.md');
  assert.match(note, new RegExp(`^- ${today()} · stated · session ${a.slice(0, 8)} · "call them by their screen" \\(a-[0-9a-f]{8}\\)$`, 'm'));
  const [inbox] = inboxRows(v);
  assert.equal(inbox.session, a, "the inbox row names the session the user's words were typed in");
  assert.equal(inbox.queued, u);
  const decisions = queueRows(v).filter(r => r.decides);
  assert.deepEqual(decisions.map(d => [d.decides, d.decision, d.offer, d.session]), [[u, 'kept', again.id, b]]);
  assert.match(decisions[0].id, /^d-[0-9a-f]{8}$/);

  const twice = v.propose(b, { queued: u });
  assert.equal(twice.code, 1);
  assert.match(twice.stderr, /^Not proposed: /);
  const found = (await v.import('lib/lint.mjs')).lint().filter(f => f.file === 'wiki/glim/rules/tidy-names.md');
  assert.deepEqual(found, [], 'lint checks the quote against the inbox row of the session it was typed in');
});

test('(8) queue.mjs draft refuses basis stated, inferred and pick, and writes a drafted entry for reading', async t => {
  const v = makeVault(t, { config: { proposals: 'ask' } });
  const sid = sessionId();
  // The transcript holds the quote, so only the basis check can refuse.
  v.startSession(sid, { cwd: v.root, transcript: v.transcript(sid, typed(['call them by their screen'])) });
  const env = { CLAUDE_CODE_SESSION_ID: sid };
  for (const basis of ['stated', 'inferred', 'pick']) {
    const r = v.run('queue.mjs', ['draft'], { input: rule({ basis, ...(basis === 'pick' ? { quote: undefined, pick: 'q-00000001' } : {}) }), env });
    assert.equal(r.code, 1, r.stdout);
    assert.equal(r.stderr, `Not drafted: a draft takes basis reading, source or failure, so basis ${basis} is refused.\n`);
  }
  assert.deepEqual(queueRows(v), []);
  const ok = v.run('queue.mjs', ['draft'], { input: rule({ basis: 'reading', quote: undefined, reading: 'The user renamed three widgets after their screens.' }), env });
  assert.equal(ok.code, 0, ok.stderr);
  const [row] = queueRows(v);
  assert.equal(row.why, 'drafted');
  assert.equal(row.unattended, null);
  assert.equal(row.from, null);
  assert.equal(row.session, sid);
  assert.equal(row.quote, null);
  assert.ok(!v.exists('wiki/glim/rules/tidy-names.md'));
  assert.deepEqual(await queueLint(v), []);
});

test('queue.mjs draft takes a page change with no basis, and the entry offered again writes the page once kept', async t => {
  const v = makeVault(t, { config: { proposals: 'ask' } });
  const sid = sessionId();
  v.startSession(sid, { cwd: v.root, transcript: v.transcript(sid, typed(['call them by their screen'])) });
  const env = { CLAUDE_CODE_SESSION_ID: sid };
  const rel = 'wiki/glim/entities/zq-lib.md';
  const text = zqPage();
  const r = v.run('queue.mjs', ['draft'], { input: JSON.stringify({ page: rel, text }), env });
  assert.equal(r.code, 0, r.stderr);
  const [row] = queueRows(v);
  assert.equal(row.why, 'drafted');
  assert.equal(row.kind, 'page');
  assert.equal(row.fields.page, rel);
  assert.ok(!v.exists(rel));
  assert.deepEqual(await queueLint(v), []);
  const o = offered(v.propose(sid, { queued: row.id }));
  assert.match(o.text, /^\*\*Keep this page change\?\*\* wiki\/glim\/entities\/zq-lib\.md · new\n/);
  const k = keepAllowed(v, sid, o.id, o.text);
  assert.equal(k.code, 0, k.stderr);
  assert.equal(v.read(rel).replace(/\r\n/g, '\n'), text);
});

function draftedChange(t) {
  const v = makeVault(t, { config: { proposals: 'ask' } });
  const rel = 'wiki/glim/entities/zq-lib.md';
  v.write(rel, zqPage('Zq-lib parses screens.'));
  const sid = sessionId();
  v.startSession(sid, { cwd: v.root, transcript: v.transcript(sid, typed(['call them by their screen'])) });
  const text = zqPage('Zq-lib parses screens and themes.');
  const r = v.run('queue.mjs', ['draft'], { input: JSON.stringify({ page: rel, text }), env: { CLAUDE_CODE_SESSION_ID: sid } });
  assert.equal(r.code, 0, r.stderr);
  const [row] = queueRows(v);
  assert.match(row.fields.base, /^[0-9a-f]{64}$/);
  return { v, sid, rel, text, row };
}

test('a drafted change to an existing page, offered again from the queue, writes the page once kept and closes the entry', t => {
  const { v, sid, rel, text, row } = draftedChange(t);
  const o = offered(v.propose(sid, { queued: row.id }));
  assert.match(o.text, /^\*\*Keep this page change\?\*\* wiki\/glim\/entities\/zq-lib\.md · change\n/);
  const k = keepAllowed(v, sid, o.id, o.text);
  assert.equal(k.code, 0, k.stderr);
  assert.equal(v.read(rel), text);
  const decisions = queueRows(v).filter(r => r.decides);
  assert.deepEqual(decisions.map(d => [d.decides, d.decision, d.offer]), [[row.id, 'kept', o.id]]);
});

test('a drafted page change is refused once the page changed since the draft, when offered again and at keep', t => {
  const { v, sid, rel, row } = draftedChange(t);
  v.write(rel, zqPage('The user rewrote this.'));
  const stale = v.propose(sid, { queued: row.id });
  assert.equal(stale.code, 1, stale.stdout);
  assert.equal(stale.stderr, `Not proposed: ${rel} changed since \`${row.id}\` was made from it, so it would undo that change. Drop \`${row.id}\` and draft the change again from the page as it is now.\n`);

  v.write(rel, zqPage('Zq-lib parses screens.'));
  const o = offered(v.propose(sid, { queued: row.id }));
  v.write(rel, zqPage('The user rewrote this.'));
  const k = keepAllowed(v, sid, o.id, o.text);
  assert.equal(k.code, 1);
  assert.match(k.stderr, /^Not kept: wiki\/glim\/entities\/zq-lib\.md changed since the offer/);
  assert.match(v.read(rel), /The user rewrote this\./);
  assert.deepEqual(queueRows(v).filter(r => r.decides), []);
});

test('queue.mjs draft takes a reword, and the entry offered again changes the rule once kept', async t => {
  const v = makeVault(t, { config: { proposals: 'ask' } });
  v.write('wiki/glim/rules/the-thing.md', ruleNote({ keywords: ['thing'] }));
  const sid = sessionId();
  v.startSession(sid, { cwd: v.root, transcript: v.transcript(sid, typed(['call them by their screen'])) });
  const env = { CLAUDE_CODE_SESSION_ID: sid };
  const input = { change: 'reword', key: 'glim/the-thing', do: 'Do the thing twice.', basis: 'reading', reading: 'The user did the thing twice in each screen.' };
  const r = v.run('queue.mjs', ['draft'], { input: JSON.stringify(input), env });
  assert.equal(r.code, 0, r.stderr);
  const [row] = queueRows(v);
  assert.equal(row.kind, 'reword');
  assert.equal(row.key, 'glim/the-thing');
  assert.deepEqual(await queueLint(v), []);
  const o = offered(v.propose(sid, { queued: row.id }));
  assert.match(o.text, /^\*\*Change this rule\?\*\* glim\/the-thing\n/);
  const k = keepAllowed(v, sid, o.id, o.text);
  assert.equal(k.code, 0, k.stderr);
  assert.match(v.read('wiki/glim/rules/the-thing.md'), /\*\*Do:\*\* Do the thing twice\.\r?\n/);
});

test('queue.mjs draft takes a domain and a move into it, and walking the domain first lets the move be kept', async t => {
  const v = makeVault(t, { config: { proposals: 'ask' } });
  v.write('wiki/glim/rules/the-thing.md', ruleNote({ keywords: ['thing'] }));
  const sid = sessionId();
  v.startSession(sid, { cwd: v.root, transcript: v.transcript(sid, typed(['call them by their screen'])) });
  const draft = input => v.run('queue.mjs', ['draft'], { input: JSON.stringify(input), env: { CLAUDE_CODE_SESSION_ID: sid } });
  const move = { change: 'move', key: 'glim/the-thing', domain: 'quill' };
  assert.match(draft(move).stderr, /there's no domain quill/);
  const d = draft({ name: 'quill', title: 'Quill', topics: ['code'], marker: 'quill.project' });
  assert.equal(d.code, 0, d.stderr);
  assert.match(d.stdout, /^Drafted `u-[0-9a-f]{8}` into the review queue; nothing is written\.$/m);
  assert.equal(JSON.parse(v.read('vault.config.json')).domains.quill, undefined);
  assert.equal(draft(move).code, 0);
  assert.match(v.propose(sid, move).stderr, /there's no domain quill/, 'only a draft may name a domain the queue holds');
  const [domain, moved] = entries(v);
  assert.deepEqual([domain.kind, domain.key, moved.kind, moved.key], ['domain', 'quill', 'move', 'glim/the-thing']);
  assert.deepEqual(await queueLint(v), []);
  const o = offered(v.propose(sid, { queued: domain.id }));
  assert.equal(keepAllowed(v, sid, o.id, o.text).code, 0);
  const m = offered(v.propose(sid, { queued: moved.id }));
  const k = keepAllowed(v, sid, m.id, m.text);
  assert.equal(k.code, 0, k.stderr);
  assert.match(v.read('wiki/quill/rules/the-thing.md'), /^moved_from: glim\/the-thing$/m);
  assert.deepEqual(entries(v).filter(r => !queueRows(v).some(x => x.decides === r.id)), []);
});

test('queue.mjs lists open entries oldest first, marks unattended ones, and later and drop append decision rows', async t => {
  const v = makeVault(t, { config: { proposals: 'ask' } });
  const a = started(v);
  const first = offered(v.propose(a, rule()));
  const second = heldId(v.propose(a, rule({ slug: 'other-names', do: 'Prefix widget names with zq.', not: 'Name widgets freely.', hold: true })));
  quiet(v, a);
  const sid = sessionId();
  v.startSession(sid, { cwd: v.root });
  // The newer entry first in the file, so only the sort by at lists the older one first.
  const [file] = fs.readdirSync(v.at('raw', 'queue'));
  const now = Date.now();
  const dated = queueRows(v).map(r => ({ ...r, at: new Date(r.from === first.id ? now : now - 3600e3).toISOString() }));
  v.write(`raw/queue/${file}`, dated.sort((x, y) => y.at.localeCompare(x.at)).map(r => `${JSON.stringify(r)}\n`).join(''));
  const env = { CLAUDE_CODE_SESSION_ID: sid };
  const list = v.run('queue.mjs', ['list'], { env });
  assert.equal(list.code, 0, list.stderr);
  const lines = list.stdout.trim().split('\n');
  assert.equal(lines.length, 2, list.stdout);
  assert.deepEqual(lines.map(l => l.split(' · ')[0]), [`u-${second.slice(2)}`, `u-${first.id.slice(2)}`], 'oldest first');
  assert.match(lines.join('\n'), new RegExp(`u-${first.id.slice(2)}.*unattended: left`));
  assert.doesNotMatch(lines.find(l => l.includes(second.slice(2))), /unattended/);
  const u = `u-${first.id.slice(2)}`;
  assert.equal(v.run('queue.mjs', ['show', u], { env }).code, 0);
  assert.equal(v.run('queue.mjs', ['later', u], { env }).code, 0);
  assert.equal(v.run('queue.mjs', ['list'], { env }).stdout.trim().split('\n').length, 2, 'a later decision keeps the entry open');
  assert.equal(v.run('queue.mjs', ['drop', u], { env }).code, 0);
  assert.equal(v.run('queue.mjs', ['list'], { env }).stdout.trim().split('\n').length, 1);
  const drop = v.run('queue.mjs', ['drop', u], { env });
  assert.equal(drop.code, 1, 'a decided entry is dropped twice');
  const decisions = queueRows(v).filter(r => r.decides);
  assert.deepEqual(decisions.map(d => [d.decision, d.session]), [['later', sid], ['dropped', sid]]);
  assert.equal(v.run('build.mjs').code, 0);
  assert.match(v.read('queue.md'), new RegExp(`u-${second.slice(2)}`));
  assert.doesNotMatch(v.read('queue.md'), new RegExp(u));
  assert.deepEqual(await queueLint(v), []);
});

test('a held offer stays held: nothing is written, and release returns it for keep', t => {
  const v = makeVault(t, { config: { proposals: 'ask' } });
  const a = started(v);
  const r = v.propose(a, rule({ hold: true }));
  const id = heldId(r);
  assert.equal(r.stdout.trim(), `Held \`${id}\`; nothing is written yet. Don't show it now. Release it with the others when the task is done.`);
  assert.equal(offerAt(v, id).state, 'held');
  const rel = v.propose(a, { release: true });
  assert.equal(rel.code, 0, rel.stderr);
  assert.match(rel.stdout, /^Call `keep` for each offer below, then say in your final reply what was kept\.\n\nOffered `o-/);
  const o = offerOf(rel.stdout.slice(rel.stdout.indexOf('Offered')));
  assert.equal(o.id, id);
  const released = offerAt(v, id);
  assert.equal(released.state, 'pending');
  assert.ok(!Number.isNaN(Date.parse(released.released_at)));
  const k = keepAllowed(v, a, id, o.text);
  assert.equal(k.code, 0, k.stderr);
  assert.ok(v.exists('wiki/glim/rules/tidy-names.md'));
});

test('under corrections, release writes the held rules; under off, hold still needs asked', t => {
  const v = makeVault(t);
  const a = started(v);
  heldId(v.propose(a, rule({ hold: true })));
  assert.ok(!v.exists('wiki/glim/rules/tidy-names.md'));
  const rel = v.propose(a, { release: true });
  assert.equal(rel.code, 0, rel.stderr);
  assert.match(rel.stdout, /^Wrote wiki\/glim\/rules\/tidy-names\.md\./);
  assert.ok(v.exists('wiki/glim/rules/tidy-names.md'));

  const off = makeVault(t, { config: { proposals: 'off' } });
  const b = started(off);
  const r = off.propose(b, rule({ hold: true }));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /proposals is off for glim/);
});

test('an offer made again from an entry and left unanswered stays that entry, which can still be offered', t => {
  const v = makeVault(t, { config: { proposals: 'ask' } });
  const a = started(v);
  const o = offered(v.propose(a, rule()));
  quiet(v, a);
  const b = started(v, ['something unrelated']);
  const u = `u-${o.id.slice(2)}`;
  const again = offered(v.propose(b, { queued: u }));
  quiet(v, b);
  const c = started(v, ['something else']);
  assert.deepEqual(entries(v).map(r => r.id), [u]);
  assert.equal(offerAt(v, again.id).queued_as, u);
  const k = keepAllowed(v, b, again.id, again.text);
  assert.equal(k.stderr, `Not kept: Offer \`${again.id}\` went to the review queue as \`${u}\`. Propose it again with \`queued: "${u}"\`.
`);
  offered(v.propose(c, { queued: u }));
});

test('release reads the mode when it runs: a rule held under corrections is offered once the user switched to ask', t => {
  const v = makeVault(t);
  const a = started(v);
  const id = heldId(v.propose(a, rule({ hold: true })));
  setMode(v, 'ask');
  const rel = v.propose(a, { release: true });
  assert.equal(rel.code, 0, rel.stderr);
  assert.equal(offerOf(rel.stdout.slice(rel.stdout.indexOf('Offered'))).id, id);
  assert.ok(!v.exists('wiki/glim/rules/tidy-names.md'));
});

test("a subagent can't release the session's held offers or offer a queued entry again", t => {
  const v = makeVault(t, { config: { proposals: 'ask' } });
  const a = started(v);
  const id = heldId(v.propose(a, rule({ hold: true })));
  for (const [k, input] of [['release', { release: true }], ['queued', { queued: 'u-00000001' }]]) {
    const call = recordedCall(v, a, { tool: 'propose', subagent: 'agent-7' });
    const r = v.run('propose.mjs', [a, call], { input });
    assert.equal(r.code, 1, r.stdout);
    assert.equal(r.stderr, `Not proposed: a subagent's rules wait in the review queue for the user, so ${k} is for the main session.\n`);
  }
  assert.equal(offerAt(v, id).state, 'held');
});

test('under off, a queued entry is offered again with the words of the user asking for it', t => {
  const v = makeVault(t, { config: { proposals: 'ask' } });
  const a = started(v);
  const o = offered(v.propose(a, rule()));
  quiet(v, a);
  setMode(v, 'off');
  const b = started(v, ['keep the widget naming rule']);
  const u = `u-${o.id.slice(2)}`;
  const bare = v.propose(b, { queued: u });
  assert.equal(bare.code, 1);
  assert.match(bare.stderr, /proposals is off for glim/);
  offered(v.propose(b, { queued: u, asked: 'keep the widget naming rule' }));
  const other = v.propose(b, { queued: u, do: 'x' });
  assert.equal(other.stderr, "Not proposed: queued takes no other field than asked, and repeats or slug for a rule entry: the entry's own fields are proposed again.\n");
});

test('under corrections, and in the vault folder, an entry proposed again with queued is an offer for the user, not a write', async t => {
  for (const vaultFolder of [false, true]) {
    const v = makeVault(t);
    const a = started(v);
    const held = heldId(v.propose(a, rule({ hold: true })));
    quiet(v, a);
    const b = sessionId();
    v.startSession(b, { transcript: v.transcript(b, typed(['something unrelated'])), ...(vaultFolder ? { cwd: v.root } : {}) });
    const u = `u-${held.slice(2)}`;
    const again = offered(v.propose(b, { queued: u }));
    assert.ok(!v.exists('wiki/glim/rules/tidy-names.md'), 'the entry waits for the user, whatever the mode');
    const kept = keepAllowed(v, b, again.id, again.text);
    assert.equal(kept.code, 0, kept.stderr);
    assert.ok(v.exists('wiki/glim/rules/tidy-names.md'));
    assert.deepEqual(queueRows(v).filter(r => r.decides).map(d => [d.decides, d.decision]), [[u, 'kept']]);
    assert.deepEqual(await queueLint(v), []);
  }
});

test("a session start waits at most 2 s for another session's offers.lock, and leaves the sweep to the next start", t => {
  const v = makeVault(t, { config: { proposals: 'ask' } });
  const a = started(v);
  offered(v.propose(a, rule()));
  quiet(v, a);
  // A live holder's lock, which goes stale only after 30 s.
  v.write('.state/offers.lock', `${process.pid}:held`, { settled: false });
  const t0 = Date.now();
  started(v, ['something unrelated']);
  assert.ok(Date.now() - t0 < 4000, `the start took ${Date.now() - t0} ms`);
  assert.deepEqual(queueRows(v), []);
  fs.rmSync(v.at('.state', 'offers.lock'));
  started(v, ['something unrelated']);
  assert.equal(entries(v).length, 1);
});

test('lint warns on queue rows of the wrong shape, decisions with no entry or a second close, and a quote the user never typed', async t => {
  const v = makeVault(t, { config: { proposals: 'ask' } });
  const a = started(v);
  const transcript = registryOf(v, a).transcript;
  const at = new Date().toISOString();
  const entry = o => ({
    id: 'u-0000000a', at, kind: 'rule', why: 'ignored', unattended: 'left', from: 'o-0000000a', session: a, agent: 'claude-code', transcript,
    cwd: null, domain: 'glim', key: 'glim/tidy-names', fields: rule(), text: 'x', quote: 'call them by their screen', checked: today(), ...o,
  });
  const decision = o => ({ id: 'd-0000000a', at, decides: 'u-0000000a', decision: 'dropped', offer: null, session: a, ...o });
  v.write(`raw/queue/${today()}-${a.slice(0, 8)}.jsonl`, [
    entry({}),
    entry({ id: 'u-zz', kind: 'bogus', why: 'bored', unattended: 'away' }),
    entry({ id: 'u-0000000b', quote: 'name them after the moon', fields: rule({ quote: 'name them after the moon' }) }),
    entry({ id: 'u-0000000d', quote: 'name them after the sun', fields: rule({ basis: 'inferred', quote: 'name them after the sun' }) }),
    decision({}),
    decision({ id: 'd-0000000b', decision: 'kept' }),
    decision({ id: 'd-0000000c', decides: 'u-0000000f', decision: 'maybe' }),
  ].map(r => `${JSON.stringify(r)}\n`).join(''));
  const file = `raw/queue/${today()}-${a.slice(0, 8)}.jsonl`;
  const found = (await v.import('lib/lint.mjs')).lint().filter(f => f.file === file).map(f => f.msg);
  assert.deepEqual(found.sort(), [
    "d-0000000b closes u-0000000a, which d-0000000a already closed",
    'd-0000000c decides u-0000000f, which has no entry',
    'd-0000000c records decision "maybe", which is neither kept, dropped nor later',
    'u-0000000b quotes "name them after the moon", which isn\'t in what the user typed in session ' + a.slice(0, 8),
    'u-0000000d quotes "name them after the sun", which isn\'t in what the user typed in session ' + a.slice(0, 8),
    'u-zz has why "bored", which is none of unreleased, skipped, ignored, unattended or drafted',
    'u-zz has kind "bogus", which is none of rule, evidence, page, reword, retire, domain or move',
    'u-zz has unattended "away", which is none of subagent, headless or left',
    "u-zz isn't an entry id: u- and 8 hex digits",
  ].sort());
});

test('review.mjs status lists the entries dropped from the queue with the session that dropped them', t => {
  const v = makeVault(t, { config: { proposals: 'ask' } });
  const a = started(v);
  const o = offered(v.propose(a, rule()));
  quiet(v, a);
  const sid = sessionId();
  v.startSession(sid, { cwd: v.root });
  const u = `u-${o.id.slice(2)}`;
  assert.equal(v.run('queue.mjs', ['drop', u], { env: { CLAUDE_CODE_SESSION_ID: sid } }).code, 0);
  const r = v.run('review.mjs', ['status']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(sectionOf(r.stdout, 'Review queue entries dropped'), [`- ${u} · glim/tidy-names · dropped ${today()} in session ${sid.slice(0, 8)}`]);
});

test('a Deny whose call record is past pruneCalls age is still not queued while its offer waits', async t => {
  const v = makeVault(t, { config: { proposals: 'ask' } });
  const a = started(v);
  const o = offered(v.propose(a, rule()));
  recordedCall(v, a, { offer: o.id, allow: false, input: { id: o.id, offer: o.text } });
  // The user denied and left without typing again; three days pass before the next session starts.
  const old = new Date(Date.now() - 3 * 864e5);
  for (const dir of [v.at('.state', 'calls'), v.at('.state', 'calls', 'offers')]) {
    for (const name of fs.readdirSync(dir).filter(n => n.endsWith('.json'))) {
      const file = `${dir}/${name}`;
      const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (rec.at) fs.writeFileSync(file, JSON.stringify({ ...rec, at: old.toISOString() }));
      fs.utimesSync(file, old, old);
    }
  }
  quiet(v, a, 72);
  (await v.import('lib/calls.mjs')).pruneCalls();
  started(v);
  assert.deepEqual(queueRows(v), []);
  assert.equal(offerAt(v, o.id).state, 'denied');
  (await v.import('lib/calls.mjs')).pruneCalls();
  assert.deepEqual(fs.readdirSync(v.at('.state', 'calls')).filter(n => n.endsWith('.json')), [], 'a decided offer frees its call record');
  assert.deepEqual(fs.readdirSync(v.at('.state', 'calls', 'offers')), []);
});

test('build leaves queue.md to the holder of queue.lock, and writes it once the lock is free', async t => {
  const v = makeVault(t, { config: { proposals: 'ask' } });
  v.write('queue.md', 'stale\n');
  // A live holder's lock, which goes stale only after 30 s.
  v.write('.state/queue.lock', `${process.pid}:held`, { settled: false });
  const { build } = await v.import('lib/build.mjs');
  const written = build();
  assert.equal(v.read('queue.md'), 'stale\n');
  assert.ok(!written.includes('queue.md'), written.join(', '));
  assert.ok(v.exists('index.md'));
  fs.rmSync(v.at('.state', 'queue.lock'));
  assert.ok(build().includes('queue.md'));
  assert.match(v.read('queue.md'), /^# Review queue/);
});

test("a registry the sweep can't read counts as live, so its session's offers wait, and tidy keeps it", async t => {
  const v = makeVault(t, { config: { proposals: 'ask' } });
  const a = started(v);
  const o = offered(v.propose(a, rule()));
  quiet(v, a);
  v.write(`.state/sessions/${a}.json`, '{"session": "half written');
  started(v);
  assert.deepEqual(queueRows(v), []);
  assert.equal(offerAt(v, o.id).state, 'pending');
  (await v.import('lib/sessions.mjs')).tidy({ full: true });
  assert.ok(v.exists(`.state/sessions/${a}.json`), 'tidy pruned a registry it could not read');
});

test("the sweep's wait for queue.lock is what remains of one deadline, not a second wait", async t => {
  const v = makeVault(t, { config: { proposals: 'ask' } });
  const a = started(v);
  offered(v.propose(a, rule()));
  quiet(v, a);
  v.write('.state/offers.lock', `${process.pid}:held`, { settled: false });
  v.write('.state/queue.lock', `${process.pid}:held`, { settled: false });
  // The sweep blocks this process while it waits, so another one frees offers.lock partway through.
  const free = `setTimeout(() => require('fs').rmSync(${JSON.stringify(v.at('.state', 'offers.lock'))}, { force: true }), 1000)`;
  const child = execFile(process.execPath, ['-e', free]);
  const exited = new Promise(resolve => child.on('exit', resolve));
  const { sweep } = await v.import('lib/queue.mjs');
  const t0 = Date.now();
  assert.throws(() => sweep(sessionId(), { waitMs: 1600 }), { code: 'ELOCKED' });
  const took = Date.now() - t0;
  await exited;
  assert.ok(took < 2200, `the sweep waited ${took} ms`);
  fs.rmSync(v.at('.state', 'queue.lock'));
});

test('a task notification or a message from another session is not a typed message, so an offer before it stays ignored', t => {
  const v = makeVault(t, { config: { proposals: 'ask' } });
  const a = started(v);
  const o = offered(v.propose(a, rule()));
  prompt(v, a, '<task-notification>\n<task-id>b1x2y3z4w</task-id>\n<status>completed</status>\n</task-notification>');
  prompt(v, a, 'Another Claude session sent a message:\n<cross-session-message from="local_1">done</cross-session-message>');
  prompt(v, a, 'Another Claude session sent a message:\n<agent-message from="worker">done</agent-message>');
  assert.equal(registryOf(v, a).last_prompt, undefined);
  quiet(v, a);
  started(v);
  assert.deepEqual(queueRows(v).map(r => [r.from, r.why, r.unattended]), [[o.id, 'ignored', 'left']]);
});

test("queue rows keep the session's agent, so a Codex session is named by its last 8 characters once its registry is gone", t => {
  const v = makeVault(t, { config: { proposals: 'ask', agents: ['claude-code', 'codex'] } });
  const a = started(v);
  const o = offered(v.propose(a, rule()));
  const offer = offerAt(v, o.id);
  assert.equal(offer.agent, 'claude-code');
  // An offer from a Codex session whose registry tidy removed: the entry takes the agent the offer recorded.
  const c = sessionId();
  const cOffer = { ...offer, id: 'o-c0dec0de', session: c, agent: 'codex', key: 'glim/codex-names' };
  v.write(`.state/offers/${cOffer.id}.json`, JSON.stringify(cOffer));
  quiet(v, a);
  const codex = sessionId();
  v.hook('session-start', codexInput('SessionStart', { session_id: codex, cwd: v.root }), { agent: 'codex' });
  const entry = entries(v).find(r => r.from === cOffer.id);
  assert.equal(entry?.agent, 'codex');
  assert.ok(v.exists(`raw/queue/${today()}-${c.slice(-8)}.jsonl`));
  const u = `u-${o.id.slice(2)}`;
  assert.equal(v.run('queue.mjs', ['drop', u, codex], { env: { CODEX_THREAD_ID: codex } }).code, 0);
  const [d] = queueRows(v).filter(r => r.decides);
  assert.equal(d.agent, 'codex');
  assert.ok(v.exists(`raw/queue/${today()}-${codex.slice(-8)}.jsonl`));
  fs.rmSync(v.at('.state', 'sessions', `${codex}.json`));
  const r = v.run('review.mjs', ['status']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(sectionOf(r.stdout, 'Review queue entries dropped'), [`- ${u} · glim/tidy-names · dropped ${today()} in session ${codex.slice(-8)}`]);
});

const ledgerFailure = o => ({
  domain: 'almanac', kind: 'knowledge', topic: 'ledger', basis: 'failure', error: 'TypeError: ledger.shut is not a function', fix: 'Called ledger.close.', file: 'src/ledger.txt',
  slug: 'ledger-shut', do: 'Close a ledger with ledger.close.', not: 'Call ledger.shut.', keywords: ['shutz'], ...o,
});
function queuedEvidence(v, key, fields) {
  v.write('raw/queue/2026-11-01-0badc0de.jsonl', `${JSON.stringify({
    id: 'u-0badc0de', at: '2026-11-01T10:00:00.000Z', kind: 'evidence', why: 'ignored', unattended: 'left', from: 'o-0badc0de',
    session: '0badc0de-0000-4000-8000-000000000001', agent: null, transcript: null, cwd: v.projects.almanac, domain: 'almanac', key,
    fields, text: `**Back this rule again?** ${key}`, quote: null, checked: '2026-11-01',
  })}\n`);
}

test('a queued evidence entry naming a rule by its key from before a move is proposed against the moved note', t => {
  const v = makeVault(t, { presets: ['almanac'] });
  v.write('wiki/global/rules/ledger-close.md', ruleNote({
    domain: 'global', topic: 'code', keywords: ['ledgerz'], doLine: 'Close the ledger zz.', notLine: 'Leave the ledger open.', extra: ['moved_from: almanac/ledger-close'],
  }));
  const sid = sessionId();
  v.startSession(sid, { cwd: v.root });
  queuedEvidence(v, 'almanac/ledger-close', ledgerFailure({ repeats: 'almanac/ledger-close' }));
  const r = v.propose(sid, { queued: 'u-0badc0de' });
  const o = offered(r);
  assert.match(o.text, /global\/ledger-close/);
});

test("a queued evidence entry whose stored checked_with is older than the rule's leaves checked_with where it is", t => {
  const v = makeVault(t, { presets: ['almanac'] });
  v.write('wiki/almanac/rules/ledger-close.md', ruleNote({
    domain: 'almanac', topic: 'ledger', kind: 'knowledge', basis: 'source', applies_to: ['src/**'], doLine: 'Close the ledger zz.', notLine: 'Leave the ledger open.',
    extra: ['as_of: 2026-10-01', 'package: { ecosystem: fixture, name: pkg }', "checked_with: '2.4.0'"],
    evidence: ['- 2026-10-01 · source · session 1a2b3c4d · raw/refs/ledger-guide.md · dated 2026-10-01 · "openLedger takes a path and returns the ledger" (a-00000002)'],
  }));
  const sid = sessionId();
  v.startSession(sid, { cwd: v.root });
  queuedEvidence(v, 'almanac/ledger-close', { ...ledgerFailure({ repeats: 'almanac/ledger-close' }), checked_with: '2.1.0' });
  const o = offered(v.propose(sid, { queued: 'u-0badc0de' }));
  assert.doesNotMatch(o.text, /checked_with would move/, o.text);
});
