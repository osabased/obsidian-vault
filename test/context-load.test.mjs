import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { namedIn } from '../tools/lib/neutral.mjs';
import { makeVault, sessionId, cleanEnv } from './fixture.mjs';

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

// The notes name tools, not scripts, so no path or session id differs between machines or sessions.
const notesOf = (out, re) => (out?.hookSpecificOutput?.additionalContext ?? '').split('\n\n').filter(b => re.test(b)).join('\n\n');

test('a domain session\'s propose and pick notes stay within budget, name the vault\'s tools and keep what nothing else tells the agent', t => {
  const text = notesOf(makeVault(t).startSession(sessionId()), /`propose` tool|`pick` tool/);
  assert.ok(text.length <= 1600, `the propose and pick notes are ${text.length} characters:\n${text}`);
  // The vault skill finds the tool that sets the mode by the name this note gives it.
  assert.match(text, /through the vault's `propose` tool/);
  assert.match(text, /through the vault's `proposals` tool/);
  assert.match(text, /with the vault's `pick` tool/);
  assert.match(text, /call `pick` with `show` and the subject/);
  assert.doesNotMatch(text, /\.mjs|node "|\bpipe|heredoc|shell/i);
  // propose checks only quotes of the user's words against the session, so nothing else holds an agent to it.
  assert.match(text, /Propose only from what happened in this session, never from a brief, a skill or the task itself\./);
});

test('every mode\'s note names the propose tool and what it takes, with no script path', t => {
  for (const proposals of ['corrections', 'ask', 'off']) {
    const text = notesOf(makeVault(t, { config: { proposals } }).startSession(sessionId()), /`propose` tool/);
    assert.match(text, /through the vault's `propose` tool \(its schema lists the fields\), then end your reply with the lines it returns/, proposals);
    assert.doesNotMatch(text, /\.mjs|approved/, proposals);
  }
  const ask = notesOf(makeVault(t, { config: { proposals: 'ask' } }).startSession(sessionId()), /`propose` tool/);
  assert.match(ask, /offer a rule through the vault's `propose` tool and do what it returns; nothing is written until the user agrees\./);
  const off = notesOf(makeVault(t, { config: { proposals: 'off' } }).startSession(sessionId()), /`propose` tool/);
  assert.match(off, /with their words asking as `asked`\./);
});

test('a session no domain reaches gets its note within budget, naming the tools that set the mode and start a domain', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-uncovered-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const text = notesOf(makeVault(t).startSession(sessionId(), { cwd: dir }), /no domain/);
  assert.ok(text.length <= 850, `the no-domain note is ${text.length} characters:\n${text}`);
  assert.match(text, /through the vault's `proposals` tool/);
  assert.match(text, /vault's `domain` tool/);
  assert.doesNotMatch(text, /\.mjs|node "|\bpipe|heredoc|shell/i);
});

// A client gets every tool's description and schema at connect, so a session pays for them like the notes.
function toolsListed(root, clientInfo) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'mcp', 'launch.mjs'), root], { env: cleanEnv({}), stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { child.kill(); reject(new Error('no tools/list answer in 30 s')); }, 30000);
    let out = '';
    let err = '';
    child.stderr.on('data', d => { err += d; });
    child.stdout.on('data', d => {
      out += d;
      const line = out.split('\n').find(l => l.startsWith('{') && l.includes('"id":2'));
      if (!line) return;
      clearTimeout(timer);
      child.kill();
      resolve(JSON.parse(line).result.tools);
    });
    child.on('exit', () => { clearTimeout(timer); reject(new Error(`the server stopped before it listed its tools: ${err}`)); });
    const send = m => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo } });
    send({ method: 'notifications/initialized' });
    send({ id: 2, method: 'tools/list' });
  });
}

test('the vault\'s tools/list for Claude Code stays within 12,000 characters', async t => {
  const v = makeVault(t);
  fs.cpSync(v.at('tools'), v.at('.live', 'tools'), { recursive: true });
  const tools = await toolsListed(v.root, { name: 'claude-code', version: '2.1.309' });
  assert.deepEqual(tools.map(x => x.name).sort(), ['domain', 'keep', 'log', 'pick', 'proposals', 'propose', 'search', 'status']);
  const sizes = tools.map(x => [x.name, JSON.stringify(x).length]).sort((a, b) => b[1] - a[1]);
  const total = sizes.reduce((sum, [, n]) => sum + n, 0);
  assert.ok(total <= 12000, `tools/list is ${total} characters; by tool: ${sizes.map(s => s.join(' ')).join(', ')}`);
});
