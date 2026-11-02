import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeVault, ruleNote, sessionId, userTurn, assistantTurn } from './fixture.mjs';

// The proposals setting: in ask and off, propose.mjs writes a rule, or adds evidence to one, only with the user's words
// agreeing from their latest message, outside the vault folder; tools/proposals.mjs changes the setting the same way.
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

const rule = (o = {}) => ({
  domain: 'glim', slug: 'tidy-names', topic: 'code', basis: 'stated', quote: 'call them by their screen',
  do: 'Name widgets after their screen.', not: 'Leave widget names bare.', keywords: ['widgetz'], ...o,
});

test('with no proposals setting, a project session needs the user to agree: propose.mjs shows the rule and writes nothing', t => {
  const v = vaultIn(t, undefined);
  const { sid, out } = started(v, ['call them by their screen']);
  assert.match(context(out), /ask the user/i);
  const r = v.propose(sid, rule());
  assert.equal(r.code, 1, r.stdout);
  assert.match(r.stderr, /^Not proposed: /);
  assert.match(r.stderr, /approved/);
  assert.match(r.stderr, /glim\/tidy-names: Do: Name widgets after their screen\. Not: Leave widget names bare\./);
  assert.ok(!v.exists('wiki/glim/rules/tidy-names.md'));
  assert.deepEqual(inboxRows(v), []);
});

test('in ask, the user agreeing in their latest message lets the rule through, and the row keeps their words', t => {
  const v = vaultIn(t, 'ask');
  const { sid } = started(v, ['call them by their screen', 'yes, keep that one']);
  const r = v.propose(sid, rule({ approved: 'yes, keep that one' }));
  assert.equal(r.code, 0, r.stderr);
  assert.ok(v.exists('wiki/glim/rules/tidy-names.md'));
  assert.equal(inboxRows(v)[0].approved, 'yes, keep that one');
});

test("in ask, approved must be the user's latest message, and a session with no transcript can't approve", t => {
  const v = vaultIn(t, 'ask');
  const { sid } = started(v, ['yes, keep that one', 'call them by their screen']);
  const r = v.propose(sid, rule({ approved: 'yes, keep that one' }));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /latest message/);
  assert.ok(!v.exists('wiki/glim/rules/tidy-names.md'));

  const bare = started(v, null);
  const b = v.propose(bare.sid, rule({ basis: 'reading', quote: undefined, reading: 'The user renamed the widgets.', approved: 'yes' }));
  assert.equal(b.code, 1);
  assert.match(b.stderr, /no transcript/);
});

test('in off, propose.mjs refuses without approved and shows no rule to offer', t => {
  const v = vaultIn(t, 'off');
  const { sid, out } = started(v, ['call them by their screen']);
  assert.match(context(out), /only when the user asks/i);
  const r = v.propose(sid, rule());
  assert.equal(r.code, 1);
  assert.match(r.stderr, /only when the user asks/);
  assert.doesNotMatch(r.stderr, /Do: Name widgets/);
  const ok = started(v, ['call them by their screen', 'make a rule of that']);
  assert.equal(v.propose(ok.sid, rule({ approved: 'make a rule of that' })).code, 0);
});

test('a domain sets its own mode over the top-level one, and global takes the top-level one', t => {
  const v = vaultIn(t, 'ask', { domains: { glim: { proposals: 'corrections' } } });
  const { sid, out } = started(v, ['call them by their screen']);
  assert.match(context(out), /glim/);
  assert.equal(v.propose(sid, rule()).code, 0);
  const g = v.propose(sid, rule({
    domain: 'global', slug: 'plain-gizmos', basis: 'reading', quote: undefined, reading: 'The user named gizmos plainly.',
    do: 'Call gizmos plainly.', not: 'Dress gizmo names up.', keywords: ['gizmoz'],
  }));
  assert.equal(g.code, 1);
  assert.match(g.stderr, /approved/);
});

test('in ask, adding evidence to a rule through repeats needs approval too', t => {
  const v = vaultIn(t, 'ask');
  v.write('wiki/glim/rules/name-widgets.md', ruleNote({ keywords: ['widgetz'], doLine: 'Name widgets after their screen.', notLine: 'Leave widget names bare.' }));
  const before = v.read('wiki/glim/rules/name-widgets.md');
  const { sid } = started(v, ['call them by their screen']);
  const r = v.propose(sid, rule({ repeats: 'glim/name-widgets' }));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /approved/);
  assert.equal(v.read('wiki/glim/rules/name-widgets.md'), before);
});

test('a session in the vault folder proposes as it always has, whatever the mode', t => {
  const v = vaultIn(t, 'off');
  const { sid } = started(v, ['call them by their screen'], { cwd: v.root });
  const r = v.propose(sid, rule());
  assert.equal(r.code, 0, r.stderr);
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
  assert.match(context(out), /proposals\.mjs/);
});

test('proposals.mjs sets the mode with the user\'s words, keeping the rest of the config as it was', t => {
  const v = vaultIn(t, 'ask');
  const before = v.read('vault.config.json');
  const { sid } = started(v, ['switch rules to off']);
  const refused = v.run('proposals.mjs', [sid], { input: { mode: 'off' } });
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /approved/);
  assert.equal(v.read('vault.config.json'), before);

  const r = v.run('proposals.mjs', [sid], { input: { mode: 'off', approved: 'switch rules to off' } });
  assert.equal(r.code, 0, r.stderr);
  const after = v.read('vault.config.json');
  assert.equal(JSON.parse(after).proposals, 'off');
  assert.equal(after.replace('"proposals": "off"', '"proposals": "ask"'), before);
  assert.match(r.stdout, /off/);
  assert.equal(v.propose(sid, rule({ basis: 'reading', quote: undefined, reading: 'The user renamed the widgets.' })).code, 1);
});

test('proposals.mjs sets one domain\'s mode, and refuses an unknown mode or domain', t => {
  const v = vaultIn(t, 'ask');
  const { sid } = started(v, ['only glim, corrections']);
  const bad = v.run('proposals.mjs', [sid], { input: { mode: 'sometimes', approved: 'only glim, corrections' } });
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /corrections, ask or off/);
  const none = v.run('proposals.mjs', [sid], { input: { mode: 'off', domain: 'nope', approved: 'only glim, corrections' } });
  assert.equal(none.code, 1);
  assert.match(none.stderr, /nope/);
  const r = v.run('proposals.mjs', [sid], { input: { mode: 'corrections', domain: 'glim', approved: 'only glim, corrections' } });
  assert.equal(r.code, 0, r.stderr);
  const c = JSON.parse(v.read('vault.config.json'));
  assert.equal(c.domains.glim.proposals, 'corrections');
  assert.equal(c.proposals, 'ask');
  const again = v.run('proposals.mjs', [sid], { input: { mode: 'off', domain: 'glim', approved: 'only glim, corrections' } });
  assert.equal(again.code, 0, again.stderr);
  assert.equal(JSON.parse(v.read('vault.config.json')).domains.glim.proposals, 'off');
});

test('setting the top-level mode names the domains that keep their own', t => {
  const v = vaultIn(t, 'ask', { domains: { glim: { proposals: 'corrections' } } });
  const { sid } = started(v, ['turn rules off']);
  const r = v.run('proposals.mjs', [sid], { input: { mode: 'off', approved: 'turn rules off' } });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /glim keeps its own mode, corrections/);
});

test('lint reports a proposals value that is not corrections, ask or off', t => {
  const v = vaultIn(t, 'sometimes', { domains: { glim: { proposals: 'never' } } });
  const errors = lintErrors(v);
  assert.ok(errors.some(l => /proposals/.test(l) && /sometimes/.test(l)), errors.join('\n'));
  assert.ok(errors.some(l => /glim/.test(l) && /never/.test(l)), errors.join('\n'));
});

test("approved can't be the words the rule quotes, since those state the preference rather than agree to keep it", t => {
  const v = vaultIn(t, 'ask');
  const { sid } = started(v, ['call them by their screen']);
  const r = v.propose(sid, rule({ approved: 'them' }));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /quote/);
  assert.ok(!v.exists('wiki/glim/rules/tidy-names.md'));
});

test('in ask, a session with no transcript is refused before any offer, since no answer could approve it', t => {
  const v = vaultIn(t, 'ask');
  const { sid } = started(v, null);
  const r = v.propose(sid, rule({ basis: 'reading', quote: undefined, reading: 'The user renamed the widgets.' }));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no transcript/);
  assert.doesNotMatch(r.stderr, /Keep this rule/);
});

test('a session in the vault folder that a domain reaches hears that it proposes as in corrections', t => {
  const v = vaultIn(t, 'ask');
  v.write('vault.local.json', JSON.stringify({ domains: { glim: { paths: [v.root] } } }));
  const { out } = started(v, ['hi'], { cwd: v.root });
  assert.match(context(out), /propose a rule when the user corrects you/);
  assert.doesNotMatch(context(out), /offer a rule/);
});

test('lint reports a bad proposals value even when vault.local.json is broken', t => {
  const v = vaultIn(t, 'sometimes');
  v.write('vault.local.json', '{ broken');
  assert.ok(lintErrors(v).some(l => /sometimes/.test(l)), lintErrors(v).join('\n'));
});
