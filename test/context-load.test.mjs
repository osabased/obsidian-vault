import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { namedIn } from '../tools/lib/neutral.mjs';
import { makeVault, sessionId } from './fixture.mjs';

// What the vault puts in a session's context before the agent does anything: AGENTS.md in this folder (and wherever a
// session reads a file here), and the start hook's notes in every project. Every session pays for each line of it.

const ROOT = path.resolve(import.meta.dirname, '..');
const SKIPPED = new Set(['node_modules', '.git']);

function filesUnder(p) {
  if (!fs.existsSync(p)) return [];
  if (!fs.statSync(p).isDirectory()) return [p];
  return fs.readdirSync(p, { recursive: true, withFileTypes: true })
    .filter(e => e.isFile() && !path.relative(p, e.parentPath).split(path.sep).some(s => SKIPPED.has(s)))
    .map(e => path.join(e.parentPath, e.name));
}

const rel = file => path.relative(ROOT, file).replace(/\\/g, '/');
const DOCS = ['AGENTS.md', ...filesUnder(path.join(ROOT, 'reference')).filter(f => f.endsWith('.md')).map(rel)];

// The places a reader is sent to: a `## heading`, or an Operations item's bold `**name**:`. A heading in a code fence is
// part of an example note, not a section.
function sectionsOf(doc) {
  const text = fs.readFileSync(path.join(ROOT, doc), 'utf8').replace(/^ *```[^]*?^ *```/gm, '');
  return new Set([...text.matchAll(/^#{2,3} (.+?)\r?$|^- \*\*(.+?)\*\*:/gm)].map(m => m[1] ?? m[2]));
}

// Codex reads at most project_doc_max_bytes of AGENTS.md, 32 KiB by default, and drops the rest without a word.
test('AGENTS.md fits within Codex\'s 32 KiB project-doc limit as checked out', () => {
  const bytes = fs.statSync(path.join(ROOT, 'AGENTS.md')).size;
  assert.ok(bytes <= 32 * 1024, `AGENTS.md is ${bytes} bytes; move a section that only some work needs to reference/`);
});

test('every section AGENTS.md, reference/, the skills and the tools send a reader to exists', () => {
  const bad = [];
  const check = (from, doc, name) => {
    if (!fs.existsSync(path.join(ROOT, doc))) bad.push(`${from}: ${doc} doesn't exist`);
    else if (name && !sectionsOf(doc).has(name)) bad.push(`${from}: ${doc} has no section ${name}`);
  };
  const lineOf = (text, m) => text.slice(0, m.index).split('\n').length;
  for (const doc of DOCS) {
    const text = fs.readFileSync(path.join(ROOT, doc), 'utf8');
    for (const m of text.matchAll(/\(see (?!below\))([^)`]+?)(?: in `([^`]+)`)?\)/g)) check(`${doc}:${lineOf(text, m)}`, m[2] ?? doc, m[1]);
  }
  const code = [...filesUnder(path.join(ROOT, 'tools')), ...filesUnder(path.join(ROOT, '.claude', 'skills'))]
    .filter(f => /\.(mjs|md)$/.test(f));
  for (const file of code) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/(AGENTS\.md|reference\/[\w-]+\.md)\S*?(?:'s ([A-Z][\w' ]*?) section| says under ([A-Z][\w' ]*?)[.,])/g)) {
      check(`${rel(file)}:${lineOf(text, m)}`, m[1], m[2] ?? m[3]);
    }
  }
  for (const file of [...DOCS.map(d => path.join(ROOT, d)), ...code]) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/reference\/[\w-]+\.md/g)) check(`${rel(file)}:${lineOf(text, m)}`, m[0]);
  }
  assert.deepEqual(bad, [], `${bad.length} pointers lead nowhere:\n${bad.join('\n')}`);
});

test('the domain-name scan reads the reference files too', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-scan-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'reference'));
  fs.writeFileSync(path.join(dir, 'reference', 'notes.md'), '# Notes\n\nA rule for zorblax projects.\n');
  assert.deepEqual(namedIn(dir, { zorblax: { title: 'Zorblax' } }), ['reference/notes.md:3: key "zorblax"']);
});

// The paths and the session id differ per machine and session, so the budgets count the rest.
const notesOf = (out, sid, re) => (out?.hookSpecificOutput?.additionalContext ?? '').split('\n\n').filter(b => re.test(b))
  .map(b => b.replace(/`node "[^"]*\/([\w-]+\.mjs)"/g, '`node "<T>/$1"').replaceAll(sid, '<sid>')).join('\n\n');

test('a domain session\'s propose and pick notes stay within budget and keep what nothing else tells the agent', t => {
  const sid = sessionId();
  const text = notesOf(makeVault(t).startSession(sid), sid, /propose\.mjs|pick\.mjs/);
  assert.ok(text.length <= 1600, `the propose and pick notes are ${text.length} characters:\n${text}`);
  // The vault skill finds the vault, and the script to set the mode with, by the proposals.mjs this note names.
  assert.match(text, /`node "<T>\/proposals\.mjs" <sid>`/);
  assert.match(text, /`node "<T>\/pick\.mjs" show <sid> <subject>`/);
  // propose.mjs checks only quotes of the user's words against the session, so nothing else holds an agent to it.
  assert.match(text, /Propose only from what happened in this session, never from a brief, a skill or the task itself\./);
});

test('a session no domain reaches gets its note within budget, naming the script that sets the mode', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-uncovered-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sid = sessionId();
  const text = notesOf(makeVault(t).startSession(sid, { cwd: dir }), sid, /no domain/);
  assert.ok(text.length <= 850, `the no-domain note is ${text.length} characters:\n${text}`);
  assert.match(text, /`node "<T>\/proposals\.mjs" <sid>`/);
});
