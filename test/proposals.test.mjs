import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeVault, ruleNote, sessionId, userTurn, assistantTurn, recordedCall, keepAllowed, offerOf } from './fixture.mjs';
import { codexInput } from './codex.mjs';

// The proposals setting: in ask and off, propose.mjs only offers a rule, or evidence for one, outside the vault folder,
// and keep.mjs writes it once the user allows it; tools/proposals.mjs changes the setting only from an allowed call.
const context = out => out?.hookSpecificOutput?.additionalContext ?? '';
const typed = said => said.flatMap(s => [userTurn(s), assistantTurn('Noted.')]);
const inboxRows = v => (fs.existsSync(v.at('raw', 'inbox'))
  ? fs.readdirSync(v.at('raw', 'inbox')).flatMap(f => v.read(`raw/inbox/${f}`).trim().split('\n').map(l => JSON.parse(l)))
  : []);
const lintErrors = v => v.run('lint.mjs').stdout.split('\n').filter(l => l.startsWith('error '));

// A vault whose proposals setting is mode, or the default when mode is undefined.
const vaultIn = (t, mode, opts = {}) => makeVault(t, { ...opts, config: { proposals: mode, ...opts.config } });

function started(v, said, { cwd = v.project } = {}) {
  const sid = sessionId();
  const out = v.startSession(sid, { cwd, transcript: said ? v.transcript(sid, typed(said)) : null });
  return { sid, out };
}

// A knowledge rule cites a failure, not the user's words, so it needs no transcript.
const failed = () => rule({ kind: 'knowledge', basis: 'failure', quote: undefined, error: 'zq: unknown flag --strict', fix: 'pass --mode=strict', file: 'src/build.zq' });

const offered = r => {
  assert.equal(r.code, 0, r.stderr);
  const o = offerOf(r.stdout);
  assert.ok(o, r.stdout);
  return o;
};
const setMode = (v, sid, input, { allow = true } = {}) => v.run('proposals.mjs', [sid, recordedCall(v, sid, { tool: 'proposals', allow, input })], { input });

const rule = (o = {}) => ({
  domain: 'glim', slug: 'tidy-names', topic: 'code', basis: 'stated', quote: 'call them by their screen',
  do: 'Name widgets after their screen.', not: 'Leave widget names bare.', keywords: ['widgetz'], ...o,
});

test('with no proposals setting, a project session needs the user to agree: propose.mjs offers the rule and writes nothing', t => {
  const v = vaultIn(t, undefined);
  const { sid, out } = started(v, ['call them by their screen']);
  assert.match(context(out), /nothing is written until the user agrees/i);
  const r = v.propose(sid, rule());
  const o = offered(r);
  assert.match(o.text, /glim\/tidy-names: Do: Name widgets after their screen\. Not: Leave widget names bare\./);
  assert.ok(!v.exists('wiki/glim/rules/tidy-names.md'));
  assert.deepEqual(inboxRows(v), []);
});

test('in ask, keep with the call the user allowed lets the rule through, and the row says the prompt agreed', t => {
  const v = vaultIn(t, 'ask');
  const { sid } = started(v, ['call them by their screen']);
  const o = offered(v.propose(sid, rule()));
  const k = keepAllowed(v, sid, o.id, o.text);
  assert.equal(k.code, 0, k.stderr);
  assert.ok(v.exists('wiki/glim/rules/tidy-names.md'));
  const [row] = inboxRows(v);
  assert.equal(row.consent, 'prompt');
  assert.ok(!Object.hasOwn(row, 'approved'));
});

test('in ask, approved is no field, and a session with no transcript is offered the rule, since the prompt agrees', t => {
  const v = vaultIn(t, 'ask');
  const { sid } = started(v, ['call them by their screen', 'yes, keep that one']);
  const r = v.propose(sid, rule({ approved: 'yes, keep that one' }));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /^Not proposed: approved isn't a field propose\.mjs takes\./);

  const bare = started(v, null);
  const o = offered(v.propose(bare.sid, failed()));
  assert.equal(keepAllowed(v, bare.sid, o.id, o.text).code, 0);
  assert.ok(v.exists('wiki/glim/rules/tidy-names.md'));
});

test('in off, propose.mjs refuses without asked and shows no rule to offer, and offers with the user asking', t => {
  const v = vaultIn(t, 'off');
  const { sid, out } = started(v, ['call them by their screen']);
  assert.match(context(out), /only when the user asks/i);
  const r = v.propose(sid, rule());
  assert.equal(r.code, 1);
  assert.match(r.stderr, /only when the user asks/);
  assert.doesNotMatch(r.stderr, /Do: Name widgets/);
  const early = started(v, ['make a rule of that', 'call them by their screen']);
  const e = v.propose(early.sid, rule({ asked: 'make a rule of that' }));
  assert.equal(e.code, 1);
  assert.match(e.stderr, /latest message/);
  const ok = started(v, ['call them by their screen', 'make a rule of that']);
  const o = offered(v.propose(ok.sid, rule({ asked: 'make a rule of that' })));
  assert.ok(!v.exists('wiki/glim/rules/tidy-names.md'));
  assert.equal(keepAllowed(v, ok.sid, o.id, o.text).code, 0);
  assert.ok(v.exists('wiki/glim/rules/tidy-names.md'));
  assert.ok(!Object.hasOwn(JSON.parse(v.read(`.state/offers/${o.id}.json`)).fields, 'asked'));
});

test('a domain sets its own mode over the top-level one, and global takes the top-level one', t => {
  const v = vaultIn(t, 'ask', { domains: { glim: { proposals: 'corrections' } } });
  const { sid, out } = started(v, ['call them by their screen', 'name gizmos plainly']);
  assert.match(context(out), /glim/);
  assert.equal(v.propose(sid, rule()).code, 0);
  const g = v.propose(sid, rule({
    domain: 'global', slug: 'plain-gizmos', quote: 'name gizmos plainly',
    do: 'Call gizmos plainly.', not: 'Dress gizmo names up.', keywords: ['gizmoz'],
  }));
  offered(g);
  assert.ok(!v.exists('wiki/global/rules/plain-gizmos.md'));
});

test('in ask, adding evidence to a rule through repeats is offered too', t => {
  const v = vaultIn(t, 'ask');
  v.write('wiki/glim/rules/name-widgets.md', ruleNote({ keywords: ['widgetz'], doLine: 'Name widgets after their screen.', notLine: 'Leave widget names bare.' }));
  const before = v.read('wiki/glim/rules/name-widgets.md');
  const { sid } = started(v, ['call them by their screen']);
  const o = offered(v.propose(sid, rule({ repeats: 'glim/name-widgets' })));
  assert.match(o.text, /^\*\*Back this rule again\?\*\* glim\/name-widgets: /);
  assert.equal(v.read('wiki/glim/rules/name-widgets.md'), before);
});

test('a session in the vault folder is offered each rule, under corrections and under off without asked', t => {
  for (const mode of ['corrections', 'off']) {
    const v = vaultIn(t, mode);
    const { sid } = started(v, ['call them by their screen'], { cwd: v.root });
    const o = offered(v.propose(sid, rule()));
    assert.ok(!v.exists('wiki/glim/rules/tidy-names.md'), mode);
    const k = keepAllowed(v, sid, o.id, o.text);
    assert.equal(k.code, 0, k.stderr);
    assert.ok(v.exists('wiki/glim/rules/tidy-names.md'), mode);
  }
});

test('a session no domain reaches hears the mode for global', t => {
  const v = vaultIn(t, 'off');
  const dir = fs.mkdtempSync(`${v.root}-elsewhere-`);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { out } = started(v, ['hi'], { cwd: dir });
  assert.match(context(out), /this project is in no domain/);
  assert.match(context(out), /only when the user asks/i);
});

test('every project session hears how to change the mode', t => {
  const v = vaultIn(t, 'corrections');
  const { out } = started(v, ['hi']);
  assert.match(context(out), /the vault's `proposals` tool/);
});

test('proposals.mjs sets the mode from a call the user allowed, keeping the rest of the config as it was', t => {
  const v = vaultIn(t, 'ask');
  const before = v.read('vault.config.json');
  const { sid } = started(v, ['call them by their screen', 'switch rules to off']);
  const refused = v.run('proposals.mjs', [sid], { input: { mode: 'off' } });
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /allows it at the prompt/);
  assert.equal(setMode(v, sid, { mode: 'off', approved: 'switch rules to off' }).code, 1, 'approved is no field');
  assert.equal(v.read('vault.config.json'), before);

  const r = setMode(v, sid, { mode: 'off' });
  assert.equal(r.code, 0, r.stderr);
  const after = v.read('vault.config.json');
  assert.equal(JSON.parse(after).proposals, 'off');
  assert.equal(after.replace('"proposals": "off"', '"proposals": "ask"'), before);
  assert.match(r.stdout, /off/);
  const off = v.propose(sid, rule());
  assert.equal(off.code, 1);
  assert.match(off.stderr, /only when the user asks/);
});

test('proposals.mjs sets one domain\'s mode, and refuses an unknown mode or domain', t => {
  const v = vaultIn(t, 'ask');
  const { sid } = started(v, ['only glim, corrections']);
  const bad = setMode(v, sid, { mode: 'sometimes' });
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /corrections, ask or off/);
  const none = setMode(v, sid, { mode: 'off', domain: 'nope' });
  assert.equal(none.code, 1);
  assert.match(none.stderr, /nope/);
  const r = setMode(v, sid, { mode: 'corrections', domain: 'glim' });
  assert.equal(r.code, 0, r.stderr);
  const c = JSON.parse(v.read('vault.config.json'));
  assert.equal(c.domains.glim.proposals, 'corrections');
  assert.equal(c.proposals, 'ask');
  const again = setMode(v, sid, { mode: 'off', domain: 'glim' });
  assert.equal(again.code, 0, again.stderr);
  assert.equal(JSON.parse(v.read('vault.config.json')).domains.glim.proposals, 'off');
});

test('setting the top-level mode names the domains that keep their own', t => {
  const v = vaultIn(t, 'ask', { domains: { glim: { proposals: 'corrections' } } });
  const { sid } = started(v, ['turn rules off']);
  const r = setMode(v, sid, { mode: 'off' });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /glim keeps its own mode, corrections/);
});

test('lint reports a proposals value that is not corrections, ask or off', t => {
  const v = vaultIn(t, 'sometimes', { domains: { glim: { proposals: 'never' } } });
  const errors = lintErrors(v);
  assert.ok(errors.some(l => /proposals/.test(l) && /sometimes/.test(l)), errors.join('\n'));
  assert.ok(errors.some(l => /glim/.test(l) && /never/.test(l)), errors.join('\n'));
});

test('in ask, a session whose consent is a code and has no transcript is refused before any offer, since no answer could agree', t => {
  const v = vaultIn(t, 'ask', { config: { agents: ['claude-code', 'codex'] } });
  const sid = '019a0fb1-dddd-7000-8000-000000000001';
  v.hook('session-start', codexInput('SessionStart', { session_id: sid, cwd: v.project }), { agent: 'codex' });
  const r = v.propose(sid, failed());
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no transcript/);
  assert.doesNotMatch(r.stderr, /Keep this rule/);
});

test('a session in the vault folder that a domain reaches hears that it offers rules, and its status says ask', t => {
  const v = vaultIn(t, 'corrections');
  v.write('vault.local.json', JSON.stringify({ domains: { glim: { paths: [v.root] } } }));
  const { out } = started(v, ['hi'], { cwd: v.root });
  assert.match(context(out), /offer a rule through the vault's `propose` tool/);
  assert.doesNotMatch(context(out), /propose a rule when the user corrects you/);
  assert.match(out?.systemMessage ?? '', /proposals: ask/);
});

test('a domain session hears to write pages directly, and a session in the vault folder, whose instructions cover pages, does not', t => {
  const v = vaultIn(t, 'ask');
  const held = /Write the rest worth keeping on a vault page directly/;
  assert.match(context(started(v, ['hi']).out), held);
  v.write('vault.local.json', JSON.stringify({ domains: { glim: { paths: [v.root] } } }));
  const inVault = context(started(v, ['hi'], { cwd: v.root }).out);
  assert.match(inVault, /hold a knowledge rule/);
  assert.doesNotMatch(inVault, held);
});

test('lint reports a bad proposals value even when vault.local.json is broken', t => {
  const v = vaultIn(t, 'sometimes');
  v.write('vault.local.json', '{ broken');
  assert.ok(lintErrors(v).some(l => /sometimes/.test(l)), lintErrors(v).join('\n'));
});

test('a proposals call refused for its fields is spent, so a shell rerun of that call with another mode sets nothing', t => {
  const v = vaultIn(t, 'ask');
  const { sid } = started(v, ['switch it off']);
  const before = v.read('vault.config.json');
  const sent = { mode: 'off', domain: 'nope' };
  const call = recordedCall(v, sid, { tool: 'proposals', input: sent });
  const first = v.run('proposals.mjs', [sid, call], { input: sent });
  assert.equal(first.code, 1);
  assert.match(first.stderr, /^Not set: vault\.config\.json has no domain nope\./);
  assert.ok(JSON.parse(v.read(`.state/calls/${call}.json`)).used, 'the refused run spent its call');
  const rerun = v.run('proposals.mjs', [sid, call], { input: { mode: 'corrections' } });
  assert.equal(rerun.code, 1, rerun.stdout);
  assert.equal(rerun.stderr, "Not set: proposals changes the mode only from the vault's `proposals` tool, once the user allows it at the prompt.\n");
  assert.equal(v.read('vault.config.json'), before);
});

test('/vault off as a slash command sets the mode through the proposals call the user allows', t => {
  const v = vaultIn(t, 'ask');
  const { sid } = started(v, ['<command-message>vault</command-message>\n<command-name>/vault</command-name>\n<command-args>off</command-args>']);
  const r = setMode(v, sid, { mode: 'off' });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(v.read('vault.config.json')).proposals, 'off');
  assert.equal(setMode(v, sid, { mode: 'ask' }, { allow: false }).code, 1, 'a denied call sets nothing');
  assert.equal(JSON.parse(v.read('vault.config.json')).proposals, 'off');
});
