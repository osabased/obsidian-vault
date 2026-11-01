import test from 'node:test';
import assert from 'node:assert/strict';
import { makeVault, ruleNote, pageNote as page, denied, sessionId, editFile as edit, prompt, lintFound } from './fixture.mjs';

const context = out => out?.hookSpecificOutput?.additionalContext ?? null;
const pointed = out => (context(out) ?? '').split('\n').slice(1).map(l => l.split(' ')[1]);

const pushed = opts => page({ kind: 'concept', ...opts });
const pathOf = (v, key) => v.at('wiki', ...key.split('/')).replace(/\\/g, '/') + '.md';

test('a prompt that names a page\'s keyword points the session to the page, once, and again after compaction', t => {
  const v = makeVault(t);
  const sid = sessionId();
  v.write('wiki/demo/luau-types.md', pushed({ keywords: ['strict mode'], summary: "'How the checker treats strict mode'" }));
  assert.equal(context(prompt(v, sid, 'turn on strict mode here')), [
    'Vault pages on this request. Read the ones that bear on it:',
    `- demo/luau-types (concept page): How the checker treats strict mode. ${pathOf(v, 'demo/luau-types')}`,
  ].join('\n'));
  assert.equal(prompt(v, sid, 'strict mode again'), null);
  assert.equal(prompt(v, sid, 'nothing it names'), null);
  v.startSession(sid, { source: 'compact' });
  assert.match(context(prompt(v, sid, 'strict mode')), /demo\/luau-types/);
});

test('an edit to a file a page applies to points the session to it without refusing the edit, once per session', t => {
  const v = makeVault(t);
  const sid = sessionId();
  v.write('wiki/demo/shop-layout.md', pushed({ applies_to: ['src/ui/**'], keywords: ['shop'] }));
  const out = edit(v, sid, 'src/ui/shop.luau');
  assert.equal(out.hookSpecificOutput.permissionDecision, undefined);
  assert.equal(context(out), [
    'Vault pages on src/ui/shop.luau. Read the ones that bear on this work:',
    `- demo/shop-layout (concept page): What we know. ${pathOf(v, 'demo/shop-layout')}`,
  ].join('\n'));
  assert.equal(edit(v, sid, 'src/ui/bag.luau'), null, 'once per session, not per file');
  assert.equal(prompt(v, sid, 'the shop'), null, 'a prompt does not bring it up again');
  assert.equal(edit(v, sessionId(), 'src/net/remote.luau'), null, 'a file outside its globs');
});

test('a subagent hears of a page apart from the agent that started it', t => {
  const v = makeVault(t);
  const sid = sessionId();
  v.write('wiki/demo/shop-layout.md', pushed({ applies_to: ['src/ui/**'], keywords: ['shop'] }));
  assert.deepEqual(pointed(prompt(v, sid, 'build the shop')), ['demo/shop-layout']);
  assert.deepEqual(pointed(edit(v, sid, 'src/ui/shop.luau', { agent: 'agent-1' })), ['demo/shop-layout']);
  assert.equal(edit(v, sid, 'src/ui/bag.luau', { agent: 'agent-1' }), null);
  assert.deepEqual(pointed(edit(v, sid, 'src/ui/bag.luau', { agent: 'agent-2' })), ['demo/shop-layout']);
  assert.equal(edit(v, sid, 'src/ui/bag.luau'), null, 'the main agent already heard of it');
});

test('a global page\'s globs are read from the project folder of the file edited', t => {
  const v = makeVault(t);
  v.write('wiki/global/ui-notes.md', pushed({ domain: 'global', applies_to: ['src/ui/**'] }));
  const out = edit(v, sessionId(), 'src/ui/shop.luau');
  assert.match(context(out), /^Vault pages on src\/ui\/shop\.luau\./);
  assert.deepEqual(pointed(out), ['global/ui-notes']);
});

test('an edit to the vault\'s notes or sources brings up no page', t => {
  const v = makeVault(t);
  const sid = sessionId();
  v.write('wiki/global/everything.md', pushed({ domain: 'global', applies_to: ['**'] }));
  const write = rel => edit(v, sid, null, { tool: 'Write', abs: v.at(...rel.split('/')), cwd: v.root, text: 'x' });
  assert.equal(write('wiki/demo/new-note.md'), null);
  assert.equal(write('raw/refs/new-ref.md'), null);
  assert.deepEqual(pointed(write('notes.md')), ['global/everything']);
});

test('a rule that refuses an edit holds the pages back for the retry', t => {
  const v = makeVault(t);
  const sid = sessionId();
  v.write('wiki/demo/ui-rule.md', ruleNote({ applies_to: ['src/**'] }));
  v.write('wiki/demo/shop-layout.md', pushed({ applies_to: ['src/**'] }));
  const first = edit(v, sid, 'src/a.luau');
  assert.ok(denied(first));
  assert.equal(context(first), null);
  const retry = edit(v, sid, 'src/a.luau');
  assert.equal(denied(retry), null);
  assert.match(context(retry), /demo\/shop-layout/);
});

test('pages reach the sessions their domain\'s rules reach, and every page reaches a session in the vault folder', t => {
  const v = makeVault(t, { domains: { reading: { title: 'Reading', vaultOnly: true, topics: ['solvers'] } } });
  v.write('wiki/global/solver-basics.md', pushed({ domain: 'global', keywords: ['solver'] }));
  v.write('wiki/reading/solver-history.md', pushed({ domain: 'reading', topic: 'solvers', keywords: ['solver'] }));
  assert.deepEqual(pointed(prompt(v, sessionId(), 'which solver?')), ['global/solver-basics']);
  assert.deepEqual(pointed(prompt(v, sessionId(), 'which solver?', { cwd: v.root })), ['global/solver-basics', 'reading/solver-history']);
});

test('a page saved within the settle window, or with an error, does not come up', t => {
  const v = makeVault(t);
  for (const slug of ['a-grid', 'b-grid']) v.write(`wiki/demo/${slug}.md`, pushed({ keywords: ['grid'], applies_to: ['src/**'] }));
  // Both sort ahead of the settled pages, so either one coming up shows in the pointers.
  v.write('wiki/demo/a-fresh-grid.md', pushed({ keywords: ['grid'], applies_to: ['src/**'] }), { settled: false });
  v.write('wiki/demo/a-broken-grid.md', pushed({ applies_to: ['src/**'], extra: ['keywords: grid'] }));
  assert.deepEqual(pointed(prompt(v, sessionId(), 'a grid')), ['demo/a-grid', 'demo/b-grid']);
  assert.deepEqual(pointed(edit(v, sessionId(), 'src/a.luau')), ['demo/a-grid', 'demo/b-grid']);
});

test('at most delivery.maxPages come up at a time, and the rest on the next match', t => {
  const v = makeVault(t);
  for (const slug of ['a-grid', 'b-grid', 'c-grid', 'd-grid']) v.write(`wiki/demo/${slug}.md`, pushed({ keywords: ['grid'], applies_to: ['src/**'] }));
  const sid = sessionId();
  assert.deepEqual(pointed(prompt(v, sid, 'a grid')), ['demo/a-grid', 'demo/b-grid', 'demo/c-grid']);
  assert.deepEqual(pointed(prompt(v, sid, 'a grid')), ['demo/d-grid']);
  const other = sessionId();
  assert.deepEqual(pointed(edit(v, other, 'src/a.luau')), ['demo/a-grid', 'demo/b-grid', 'demo/c-grid']);
  assert.deepEqual(pointed(edit(v, other, 'src/b.luau')), ['demo/d-grid']);
});

test('lint checks a page\'s keywords and applies_to as it does a rule\'s, and warns on the fields only rules take', async t => {
  const v = makeVault(t, { domains: { reading: { title: 'Reading', vaultOnly: true, topics: ['solvers'] } } });
  v.write('wiki/demo/code.md', page({ body: ['[[bad-glob]] [[rule-fields]]', '', '## Rules'] }));
  v.write('wiki/demo/bad-glob.md', pushed({ applies_to: ['src/{a'] }));
  v.write('wiki/demo/rule-fields.md', pushed({ extra: ['always: true', 'triggers: []'] }));
  v.write('wiki/reading/solvers.md', page({ domain: 'reading', topic: 'solvers', body: ['[[solver-history]]', '', '## Rules'] }));
  v.write('wiki/reading/solver-history.md', pushed({ domain: 'reading', topic: 'solvers', applies_to: ['src/**'] }));
  const found = await lintFound(v, /glob|rules\. A page|no edit/);
  assert.deepEqual(found.map(f => [f.level, f.file, f.msg]).sort(), [
    ['error', 'wiki/demo/bad-glob.md', 'bad glob in applies_to: src/{a'],
    ['warn', 'wiki/demo/rule-fields.md', 'always and triggers are for rules. A page comes up through keywords and applies_to'],
    ['warn', 'wiki/reading/solver-history.md', 'reading is vault-only, so no edit brings this page up. Give it keywords instead'],
  ]);
});

test('a rule\'s errors keep their order, and a note of another type gets only the type error', async t => {
  const v = makeVault(t, { domains: { reading: { title: 'Reading', vaultOnly: true, topics: ['solvers'] } } });
  const rules = await v.import('lib/rules.mjs');
  const rule = rules.parseNote(ruleNote({ domain: 'reading', applies_to: ['src/{a'] }), 'wiki/reading/x.md');
  assert.match(rules.noteErrors(rule)[0], /is vault-only/);
  const memo = rules.parseNote(page({ extra: ['keywords: grid'] }).replace('type: page', 'type: memo'), 'wiki/demo/x.md');
  assert.deepEqual(rules.noteErrors(memo), ['type must be rule or page']);
});
