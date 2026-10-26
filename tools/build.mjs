import { build } from './lib/build.mjs';

const args = process.argv.slice(2);
const check = args[0] === '--check';

if (args.length > (check ? 1 : 0)) {
  console.error('usage: node tools/build.mjs [--check]');
  process.exit(2);
}

try {
  const names = build({ check });
  if (!names.length) {
    console.log('up to date');
  } else if (check) {
    console.log(`stale: ${names.join(', ')}`);
    process.exitCode = 1;
  } else {
    console.log(`wrote ${names.join(', ')}`);
  }
} catch (e) {
  console.error(`build failed: ${e.message}`);
  process.exitCode = 1;
}
