import fs from 'node:fs';
import path from 'node:path';
import { vaultPath, plural, fromRoot, filesIn } from './lib/vault.mjs';
import { vaultFile, bundleOf } from './lib/rules.mjs';
import { hashPath, fileText } from './lib/sources.mjs';
import { unallowedSecrets, secretLine } from './lib/secrets.mjs';

const USAGE = `usage: node tools/scan.mjs <file or bundle folder>...
Lists the key- and token-shaped values in each file in the vault, or in a bundle, reading a binary through its derived
text. Exits 1 when it finds one that privacy.allow in vault.config.json doesn't allow.`;

// The text a file's quotes come from: its own, or a binary's derived text, whose lines the line numbers count.
function textOf(rel) {
  const file = vaultPath(...rel.split('/'));
  const own = fileText(file);
  if (own !== null) return { text: own, derived: false };
  try { return { text: fs.readFileSync(vaultPath('derived', `${hashPath(file)}.md`), 'utf8'), derived: true }; } catch { return { text: null }; }
}

// A bundle's files from the vault root as the disk spells them, or null when ref isn't a bundle's folder.
function bundleFiles(ref) {
  const marker = vaultFile(`${ref}/source.md`);
  const dir = marker && path.posix.dirname(marker);
  if (!dir || bundleOf(dir) !== dir) return null;
  return filesIn(vaultPath(...dir.split('/')), '', dir).sort();
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
    try {
      const rels = rel ? [rel] : bundleFiles(fromRoot(ref));
      if (!rels) throw new Error('no such file or bundle');
      for (const r of rels) texts.push([r, textOf(r)]);
    } catch {
      console.error(`${ref} is not a file or bundle in the vault that scan.mjs can read.\n${USAGE}`);
      return 2;
    }
  }
  const lines = [];
  const hit = new Set();
  let count = 0;
  for (const [rel, { text, derived }] of texts) {
    if (text === null) {
      lines.push(`skipped ${rel}: it isn't UTF-8 and has no derived text. Run node tools/extract.mjs ${rel}, then scan again.`);
      continue;
    }
    for (const s of unallowedSecrets(text, { derived })) {
      lines.push(secretLine(rel, s));
      hit.add(rel);
      count++;
    }
  }
  lines.push(count
    ? `${plural(count, 'key- or token-shaped value')} in ${plural(hit.size, 'file')}. Remove them, or add an allow id to privacy.allow in vault.config.json if it isn't a secret.`
    : `No key- or token-shaped values in ${plural(texts.filter(([, { text }]) => text !== null).length, 'file')}.`);
  console.log(lines.join('\n'));
  return count ? 1 : 0;
}

try {
  process.exitCode = main(process.argv.slice(2)) ?? 0;
} catch (e) {
  console.error(`scan failed: ${e.message}`);
  process.exitCode = 2;
}
