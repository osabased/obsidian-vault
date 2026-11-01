import fs from 'node:fs';
import path from 'node:path';
import { vaultPath, plural, fromRoot } from './lib/vault.mjs';
import { vaultFile, bundleOf, diskRel } from './lib/rules.mjs';
import { hashPath, fileText } from './lib/sources.mjs';
import { unallowedSecrets, secretLine } from './lib/secrets.mjs';

const USAGE = `usage: node tools/scan.mjs <file, bundle or doc set folder>...
Lists the key- and token-shaped values in each file in the vault, or in every file of a bundle or doc set, reading a
binary through its derived text. Exits 1 when it finds one that privacy.allow in vault.config.json doesn't allow.`;

// The text a file's quotes come from: its own, or a binary's derived text, whose lines the line numbers count.
function textOf(rel) {
  const file = vaultPath(...rel.split('/'));
  const own = fileText(file);
  if (own !== null) return { text: own, derived: false };
  try { return { text: fs.readFileSync(vaultPath('derived', `${hashPath(file)}.md`), 'utf8'), derived: true }; } catch { return { text: null }; }
}

// Every file under a folder, dotfiles included, since a key in kit/.env sits in raw/ and gets committed like any other.
// Only what git never tracks is left out.
function filesUnder(dir, rel) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    if (e.name === '.git') return [];
    const r = `${rel}/${e.name}`;
    if (e.isDirectory()) return filesUnder(path.join(dir, e.name), r);
    return e.isFile() ? [r] : [];
  });
}

// The files on disk under a source folder, a bundle or a doc set, from the vault root as the disk spells them, or null
// when ref isn't the folder of one.
function sourceFiles(ref) {
  const at = diskRel(ref);
  if (!at?.stat.isDirectory() || bundleOf(at.rel) !== at.rel) return null;
  return filesUnder(vaultPath(...at.rel.split('/')), at.rel).sort();
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
    const rels = rel ? [rel] : sourceFiles(fromRoot(ref));
    if (!rels) {
      console.error(`${ref} is not a file, bundle or doc set in the vault.\n${USAGE}`);
      return 2;
    }
    for (const r of rels) {
      try {
        texts.push([r, textOf(r)]);
      } catch (e) {
        console.error(`${r} can't be read (${e.code ?? e.message}). Close whatever holds it open or fix its permissions, then scan again.`);
        return 2;
      }
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
