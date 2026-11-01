import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeRegExp } from '../tools/lib/rules.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const CONFIG = path.join(ROOT, 'vault.config.json');
const SCANNED = ['tools', '.claude/skills', 'test', 'AGENTS.md'];
const SKIPPED = new Set(['node_modules', '.git']);

function filesUnder(p) {
  if (!fs.existsSync(p)) return [];
  if (!fs.statSync(p).isDirectory()) return [p];
  return fs.readdirSync(p, { recursive: true, withFileTypes: true })
    .filter(e => e.isFile() && !path.relative(p, e.parentPath).split(path.sep).some(s => SKIPPED.has(s)))
    .map(e => path.join(e.parentPath, e.name));
}

test('no configured domain\'s key or multi-word title appears in the core, skills, tests or AGENTS.md', { todo: '§3', skip: !fs.existsSync(CONFIG) && 'no vault.config.json' }, () => {
  const domains = JSON.parse(fs.readFileSync(CONFIG, 'utf8').replace(/^﻿/, '')).domains ?? {};
  const terms = Object.entries(domains).flatMap(([key, d]) => {
    const words = String(d.title ?? '').trim().split(/\s+/).filter(Boolean);
    return [
      { what: `key "${key}"`, re: new RegExp(`(?<![\\w-])${escapeRegExp(key)}(?![\\w-])`, 'gi') },
      ...(words.length > 1 ? [{ what: `title "${words.join(' ')}"`, re: new RegExp(`(?<!\\w)${words.map(w => escapeRegExp(w)).join('\\s+')}(?!\\w)`, 'gi') }] : []),
    ];
  });
  const hits = [];
  for (const root of SCANNED) {
    for (const file of filesUnder(path.join(ROOT, root))) {
      const text = fs.readFileSync(file, 'utf8');
      if (text.includes('\0')) continue;
      for (const { what, re } of terms) {
        for (const m of text.matchAll(re)) hits.push(`${path.relative(ROOT, file).replace(/\\/g, '/')}:${text.slice(0, m.index).split('\n').length}: ${what}`);
      }
    }
  }
  assert.deepEqual(hits, [], `${hits.length} lines name a configured domain:\n${hits.join('\n')}`);
});
