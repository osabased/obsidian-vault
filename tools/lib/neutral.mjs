import fs from 'node:fs';
import path from 'node:path';
import { escapeRegExp } from './rules.mjs';

// The core, skills, tests and AGENTS.md name no domain, so a domain named like a word in them would read as one there.
const SCANNED = ['tools', '.claude/skills', 'test', 'AGENTS.md'];
const SKIPPED = new Set(['node_modules', '.git']);

function filesUnder(p) {
  if (!fs.existsSync(p)) return [];
  if (!fs.statSync(p).isDirectory()) return [p];
  return fs.readdirSync(p, { recursive: true, withFileTypes: true })
    .filter(e => e.isFile() && !path.relative(p, e.parentPath).split(path.sep).some(s => SKIPPED.has(s)))
    .map(e => path.join(e.parentPath, e.name));
}

// One line per place a domain's key, or its title when that has more than one word, appears: file:line: what.
export function namedIn(root, domains) {
  const terms = Object.entries(domains).flatMap(([key, d]) => {
    const words = String(d?.title ?? '').trim().split(/\s+/).filter(Boolean);
    return [
      { what: `key "${key}"`, re: new RegExp(`(?<![\\w-])${escapeRegExp(key)}(?![\\w-])`, 'gi') },
      ...(words.length > 1 ? [{ what: `title "${words.join(' ')}"`, re: new RegExp(`(?<!\\w)${words.map(w => escapeRegExp(w)).join('\\s+')}(?!\\w)`, 'gi') }] : []),
    ];
  });
  const hits = [];
  for (const scanned of SCANNED) {
    for (const file of filesUnder(path.join(root, scanned))) {
      const text = fs.readFileSync(file, 'utf8');
      if (text.includes('\0')) continue;
      for (const { what, re } of terms) {
        for (const m of text.matchAll(re)) hits.push(`${path.relative(root, file).replace(/\\/g, '/')}:${text.slice(0, m.index).split('\n').length}: ${what}`);
      }
    }
  }
  return hits;
}
