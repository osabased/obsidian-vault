import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeVault, ruleNote, pageNote, sourcePage } from './fixture.mjs';
import { today } from '../tools/lib/vault.mjs';

const OLD = new Date(2026, 9, 1, 12);
const savedOn = (v, rel) => today(fs.statSync(v.at(...rel.split('/'))).mtime);

function brokenVault(t) {
  const v = makeVault(t);
  v.write('raw/refs/guide.md', 'The guide says to do the thing.\n');
  v.write('wiki/glim/rules/said.md', ruleNote({
    because: 'It reads better.',
    keywords: ['thing'],
    evidence: ['- 2026-10-01 · stated · session 1a2b3c4d · "see [[glim/code]]" (a-00000001)'],
  }).replace('## Examples\n', '## Examples\n\n- [[glim/code]]\n'), { saved: OLD });
  v.write('wiki/glim/topics/code.md', pageNote({ body: [
    'Links [[glim/said]] and [[glim/said#Do|the rule]], [the rule](glim/said.md) and [here](./said.md), and [[nowhere]].',
    'The guide is [[wiki/glim/sources/guide|guide]].',
    '',
    '| Rule | Why |',
    '| --- | --- |',
    '| [[glim/said]] | it says so |',
    '',
    'Write it as `[[glim/said]]`.',
    '',
    '```',
    '[[glim/said]]',
    '```',
    '',
    'Cited.[^1] Again.[^2]',
    '',
    '[^1]: ./raw/refs/guide.md · 2026-10-01',
    '[^2]: `./raw/refs/guide.md`',
    '',
    '## Rules',
    '',
    '- [[wiki/glim/rules/said|said]]',
    '',
    '## You said',
    '',
    '- 2026-10-01 · session 1a2b3c4d · "see [[glim/said]]"',
  ] }), { saved: OLD });
  v.write('wiki/glim/sources/guide.md', sourcePage({ source: "'./raw/refs/guide.md'", dated: '2026-10-01' }).replace(/\n/g, '\r\n'), { saved: OLD });
  return v;
}

test('lint --fix rewrites the paths lint gives outside the quoted words, and rebuilds the generated files', t => {
  const v = brokenVault(t);
  assert.equal(v.run('lint.mjs').code, 1);
  const r = v.run('lint.mjs', ['--fix']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const lines = r.stdout.trimEnd().split('\n');
  assert.equal(lines.filter(l => l.startsWith('fixed ')).length, 9, r.stdout);
  assert.ok(lines.includes('rebuilt index.md'), r.stdout);
  assert.deepEqual(lines.slice(-3), [
    'warn wiki/glim/topics/code.md: links [[nowhere]], which has no note',
    "warn wiki: 2 quotes can't be checked: 2 cite a session whose transcript is gone. node tools/review.mjs status lists them.",
    '0 errors, 2 warnings',
  ]);

  assert.deepEqual(v.read('wiki/glim/topics/code.md').split('\n').slice(10, -1), [
    'Links [[wiki/glim/rules/said|said]] and [[wiki/glim/rules/said#Do|the rule]], [the rule](wiki/glim/rules/said.md) and [here](wiki/glim/rules/said.md), and [[nowhere]].',
    'The guide is [[wiki/glim/sources/guide|guide]].',
    '',
    '| Rule | Why |',
    '| --- | --- |',
    '| [[wiki/glim/rules/said\\|said]] | it says so |',
    '',
    'Write it as `[[glim/said]]`.',
    '',
    '```',
    '[[glim/said]]',
    '```',
    '',
    'Cited.[^1] Again.[^2]',
    '',
    '[^1]: raw/refs/guide.md · 2026-10-01',
    '[^2]: `raw/refs/guide.md`',
    '',
    '## Rules',
    '',
    '- [[wiki/glim/rules/said|said]]',
    '',
    '## You said',
    '',
    '- 2026-10-01 · session 1a2b3c4d · "see [[glim/said]]"',
  ]);
  const rule = v.read('wiki/glim/rules/said.md');
  assert.match(rule, /## Examples\n\n- \[\[wiki\/glim\/topics\/code\|code\]\]\n/);
  assert.match(rule, /## Evidence\n- 2026-10-01 · stated · session 1a2b3c4d · "see \[\[glim\/code\]\]" \(a-00000001\)\n/);
  const source = v.read('wiki/glim/sources/guide.md');
  assert.match(source, /\r\nsource: 'raw\/refs\/guide\.md'\r\n/);
  assert.doesNotMatch(source, /[^\r]\n/);
  for (const rel of ['wiki/glim/rules/said.md', 'wiki/glim/topics/code.md', 'wiki/glim/sources/guide.md']) {
    assert.match(v.read(rel), /\nupdated: 2026-10-01\r?\n/);
    assert.equal(savedOn(v, rel), '2026-10-01', `${rel} keeps the day it was saved, so the pages that watch it don't go stale`);
  }

  const again = v.run('lint.mjs', ['--fix']);
  assert.deepEqual(again.stdout.trimEnd().split('\n'), lines.slice(-3));
  assert.deepEqual(v.read('log.md').split('\n').filter(l => l.includes('fixed paths')).map(l => l.split(' · ').slice(1).join(' · ')), [
    'fixed paths · notes glim/code, glim/guide, glim/said',
  ]);
});

test('lint --fix leaves a link to a key two notes share', t => {
  const v = makeVault(t);
  v.write('wiki/glim/rules/said.md', ruleNote({ because: 'It reads better.' }));
  v.write('wiki/glim/topics/said.md', pageNote());
  v.write('wiki/glim/topics/code.md', pageNote({ body: ['See [[glim/said]].', '', '## Rules'] }));
  const before = v.read('wiki/glim/topics/code.md');
  const r = v.run('lint.mjs', ['--fix']);
  assert.doesNotMatch(r.stdout, /^fixed /m);
  assert.equal(v.read('wiki/glim/topics/code.md'), before);
});

test('lint --fix takes --fail-on, and refuses other arguments', t => {
  const v = brokenVault(t);
  assert.equal(v.run('lint.mjs', ['--fix', '--fail-on', 'warn']).code, 1);
  assert.equal(v.run('lint.mjs', ['--fail-on', 'warn', '--fix']).code, 1);
  assert.equal(v.run('lint.mjs', ['--fix', '--fix']).code, 2);
  assert.equal(v.run('lint.mjs', ['--mend']).code, 2);
});
