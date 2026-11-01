import { appendLog } from './lib/vault.mjs';
import { keyOf } from './lib/rules.mjs';
import { lint, tally, fix } from './lib/lint.mjs';
import { sourceChains } from './lib/sources.mjs';
import { refStats } from './lib/cache.mjs';
import { currentSession } from './lib/agents.mjs';

const args = process.argv.slice(2);
const LEVELS = ['error', 'warn'];
const fixAt = args.indexOf('--fix');
const rest = fixAt < 0 ? args : args.toSpliced(fixAt, 1);

if (rest.length && !(rest.length === 2 && rest[0] === '--fail-on' && LEVELS.includes(rest[1]))) {
  console.error(`usage: node tools/lint.mjs [--fix] [--fail-on error|warn]
--fix rewrites the link, footnote and source paths lint gives the spelling of, writes the skill copies in .agents/skills/ that are missing or differ, and rebuilds the generated files.`);
  process.exit(2);
}
const failOn = rest[1] ?? 'error';

try {
  // --fix rewrites notes only, so the second lint and the rebuild read raw/refs/ as the first did. The stat comes first: a copy
  // saved between the two reads then changes it, and the next session start derives again, where a stat taken after the
  // chains would record the copy as seen.
  const refs = refStats();
  const chains = sourceChains();
  let found = lint(undefined, chains);
  if (fixAt >= 0) {
    const { fixed, written, rebuilt } = fix(found, chains, refs);
    for (const f of fixed) console.log(`fixed ${f.file}: ${f.msg}`);
    for (const name of rebuilt) console.log(`rebuilt ${name}`);
    if (written.length) {
      const sid = currentSession()?.id;
      appendLog([`fixed paths · notes ${written.map(keyOf).sort().join(', ')}${sid ? ` · session ${sid.slice(0, 8)}` : ''}`]);
    }
    found = lint(undefined, chains);
  }
  for (const f of found) console.log(`${f.level} ${f.file}: ${f.msg}`);
  console.log(tally(found));
  const errors = found.some(f => f.level === 'error');
  if (errors || (failOn === 'warn' && found.length)) process.exitCode = 1;
} catch (e) {
  console.error(`lint failed: ${e.message}`);
  process.exitCode = 1;
}
