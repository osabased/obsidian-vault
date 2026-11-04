import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeVault, sessionId, userTurn, assistantTurn, recordedCall, keepAllowed, offerOf, prompt, cleanEnv } from './fixture.mjs';
import { today } from '../tools/lib/vault.mjs';

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

test('(8) queue.mjs draft refuses basis stated, inferred and pick, and writes a drafted entry for reading', t => {
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
});

test('queue.mjs lists open entries oldest first, marks unattended ones, and later and drop append decision rows', t => {
  const v = makeVault(t, { config: { proposals: 'ask' } });
  const a = started(v);
  const first = offered(v.propose(a, rule()));
  const second = heldId(v.propose(a, rule({ slug: 'other-names', do: 'Prefix widget names with zq.', not: 'Name widgets freely.', hold: true })));
  quiet(v, a);
  const sid = sessionId();
  v.startSession(sid, { cwd: v.root });
  const env = { CLAUDE_CODE_SESSION_ID: sid };
  const list = v.run('queue.mjs', ['list'], { env });
  assert.equal(list.code, 0, list.stderr);
  const lines = list.stdout.trim().split('\n');
  assert.equal(lines.length, 2, list.stdout);
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
  const other = v.propose(b, { queued: u, slug: 'x' });
  assert.equal(other.stderr, "Not proposed: queued takes no other field than asked: the entry's own fields are proposed again.\n");
});
