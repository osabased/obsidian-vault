import { appendLog } from './lib/vault.mjs';
import { keyOf } from './lib/rules.mjs';
import { lint, tally, fix } from './lib/lint.mjs';

const args = process.argv.slice(2);
const LEVELS = ['error', 'warn'];
const fixAt = args.indexOf('--fix');
const rest = fixAt < 0 ? args : args.toSpliced(fixAt, 1);

if (rest.length && !(rest.length === 2 && rest[0] === '--fail-on' && LEVELS.includes(rest[1]))) {
  console.error(`usage: node tools/lint.mjs [--fix] [--fail-on error|warn]
--fix rewrites the link, footnote and source paths lint gives the spelling of, and rebuilds the generated files.`);
  process.exit(2);
}
const failOn = rest[1] ?? 'error';

try {
  let found = lint();
  if (fixAt >= 0) {
    const { fixed, written, rebuilt } = fix(found);
    for (const f of fixed) console.log(`fixed ${f.file}: ${f.msg}`);
    for (const name of rebuilt) console.log(`rebuilt ${name}`);
    if (written.length) {
      const sid = process.env.CLAUDE_CODE_SESSION_ID;
      appendLog([`fixed paths · notes ${written.map(keyOf).sort().join(', ')}${sid ? ` · session ${sid.slice(0, 8)}` : ''}`]);
    }
    found = lint();
  }
  for (const f of found) console.log(`${f.level} ${f.file}: ${f.msg}`);
  console.log(tally(found));
  const errors = found.some(f => f.level === 'error');
  if (errors || (failOn === 'warn' && found.length)) process.exitCode = 1;
} catch (e) {
  console.error(`lint failed: ${e.message}`);
  process.exitCode = 1;
}
