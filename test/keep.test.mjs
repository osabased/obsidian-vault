import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeVault, sessionId, userTurn, assistantTurn, ruleNote, recordedCall, keepAllowed, offerOf } from './fixture.mjs';
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

test('Codex: every code is four characters with at least one digit', async t => {
  const v = codexVault(t);
  const { makeOffer } = await v.import('lib/offers.mjs');
  for (let i = 0; i < 80; i++) {
    const { code } = makeOffer({ kind: 'rule', sid: 'codes', entry: { agent: 'codex' }, key: `k${i}`, fields: {}, lines: ['x'] });
    assert.match(code, /^[A-HJKMNP-Z2-9]{4}$/);
    assert.match(code, /[2-9]/);
  }
});
