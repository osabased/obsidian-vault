import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { namedIn } from '../tools/lib/neutral.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const CONFIG = path.join(ROOT, 'vault.config.json');
const SKIPPED = new Set(['node_modules', '.git']);

function filesUnder(p) {
  if (!fs.existsSync(p)) return [];
  if (!fs.statSync(p).isDirectory()) return [p];
  return fs.readdirSync(p, { recursive: true, withFileTypes: true })
    .filter(e => e.isFile() && !path.relative(p, e.parentPath).split(path.sep).some(s => SKIPPED.has(s)))
    .map(e => path.join(e.parentPath, e.name));
}

test('no configured domain\'s key or multi-word title appears in the core, skills, tests, AGENTS.md or the reference files', { skip: !fs.existsSync(CONFIG) && 'no vault.config.json' }, () => {
  const hits = namedIn(ROOT, JSON.parse(fs.readFileSync(CONFIG, 'utf8').replace(/^\uFEFF/, '')).domains ?? {});
  assert.deepEqual(hits, [], `${hits.length} lines name a configured domain:\n${hits.join('\n')}`);
});

const ADAPTERS = path.join(ROOT, 'tools', 'adapters');

// The lines the design accepts: the first agent's name, which an entry with no agent and an unset agents list fall back
// to, and the tools/hooks/ shims an installed launcher from before the adapters still runs.
const ACCEPTED = [
  { file: /^tools\/lib\/agents\.mjs$/, line: /^export const FIRST_AGENT = '[a-z0-9_-]+';$/ },
  { file: /^tools\/lib\/vault\.mjs$/, line: /^ *const agents = Array\.isArray\(c\.agents\) \? c\.agents : \['[a-z0-9_-]+'\];$/ },
  { file: /^tools\/hooks\/[^/]+\.mjs$/, line: /^import '\.\.\/adapters\/[a-z0-9_-]+\/hooks\/[a-z0-9_-]+\.mjs';$/ },
];

test('nothing in tools/ outside tools/adapters/ names an agent, its tools or its hook fields', async () => {
  const names = fs.existsSync(ADAPTERS) ? fs.readdirSync(ADAPTERS).filter(n => fs.existsSync(path.join(ADAPTERS, n, 'adapter.mjs'))) : [];
  assert.ok(names.length > 0, 'no adapter in tools/adapters/');
  const ids = [];
  for (const name of names) {
    const { identifiers, sessionVar } = await import(pathToFileURL(path.join(ADAPTERS, name, 'adapter.mjs')).href);
    assert.ok(Array.isArray(identifiers) && identifiers.length, `tools/adapters/${name}/adapter.mjs exports no identifiers`);
    ids.push(...[...identifiers, name, sessionVar].map(id => ({ id, name })));
  }
  const hits = [];
  for (const file of filesUnder(path.join(ROOT, 'tools')).filter(f => path.relative(ADAPTERS, f).startsWith('..'))) {
    const text = fs.readFileSync(file, 'utf8');
    if (text.includes('\0')) continue;
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    text.split('\n').forEach((raw, i) => {
      const line = raw.replace(/\r$/, '');
      if (ACCEPTED.some(a => a.file.test(rel) && a.line.test(line))) return;
      for (const { id, name } of ids) if (line.includes(id)) hits.push(`${rel}:${i + 1}: ${id} (${name})`);
    });
  }
  assert.deepEqual(hits, [], `${hits.length} lines outside tools/adapters/ name an agent:\n${hits.join('\n')}`);
});
