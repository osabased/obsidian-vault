import test from 'node:test';
import assert from 'node:assert/strict';
import { makeVault, ruleNote, sessionId } from './fixture.mjs';

const sectionOf = (out, title) => out.trimEnd().split('\n\n').find(b => b.startsWith(`${title}\n`))?.split('\n').slice(1);
const fact = (topic, asOf) => ruleNote({ topic, kind: 'knowledge', basis: 'source', extra: [`as_of: ${asOf}`], applies_to: [`src/${topic}/**`] });

test('review status ranks each pair of rules whose globs overlap', t => {
  const v = makeVault(t, { topics: ['a', 'b', 'c', 'd', 'e', 'f'] });
  v.write('wiki/glim/rules/said.md', ruleNote({ topic: 'a', applies_to: ['src/a/**'] }));
  v.write('wiki/glim/rules/guessed.md', ruleNote({ topic: 'a', basis: 'inferred', applies_to: ['src/a/**'] }));
  v.write('wiki/glim/rules/twice.md', ruleNote({ topic: 'b', applies_to: ['src/b/**'], evidence: [
    '- 2026-10-01 · stated · session 1a2b3c4d · "do the thing" (a-00000001)',
    '- 2026-10-02 · correction · session 5e6f7a8b · "do the thing again" (a-00000002)',
  ] }));
  v.write('wiki/glim/rules/once.md', ruleNote({ topic: 'b', applies_to: ['src/b/**'] }));
  v.write('wiki/glim/rules/newer.md', ruleNote({ topic: 'c', applies_to: ['src/c/**'], evidence: ['- 2026-10-20 · stated · session 1a2b3c4d · "do the thing" (a-00000003)'] }));
  v.write('wiki/glim/rules/older.md', ruleNote({ topic: 'c', applies_to: ['src/c/**'] }));
  v.write('wiki/glim/rules/tie-one.md', ruleNote({ topic: 'd', applies_to: ['src/d/**'] }));
  v.write('wiki/glim/rules/tie-two.md', ruleNote({ topic: 'd', applies_to: ['src/d/**'] }));
  v.write('wiki/glim/rules/fact-new.md', fact('e', '2026-10-10'));
  v.write('wiki/glim/rules/fact-old.md', fact('e', '2026-09-01'));
  v.write('wiki/glim/rules/taste-f.md', ruleNote({ topic: 'f', applies_to: ['src/f/**'] }));
  v.write('wiki/glim/rules/fact-f.md', fact('f', '2026-10-10'));
  assert.deepEqual(sectionOf(v.run('review.mjs', ['status']).stdout, 'Rules on one topic whose globs overlap'), [
    "- glim/fact-f and glim/taste-f, on f: 'src/f/**' and 'src/f/**'",
    "- glim/fact-new and glim/fact-old, on e: 'src/e/**' and 'src/e/**' · glim/fact-new ranks first: as_of 2026-10-10 over 2026-09-01",
    "- glim/guessed and glim/said, on a: 'src/a/**' and 'src/a/**' · glim/said ranks first: basis stated over inferred",
    "- glim/newer and glim/older, on c: 'src/c/**' and 'src/c/**' · glim/newer ranks first: evidence from 2026-10-20 over 2026-10-01",
    "- glim/once and glim/twice, on b: 'src/b/**' and 'src/b/**' · glim/twice ranks first: 2 Evidence lines to 1",
    "- glim/tie-one and glim/tie-two, on d: 'src/d/**' and 'src/d/**' · neither ranks first: same basis, Evidence count and newest Evidence date",
  ]);
});

test('propose ranks the new rule against the rules whose globs it overlaps', t => {
  const v = makeVault(t);
  const sid = sessionId();
  v.startSession(sid);
  v.write('wiki/glim/rules/said.md', ruleNote({ applies_to: ['src/new/**'] }));
  v.write('wiki/glim/rules/read.md', ruleNote({ basis: 'reading', applies_to: ['src/new/*.lua'], doLine: 'Other thing.', notLine: 'Other skip.' }));
  const proposal = {
    domain: 'glim', slug: 'new-rule', topic: 'code', basis: 'reading', reading: 'The user rewrote the screen twice.',
    do: 'Zebra quartz mango.', not: 'Plover lantern ember.', applies_to: ['src/new/**'],
  };
  assert.match(v.propose(sid, proposal).stderr, /may repeat rules already in the vault/);
  const r = v.propose(sid, proposal);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^Wrote wiki\/glim\/rules\/new-rule\.md\. On code, glim\/read and glim\/said cover files this rule covers too\. Check the new rule doesn't contradict them\. If one does, show the user both with the higher-ranked first: glim\/new-rule ranks before glim\/read \(evidence from \d{4}-\d\d-\d\d over 2026-10-01\); glim\/said ranks before glim\/new-rule \(basis stated over reading\)\. End your reply/);
});
