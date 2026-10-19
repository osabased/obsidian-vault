import { lint, tally } from './lib/lint.mjs';

const args = process.argv.slice(2);
const LEVELS = ['error', 'warn'];

if (args.length && !(args.length === 2 && args[0] === '--fail-on' && LEVELS.includes(args[1]))) {
  console.error('usage: node tools/lint.mjs [--fail-on error|warn]');
  process.exit(2);
}
const failOn = args[1] ?? 'error';

try {
  const found = lint();
  for (const f of found) console.log(`${f.level} ${f.file}: ${f.msg}`);
  console.log(tally(found));
  const errors = found.some(f => f.level === 'error');
  if (errors || (failOn === 'warn' && found.length)) process.exitCode = 1;
} catch (e) {
  console.error(`lint failed: ${e.message}`);
  process.exitCode = 1;
}
