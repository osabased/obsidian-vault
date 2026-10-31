import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeVault, ruleNote, pageNote, sourcePage } from './fixture.mjs';

const OLD = new Date(2026, 9, 1, 12);
const age = (v, rel) => fs.utimesSync(v.at(...rel.split('/')), OLD, OLD);
const savedOn = (v, rel) => {
  const t = new Date(fs.statSync(v.at(...rel.split('/'))).mtimeMs);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
};

function brokenVault(t) {
  const v = makeVault(t);
  v.write('raw/refs/guide.md', 'The guide says to do the thing.\n');
  v.write('wiki/demo/rules/said.md', ruleNote({
    because: 'It reads better.',
    evidence: ['- 2026-10-01 · stated · session 1a2b3c4d · "see [[demo/code]]" (a-00000001)'],
  }).replace('## Examples\n', '## Examples\n\n- [[demo/code]]\n'));
  v.write('wiki/demo/topics/code.md', pageNote({ body: [
    'Links [[demo/said]] and [[demo/said#Do|the rule]], [the rule](demo/said.md) and [here](./said.md), and [[nowhere]].',
    'The guide is [[wiki/demo/sources/guide|guide]].',
    '',
    '| Rule | Why |',
    '| --- | --- |',
    '| [[demo/said]] | it says so |',
    '',
    'Write it as `[[demo/said]]`.',
    '',
    '```',
    '[[demo/said]]',
    '```',
    '',
    'Cited.[^1] Again.[^2]',
    '',
    '[^1]: ./raw/refs/guide.md · 2026-10-01',
    '[^2]: `./raw/refs/guide.md`',
    '',
    '## Rules',
    '',
    '- [[wiki/demo/rules/said|said]]',
    '',
    '## You said',
    '',
    '- 2026-10-01 · session 1a2b3c4d · "see [[demo/said]]"',
  ] }));
  v.write('wiki/demo/sources/guide.md', sourcePage({ source: "'./raw/refs/guide.md'", dated: '2026-10-01' }).replace(/\n/g, '\r\n'));
  for (const rel of ['wiki/demo/rules/said.md', 'wiki/demo/topics/code.md', 'wiki/demo/sources/guide.md']) age(v, rel);
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
  assert.deepEqual(lines.slice(-2), ['warn wiki/demo/topics/code.md: links [[nowhere]], which has no note', '0 errors, 1 warning']);

  assert.deepEqual(v.read('wiki/demo/topics/code.md').split('\n').slice(10, -1), [
    'Links [[wiki/demo/rules/said|said]] and [[wiki/demo/rules/said#Do|the rule]], [the rule](wiki/demo/rules/said.md) and [here](wiki/demo/rules/said.md), and [[nowhere]].',
    'The guide is [[wiki/demo/sources/guide|guide]].',
    '',
    '| Rule | Why |',
    '| --- | --- |',
    '| [[wiki/demo/rules/said\\|said]] | it says so |',
    '',
    'Write it as `[[demo/said]]`.',
    '',
    '```',
    '[[demo/said]]',
    '```',
    '',
    'Cited.[^1] Again.[^2]',
    '',
    '[^1]: raw/refs/guide.md · 2026-10-01',
    '[^2]: `raw/refs/guide.md`',
    '',
    '## Rules',
    '',
    '- [[wiki/demo/rules/said|said]]',
    '',
    '## You said',
    '',
    '- 2026-10-01 · session 1a2b3c4d · "see [[demo/said]]"',
  ]);
  const rule = v.read('wiki/demo/rules/said.md');
  assert.match(rule, /## Examples\n\n- \[\[wiki\/demo\/topics\/code\|code\]\]\n/);
  assert.match(rule, /## Evidence\n- 2026-10-01 · stated · session 1a2b3c4d · "see \[\[demo\/code\]\]" \(a-00000001\)\n/);
  const source = v.read('wiki/demo/sources/guide.md');
  assert.match(source, /\r\nsource: 'raw\/refs\/guide\.md'\r\n/);
  assert.doesNotMatch(source, /[^\r]\n/);
  for (const rel of ['wiki/demo/rules/said.md', 'wiki/demo/topics/code.md', 'wiki/demo/sources/guide.md']) {
    assert.match(v.read(rel), /\nupdated: 2026-10-01\r?\n/);
    assert.equal(savedOn(v, rel), '2026-10-01', `${rel} keeps the day it was saved, so the pages that watch it don't go stale`);
  }

  const again = v.run('lint.mjs', ['--fix']);
  assert.deepEqual(again.stdout.trimEnd().split('\n'), lines.slice(-2));
  assert.deepEqual(v.read('log.md').split('\n').filter(l => l.includes('fixed paths')).map(l => l.split(' · ').slice(1).join(' · ')), [
    'fixed paths · notes demo/code, demo/guide, demo/said',
  ]);
});

test('lint --fix leaves a link to a key two notes share', t => {
  const v = makeVault(t);
  v.write('wiki/demo/rules/said.md', ruleNote({ because: 'It reads better.' }));
  v.write('wiki/demo/topics/said.md', pageNote());
  v.write('wiki/demo/topics/code.md', pageNote({ body: ['See [[demo/said]].', '', '## Rules'] }));
  const before = v.read('wiki/demo/topics/code.md');
  const r = v.run('lint.mjs', ['--fix']);
  assert.doesNotMatch(r.stdout, /^fixed /m);
  assert.equal(v.read('wiki/demo/topics/code.md'), before);
});

test('lint --fix takes --fail-on, and refuses other arguments', t => {
  const v = brokenVault(t);
  assert.equal(v.run('lint.mjs', ['--fix', '--fail-on', 'warn']).code, 1);
  assert.equal(v.run('lint.mjs', ['--fail-on', 'warn', '--fix']).code, 1);
  assert.equal(v.run('lint.mjs', ['--fix', '--fix']).code, 2);
  assert.equal(v.run('lint.mjs', ['--mend']).code, 2);
});
