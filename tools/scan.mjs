import fs from 'node:fs';
import path from 'node:path';
import { vaultPath, vaultRel, plural } from './lib/vault.mjs';
import { vaultFile } from './lib/rules.mjs';
import { hashPath } from './lib/sources.mjs';
import { utf8Text } from './lib/quotes.mjs';
import { unallowedSecrets, shownSecret } from './lib/secrets.mjs';

const USAGE = `usage: node tools/scan.mjs <file>...
Lists the key- and token-shaped values in each file in the vault, reading a binary through its derived text. Exits 1
when it finds one that privacy.allow in vault.config.json doesn't allow.`;

const fromRoot = ref => (path.isAbsolute(ref) && vaultRel(ref)) || ref;

// The text a file's quotes come from: its own, or a binary's derived text, whose lines the line numbers count.
function textOf(rel) {
  const file = vaultPath(...rel.split('/'));
  const own = utf8Text(fs.readFileSync(file));
  if (own !== null) return own;
  try { return fs.readFileSync(vaultPath('derived', `${hashPath(file)}.md`), 'utf8'); } catch { return null; }
}

function main(args) {
  if (args.includes('--help')) return console.log(USAGE);
  const flag = args.find(a => a.startsWith('--'));
  if (flag || !args.length) {
    console.error(flag ? `${flag} isn't a flag scan.mjs takes.\n${USAGE}` : USAGE);
    return 2;
  }
  const texts = [];
  for (const ref of args) {
    const rel = vaultFile(fromRoot(ref));
    let text;
    try {
      if (!rel) throw new Error('no such file');
      text = textOf(rel);
    } catch {
      console.error(`${ref} is not a file in the vault that scan.mjs can read.\n${USAGE}`);
      return 2;
    }
    texts.push([rel, text]);
  }
  const lines = [];
  const hit = new Set();
  let count = 0;
  for (const [rel, text] of texts) {
    if (text === null) {
      lines.push(`skipped ${rel}: it isn't UTF-8 and has no derived text. Run node tools/extract.mjs ${rel}, then scan again.`);
      continue;
    }
    for (const s of unallowedSecrets(text)) {
      lines.push(`${rel}:${s.line} ${shownSecret(s)} · allow ${s.allow}`);
      hit.add(rel);
      count++;
    }
  }
  lines.push(count
    ? `${plural(count, 'key- or token-shaped value')} in ${plural(hit.size, 'file')}. Remove them, or add an allow id to privacy.allow in vault.config.json if it isn't a secret.`
    : `No key- or token-shaped values in ${plural(texts.filter(([, text]) => text !== null).length, 'file')}.`);
  console.log(lines.join('\n'));
  return count ? 1 : 0;
}

try {
  process.exitCode = main(process.argv.slice(2)) ?? 0;
} catch (e) {
  console.error(`scan failed: ${e.message}`);
  process.exitCode = 1;
}
