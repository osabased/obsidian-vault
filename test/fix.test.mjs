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

test('lint errors when a skill has no copy in .agents/skills/ or one that differs other than in line endings, and lint --fix writes it', t => {
  const v = makeVault(t);
  const skill = '---\nname: ingest\ndescription: Take in a source.\n---\r\n\nSteps with a curly ’quote’.\n';
  v.write('.claude/skills/ingest/SKILL.md', skill);
  const missing = v.run('lint.mjs');
  assert.match(missing.stdout, /^error \.agents\/skills\/ingest\/SKILL\.md: missing; run node tools\/lint\.mjs --fix to copy \.claude\/skills\/ingest\/SKILL\.md$/m);
  v.write('.agents/skills/ingest/SKILL.md', skill.replace('\r\n', '\n'));
  assert.doesNotMatch(v.run('lint.mjs').stdout, /\.agents\/skills/, 'a copy that differs only in line endings is the same skill');
  v.write('.agents/skills/ingest/SKILL.md', skill.replace('Steps', 'Old steps'));
  const differs = v.run('lint.mjs');
  assert.match(differs.stdout, /^error \.agents\/skills\/ingest\/SKILL\.md: differs from \.claude\/skills\/ingest\/SKILL\.md; edit the skill there, then run node tools\/lint\.mjs --fix to copy it$/m);
  const fixed = v.run('lint.mjs', ['--fix']);
  assert.match(fixed.stdout, /^fixed \.agents\/skills\/ingest\/SKILL\.md: /m);
  assert.ok(fs.readFileSync(v.at('.agents', 'skills', 'ingest', 'SKILL.md')).equals(Buffer.from(skill)));
  assert.doesNotMatch(fixed.stdout.split(/^fixed .*$/m).at(-1), /\.agents\/skills/);
});

test('lint errors on a copy in .agents/skills/ whose skill is gone, naming the folder to delete, and lint --fix leaves it', t => {
  const v = makeVault(t);
  v.write('.claude/skills/ingest/SKILL.md', '---\nname: ingest\n---\n');
  v.write('.agents/skills/ingest/SKILL.md', '---\nname: ingest\n---\n');
  v.write('.agents/skills/old-name/SKILL.md', '---\nname: old-name\n---\n');
  v.write('.agents/skills/old-name/notes/more.md', 'More.\n');
  const r = v.run('lint.mjs');
  assert.equal(r.code, 1);
  const found = r.stdout.split('\n').filter(l => l.includes('.agents/skills'));
  assert.deepEqual(found, ['error .agents/skills/old-name/: .claude/skills/old-name/ no longer exists; delete .agents/skills/old-name/']);
  const fixed = v.run('lint.mjs', ['--fix']);
  assert.match(fixed.stdout, /^error \.agents\/skills\/old-name\/: /m);
  assert.ok(fs.existsSync(v.at('.agents', 'skills', 'old-name', 'SKILL.md')));
});
