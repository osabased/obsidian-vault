import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeVault, ruleNote } from './fixture.mjs';

const END = '<!-- taste-vault: end -->';
const beginLine = hash => `<!-- taste-vault: begin ${hash} · written by node tools/compile.mjs; edits inside are overwritten -->`;
const HASH = '2fdaa50d75083113';

const BODY = [
  '## Taste rules',
  '',
  "From the user's taste vault. Follow them in this project.",
  '',
  '- glim/always-rule: Do: Open each glim file with a purpose line. Not: Start a file straight with code. Because: The user reads the first line first.',
  '',
  '### When editing src/**/*.zq',
  '',
  '- glim/zq-trigger: Do: Set values through a named step. Not: Set a value inline. Because: The user traces values by step name.',
  '',
  '### When the request mentions shimmer',
  '',
  '- glim/keyword-rule: Do: Fade a shimmer in over two frames. Not: Flash a shimmer on at once. Because: The user found the flash harsh.',
];
const sectionOf = (body, hash = createHash('sha256').update(body.join('\n')).digest('hex').slice(0, 16)) => `${[beginLine(hash), ...body, END].join('\n')}\n`;
const SECTION = sectionOf(BODY, HASH);

const posix = p => p.replace(/\\/g, '/');
const crlf = s => s.replace(/\n/g, '\r\n');

function glimVault(t, { compile = ['codex'], config = {}, domains = {} } = {}) {
  const v = makeVault(t, { presets: ['glim'], config, domains: { glim: compile === null ? {} : { compile }, ...domains } });
  listProject(v);
  return v;
}

// Lists the project as a path of the domain, which is how lint finds a project root on this machine.
function listProject(v, dir = v.project) {
  v.write('vault.local.json', `${JSON.stringify({ domains: { glim: { paths: [posix(dir)] } } }, null, 2)}\n`);
}

const compile = (v, ...dirs) => v.run('compile.mjs', dirs.length ? dirs : [v.project]);
const agentsOf = (v, dir = v.project) => path.join(dir, 'AGENTS.md');
const lintOf = async v => (await v.import('lib/lint.mjs')).lint().filter(f => !f.file.startsWith('wiki/'));
const bytes = file => fs.readFileSync(file);
const reword = (v, doLine) => v.write('wiki/glim/rules/keyword-rule.md', ruleNote({ keywords: ['shimmer'], doLine, notLine: 'Flash a shimmer on at once.', because: 'The user found the flash harsh.' }));
const folder = (t, files = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-compile-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
};

test('compile writes the project\'s AGENTS.md section byte for byte: always rules, file globs, then keywords, with triggers dropped', t => {
  const v = glimVault(t);
  const r = compile(v);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, `wrote ${posix(agentsOf(v))}: 3 rules\n`);
  const got = fs.readFileSync(agentsOf(v), 'utf8');
  assert.equal(got, SECTION);
  assert.match(got, /^<!-- taste-vault: begin [0-9a-f]{16} · /);
});

test('a project\'s own CRLF AGENTS.md keeps every other byte and its line endings, and the section follows a blank line', t => {
  const v = glimVault(t);
  const mine = '# Mine\r\n\r\nUse tabs.\r\nNo final newline';
  fs.writeFileSync(agentsOf(v), mine);
  const r = compile(v);
  assert.equal(r.code, 0, r.stderr);
  const got = fs.readFileSync(agentsOf(v), 'utf8');
  assert.ok(got.startsWith(`${mine}\r\n\r\n<!-- taste-vault: begin `), JSON.stringify(got.slice(0, 60)));
  assert.ok(!/(?<!\r)\n/.test(got), 'every line ending stays CRLF');
  assert.equal(got.slice(`${mine}\r\n\r\n`.length), crlf(sectionOf(BODY)));
});

test('a file without the section gets it appended after its last line, and a file with LF endings stays LF', t => {
  const v = glimVault(t);
  fs.writeFileSync(agentsOf(v), '# Mine\n\nUse tabs.\n');
  assert.equal(compile(v).code, 0);
  assert.equal(fs.readFileSync(agentsOf(v), 'utf8'), `# Mine\n\nUse tabs.\n\n${sectionOf(BODY)}`);
});

test('an existing section is rewritten in place when a rule changes, with the text around it and the BOM untouched', t => {
  const v = glimVault(t);
  assert.equal(compile(v).code, 0);
  const first = fs.readFileSync(agentsOf(v), 'utf8');
  fs.writeFileSync(agentsOf(v), `﻿before\r\n${crlf(first)}after\r\n`);
  reword(v, 'Fade a shimmer in over three frames.');
  const r = compile(v);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, `wrote ${posix(agentsOf(v))}: 3 rules\n`);
  const body = BODY.map(l => l.replace('two frames', 'three frames'));
  assert.equal(fs.readFileSync(agentsOf(v), 'utf8'), `﻿before\r\n${crlf(sectionOf(body))}after\r\n`);
});

test('a second run prints unchanged and writes nothing; a hand edit inside the section is refused with exit 1 and nothing written', t => {
  const v = glimVault(t);
  assert.equal(compile(v).code, 0);
  const file = agentsOf(v);
  const stamp = fs.statSync(file).mtimeMs;
  const again = compile(v);
  assert.equal(again.code, 0);
  assert.equal(again.stdout, `unchanged ${posix(file)}\n`);
  assert.equal(fs.statSync(file).mtimeMs, stamp);

  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('Open each glim file', 'Open each glim file, then relax,'));
  reword(v, 'Fade a shimmer in over three frames.');
  const before = bytes(file);
  const r = compile(v);
  assert.equal(r.code, 1);
  assert.equal(r.stdout, `refused ${posix(file)}: the taste-vault section was edited by hand since it was compiled. Move those edits out of the section, or delete it, then compile again.\n`);
  assert.deepEqual(bytes(file), before);
});

test('markers that don\'t pair are refused, and nothing is written: a begin with no end, two begins, an end before a begin', t => {
  const v = glimVault(t);
  const begin = beginLine('0123456789abcdef');
  for (const [what, text] of [
    ['begin with no end', `mine\n${begin}\nleft over\n`],
    ['two begins', `${begin}\nx\n${begin}\n${END}\n`],
    ['end before begin', `${END}\nmine\n${begin}\n`],
    ['end with no begin', `mine\n${END}\n`],
  ]) {
    fs.writeFileSync(agentsOf(v), text);
    const r = compile(v);
    assert.equal(r.code, 1, what);
    assert.match(r.stdout, new RegExp(`^refused ${posix(agentsOf(v)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: .*markers`), what);
    assert.equal(fs.readFileSync(agentsOf(v), 'utf8'), text, what);
  }
});

test('a file that isn\'t UTF-8 text is refused, since writing it back would change its other bytes', t => {
  const v = glimVault(t);
  const odd = Buffer.from([0x23, 0x20, 0xe9, 0x0a]);
  fs.writeFileSync(agentsOf(v), odd);
  const r = compile(v);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /^refused .*AGENTS\.md: .*UTF-8/);
  assert.deepEqual(bytes(agentsOf(v)), odd);
});

test('exit 2 for a path that isn\'t a folder, a project no opted-in domain reaches, and a folder in the vault, with nothing written', t => {
  const v = glimVault(t);
  const stray = folder(t, { 'README.md': 'x' });
  const missing = path.join(os.tmpdir(), 'vault-compile-missing-folder');
  for (const bad of [missing, stray, v.root]) {
    const r = compile(v, v.project, bad);
    assert.equal(r.code, 2, bad);
    assert.ok(r.stderr.trim(), `${bad} says why`);
    assert.ok(!fs.existsSync(agentsOf(v)), 'the valid project is not written either');
  }
  const none = glimVault(t, { compile: null });
  assert.equal(compile(none).code, 2, 'compile is unset by default');
  assert.ok(!fs.existsSync(agentsOf(none)));
  const empty = glimVault(t, { compile: [] });
  assert.equal(compile(empty).code, 2);
});

test('only live file-glob and keyword rules compile: a namespace glob, a tools rule and a retired rule are left out, and a ! entry reads as "except"', t => {
  const v = glimVault(t);
  v.write('wiki/glim/rules/ns-rule.md', ruleNote({ applies_to: ['glim-tree:Panel.*'], doLine: 'Name panels.', notLine: 'Leave panels bare.' }));
  v.write('wiki/glim/rules/mixed.md', ruleNote({ applies_to: ['glim-tree:Panel.*', 'docs/**/*.md', '!docs/drafts/**'], doLine: 'Head each doc.', notLine: 'Start without a head.' }));
  v.write('wiki/glim/rules/retired.md', ruleNote({ applies_to: ['docs/**/*.md'], doLine: 'Old.', notLine: 'Older.', extra: ['superseded_by: glim/mixed'] }));
  assert.equal(compile(v).code, 0);
  const got = fs.readFileSync(agentsOf(v), 'utf8');
  assert.doesNotMatch(got, /ns-rule|retired|ask-rule|Panel/);
  assert.match(got, /### When editing docs\/\*\*\/\*\.md, except docs\/drafts\/\*\*\n\n- glim\/mixed: Do: Head each doc\./);
});

test('rules go in key order within a group, and a rule with two channels is listed under both', t => {
  const v = glimVault(t);
  v.write('wiki/glim/rules/b-two.md', ruleNote({ applies_to: ['src/**/*.zq'], keywords: ['shimmer'], doLine: 'B.', notLine: 'Not B.' }));
  v.write('wiki/glim/rules/a-two.md', ruleNote({ applies_to: ['src/**/*.zq'], doLine: 'A.', notLine: 'Not A.' }));
  assert.equal(compile(v).code, 0);
  const lines = fs.readFileSync(agentsOf(v), 'utf8').split('\n').filter(l => l.startsWith('- '));
  assert.deepEqual(lines.map(l => l.match(/^- ([^:]+):/)[1]), ['glim/always-rule', 'glim/a-two', 'glim/b-two', 'glim/zq-trigger', 'glim/b-two', 'glim/keyword-rule']);
});

test('a domain whose marker sits below the project folder gets its globs under that folder', t => {
  const v = glimVault(t);
  const root = folder(t, { 'pkg/glim.project': '' });
  v.write('vault.local.json', `${JSON.stringify({ domains: { glim: { paths: [] } } })}\n`);
  assert.equal(compile(v, root).code, 0);
  assert.match(fs.readFileSync(agentsOf(v, root), 'utf8'), /### When editing pkg\/src\/\*\*\/\*\.zq\n\n- glim\/zq-trigger/);
});

test('over compile.maxBytes the section stops at a rule and ends with the overflow line, and fits the limit', t => {
  const v = glimVault(t, { config: { compile: { maxBytes: 700 } } });
  for (let i = 0; i < 8; i++) v.write(`wiki/glim/rules/long-${i}.md`, ruleNote({ keywords: [`word${i}`], doLine: `Do thing number ${i} in the usual way.`, notLine: `Skip thing number ${i}.` }));
  const r = compile(v);
  assert.equal(r.code, 0, r.stderr);
  const section = fs.readFileSync(agentsOf(v), 'utf8');
  const body = section.split('\n').slice(1, section.split('\n').indexOf(END));
  assert.ok(Buffer.byteLength(body.join('\n')) <= 700, `${Buffer.byteLength(body.join('\n'))} bytes`);
  assert.match(body.at(-1), /^\(Left out to stay within \d+ characters: \d+ rules?\./);
  assert.match(r.stdout, /: \d+ rules\n$/);
});

test('lint warns on a section that is missing, stale or edited by hand, and names the command to run', async t => {
  const v = glimVault(t);
  const root = posix(v.project);
  const file = agentsOf(v);
  const compiledFindings = async () => (await lintOf(v)).filter(f => f.file === posix(file));
  assert.deepEqual((await compiledFindings()).map(f => [f.level, f.msg]), [['warn', `not compiled; run node tools/compile.mjs ${root}`]]);

  assert.equal(compile(v).code, 0);
  assert.deepEqual(await compiledFindings(), []);

  reword(v, 'Fade a shimmer in over three frames.');
  assert.deepEqual((await compiledFindings()).map(f => [f.level, f.msg]), [['warn', `stale: 1 rule changed since it was compiled; run node tools/compile.mjs ${root}`]]);
  assert.equal(compile(v).code, 0);

  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('Open each glim file', 'Open any glim file'));
  assert.deepEqual((await compiledFindings()).map(f => [f.level, f.msg]), [['warn', 'edited by hand since it was compiled']]);
});

test('lint reports no compile finding for a domain that doesn\'t opt in', async t => {
  const v = glimVault(t, { compile: null });
  assert.deepEqual((await lintOf(v)).filter(f => /compile/.test(f.msg)), []);
});

test('lint errors on compile: ["nope"] and on agents: ["nope"]', async t => {
  const v = glimVault(t, { compile: ['nope'], config: { agents: ['claude-code', 'nope'] } });
  const found = (await lintOf(v)).filter(f => f.level === 'error').map(f => f.msg);
  assert.ok(found.includes('glim.compile names nope, and tools/adapters/nope/compile.mjs doesn\'t exist'), found.join('\n'));
  assert.ok(found.includes('agents names nope, and tools/adapters/nope/adapter.mjs doesn\'t exist'), found.join('\n'));
});

test('lint errors on a compile or compile.maxBytes of the wrong shape', async t => {
  const v = glimVault(t, { compile: 'codex', config: { compile: { maxBytes: 'big' } } });
  const found = (await lintOf(v)).filter(f => f.level === 'error').map(f => f.msg);
  assert.ok(found.some(m => /^glim\.compile must be a list of adapter names/.test(m)), found.join('\n'));
  assert.ok(found.some(m => /^compile\.maxBytes must be a whole number/.test(m)), found.join('\n'));
});
