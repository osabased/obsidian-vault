import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeVault, sessionId, userTurn, assistantTurn, ruleNote, zqEntityPage as entityPage, recordedCall, keepAllowed, offerOf, lintFound, prompt, pageNote, denied, editVault } from './fixture.mjs';
import { codexInput, codexRollout } from './codex.mjs';

// Outside the vault folder in ask and off, propose.mjs, domain.mjs and proposals.mjs only offer, and keep.mjs writes the
// offer once the user agreed: at the prompt for an agent whose consent is the prompt, by typing the offer's code in
// their next message for one whose consent is a code.
const inboxRows = v => (fs.existsSync(v.at('raw', 'inbox'))
  ? fs.readdirSync(v.at('raw', 'inbox')).flatMap(f => v.read(`raw/inbox/${f}`).trim().split('\n').map(l => JSON.parse(l)))
  : []);
const typed = said => said.flatMap(s => [userTurn(s), assistantTurn('Noted.')]);
const rule = (o = {}) => ({
  domain: 'glim', slug: 'tidy-names', topic: 'code', basis: 'stated', quote: 'call them by their screen',
  do: 'Name widgets after their screen.', not: 'Leave widget names bare.', keywords: ['widgetz'], applies_to: ['src/**/*.zq'], ...o,
});
const QUILL = { name: 'quill', title: 'Quill', topics: ['code'], marker: 'quill.project' };
const keep = (v, sid, call, input) => v.run('keep.mjs', call ? [sid, call] : [sid], { input });

function started(v, said = ['call them by their screen'], { cwd = v.project } = {}) {
  const sid = sessionId();
  v.startSession(sid, { cwd, transcript: said ? v.transcript(sid, typed(said)) : null });
  return sid;
}

function offered(r) {
  assert.equal(r.code, 0, r.stderr);
  const o = offerOf(r.stdout);
  assert.ok(o, r.stdout);
  return o;
}

test('in ask, propose writes nothing and returns an offer naming the rule, where it applies and what to do', t => {
  const v = makeVault(t, { config: { proposals: 'ask' } });
  const sid = started(v);
  const r = v.propose(sid, rule());
  const o = offered(r);
  assert.match(r.stdout, /^Offered `o-[0-9a-f]{8}`; nothing is written yet\. Call the vault's `keep` tool now with id `o-[0-9a-f]{8}` and offer set to the lines below, exactly\. The user allows or denies it at the prompt; a Deny ends this proposal, so don't offer it again unless they ask\.\n\n/);
  assert.equal(o.text, '**Keep this rule?** glim/tidy-names: Do: Name widgets after their screen. Not: Leave widget names bare.\nApplies to src/**/*.zq · keywords: widgetz');
  assert.ok(!v.exists('wiki/glim/rules/tidy-names.md'));
  assert.deepEqual(inboxRows(v), []);
  assert.doesNotMatch(o.text, /Reply "keep/);
});

test('keep with an allowed call writes the rule, and its row records consent at the prompt', t => {
  const v = makeVault(t, { config: { proposals: 'ask' } });
  const sid = started(v);
  const o = offered(v.propose(sid, rule()));
  const k = keepAllowed(v, sid, o.id, o.text);
  assert.equal(k.code, 0, k.stderr);
  assert.match(k.stdout, /^Wrote wiki\/glim\/rules\/tidy-names\.md\./);
  assert.ok(v.exists('wiki/glim/rules/tidy-names.md'));
  const [row] = inboxRows(v);
  assert.equal(row.consent, 'prompt');
  assert.equal(row.approved, undefined);
  assert.equal(JSON.parse(v.read(`.state/offers/${o.id}.json`)).state, 'kept');
});

test('keep refuses edited text, a second keep of the offer, and a run with no allowed call', t => {
  const v = makeVault(t, { config: { proposals: 'ask' } });
  const sid = started(v);
  const o = offered(v.propose(sid, rule()));
  const bare = keep(v, sid, null, { id: o.id, offer: o.text });
  assert.equal(bare.code, 1);
  assert.equal(bare.stderr, "Not kept: keep writes only from the vault's `keep` tool once the user allows it at the prompt; a shell run can't keep this session's offers.\n");
  const edited = keepAllowed(v, sid, o.id, o.text.replace('Name widgets', 'Name all widgets'));
  assert.equal(edited.code, 1);
  assert.equal(edited.stderr, `Not kept: offer isn't the text propose returned for \`${o.id}\`, so the user didn't agree to what keep would write. Propose it again.\n`);
  assert.equal(JSON.parse(v.read(`.state/offers/${o.id}.json`)).state, 'used', 'a keep refused at the prompt for its lines ends the offer');
  assert.ok(!v.exists('wiki/glim/rules/tidy-names.md'));

  const again = offered(v.propose(sid, rule()));
  assert.equal(keepAllowed(v, sid, again.id, again.text).code, 0);
  const twice = keepAllowed(v, sid, again.id, again.text);
  assert.equal(twice.code, 1);
  assert.match(twice.stderr, /^Not kept: keep writes only from the vault's `keep` tool/, 'the hook records no second keep of an offer');
  assert.equal(inboxRows(v).length, 1);
});

test('a Deny leaves the call unallowed, so keep refuses and the same rule proposed again is refused as declined', t => {
  const v = makeVault(t, { config: { proposals: 'ask' } });
  const sid = started(v);
  const o = offered(v.propose(sid, rule()));
  const call = recordedCall(v, sid, { offer: o.id, allow: false });
  const r = keep(v, sid, call, { id: o.id, offer: o.text });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /^Not kept: keep writes only from the vault's `keep` tool once the user allows it/);
  const again = v.propose(sid, rule());
  assert.equal(again.code, 1);
  assert.equal(again.stderr, "Not proposed: the user denied keeping this rule at the prompt in this session. Don't offer it again unless they ask.\n");
  assert.ok(!v.exists('wiki/glim/rules/tidy-names.md'));
});

test('a prompt keep refused for its text spends its call, so a shell rerun of that call with the real text writes nothing', t => {
  const v = makeVault(t, { config: { proposals: 'ask' } });
  const sid = started(v);
  const o = offered(v.propose(sid, rule()));
  const shown = { id: o.id, offer: '**Keep this rule?** glim/tidy-names: Do: use tabs.' };
  const call = recordedCall(v, sid, { offer: o.id, input: shown });
  const first = keep(v, sid, call, shown);
  assert.equal(first.code, 1);
  assert.equal(first.stderr, `Not kept: offer isn't the text propose returned for \`${o.id}\`, so the user didn't agree to what keep would write. Propose it again.\n`);
  const rerun = keep(v, sid, call, { id: o.id, offer: o.text });
  assert.equal(rerun.code, 1, rerun.stdout);
  assert.equal(rerun.stderr, "Not kept: keep writes only from the vault's `keep` tool once the user allows it at the prompt; a shell run can't keep this session's offers.\n");
  assert.ok(!v.exists('wiki/glim/rules/tidy-names.md'));
  assert.deepEqual(inboxRows(v), []);
});

test('another session can\'t keep an offer, and an unknown offer is refused', t => {
  const v = makeVault(t, { config: { proposals: 'ask' } });
  const sid = started(v);
  const o = offered(v.propose(sid, rule()));
  const other = started(v);
  assert.match(keepAllowed(v, other, o.id, o.text).stderr, /^Not kept: there's no offer `o-[0-9a-f]{8}` in this session\./);
  assert.match(keepAllowed(v, sid, 'o-00000000', o.text).stderr, /^Not kept: there's no offer `o-00000000` in this session\./);
  const extra = { id: 'o-11111111', offer: 'x', approved: 'yes' };
  assert.match(keep(v, sid, recordedCall(v, sid, { offer: extra.id, input: extra }), extra).stderr, /^Not kept: approved isn't a field keep\.mjs takes\./);
});

test('keep refuses input other than the call the user allowed, and that call is spent', t => {
  const v = makeVault(t, { config: { proposals: 'ask' } });
  const sid = started(v);
  const o = offered(v.propose(sid, rule()));
  const shown = { id: o.id, offer: o.text };
  const call = recordedCall(v, sid, { offer: o.id, input: shown });
  const r = keep(v, sid, call, { id: o.id, offer: o.text.replace('Name widgets', 'Name all widgets') });
  assert.equal(r.code, 1);
  assert.equal(r.stderr, "Not kept: keep writes only from the vault's `keep` tool once the user allows it at the prompt; a shell run can't keep this session's offers.\n");
  assert.ok(!v.exists('wiki/glim/rules/tidy-names.md'));
  assert.equal(JSON.parse(v.read(`.state/offers/${o.id}.json`)).state, 'pending');
  assert.ok(JSON.parse(v.read(`.state/calls/${call}.json`)).used);
  const k = keep(v, sid, call, { offer: o.text, id: o.id });
  assert.equal(k.code, 1);
  assert.ok(!v.exists('wiki/glim/rules/tidy-names.md'));
});

test('a prompt keep refused past its call leaves the call used', t => {
  const v = makeVault(t, { config: { proposals: 'ask' } });
  const sid = started(v);
  const input = { id: 'o-00000000', offer: 'anything' };
  const call = recordedCall(v, sid, { offer: input.id, input });
  assert.match(keep(v, sid, call, input).stderr, /^Not kept: there's no offer `o-00000000` in this session\./);
  assert.ok(JSON.parse(v.read(`.state/calls/${call}.json`)).used);
  assert.match(keep(v, sid, call, input).stderr, /^Not kept: keep writes only from the vault's `keep` tool/);
});

test('a rule written since the offer makes keep refuse, with the offer used', t => {
  const v = makeVault(t, { config: { proposals: 'ask' } });
  const sid = started(v);
  const o = offered(v.propose(sid, rule()));
  v.write('wiki/glim/rules/tidy-names.md', ruleNote({ keywords: ['other'] }));
  const r = keepAllowed(v, sid, o.id, o.text);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /^Not kept: wiki\/glim\/rules\/tidy-names\.md already exists\./);
  assert.equal(inboxRows(v).length, 0);
  assert.notEqual(JSON.parse(v.read(`.state/offers/${o.id}.json`)).state, 'pending');
});

test('evidence through repeats is offered and kept the same way', t => {
  const v = makeVault(t, { config: { proposals: 'ask' } });
  v.write('wiki/glim/rules/name-widgets.md', ruleNote({ keywords: ['widgetz'], doLine: 'Name widgets after their screen.', notLine: 'Leave widget names bare.' }));
  const before = v.read('wiki/glim/rules/name-widgets.md');
  const sid = started(v);
  const o = offered(v.propose(sid, rule({ repeats: 'glim/name-widgets' })));
  assert.equal(o.text, '**Back this rule again?** glim/name-widgets: Do: Name widgets after their screen. Not: Leave widget names bare.\nIts note would get this Evidence: "call them by their screen".');
  assert.equal(v.read('wiki/glim/rules/name-widgets.md'), before);
  const k = keepAllowed(v, sid, o.id, o.text);
  assert.equal(k.code, 0, k.stderr);
  assert.match(v.read('wiki/glim/rules/name-widgets.md'), /"call them by their screen"/);
  assert.equal(inboxRows(v)[0].consent, 'prompt');
});

test('in off, propose needs the user\'s words asking as asked, then offers', t => {
  const v = makeVault(t, { config: { proposals: 'off' } });
  const sid = started(v, ['call them by their screen', 'make a rule of that']);
  const no = v.propose(sid, rule());
  assert.equal(no.code, 1);
  assert.equal(no.stderr, 'Not proposed: proposals is off for glim: propose a rule only when the user asks you to keep one, with their words asking as asked.\n');
  assert.match(v.propose(sid, rule({ asked: 'keep that please' })).stderr, /^Not proposed: asked isn't in the user's latest message\./);
  const o = offered(v.propose(sid, rule({ asked: 'make a rule of that' })));
  assert.equal(keepAllowed(v, sid, o.id, o.text).code, 0);
  assert.ok(v.exists('wiki/glim/rules/tidy-names.md'));
});

test('a later offer of the same rule supersedes the earlier one', t => {
  const v = makeVault(t, { config: { proposals: 'ask' } });
  const sid = started(v);
  const first = offered(v.propose(sid, rule()));
  const second = offered(v.propose(sid, rule({ do: 'Name each widget after its screen.' })));
  assert.match(keepAllowed(v, sid, first.id, first.text).stderr, /^Not kept: offer `o-[0-9a-f]{8}` was replaced by a later offer of the same rule\./);
  assert.equal(keepAllowed(v, sid, second.id, second.text).code, 0);
});

test('a new domain is offered in every mode, the vault folder too, and written only through keep', t => {
  const v = makeVault(t);
  const dir = fs.mkdtempSync(`${v.root}-quill-`);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(`${dir}/quill.project`, '');
  const before = v.read('vault.config.json');
  const sid = started(v, null, { cwd: dir });
  const r = v.run('domain.mjs', [sid], { input: QUILL });
  const o = offered(r);
  assert.match(o.text, /^\*\*Start this domain\?\*\* quill, "Quill": a project holding quill\.project is in it, such as .+\. Topics: code\.$/);
  assert.equal(v.read('vault.config.json'), before);
  const k = keepAllowed(v, sid, o.id, o.text);
  assert.equal(k.code, 0, k.stderr);
  assert.match(k.stdout, /^Added quill to vault\.config\.json\./);
  assert.ok(JSON.parse(v.read('vault.config.json')).domains.quill);

  const home = started(v, null, { cwd: v.root });
  const pages = offered(v.run('domain.mjs', [home], { input: { ...QUILL, name: 'brook', title: 'Brook', marker: undefined, vaultOnly: true } }));
  assert.equal(pages.text, '**Start this domain?** brook, "Brook": it holds pages only. Topics: code.');
  assert.equal(JSON.parse(v.read('vault.config.json')).domains.brook, undefined);
  assert.equal(keepAllowed(v, home, pages.id, pages.text).code, 0);
  assert.equal(JSON.parse(v.read('vault.config.json')).domains.brook.vaultOnly, true);
});

test('proposals sets the mode only with an allowed call for it', t => {
  const v = makeVault(t, { config: { proposals: 'ask' } });
  const sid = started(v, null);
  const before = v.read('vault.config.json');
  const bare = v.run('proposals.mjs', [sid], { input: { mode: 'off' } });
  assert.equal(bare.code, 1);
  assert.equal(bare.stderr, "Not set: proposals changes the mode only from the vault's `proposals` tool, once the user allows it at the prompt.\n");
  const denied = v.run('proposals.mjs', [sid, recordedCall(v, sid, { tool: 'proposals', allow: false })], { input: { mode: 'off' } });
  assert.equal(denied.code, 1);
  const wrongTool = v.run('proposals.mjs', [sid, recordedCall(v, sid, { tool: 'keep' })], { input: { mode: 'off' } });
  assert.equal(wrongTool.code, 1);
  assert.equal(v.read('vault.config.json'), before);
  const call = recordedCall(v, sid, { tool: 'proposals', input: { mode: 'off' } });
  const r = v.run('proposals.mjs', [sid, call], { input: { mode: 'off' } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(v.read('vault.config.json')).proposals, 'off');
  assert.equal(v.run('proposals.mjs', [sid, call], { input: { mode: 'ask' } }).code, 1, 'a call is used once');
});

// Codex: the user agrees by typing the offer's code in the message right after the reply that showed it.
let codexSessions = 0;
const codexVault = (t, mode = 'ask') => makeVault(t, { config: { agents: ['claude-code', 'codex'], proposals: mode } });
function codexStarted(v, said = ['call them by their screen'], { cwd = v.project } = {}) {
  const sid = `019a0fb1-cccc-7000-8000-${String(++codexSessions).padStart(12, '0')}`;
  const file = codexRollout(v, sid, said);
  v.hook('session-start', codexInput('SessionStart', { session_id: sid, cwd, transcript_path: file }), { agent: 'codex' });
  return { sid, said: messages => codexRollout(v, sid, messages) };
}
const codeOf = text => /Reply "keep ([A-Z2-9]{4})" to keep it, or say how to word it otherwise\.$/.exec(text)?.[1];
const agentSays = text => ({ role: 'assistant', kinds: null, text });

test('Codex: an offer carries a code and says to end the reply with it, and a keep in the same turn is refused', t => {
  const v = codexVault(t);
  const s = codexStarted(v);
  const r = v.propose(s.sid, rule());
  const o = offered(r);
  assert.match(r.stdout, /^Offered `(o-[0-9a-f]{8})`; nothing is written yet\. End your reply with the lines below as they are\. If the user's next message has the code, call `keep` with id `\1` and offer set to these lines\.\n\n/);
  assert.ok(codeOf(o.text), o.text);
  assert.match(o.text, /^\*\*Keep this rule\?\*\* glim\/tidy-names: /);
  const k = keep(v, s.sid, null, { id: o.id, offer: o.text });
  assert.equal(k.code, 1);
  assert.equal(k.stderr, "Not kept: the user hasn't replied since the offer. End your reply with it and wait.\n");
  assert.ok(!v.exists('wiki/glim/rules/tidy-names.md'));
});

test('Codex: the next message with the code writes the rule, and the row keeps that reply as approved', t => {
  const v = codexVault(t);
  const s = codexStarted(v);
  const o = offered(v.propose(s.sid, rule()));
  const reply = `ok ${codeOf(o.text).toLowerCase()}`;
  s.said(['call them by their screen', agentSays(`Here it is.\n\n${o.text}`), reply]);
  const k = keep(v, s.sid, null, { id: o.id, offer: o.text });
  assert.equal(k.code, 0, k.stderr);
  const [row] = inboxRows(v);
  assert.equal(row.consent, 'code');
  assert.equal(row.approved, reply);
});

test('Codex: a reply without the code, after a reply without the offer, or two messages later is refused', t => {
  const v = codexVault(t);
  const s = codexStarted(v);
  const o = offered(v.propose(s.sid, rule()));
  const code = codeOf(o.text);
  const tries = [
    [['call them by their screen', agentSays(o.text), 'yes keep it'], "Not kept: the user's reply after the offer doesn't have its code, so they didn't agree. Don't keep it.\n"],
    [['call them by their screen', agentSays('Something else.'), `yes ${code}`], "Not kept: your reply before the user's didn't show the offer's lines, so they didn't see what they'd agree to. Propose it again.\n"],
    [['call them by their screen', agentSays(o.text), 'hm', `yes ${code}`], /^Not kept: /],
    [['call them by their screen', agentSays(o.text), `yes ${code}x`], /doesn't have its code/],
  ];
  for (const [messages, why] of tries) {
    s.said(messages);
    const k = keep(v, s.sid, null, { id: o.id, offer: o.text });
    assert.equal(k.code, 1, JSON.stringify(messages));
    if (typeof why === 'string') assert.equal(k.stderr, why);
    else assert.match(k.stderr, why);
  }
  assert.ok(!v.exists('wiki/glim/rules/tidy-names.md'));
});

test('Codex: an offer held, three typed messages, released, then one message with its code is kept', t => {
  const v = codexVault(t);
  const s = codexStarted(v);
  const held = v.propose(s.sid, rule({ hold: true }));
  assert.equal(held.code, 0, held.stderr);
  const id = /^Held `(o-[0-9a-f]{8})`/.exec(held.stdout)?.[1];
  assert.ok(id, held.stdout);
  const before = ['call them by their screen', agentSays('On it.'), 'also fix the header', agentSays('Done.'), 'and the footer', agentSays('Done.'), 'thanks'];
  s.said(before);
  const rel = v.propose(s.sid, { release: true });
  assert.equal(rel.code, 0, rel.stderr);
  const o = offerOf(rel.stdout);
  assert.equal(o?.id, id, rel.stdout);
  assert.match(rel.stdout, /^Offered `o-[0-9a-f]{8}`; nothing is written yet\. End your reply with the lines below as they are\./);
  s.said([...before, agentSays(`All done.

${o.text}`), `keep ${codeOf(o.text)}`]);
  const k = keep(v, s.sid, null, { id, offer: o.text });
  assert.equal(k.code, 0, k.stderr);
  assert.ok(v.exists('wiki/glim/rules/tidy-names.md'));
});

test('Codex: proposals and domain go offer then code', t => {
  const v = codexVault(t);
  const s = codexStarted(v, ['switch rules to off']);
  const m = offered(v.run('proposals.mjs', [s.sid], { input: { mode: 'off' } }));
  assert.match(m.text, /^\*\*Set proposals\?\*\* off: agents propose a rule only when you ask for one\.\nReply "keep [A-Z2-9]{4}" to keep it, or say how to word it otherwise\.$/);
  assert.equal(JSON.parse(v.read('vault.config.json')).proposals, 'ask');
  s.said(['switch rules to off', agentSays(m.text), codeOf(m.text)]);
  assert.equal(keep(v, s.sid, null, { id: m.id, offer: m.text }).code, 0);
  assert.equal(JSON.parse(v.read('vault.config.json')).proposals, 'off');

  const dir = fs.mkdtempSync(`${v.root}-quill-`);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(`${dir}/quill.project`, '');
  const d = codexStarted(v, ['start a quill domain'], { cwd: dir });
  const o = offered(v.run('domain.mjs', [d.sid], { input: QUILL }));
  d.said(['start a quill domain', agentSays(o.text), `go ${codeOf(o.text)}`]);
  const k = keep(v, d.sid, null, { id: o.id, offer: o.text });
  assert.equal(k.code, 0, k.stderr);
  assert.ok(JSON.parse(v.read('vault.config.json')).domains.quill);
});

test('Codex: lines that are not the offer leave it pending, so a keep with the right lines then writes it', t => {
  const v = codexVault(t);
  const s = codexStarted(v);
  const o = offered(v.propose(s.sid, rule()));
  s.said(['call them by their screen', agentSays(o.text), `keep ${codeOf(o.text)}`]);
  const wrong = keep(v, s.sid, null, { id: o.id, offer: o.text.replace('Name widgets', 'Name all widgets') });
  assert.equal(wrong.stderr, `Not kept: offer isn't the text propose returned for \`${o.id}\`. Pass its lines exactly.\n`);
  const k = keep(v, s.sid, null, { id: o.id, offer: o.text });
  assert.equal(k.code, 0, k.stderr);
  assert.ok(v.exists('wiki/glim/rules/tidy-names.md'));
  assert.match(keep(v, s.sid, null, { id: o.id, offer: o.text }).stderr, /^Not kept: offer `o-[0-9a-f]{8}` was already kept\./);
});

test('Codex: a keep of an offer the user denied says so, and writes nothing', t => {
  const v = codexVault(t);
  const s = codexStarted(v);
  const o = offered(v.propose(s.sid, rule()));
  s.said(['call them by their screen', agentSays(o.text), `keep ${codeOf(o.text)}`]);
  const file = `.state/offers/${o.id}.json`;
  v.write(file, JSON.stringify({ ...JSON.parse(v.read(file)), state: 'denied' }));
  const k = keep(v, s.sid, null, { id: o.id, offer: o.text });
  assert.equal(k.code, 1);
  assert.equal(k.stderr, `Not kept: the user denied keeping offer \`${o.id}\` at the prompt in this session. Don't offer it again unless they ask.\n`);
  assert.ok(!v.exists('wiki/glim/rules/tidy-names.md'));
});

test('Codex: every code is four characters with at least one digit', async t => {
  const v = codexVault(t);
  const { makeOffer } = await v.import('lib/offers.mjs');
  for (let i = 0; i < 80; i++) {
    const { code } = makeOffer({ kind: 'rule', sid: 'codes', entry: { agent: 'codex' }, key: `k${i}`, fields: {}, lines: ['x'] });
    assert.match(code, /^[A-HJKMNP-Z2-9]{4}$/);
    assert.match(code, /[2-9]/);
  }
});

const ENTITY_REL = 'wiki/glim/entities/zq-lib.md';

test('propose with page and text offers a page change, and keep writes the page and its log line', t => {
  const v = makeVault(t, { config: { proposals: 'ask' } });
  const sid = started(v);
  const o = offered(v.propose(sid, { page: ENTITY_REL, text: entityPage() }));
  assert.match(o.text, /^\*\*Keep this page change\?\*\* wiki\/glim\/entities\/zq-lib\.md · new\n/);
  assert.match(o.text, /Zq-lib parses screens\./);
  assert.ok(!v.exists(ENTITY_REL));
  const k = keepAllowed(v, sid, o.id, o.text);
  assert.equal(k.code, 0, k.stderr);
  assert.equal(v.read(ENTITY_REL).replace(/\r\n/g, '\n'), entityPage());
  assert.match(v.read('log.md'), /wrote page glim\/zq-lib · session /);
  assert.match(v.read('index.md'), /\[\[wiki\/glim\/entities\/zq-lib\|zq-lib\]\]/);
});

test('a page change offers a diff, and keep refuses once the page changed since the offer', t => {
  const v = makeVault(t, { config: { proposals: 'ask' } });
  v.write(ENTITY_REL, entityPage());
  const sid = started(v);
  const o = offered(v.propose(sid, { page: ENTITY_REL, text: entityPage('Zq-lib parses screens and themes.') }));
  assert.match(o.text, /^\*\*Keep this page change\?\*\* wiki\/glim\/entities\/zq-lib\.md · change\n/);
  assert.match(o.text, /^-Zq-lib parses screens\.$/m);
  assert.match(o.text, /^\+Zq-lib parses screens and themes\.$/m);
  v.write(ENTITY_REL, entityPage('The user rewrote this.'));
  const k = keepAllowed(v, sid, o.id, o.text);
  assert.equal(k.code, 1);
  assert.match(k.stderr, /^Not kept: wiki\/glim\/entities\/zq-lib\.md changed since the offer/);
  assert.match(v.read(ENTITY_REL), /The user rewrote this\./);
});

test('a page change keeps the line endings of the page it changes', t => {
  const v = makeVault(t, { config: { proposals: 'ask' } });
  v.write(ENTITY_REL, entityPage().replace(/\n/g, '\r\n'));
  const sid = started(v);
  const o = offered(v.propose(sid, { page: ENTITY_REL, text: entityPage('Zq-lib parses screens and themes.') }));
  assert.doesNotMatch(o.text, /\r/);
  assert.equal(keepAllowed(v, sid, o.id, o.text).code, 0);
  assert.equal(v.read(ENTITY_REL), entityPage('Zq-lib parses screens and themes.').replace(/\n/g, '\r\n'));
});

test('a page change keeps the byte order mark of the page it changes', t => {
  const v = makeVault(t, { config: { proposals: 'ask' } });
  v.write(ENTITY_REL, `\uFEFF${entityPage()}`);
  const sid = started(v);
  const o = offered(v.propose(sid, { page: ENTITY_REL, text: entityPage('Zq-lib parses screens and themes.') }));
  assert.equal(keepAllowed(v, sid, o.id, o.text).code, 0);
  assert.equal(v.read(ENTITY_REL), `\uFEFF${entityPage('Zq-lib parses screens and themes.')}`);
});

const opened = (text, value = 'true') => text.replace('updated: 2026-10-01\n', `updated: 2026-10-01\nopen: ${value}\n`);
const OPENS = ' · opens it: agents may then write this page without asking';

test('a page offer that adds open: true names the opening in its head line, to a new page and to an existing one, and keep writes it', t => {
  const v = makeVault(t, { config: { proposals: 'ask' } });
  const sid = started(v);
  const o = offered(v.propose(sid, { page: ENTITY_REL, text: opened(entityPage()) }));
  assert.ok(o.text.startsWith(`**Keep this page change?** ${ENTITY_REL} · new${OPENS}\n`), o.text);
  assert.equal(keepAllowed(v, sid, o.id, o.text).code, 0);
  assert.equal(v.read(ENTITY_REL).replace(/\r\n/g, '\n'), opened(entityPage()));
  const other = 'wiki/glim/entities/zq-other.md';
  v.write(other, entityPage());
  const c = offered(v.propose(sid, { page: other, text: opened(entityPage()) }));
  assert.ok(c.text.startsWith(`**Keep this page change?** ${other} · change${OPENS}\n`), c.text);
  assert.equal(keepAllowed(v, sid, c.id, c.text).code, 0);
  assert.equal(v.read(other).replace(/\r\n/g, '\n'), opened(entityPage()));
});

test('a page offer names no opening when the page is open already or the text sets open: false', t => {
  const v = makeVault(t, { config: { proposals: 'ask' } });
  v.write(ENTITY_REL, opened(entityPage()));
  const sid = started(v);
  const o = offered(v.propose(sid, { page: ENTITY_REL, text: opened(entityPage('Zq-lib parses screens and themes.')) }));
  assert.ok(o.text.startsWith(`**Keep this page change?** ${ENTITY_REL} · change\n`), o.text);
  const shut = 'wiki/glim/entities/zq-shut.md';
  const f = offered(v.propose(sid, { page: shut, text: opened(entityPage(), 'false') }));
  assert.ok(f.text.startsWith(`**Keep this page change?** ${shut} · new\n`), f.text);
});

test('a held page offer that opens a page names the opening when released', t => {
  const v = makeVault(t);
  const sid = started(v);
  v.propose(sid, { page: ENTITY_REL, text: opened(entityPage()), hold: true });
  const out = v.propose(sid, { release: true });
  assert.equal(out.code, 0, out.stderr);
  const o = offerOf(out.stdout.slice(out.stdout.indexOf('Offered')));
  assert.ok(o.text.startsWith(`**Keep this page change?** ${ENTITY_REL} · new${OPENS}\n`), o.text);
});

test('an agent writing an open page directly makes an offer on that page made before it stale', t => {
  const v = makeVault(t, { config: { proposals: 'ask' } });
  v.write(ENTITY_REL, opened(entityPage()));
  const sid = started(v);
  const o = offered(v.propose(sid, { page: ENTITY_REL, text: entityPage() }));
  const free = { old_string: 'Zq-lib parses screens.', new_string: 'Zq-lib parses screens and themes.' };
  assert.equal(denied(editVault(v, sid, ENTITY_REL, 'Edit', free, v.project)), null, 'the free write is allowed');
  v.write(ENTITY_REL, opened(entityPage('Zq-lib parses screens and themes.')));
  const k = keepAllowed(v, sid, o.id, o.text);
  assert.equal(k.code, 1);
  assert.match(k.stderr, /^Not kept: wiki\/glim\/entities\/zq-lib\.md changed since the offer/);
  assert.match(v.read(ENTITY_REL), /^open: true$/m);
});

test("propose's text field says a text that adds open: true asks the user to open the page", t => {
  const v = makeVault(t);
  const s = JSON.parse(v.run('propose.mjs', ['--schema']).stdout);
  assert.match(s.inputSchema.properties.text.description, /A text that adds open: true asks the user to let agents write that page directly\.?$/);
});

const WHERE = 'Not proposed: page must be a page under wiki/, like wiki/<domain>/<folder>/<slug>.md.\n';

test('a page path with a backslash or a . or .. segment is refused, so nothing is written outside wiki/<domain>/', t => {
  const v = makeVault(t, { config: { proposals: 'ask' } });
  const sid = started(v);
  for (const page of ['wiki/glim/..\\..\\tools/evil.md', 'wiki/glim/entities\\..\\..\\..\\evil.md', 'wiki/glim/../glim/evil.md', 'wiki/glim/./evil.md']) {
    const r = v.propose(sid, { page, text: entityPage() });
    assert.equal(r.code, 1, `${page}: ${r.stdout}`);
    assert.equal(r.stderr, WHERE, page);
  }
  assert.ok(!v.exists('tools/evil.md'));
  assert.ok(!fs.existsSync(v.at('..', 'evil.md')));
});

test("a page change is refused when another note already has the page's key", t => {
  const v = makeVault(t, { config: { proposals: 'ask' } });
  v.write('wiki/glim/rules/zq-lib.md', ruleNote({ keywords: ['zq'] }));
  const sid = started(v);
  const r = v.propose(sid, { page: ENTITY_REL, text: entityPage() });
  assert.equal(r.code, 1, r.stdout);
  assert.equal(r.stderr, 'Not proposed: wiki/glim/rules/zq-lib.md already exists. Pick another slug, or leave that note to the user.\n');
  assert.ok(!v.exists(ENTITY_REL));
});

test('a page change is refused when a line it adds ends in white space, which the offer would not show', t => {
  const v = makeVault(t, { config: { proposals: 'ask' } });
  const sid = started(v);
  const fresh = v.propose(sid, { page: ENTITY_REL, text: entityPage('Zq-lib parses screens.  ') });
  assert.equal(fresh.code, 1, fresh.stdout);
  assert.equal(fresh.stderr, "Not proposed: line 12 of text ends in white space, which the offer can't show. Take it off, then propose again.\n");
  v.write(ENTITY_REL, entityPage('Zq-lib parses screens.  ').replace('created:', 'author: user\ncreated:'));
  const notes = entityPage('Zq-lib parses screens.  ').replace('created:', 'author: user\ncreated:').replace(/\n$/, '\n\n## Agent notes\n\nIt parses themes too.\n');
  const o = offered(v.propose(sid, { page: ENTITY_REL, text: notes }));
  assert.equal(keepAllowed(v, sid, o.id, o.text).code, 0);
  assert.equal(v.read(ENTITY_REL), notes, "the user's own trailing white space stays as it was");
});

test('a changed page whose diff must pass pages.maxOfferChars is refused before the diff is built', t => {
  const v = makeVault(t, { config: { proposals: 'ask', pages: { maxOfferChars: 600 } } });
  v.write(ENTITY_REL, entityPage());
  const sid = started(v);
  const r = v.propose(sid, { page: ENTITY_REL, text: entityPage(Array.from({ length: 40 }, (_, i) => `Reading line ${i}.`).join('\n')) });
  assert.equal(r.code, 1, r.stdout);
  assert.match(r.stderr, /^Not proposed: the offer for wiki\/glim\/entities\/zq-lib\.md comes to at least \d+ characters, over pages\.maxOfferChars \(600\)\. Split the change/);
});

test('a page change is refused when it would be a rule, has a note error, or its lines pass pages.maxOfferChars', t => {
  const v = makeVault(t, { config: { proposals: 'ask', pages: { maxOfferChars: 600 } } });
  const sid = started(v);
  assert.match(v.propose(sid, { page: ENTITY_REL, text: ruleNote() }).stderr, /^Not proposed: .*rule/);
  assert.match(v.propose(sid, { page: 'notes/x.md', text: entityPage() }).stderr, /^Not proposed: page must be a page under wiki\//);
  const long = v.propose(sid, { page: ENTITY_REL, text: entityPage('A long reading. '.repeat(60)) });
  assert.equal(long.code, 1);
  assert.match(long.stderr, /pages\.maxOfferChars/);
  assert.ok(!v.exists(ENTITY_REL));
});

test('a page change is refused for the links lint reports: one by key, a slug two notes share, and one to no note', t => {
  const v = makeVault(t, { config: { proposals: 'ask' } });
  v.write('wiki/glim/rules/the-thing.md', ruleNote({ keywords: ['thing'] }));
  v.write('wiki/glim/rules/twin.md', ruleNote({ keywords: ['twin'] }));
  v.write('wiki/global/rules/twin.md', ruleNote({ domain: 'global', keywords: ['twin'] }));
  const sid = started(v);
  const refused = link => v.propose(sid, { page: ENTITY_REL, text: entityPage(`Zq-lib parses screens, as ${link} says.`) });
  const byKey = refused('[[glim/the-thing]]');
  assert.equal(byKey.code, 1, byKey.stdout);
  assert.equal(byKey.stderr, 'Not proposed: wiki/glim/entities/zq-lib.md links [[glim/the-thing]], a note at wiki/glim/rules/the-thing.md. Link it by that path, as [[wiki/glim/rules/the-thing|the-thing]].\n');
  assert.equal(refused('[[twin]]').stderr, 'Not proposed: wiki/glim/entities/zq-lib.md links [[twin]], which names more than one note. Write its path from the vault root: [[wiki/glim/rules/twin]] or [[wiki/global/rules/twin]].\n');
  assert.equal(refused('[[wiki/glim/rules/no-such-rule|no-such-rule]]').stderr, 'Not proposed: wiki/glim/entities/zq-lib.md links [[wiki/glim/rules/no-such-rule]], which has no note.\n');
  assert.ok(!v.exists(ENTITY_REL));
  offered(refused('[[wiki/glim/rules/the-thing|the-thing]]'));
});

test("a page change may link a note this session holds an offer for, and isn't refused for a link the page already had", t => {
  const v = makeVault(t, { config: { proposals: 'ask' } });
  v.write(ENTITY_REL, entityPage('Zq-lib parses screens, as [[glim/old-rule]] said.'));
  const sid = started(v);
  assert.match(v.propose(sid, { ...rule(), hold: true }).stdout, /^Held `o-[0-9a-f]{8}`/);
  const rules = '## Rules\n- [[wiki/glim/rules/tidy-names|tidy-names]]';
  const text = entityPage(`Zq-lib parses screens, as [[glim/old-rule]] said.\n\n${rules}`);
  assert.match(v.propose(sid, { page: ENTITY_REL, text, hold: true }).stdout, /^Held `o-[0-9a-f]{8}`/);
  const out = v.propose(sid, { release: true });
  assert.equal(out.code, 0, out.stderr);
  const [, page] = out.stdout.split(/\n\n(?=Offered)/).map(offerOf).filter(Boolean);
  const other = started(v);
  const elsewhere = v.propose(other, { page: 'wiki/glim/entities/zq-kit.md', text: entityPage(`Zq-kit wraps zq-lib.\n\n${rules}`) });
  assert.equal(elsewhere.stderr, 'Not proposed: wiki/glim/entities/zq-kit.md links [[wiki/glim/rules/tidy-names]], which has no note.\n', "another session's offer isn't this one's");
  const k = keepAllowed(v, sid, page.id, page.text);
  assert.equal(k.code, 0, k.stderr);
  assert.equal(v.read(ENTITY_REL), text);
});

test("a link already in a user's page doesn't stop an Agent notes line, but one the line adds is refused", t => {
  const v = makeVault(t, { config: { proposals: 'ask' } });
  const page = entityPage('Zq-lib parses screens, as [[glim/old-rule]] said.').replace('created:', 'author: user\ncreated:');
  v.write(ENTITY_REL, page);
  const sid = started(v);
  const notes = line => page.replace(/\n$/, `\n\n## Agent notes\n\n${line}\n`);
  offered(v.propose(sid, { page: ENTITY_REL, text: notes('It parses themes too.') }));
  assert.equal(v.propose(sid, { page: ENTITY_REL, text: notes('See [[glim/gone]].') }).stderr, 'Not proposed: wiki/glim/entities/zq-lib.md links [[glim/gone]], which has no note.\n');
});

test('a page change is an offer under corrections and held until release', t => {
  const v = makeVault(t);
  const sid = started(v);
  const held = v.propose(sid, { page: ENTITY_REL, text: entityPage(), hold: true });
  assert.match(held.stdout, /^Held `o-[0-9a-f]{8}`/);
  const out = v.propose(sid, { release: true });
  assert.equal(out.code, 0, out.stderr);
  const o = offerOf(out.stdout.slice(out.stdout.indexOf('Offered')));
  assert.ok(o, out.stdout);
  assert.ok(!v.exists(ENTITY_REL));
});

const OLD_RULE = 'wiki/glim/rules/the-thing.md';
const reword = (o = {}) => ({ change: 'reword', key: 'glim/the-thing', do: 'Do the thing twice.', basis: 'stated', quote: 'call them by their screen', ...o });

test('a reword offer shows the old and new text, and once kept changes the Do line and adds an Evidence line', async t => {
  const v = makeVault(t, { config: { proposals: 'ask' } });
  v.write(OLD_RULE, ruleNote({ keywords: ['thing'] }));
  const sid = started(v);
  const o = offered(v.propose(sid, reword()));
  assert.match(o.text, /^\*\*Change this rule\?\*\* glim\/the-thing\n/);
  assert.match(o.text, /Do the thing\./);
  assert.match(o.text, /Do the thing twice\./);
  assert.match(v.read(OLD_RULE), /\*\*Do:\*\* Do the thing\.\r?\n/);
  const k = keepAllowed(v, sid, o.id, o.text);
  assert.equal(k.code, 0, k.stderr);
  const after = v.read(OLD_RULE);
  assert.match(after, /\*\*Do:\*\* Do the thing twice\.\r?\n/);
  assert.match(after, /\*\*Not:\*\* Skip the thing\.\r?\n/);
  assert.match(after, /"do the thing" \(a-00000001\)/);
  assert.match(after, /· stated · session [0-9a-f]{8} · "call them by their screen" \(a-[0-9a-f]{8}\)/);
  const [, id] = after.match(/"call them by their screen" \((a-[0-9a-f]{8})\)/);
  const [row] = inboxRows(v);
  assert.deepEqual([row.id, row.note, row.change, row.consent], [id, 'glim/the-thing', 'reword', 'prompt'], "the line's id names the row that records the user's consent to the change");
  assert.deepEqual(await lintFound(v, /Evidence line/), []);
});

test('a reword of an always rule with no keywords or applies_to is offered, and once kept the rule stays always', t => {
  const v = makeVault(t, { config: { proposals: 'ask' } });
  v.write(OLD_RULE, ruleNote({ always: true }));
  const sid = started(v);
  const o = offered(v.propose(sid, reword()));
  assert.equal(o.text.split('\n').slice(0, 3).join('\n'), '**Change this rule?** glim/the-thing\nWas: Do: Do the thing. Not: Skip the thing.\nNow: Do: Do the thing twice. Not: Skip the thing.');
  const k = keepAllowed(v, sid, o.id, o.text);
  assert.equal(k.code, 0, k.stderr);
  const after = v.read(OLD_RULE);
  assert.match(after, /^always: true\r?$/m);
  assert.match(after, /\*\*Do:\*\* Do the thing twice\.\r?\n/);
});

test('a reword that gives an always rule its first keywords names the empty scope it had', t => {
  const v = makeVault(t, { config: { proposals: 'ask' } });
  v.write(OLD_RULE, ruleNote({ always: true }));
  const sid = started(v);
  const o = offered(v.propose(sid, reword({ do: undefined, keywords: ['thing'] })));
  assert.equal(o.text.split('\n').slice(0, 3).join('\n'), '**Change this rule?** glim/the-thing: Do: Do the thing. Not: Skip the thing.\nWas: no keywords or applies_to\nNow: Keywords: thing', 'the unchanged text is given once');
});

test('a reword offer ends a reading that is a sentence already with its own period', t => {
  const v = makeVault(t, { config: { proposals: 'ask' } });
  v.write(OLD_RULE, ruleNote({ keywords: ['thing'] }));
  const sid = started(v);
  const o = offered(v.propose(sid, reword({ basis: 'reading', quote: undefined, reading: 'The request missed its keywords.' })));
  assert.equal(o.text.split('\n').at(-1), 'Its note would get this Evidence: The request missed its keywords.');
  const k = keepAllowed(v, sid, o.id, o.text);
  assert.equal(k.code, 0, k.stderr);
});

test('change without key, key without change, and a change other than reword are refused', t => {
  const v = makeVault(t, { config: { proposals: 'ask' } });
  v.write(OLD_RULE, ruleNote({ keywords: ['thing'] }));
  const sid = started(v);
  const { key, ...noKey } = reword();
  assert.match(v.propose(sid, noKey).stderr, /^Not proposed: change needs key/);
  assert.equal(v.propose(sid, { ...rule(), key: 'glim/the-thing' }).code, 1);
  const rename = v.propose(sid, reword({ change: 'rename' }));
  assert.equal(rename.code, 1);
  assert.equal(rename.stderr, 'Not proposed: change must be reword, retire or move.\n');
  assert.match(v.propose(sid, reword({ key: 'glim/no-such-rule' })).stderr, /glim\/no-such-rule/);
});

// A ## comment in the frontmatter reads as the body's first section if the frontmatter isn't found behind the mark.
test('a reword of a note that starts with a byte order mark replaces its Do line, keeps its frontmatter and keeps the mark', t => {
  const v = makeVault(t, { config: { proposals: 'ask' } });
  const note = `﻿${ruleNote({ keywords: ['thing'], extra: ['## kept by hand'] })}`;
  v.write(OLD_RULE, note);
  const sid = started(v);
  const o = offered(v.propose(sid, reword()));
  const k = keepAllowed(v, sid, o.id, o.text);
  assert.equal(k.code, 0, k.stderr);
  const after = v.read(OLD_RULE);
  assert.ok(after.startsWith('﻿---\n'), 'the byte order mark stays');
  const front = s => s.slice(0, s.indexOf('\n---\n') + 5).replace(/^updated: .*$/m, 'updated:');
  assert.equal(front(after), front(note), 'the frontmatter keeps its lines, updated aside');
  assert.match(after, /\n---\n\n\*\*Do:\*\* Do the thing twice\.\n\*\*Not:\*\* Skip the thing\.\n/);
});

const TOPIC_PAGE = 'wiki/glim/topics/code.md';
const linkingPage = () => `---\ntype: page\nkind: topic\ndomain: glim\ntopic: code\nsummary: 'Code taste.'\n---\n\nSee [[wiki/glim/rules/the-thing|the-thing]] and [[wiki/glim/rules/the-thing]].\n\n## Rules\n- [[wiki/glim/rules/the-thing|the-thing]]\n`;
const thingRow = { id: 'a-00000001', at: '2026-10-01T10:00:00.000Z', source: 'agent', kind: 'stated', text: 'do the thing', note: 'glim/the-thing', session: '1a2b3c4d-0000-4000-8000-000000000001', transcript: null, cwd: null, domain: 'glim' };

test('a retire offer, once kept, writes retired and why, the rule stops reaching sessions, and index.md marks it', async t => {
  const v = makeVault(t, { config: { proposals: 'corrections' } });
  v.write(OLD_RULE, ruleNote({ keywords: ['thing'] }));
  v.write('wiki/glim/rules/the-thing-two.md', ruleNote({ keywords: ['thing'], doLine: 'Do the newer thing.' }));
  v.write(TOPIC_PAGE, linkingPage());
  const sid = started(v);
  const o = offered(v.propose(sid, { change: 'retire', key: 'glim/the-thing', because: 'The thing moved to a newer rule.', superseded_by: 'glim/the-thing-two' }));
  assert.equal(o.text, '**Retire this rule?** glim/the-thing: Do: Do the thing. Not: Skip the thing.\nBecause: The thing moved to a newer rule. Superseded by glim/the-thing-two.');
  assert.doesNotMatch(v.read(OLD_RULE), /retired/, 'a retirement is an offer even under corrections');
  const k = keepAllowed(v, sid, o.id, o.text);
  assert.equal(k.code, 0, k.stderr);
  const after = v.read(OLD_RULE);
  assert.match(after, /^retired: \d{4}-\d\d-\d\d$/m);
  assert.match(after, /^retired_because: The thing moved to a newer rule\.$/m);
  assert.match(after, /^superseded_by: glim\/the-thing-two$/m);
  assert.match(k.stdout, /To bring it back, delete its retired lines and its superseded_by line in /);
  assert.match(v.read('index.md'), /the-thing\]\].*retired/);
  const other = started(v);
  const said = prompt(v, other, 'do the thing please');
  assert.doesNotMatch(said?.hookSpecificOutput?.additionalContext ?? '', /glim\/the-thing:/);
  // A retirement changes the rule, so the page may also read as stale when the test crosses midnight; only its links count here.
  assert.deepEqual(await lintFound(v, /links \[\[.*the-thing/), [], 'the links to a retired rule still resolve');
  assert.match(v.propose(sid, { change: 'retire', key: 'glim/the-thing', because: 'Again.' }).stderr, /isn't a delivered rule/);
});

test('a move offer, once kept, moves the note, rewrites the links to it and writes moved_from, and its old key still resolves', async t => {
  const v = makeVault(t, { config: { proposals: 'corrections' }, domains: { quill: { title: 'Quill', topics: ['code'], markers: ['quill.project'] }, shelf: { title: 'Shelf', vaultOnly: true } } });
  v.write(OLD_RULE, ruleNote({ keywords: ['thing'] }));
  v.write(TOPIC_PAGE, linkingPage());
  v.write('raw/inbox/2026-10-01-1a2b3c4d.jsonl', `${JSON.stringify(thingRow)}\n`);
  v.write('wiki/quill/rules/taken.md', ruleNote({ domain: 'quill', keywords: ['taken'] }));
  const sid = started(v);
  const move = to => v.propose(sid, { change: 'move', key: 'glim/the-thing', domain: to });
  assert.match(move('nope').stderr, /there's no domain nope/);
  assert.match(move('shelf').stderr, /shelf is vaultOnly/);
  const o = offered(move('quill'));
  assert.equal(o.text, '**Move this rule?** glim/the-thing to quill/the-thing: Do: Do the thing. Not: Skip the thing.');
  const k = keepAllowed(v, sid, o.id, o.text);
  assert.equal(k.code, 0, k.stderr);
  assert.ok(!v.exists(OLD_RULE));
  const moved = v.read('wiki/quill/rules/the-thing.md');
  assert.match(moved, /^domain: quill$/m);
  assert.match(moved, /^moved_from: glim\/the-thing$/m);
  const page = v.read(TOPIC_PAGE);
  assert.doesNotMatch(page, /wiki\/glim\/rules\/the-thing/);
  assert.equal((page.match(/\[\[wiki\/quill\/rules\/the-thing\|the-thing\]\]/g) ?? []).length, 3);
  assert.deepEqual(await lintFound(v, /the-thing|a-00000001/), [], "the inbox row naming the old key still backs the moved note's Evidence");
  v.write('wiki/glim/rules/taken.md', ruleNote({ keywords: ['taken'], doLine: 'Do the taken thing.' }));
  assert.match(v.propose(sid, { change: 'move', key: 'glim/taken', domain: 'quill' }).stderr, /wiki\/quill\/rules\/taken\.md already exists/);
});

test('a moved rule can move back, a session shown it before the move is not shown it again, and lint points a user page at its new path', async t => {
  const v = makeVault(t, { config: { proposals: 'corrections' }, domains: { quill: { title: 'Quill', topics: ['code'], markers: ['quill.project'] } } });
  fs.writeFileSync(path.join(v.project, 'quill.project'), '');
  v.write(OLD_RULE, ruleNote({ keywords: ['thing'] }));
  const MINE = 'wiki/glim/concepts/mine.md';
  v.write(MINE, pageNote({ kind: 'concept', extra: ['author: user'], body: ['See [[wiki/glim/rules/the-thing]].'] }));
  const context = out => out?.hookSpecificOutput?.additionalContext ?? '';
  const seen = started(v);
  assert.match(context(prompt(v, seen, 'do the thing please')), /glim\/the-thing:/);
  const sid = started(v);
  const move = (key, to) => {
    const o = offered(v.propose(sid, { change: 'move', key, domain: to }));
    const k = keepAllowed(v, sid, o.id, o.text);
    assert.equal(k.code, 0, k.stderr);
  };
  move('glim/the-thing', 'quill');
  assert.doesNotMatch(context(prompt(v, seen, 'do the thing once more')), /the-thing:/, 'a session shown the rule before its move has it in mind');
  assert.match(context(prompt(v, started(v), 'do the thing please')), /quill\/the-thing:/);
  assert.match(v.read(MINE), /\[\[wiki\/glim\/rules\/the-thing\]\]/, "the move leaves the user's page as they wrote it");
  assert.deepEqual((await lintFound(v, /the-thing/)).map(f => f.msg), ['links [[wiki/glim/rules/the-thing]], a note at wiki/quill/rules/the-thing.md. Link it by that path, as [[wiki/quill/rules/the-thing|the-thing]]']);
  move('quill/the-thing', 'glim');
  assert.match(v.read(OLD_RULE), /^moved_from: quill\/the-thing$/m);
  assert.deepEqual(await lintFound(v, /the-thing/), []);
});

const QUILL_DOMAIN = { quill: { title: 'Quill', topics: ['code'], markers: ['quill.project'] } };
function quillVault(t, said) {
  const v = makeVault(t, { config: { proposals: 'corrections' }, domains: QUILL_DOMAIN });
  fs.writeFileSync(path.join(v.project, 'quill.project'), '');
  return { v, sid: started(v, said) };
}
function moveKept(v, sid, key, to, env) {
  const o = offered(v.propose(sid, { change: 'move', key, domain: to }));
  return v.run('keep.mjs', [sid, recordedCall(v, sid, { offer: o.id, input: { id: o.id, offer: o.text } })], { input: { id: o.id, offer: o.text }, env });
}

test('repeats naming a moved rule by its old key backs the moved note, and the same words back it once whichever key names it', t => {
  const quote = 'do the thing always';
  const { v, sid } = quillVault(t, [quote, 'the thing again please']);
  const base = { domain: 'quill', slug: 'x', topic: 'code', basis: 'stated', quote, do: 'A.', not: 'B.', applies_to: ['src/new/**'] };
  const w = v.propose(sid, { ...base, domain: 'glim', slug: 'the-thing', do: 'Zebra quartz mango.', not: 'Plover lantern ember.' });
  assert.equal(w.code, 0, w.stderr);
  assert.equal(moveKept(v, sid, 'glim/the-thing', 'quill').code, 0);
  assert.equal(v.propose(sid, { ...base, repeats: 'quill/the-thing' }).stderr, 'Not proposed: these words already back quill/the-thing.\n');
  assert.equal(v.propose(sid, { ...base, repeats: 'glim/the-thing' }).stderr, 'Not proposed: these words already back quill/the-thing.\n');
  const r = v.propose(sid, { ...base, quote: 'the thing again please', repeats: 'glim/the-thing' });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /\*\*Rule backed again\*\* quill\/the-thing: /);
  assert.equal(v.read('wiki/quill/rules/the-thing.md').split('\n').filter(l => l.includes('"the thing again please"')).length, 1);
  assert.equal(inboxRows(v).at(-1).note, 'quill/the-thing');
});

test("a retirement can't name the rule's own key from before its move as the rule that supersedes it", t => {
  const { v, sid } = quillVault(t);
  v.write(OLD_RULE, ruleNote({ keywords: ['thing'] }));
  assert.equal(moveKept(v, sid, 'glim/the-thing', 'quill').code, 0);
  const r = v.propose(sid, { change: 'retire', key: 'quill/the-thing', because: 'Replaced.', superseded_by: 'glim/the-thing' });
  assert.equal(r.stderr, "Not proposed: superseded_by names glim/the-thing, which isn't another delivered rule.\n");
});

test('a move whose rename fails writes nothing: the note stays where it was and no link changes', t => {
  const { v, sid } = quillVault(t);
  v.write(OLD_RULE, ruleNote({ keywords: ['thing'] }));
  v.write(TOPIC_PAGE, linkingPage());
  // Windows refuses to rename or remove a file another program holds open; the stub fails both for the old note.
  const stub = path.join(v.root, 'busy.mjs');
  fs.writeFileSync(stub, [
    "import fs from 'node:fs';",
    "const busy = p => String(p).split(String.fromCharCode(92)).join('/').endsWith('wiki/glim/rules/the-thing.md');",
    "const fail = () => Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });",
    'for (const name of ["renameSync", "rmSync", "unlinkSync"]) {',
    '  const real = fs[name];',
    '  fs[name] = (p, ...rest) => { if (busy(p)) throw fail(); return real(p, ...rest); };',
    '}',
  ].join('\n'));
  const before = { note: v.read(OLD_RULE), page: v.read(TOPIC_PAGE), log: v.exists('log.md') ? v.read('log.md') : '' };
  const k = moveKept(v, sid, 'glim/the-thing', 'quill', { NODE_OPTIONS: `--import=${pathToFileURL(stub).href}` });
  assert.equal(k.code, 1, k.stdout);
  assert.match(k.stderr, /^Not kept: /);
  assert.equal(v.exists('wiki/quill/rules/the-thing.md'), false, 'no second copy of the rule');
  assert.equal(v.read(OLD_RULE), before.note);
  assert.equal(v.read(TOPIC_PAGE), before.page);
  assert.equal(v.exists('log.md') ? v.read('log.md') : '', before.log);
});

test('a move that relinks another rule leaves that rule shown to the sessions it was shown to', t => {
  const { v, sid } = quillVault(t);
  v.write(OLD_RULE, ruleNote({ keywords: ['thing'] }));
  v.write('wiki/glim/rules/other-thing.md', ruleNote({ keywords: ['gadget'], doLine: 'Do the gadget after [[wiki/glim/rules/the-thing|the-thing]].' }));
  const context = out => out?.hookSpecificOutput?.additionalContext ?? '';
  const seen = started(v);
  assert.match(context(prompt(v, seen, 'fix the gadget')), /glim\/other-thing:/);
  assert.equal(moveKept(v, sid, 'glim/the-thing', 'quill').code, 0);
  assert.match(v.read('wiki/glim/rules/other-thing.md'), /\[\[wiki\/quill\/rules\/the-thing\|the-thing\]\]/);
  assert.doesNotMatch(context(prompt(v, seen, 'fix the gadget again')), /other-thing:/, 'its wording is new only in its link');
  assert.match(context(prompt(v, started(v), 'fix the gadget')), /glim\/other-thing:/);
});

test("a move carries the moved rule's delivered and repeat-list markers to its new key", t => {
  const v = makeVault(t, { config: { proposals: 'corrections' } });
  const sid = started(v);
  v.write(OLD_RULE, ruleNote({ keywords: ['thing'], applies_to: ['src/new/**'] }));
  const shown = started(v);
  prompt(v, shown, 'do the thing please');
  const proposal = { domain: 'glim', slug: 'new-rule', topic: 'code', basis: 'stated', quote: 'call them by their screen', do: 'Zebra quartz mango.', not: 'Plover lantern ember.', applies_to: ['src/new/**'] };
  assert.match(v.propose(sid, proposal).stderr, /- glim\/the-thing: /);
  // A global rule stays in a glim proposal's scope, so the retry lists it again under its new key.
  assert.equal(moveKept(v, sid, 'glim/the-thing', 'global').code, 0);
  const retry = v.propose(sid, proposal);
  assert.equal(retry.code, 0, retry.stderr);
  const delivered = v.read(`.state/delivered/${shown}/keys.jsonl`).trim().split('\n').map(l => JSON.parse(l));
  assert.ok(delivered.includes('global/the-thing'), delivered.join(', '));
});
