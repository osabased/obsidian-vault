import path from 'node:path';
import { appendLog, vaultRel } from './lib/vault.mjs';
import { KEY_RE, readNote, toKey, build } from './lib/rules.mjs';

const USAGE = 'usage: node tools/log.mjs wiki/<domain>/<slug>.md, or the page\'s full path';

class UsageError extends Error {}

function logPage(ref) {
  // A session outside the vault passes the page's full path.
  const key = toKey((path.isAbsolute(ref) && vaultRel(ref)) || ref);
  if (!KEY_RE.test(key)) throw new UsageError();
  const n = readNote(key);
  if (n?.type !== 'page') throw new Error(`wiki/${key}.md is ${n ? 'not a page' : 'missing'}.`);
  // Built first, so a failed build logs nothing and a retry doesn't log the page twice.
  build();
  const sid = process.env.CLAUDE_CODE_SESSION_ID;
  appendLog([`wrote page ${key}${sid ? ` · session ${sid.slice(0, 8)}` : ''}`]);
  return `Logged wiki/${key}.md in log.md and rebuilt index.md.`;
}

const args = process.argv.slice(2);
try {
  if (args.length !== 1) throw new UsageError();
  console.log(logPage(args[0]));
} catch (e) {
  if (e instanceof UsageError) {
    console.error(USAGE);
    process.exitCode = 2;
  } else {
    console.error(`Not logged: ${e.message}`);
    process.exitCode = 1;
  }
}
