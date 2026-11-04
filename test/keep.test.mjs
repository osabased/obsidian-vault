import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeVault, sessionId, userTurn, assistantTurn, ruleNote, pageNote, recordedCall, keepAllowed, offerOf, lintFound } from './fixture.mjs';
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
const entityPage = (reading = 'Zq-lib parses screens.') => pageNote({ kind: 'entity', topic: 'code', summary: "'The zq-lib parser.'", body: ["## Agent's reading", reading] });

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
  assert.equal(o.text.split('\n').slice(3, 5).join('\n'), 'Was: no keywords or applies_to\nNow: Keywords: thing');
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
  assert.equal(rename.stderr, 'Not proposed: change must be reword.\n');
  assert.match(v.propose(sid, reword({ key: 'glim/no-such-rule' })).stderr, /glim\/no-such-rule/);
});
