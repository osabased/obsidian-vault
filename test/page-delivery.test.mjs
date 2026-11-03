import test from 'node:test';
import assert from 'node:assert/strict';
import { makeVault, ruleNote, pageNote as page, denied, sessionId, editFile as edit, prompt, lintFound } from './fixture.mjs';

const context = out => out?.hookSpecificOutput?.additionalContext ?? null;
const pointed = out => (denied(out) ?? context(out) ?? '').split('\n').filter(l => /^- \S+ \(\w+ page\)/.test(l)).map(l => l.split(' ')[1]);

const pushed = opts => page({ kind: 'concept', ...opts });
const pathOf = (v, key) => v.at('wiki', ...key.split('/')).replace(/\\/g, '/') + '.md';

test('a prompt that names a page\'s keyword points the session to the page, once, and again after compaction', t => {
  const v = makeVault(t);
  const sid = sessionId();
  v.write('wiki/glim/zq-types.md', pushed({ keywords: ['strict mode'], summary: "'How the checker treats strict mode'" }));
  assert.equal(context(prompt(v, sid, 'turn on strict mode here')), [
    'Vault pages on this request. Read the ones that bear on it:',
    `- glim/zq-types (concept page): How the checker treats strict mode. ${pathOf(v, 'glim/zq-types')}`,
  ].join('\n'));
  assert.equal(prompt(v, sid, 'strict mode again'), null);
  assert.equal(prompt(v, sid, 'nothing it names'), null);
  v.startSession(sid, { source: 'compact' });
  assert.match(context(prompt(v, sid, 'strict mode')), /glim\/zq-types/);
});

test('the first edit to a file a page applies to is refused with a pointer to it, once per session', t => {
  const v = makeVault(t);
  const sid = sessionId();
  v.write('wiki/glim/shop-layout.md', pushed({ applies_to: ['src/ui/**'], keywords: ['shop'] }));
  const out = edit(v, sid, 'src/ui/shop.zq');
  assert.equal(denied(out), [
    'Vault pages on src/ui/shop.zq. Read the ones that bear on this work:',
    `- glim/shop-layout (concept page): What we know. ${pathOf(v, 'glim/shop-layout')}`,
    'Revise this edit to follow the pages, then retry. The retry is allowed.',
  ].join('\n'));
  assert.equal(context(out), null, 'an allowed edit carries no pointer');
  assert.equal(edit(v, sid, 'src/ui/shop.zq'), null, 'the retry goes through');
  assert.equal(edit(v, sid, 'src/ui/bag.zq'), null, 'once per session, not per file');
  assert.equal(prompt(v, sid, 'the shop'), null, 'a prompt does not bring it up again');
  assert.equal(edit(v, sessionId(), 'src/net/remote.zq'), null, 'a file outside its globs');
});

test('a subagent hears of a page apart from the agent that started it', t => {
  const v = makeVault(t);
  const sid = sessionId();
  v.write('wiki/glim/shop-layout.md', pushed({ applies_to: ['src/ui/**'], keywords: ['shop'] }));
  assert.deepEqual(pointed(prompt(v, sid, 'build the shop')), ['glim/shop-layout']);
  assert.deepEqual(pointed(edit(v, sid, 'src/ui/shop.zq', { agent: 'agent-1' })), ['glim/shop-layout']);
  assert.equal(edit(v, sid, 'src/ui/bag.zq', { agent: 'agent-1' }), null);
  assert.deepEqual(pointed(edit(v, sid, 'src/ui/bag.zq', { agent: 'agent-2' })), ['glim/shop-layout']);
  assert.equal(edit(v, sid, 'src/ui/bag.zq'), null, 'the main agent already heard of it');
});

test('a global page\'s globs are read from the project folder of the file edited', t => {
  const v = makeVault(t);
  v.write('wiki/global/ui-notes.md', pushed({ domain: 'global', applies_to: ['src/ui/**'] }));
  const out = edit(v, sessionId(), 'src/ui/shop.zq');
  assert.match(denied(out), /^Vault pages on src\/ui\/shop\.zq\./);
  assert.deepEqual(pointed(out), ['global/ui-notes']);
});

test('an edit to the vault\'s notes or sources brings up no page', t => {
  const v = makeVault(t);
  const sid = sessionId();
  v.write('wiki/global/everything.md', pushed({ domain: 'global', applies_to: ['**'] }));
  const write = rel => edit(v, sid, null, { tool: 'Write', abs: v.at(...rel.split('/')), cwd: v.root, text: 'x' });
  assert.equal(write('wiki/glim/new-note.md'), null);
  assert.equal(write('raw/refs/new-ref.md'), null);
  assert.deepEqual(pointed(write('notes.md')), ['global/everything']);
});

test('a rule that refuses an edit carries the pages in the same refusal, and the retry passes', t => {
  const v = makeVault(t);
  const sid = sessionId();
  v.write('wiki/glim/ui-rule.md', ruleNote({ applies_to: ['src/**'] }));
  v.write('wiki/glim/shop-layout.md', pushed({ applies_to: ['src/**'] }));
  const first = denied(edit(v, sid, 'src/a.zq'));
  assert.match(first, /glim\/ui-rule/);
  assert.match(first, /glim\/shop-layout/);
  assert.match(first, /Revise this edit to follow them and the pages, then retry\./);
  assert.equal(edit(v, sid, 'src/a.zq'), null);
});

test('pages reach the sessions their domain\'s rules reach, and every page reaches a session in the vault folder', t => {
  const v = makeVault(t, { domains: { reading: { title: 'Reading', vaultOnly: true, topics: ['solvers'] } } });
  v.write('wiki/global/solver-basics.md', pushed({ domain: 'global', keywords: ['solver'] }));
  v.write('wiki/reading/solver-history.md', pushed({ domain: 'reading', topic: 'solvers', keywords: ['solver'] }));
  assert.deepEqual(pointed(prompt(v, sessionId(), 'which solver?')), ['global/solver-basics']);
  assert.deepEqual(pointed(prompt(v, sessionId(), 'which solver?', { cwd: v.root })), ['global/solver-basics', 'reading/solver-history']);
});

test('a page saved within the settle window, with an error, or superseded does not come up', t => {
  const v = makeVault(t);
  for (const slug of ['a-grid', 'b-grid']) v.write(`wiki/glim/${slug}.md`, pushed({ keywords: ['grid'], applies_to: ['src/**'] }));
  // Both sort ahead of the settled pages, so either one coming up shows in the pointers.
  v.write('wiki/glim/a-fresh-grid.md', pushed({ keywords: ['grid'], applies_to: ['src/**'] }), { settled: false });
  v.write('wiki/glim/a-broken-grid.md', pushed({ applies_to: ['src/**'], extra: ['keywords: grid'] }));
  v.write('wiki/glim/a-old-grid.md', pushed({ keywords: ['grid'], applies_to: ['src/**'], extra: ['superseded_by: glim/a-grid'] }));
  assert.deepEqual(pointed(prompt(v, sessionId(), 'a grid')), ['glim/a-grid', 'glim/b-grid']);
  assert.deepEqual(pointed(edit(v, sessionId(), 'src/a.zq')), ['glim/a-grid', 'glim/b-grid']);
});

test('at most delivery.maxPages come up at a time on a prompt, and the rest on the next match', t => {
  const v = makeVault(t);
  for (const slug of ['a-grid', 'b-grid', 'c-grid', 'd-grid']) v.write(`wiki/glim/${slug}.md`, pushed({ keywords: ['grid'], applies_to: ['src/**'] }));
  const sid = sessionId();
  assert.deepEqual(pointed(prompt(v, sid, 'a grid')), ['glim/a-grid', 'glim/b-grid', 'glim/c-grid']);
  assert.deepEqual(pointed(prompt(v, sid, 'a grid')), ['glim/d-grid']);
});

test('a refusal lists every page due, the ones past delivery.maxPages without their summaries', t => {
  const v = makeVault(t);
  for (const slug of ['a-grid', 'b-grid', 'c-grid', 'd-grid']) v.write(`wiki/glim/${slug}.md`, pushed({ applies_to: ['src/**'] }));
  const sid = sessionId();
  const first = edit(v, sid, 'src/a.zq');
  assert.deepEqual(pointed(first), ['glim/a-grid', 'glim/b-grid', 'glim/c-grid', 'glim/d-grid']);
  assert.ok(denied(first).includes(`- glim/c-grid (concept page): What we know. ${pathOf(v, 'glim/c-grid')}`));
  assert.ok(denied(first).includes(`- glim/d-grid (concept page): ${pathOf(v, 'glim/d-grid')}`));
  assert.equal(edit(v, sid, 'src/a.zq'), null, 'the retry goes through');
  assert.equal(edit(v, sid, 'src/b.zq'), null, 'every page was told of');
});

test('lint checks a page\'s scope fields as it does a rule\'s, always and triggers included', async t => {
  const v = makeVault(t, { domains: { reading: { title: 'Reading', vaultOnly: true, topics: ['solvers'] } } });
  v.write('wiki/glim/code.md', page({ body: ['[[bad-glob]] [[rule-fields]] [[bad-triggers]] [[bad-regex]]', '', '## Rules'] }));
  v.write('wiki/glim/bad-glob.md', pushed({ applies_to: ['src/{a'] }));
  v.write('wiki/glim/rule-fields.md', pushed({ extra: ['always: true', 'triggers: []'] }));
  v.write('wiki/glim/bad-triggers.md', pushed({ extra: ['always: maybe', 'triggers: wait'] }));
  v.write('wiki/glim/bad-regex.md', pushed({ applies_to: ['src/**'], extra: ["triggers: ['(']"] }));
  v.write('wiki/reading/solvers.md', page({ domain: 'reading', topic: 'solvers', body: ['[[solver-history]]', '', '## Rules'] }));
  v.write('wiki/reading/solver-history.md', pushed({ domain: 'reading', topic: 'solvers', applies_to: ['src/**'] }));
  const found = await lintFound(v, /glob|for rules|no edit|triggers|always/);
  assert.deepEqual(found.map(f => [f.level, f.file, f.msg]).sort(), [
    ['error', 'wiki/glim/bad-glob.md', 'bad glob in applies_to: src/{a'],
    ['error', 'wiki/glim/bad-regex.md', 'bad regex in triggers: ('],
    ['error', 'wiki/glim/bad-triggers.md', 'always must be true or false'],
    ['error', 'wiki/glim/bad-triggers.md', 'triggers must be a list'],
    ['warn', 'wiki/reading/solver-history.md', 'reading is vault-only, so no edit brings this page up. Give it keywords instead'],
  ]);
});

test('a rule\'s errors keep their order, and a note of another type gets only the type error', async t => {
  const v = makeVault(t, { domains: { reading: { title: 'Reading', vaultOnly: true, topics: ['solvers'] } } });
  const rules = await v.import('lib/rules.mjs');
  const rule = rules.parseNote(ruleNote({ domain: 'reading', applies_to: ['src/{a'] }), 'wiki/reading/x.md');
  assert.match(rules.noteErrors(rule)[0], /is vault-only/);
  const memo = rules.parseNote(page({ extra: ['keywords: grid'] }).replace('type: page', 'type: memo'), 'wiki/glim/x.md');
  assert.deepEqual(rules.noteErrors(memo), ['type must be rule or page']);
});

test('a page\'s triggers narrow it to edits whose new text matches, as a rule\'s do', t => {
  const v = makeVault(t);
  const sid = sessionId();
  v.write('wiki/glim/pauses.md', pushed({ applies_to: ['src/**'], extra: ['triggers:', "  - 'pause\\('"] }));
  assert.equal(edit(v, sid, 'src/a.zq', { text: 'set x to 1' }), null);
  assert.deepEqual(pointed(edit(v, sid, 'src/a.zq', { text: 'step.pause(1)' })), ['glim/pauses']);
});
