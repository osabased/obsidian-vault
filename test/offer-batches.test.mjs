import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { today } from '../tools/lib/vault.mjs';
import { makeVault, sessionId, userTurn, assistantTurn, ruleNote, zqEntityPage, recordedCall, keepAllowed, offerOf, cleanEnv } from './fixture.mjs';

// Offers a session makes in a batch, holds, or gets back from the review queue: each is kept as the user agreed to it,
// whatever the session wrote meanwhile, the day it is kept on, or what the sweep made of an offer left waiting.
const typed = said => said.flatMap(s => [userTurn(s), assistantTurn('Noted.')]);
const rule = (o = {}) => ({
  domain: 'glim', slug: 'tidy-names', kind: 'taste', topic: 'code', basis: 'stated', quote: 'call them by their screen',
  do: 'Name widgets after their screen.', not: 'Leave widget names bare.', keywords: ['widgetz'], applies_to: ['src/**/*.zq'], ...o,
});
// On the same topic as rule(), sharing no glob, keyword or many words with it.
const loops = (o = {}) => rule({
  slug: 'short-loops', quote: 'keep loops under ten lines', do: 'Keep each loop body short.', not: 'Write long loop bodies.', keywords: ['loopz'], applies_to: ['lib/**/*.qq'], ...o,
});
const KNOWLEDGE = {
  domain: 'glim', slug: 'zq-parse-flag', kind: 'knowledge', topic: 'code', basis: 'failure',
  error: 'zq: unknown flag --strict', fix: 'pass --mode=strict', file: 'src/build.zq',
  do: 'Pass --mode=strict to zq.', not: 'Pass --strict to zq.', keywords: ['zqflag'], applies_to: ['src/**/*.zq'],
};
// UTC-11 and UTC+14: for most of the day these give two different local days.
const WEST = { TZ: 'Pacific/Pago_Pago' };
const EAST = { TZ: 'Pacific/Kiritimati' };

function started(v, said = ['call them by their screen', 'keep loops under ten lines'], { cwd = v.project } = {}) {
  const sid = sessionId();
  v.startSession(sid, { cwd, transcript: v.transcript(sid, typed(said)) });
  return sid;
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
const offerAt = (v, id) => JSON.parse(v.read(`.state/offers/${id}.json`));
const queueRows = v => (fs.existsSync(v.at('raw', 'queue'))
  ? fs.readdirSync(v.at('raw', 'queue')).flatMap(f => v.read(`raw/queue/${f}`).trim().split('\n').filter(Boolean).map(l => JSON.parse(l)))
  : []);
function quiet(v, sid, hours = 13) {
  const entry = JSON.parse(v.read(`.state/sessions/${sid}.json`));
  v.write(`.state/sessions/${sid}.json`, JSON.stringify({ ...entry, last_seen: new Date(Date.now() - hours * 3600e3).toISOString() }));
}
function setMode(v, mode) {
  const cfg = JSON.parse(v.read('vault.config.json'));
  v.write('vault.config.json', JSON.stringify({ ...cfg, proposals: mode }));
}
// What the server does once the user clicks Allow on a keep the prompt hook recorded earlier.
function allowLater(v, call) {
  const lib = pathToFileURL(v.at('tools', 'lib', 'calls.mjs')).href;
  execFileSync(process.execPath, ['--input-type=module', '-e', `const c = await import(${JSON.stringify(lib)}); c.allowCall(process.argv[1]);`, call], { env: cleanEnv() });
}

test('a keep prompt still open when the sweep marks its offer denied writes the rule once the user allows it', t => {
  const v = makeVault(t, { config: { proposals: 'ask' } });
  const a = started(v);
  const o = offered(v.propose(a, rule()));
  const input = { id: o.id, offer: o.text };
  const call = recordedCall(v, a, { offer: o.id, allow: false, input });
  quiet(v, a);
  started(v);
  assert.equal(offerAt(v, o.id).state, 'denied');
  allowLater(v, call);
  const k = v.run('keep.mjs', [a, call], { input });
  assert.equal(k.code, 0, k.stderr);
  assert.ok(v.exists('wiki/glim/rules/tidy-names.md'));
  assert.equal(offerAt(v, o.id).state, 'kept');
});

test('release writes every held rule on one topic, and keep writes each offer of a batch', t => {
  const v = makeVault(t);
  const a = started(v);
  for (const r of [rule(), loops()]) heldId(v.propose(a, { ...r, hold: true }));
  const rel = v.propose(a, { release: true });
  assert.equal(rel.code, 0, rel.stderr);
  assert.doesNotMatch(rel.stdout, /Not written/);
  assert.ok(v.exists('wiki/glim/rules/tidy-names.md'));
  assert.ok(v.exists('wiki/glim/rules/short-loops.md'));

  const w = makeVault(t, { config: { proposals: 'ask' } });
  const b = started(w);
  const offers = [rule(), loops()].map(r => offered(w.propose(b, r)));
  for (const o of offers) {
    const k = keepAllowed(w, b, o.id, o.text);
    assert.equal(k.code, 0, k.stderr);
  }
  assert.ok(w.exists('wiki/glim/rules/short-loops.md'));
});

test('a rule another session wrote since the offer still makes keep refuse it as a possible repeat', t => {
  const v = makeVault(t, { config: { proposals: 'ask' } });
  const a = started(v);
  const o = offered(v.propose(a, loops()));
  const b = started(v);
  const ob = offered(v.propose(b, rule()));
  assert.equal(keepAllowed(v, b, ob.id, ob.text).code, 0);
  assert.ok(v.exists('wiki/glim/rules/tidy-names.md'));
  const k = keepAllowed(v, a, o.id, o.text);
  assert.match(k.stderr, /may repeat rules already in the vault/);
  assert.equal(v.exists('wiki/glim/rules/short-loops.md'), false);
});

test('two held evidence offers for one rule with different quotes both reach its note at release', t => {
  const v = makeVault(t);
  v.write('wiki/glim/rules/name-widgets.md', ruleNote({ keywords: ['widgetz'], doLine: 'Name widgets after their screen.', notLine: 'Leave widget names bare.' }));
  const a = started(v, ['call them by their screen', 'again, name them for the screen']);
  const first = v.propose(a, rule({ repeats: 'glim/name-widgets', hold: true }));
  heldId(first);
  const second = v.propose(a, rule({ repeats: 'glim/name-widgets', quote: 'again, name them for the screen', hold: true }));
  heldId(second);
  assert.doesNotMatch(second.stdout, /replaces/);
  const rel = v.propose(a, { release: true });
  assert.equal(rel.code, 0, rel.stderr);
  const note = v.read('wiki/glim/rules/name-widgets.md');
  assert.match(note, /"call them by their screen"/);
  assert.match(note, /"again, name them for the screen"/);
});

test("two held evidence offers for one knowledge rule both reach its note, though the first moves its as_of up", t => {
  const v = makeVault(t);
  v.write('wiki/glim/rules/zq-parse-flag.md', ruleNote({
    kind: 'knowledge', basis: 'failure', extra: ['as_of: 2026-01-01'], keywords: ['zqflag'], doLine: 'Pass --mode=strict to zq.', notLine: 'Pass --strict to zq.',
    evidence: ['- 2026-01-01 · failure · session 1a2b3c4d · `zq: unknown flag --strict` → pass --mode=strict (a-00000001)'],
  }));
  const a = started(v, ['fix the parser']);
  heldId(v.propose(a, { ...KNOWLEDGE, repeats: 'glim/zq-parse-flag', hold: true }));
  heldId(v.propose(a, { ...KNOWLEDGE, repeats: 'glim/zq-parse-flag', error: 'zq: unknown flag --strict=on', hold: true }));
  const rel = v.propose(a, { release: true });
  assert.equal(rel.code, 0, rel.stderr);
  assert.doesNotMatch(rel.stdout, /Not written/);
  const note = v.read('wiki/glim/rules/zq-parse-flag.md');
  assert.match(note, /unknown flag --strict=on/);
  assert.match(note, new RegExp(`^as_of: '?${today()}'?$`, 'm'));
});

test('a second held change with one key replaces the first, and its reply names the one it replaced', t => {
  const v = makeVault(t);
  const a = started(v);
  const first = heldId(v.propose(a, rule({ hold: true })));
  const r = v.propose(a, rule({ do: 'Name each widget after its screen.', hold: true }));
  const second = heldId(r);
  assert.equal(r.stdout.trim(), `Held \`${second}\`; nothing is written yet. It replaces \`${first}\`, held for glim/tidy-names: if that one changed anything this one doesn't, hold one change with both. Don't show it now. Release it with the others when the task is done.`);
  assert.equal(offerAt(v, first).state, 'superseded');
});

test('a knowledge rule held one local day and released the next is written with the day it was held', t => {
  const v = makeVault(t);
  const a = started(v, ['fix the parser']);
  const held = offerAt(v, heldId(v.run('propose.mjs', [a], { input: { ...KNOWLEDGE, hold: true }, env: WEST })));
  const rel = v.run('propose.mjs', [a], { input: { release: true }, env: EAST });
  assert.equal(rel.code, 0, rel.stderr);
  assert.doesNotMatch(rel.stdout, /Not written/);
  const note = v.read('wiki/glim/rules/zq-parse-flag.md');
  assert.equal(/^as_of: '?([\d-]+)'?$/m.exec(note)?.[1], held.checked);
  assert.match(note, new RegExp(`^- ${held.checked} · failure`, 'm'));
});

test('a queued knowledge rule keeps the day its entry was checked as as_of and on its Evidence line', t => {
  const v = makeVault(t, { config: { proposals: 'ask' } });
  const a = started(v, ['fix the parser']);
  const o = offered(v.run('propose.mjs', [a], { input: KNOWLEDGE, env: WEST }));
  quiet(v, a);
  const b = started(v, ['something unrelated']);
  const again = offered(v.run('propose.mjs', [b], { input: { queued: `u-${o.id.slice(2)}` }, env: EAST }));
  const input = { id: again.id, offer: again.text };
  const k = v.run('keep.mjs', [b, recordedCall(v, b, { offer: again.id, input })], { input, env: EAST });
  assert.equal(k.code, 0, k.stderr);
  const note = v.read('wiki/glim/rules/zq-parse-flag.md');
  const asOf = /^as_of: '?([\d-]+)'?$/m.exec(note)?.[1];
  assert.match(note, new RegExp(`^- ${asOf} · failure`, 'm'));
  assert.equal(asOf, offerAt(v, o.id).checked);
});

test('a queued rule entry takes repeats and slug, the fields its refusals name, and no other', t => {
  const v = makeVault(t, { config: { proposals: 'ask' } });
  const a = started(v, ['hello']);
  const failed = (o = {}) => rule({ kind: 'knowledge', basis: 'failure', quote: undefined, error: 'zq: unknown flag --strict', fix: 'pass --mode=strict', file: 'src/build.zq', ...o });
  const d = v.run('queue.mjs', ['draft', a], { input: failed() });
  const u = /`(u-[0-9a-f]{8})`/.exec(d.stdout)?.[1];
  assert.ok(u, d.stdout + d.stderr);
  v.write('wiki/glim/rules/screen-names.md', ruleNote({ keywords: ['widgetz'], topic: 'code' }));
  assert.match(v.propose(a, { queued: u }).stderr, /may repeat rules already in the vault/);
  assert.match(v.propose(a, { queued: u, do: 'Other.' }).stderr, /^Not proposed: queued takes no other field than asked, and repeats or slug for a rule entry: the entry's own fields are proposed again\./);
  const o = offered(v.propose(a, { queued: u, repeats: 'glim/screen-names' }));
  assert.match(o.text, /^\*\*Back this rule again\?\*\* glim\/screen-names: /);
  assert.deepEqual(offerAt(v, o.id).fields, { queued: u, repeats: 'glim/screen-names' });
  const k = keepAllowed(v, a, o.id, o.text);
  assert.equal(k.code, 0, k.stderr);
  assert.match(v.read('wiki/glim/rules/screen-names.md'), /zq: unknown flag --strict/);
  assert.ok(queueRows(v).some(r => r.decides === u && r.decision === 'kept'));

  const d2 = v.run('queue.mjs', ['draft', a], { input: failed({ slug: 'other-names', topic: 'layout', error: 'zq: panels overlap', fix: 'use grid layout', file: 'src/panels.zq', do: 'Line panels up on a grid.', not: 'Place panels freely.', keywords: ['panelz'], applies_to: ['x/**'] }) });
  const u2 = /`(u-[0-9a-f]{8})`/.exec(d2.stdout)?.[1];
  const o2 = offered(v.propose(a, { queued: u2, slug: 'screen-widget-names' }));
  assert.match(o2.text, /^\*\*Keep this rule\?\*\* glim\/screen-widget-names: /);
});

test('repeats and slug are refused with a queued page entry', t => {
  const v = makeVault(t, { config: { proposals: 'ask' } });
  const a = started(v, ['hello']);
  const d = v.run('queue.mjs', ['draft', a], { input: { page: 'wiki/glim/entities/zq-lib.md', text: zqEntityPage() } });
  const u = /`(u-[0-9a-f]{8})`/.exec(d.stdout)?.[1];
  assert.ok(u, d.stdout + d.stderr);
  assert.match(v.propose(a, { queued: u, slug: 'zq' }).stderr, new RegExp(`^Not proposed: repeats and slug are for a rule entry, and \`${u}\` is a page entry\\.`));
});

test('a swept domain offer is offered again from the queue, and keep starts the domain and closes the entry', t => {
  const v = makeVault(t, { config: { proposals: 'ask' } });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-domain-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'quill.project'), '');
  const a = started(v, ['yes, start a quill domain'], { cwd: dir });
  const o = offered(v.run('domain.mjs', [a], { input: { name: 'quill', title: 'Quill', topics: ['code'], marker: 'quill.project' } }));
  quiet(v, a);
  const b = started(v, ['walk the queue'], { cwd: v.root });
  const u = `u-${o.id.slice(2)}`;
  const again = offered(v.propose(b, { queued: u }));
  assert.match(again.text, /^\*\*Start this domain\?\*\* quill, "Quill": a project holding quill\.project is in it\. Topics: code\.$/);
  const k = keepAllowed(v, b, again.id, again.text);
  assert.equal(k.code, 0, k.stderr);
  assert.ok(JSON.parse(v.read('vault.local.json')).domains.quill);
  assert.ok(queueRows(v).some(r => r.decides === u && r.decision === 'kept'));
  assert.match(v.propose(b, { queued: u }).stderr, new RegExp(`\`${u}\` was already kept`));
});

test('release under off offers no held change the user never asked for, and that offer cannot be kept', t => {
  const v = makeVault(t, { config: { proposals: 'ask' } });
  const a = started(v, ['call them by their screen', 'keep that one: keep loops under ten lines']);
  const unasked = heldId(v.propose(a, rule({ hold: true })));
  setMode(v, 'off');
  const asked = heldId(v.propose(a, loops({ hold: true, asked: 'keep that one' })));
  const rel = v.propose(a, { release: true });
  assert.equal(rel.code, 0, rel.stderr);
  assert.ok(rel.stdout.includes(`Not offered \`${unasked}\`: proposals is off for glim: propose a rule only when the user asks you to keep one, with their words asking as asked.`), rel.stdout);
  const o = offerOf(rel.stdout.slice(rel.stdout.indexOf('Offered')));
  assert.equal(o?.id, asked, rel.stdout);
  const k = keepAllowed(v, a, unasked, offerAt(v, unasked).text);
  assert.match(k.stderr, /was already tried once\. Propose it again\./);
  assert.equal(v.exists('wiki/glim/rules/tidy-names.md'), false);
});

test('an error that is no refusal while releasing one rule is reported, and the rules already written keep their reply', t => {
  const v = makeVault(t);
  const a = started(v);
  heldId(v.propose(a, rule({ hold: true })));
  const second = heldId(v.propose(a, loops({ topic: 'layout', hold: true })));
  fs.mkdirSync(v.at('wiki', 'glim', 'rules', 'short-loops.md'), { recursive: true });
  const rel = v.propose(a, { release: true });
  assert.equal(rel.code, 0, rel.stderr);
  assert.match(rel.stdout, /^Wrote wiki\/glim\/rules\/tidy-names\.md\./);
  assert.match(rel.stdout, new RegExp(`\n\nNot written \`${second}\`: \\S`));
});

test('release once the sweep queued the held offers names their queue entries', t => {
  const v = makeVault(t);
  const a = started(v);
  const id = heldId(v.propose(a, rule({ hold: true })));
  quiet(v, a);
  started(v);
  assert.equal(offerAt(v, id).state, 'queued');
  const rel = v.propose(a, { release: true });
  assert.equal(rel.code, 0, rel.stderr);
  const u = `u-${id.slice(2)}`;
  assert.equal(rel.stdout.trim(), `Nothing is held in this session: what it held went to the review queue as \`${u}\`. Propose it again with \`queued\` set to its id.`);
});
