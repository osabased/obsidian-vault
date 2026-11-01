import path from 'node:path';
import { config, vaultPath, vaultRel, writeText, plural } from './lib/vault.mjs';
import { rawFile, clip } from './lib/rules.mjs';
import { plainSafe, yamlQuote } from './lib/frontmatter.mjs';
import { hashFile, derivedText, clockTime, isAnchor } from './lib/sources.mjs';
import { sourceTexts } from './lib/quotes.mjs';
import { loadExtractor } from './lib/extractors.mjs';
import { unallowedSecrets, secretLine } from './lib/secrets.mjs';

const USAGE = `usage: node tools/extract.mjs <file>... [--force]
Writes derived/<sha256>.md, the text of each binary file under raw/, with the first extractor in vault.config.json's
extractors that reads its extension. --force extracts again when the text is already the extractor's.`;

// A bad result from an extractor: its line is failed, and nothing is written for that file.
class Failed extends Error {}

const fromRoot = ref => (path.isAbsolute(ref) && vaultRel(ref)) || ref;
const field = s => (plainSafe(s) ? s : yamlQuote(s));

// The parts of one shape, with pages or times that rise, so the anchors the core writes are ones lint can read back.
function checked(name, mod, result) {
  if (!result || typeof result !== 'object') throw new Failed(`${name} returned no result`);
  const { kind, parts } = result;
  if (!mod.kinds.includes(kind)) throw new Failed(`${name} returned kind ${JSON.stringify(kind)}, which isn't in its kinds`);
  if (!Array.isArray(parts) || !parts.length) throw new Failed(`${name} returned no parts`);
  let shape;
  let last = -1;
  for (const p of parts) {
    if (!p || typeof p !== 'object' || typeof p.text !== 'string') throw new Failed(`${name} returned a part with no text`);
    if ('page' in p && 't' in p) throw new Failed(`${name} returned a part with both page and t`);
    const s = 'page' in p ? 'page' : 't' in p ? 't' : 'text';
    if (shape && s !== shape) throw new Failed(`${name} returned parts of more than one shape`);
    shape = s;
    if (s === 'page' && !(Number.isInteger(p.page) && p.page >= 1)) throw new Failed(`${name} returned page ${p.page}`);
    if (s === 't' && !(Number.isInteger(p.t) && p.t >= 0)) throw new Failed(`${name} returned t=${p.t}, not whole seconds`);
    const at = p[s];
    if (s !== 'text' && at <= last) throw new Failed(`${name} returned ${s === 'page' ? `page ${at} after page ${last}` : `t=${at} after t=${last}`}`);
    last = at;
    const anchor = p.text.split(/\r?\n/).find(isAnchor);
    if (anchor !== undefined) throw new Failed(`${name} returned text with a line that reads as an anchor: ${clip(anchor.trim(), 40)}`);
  }
  return { kind, parts, shape };
}

function rendered(name, version, rel, { kind, parts }) {
  const head = ['---', `kind: ${field(kind)}`, `extractor: ${field(name)}`, `extractor_version: ${yamlQuote(version)}`, `source: ${field(rel)}`, '---', ''];
  const body = parts.map(p => {
    const anchor = 'page' in p ? `[p. ${p.page}]\n` : 't' in p ? `[t=${clockTime(p.t)}]\n` : '';
    return `${anchor}${p.text.replace(/\r\n?/g, '\n')}\n`;
  });
  return head.join('\n') + body.join('');
}

async function extractOne(rel, extractors, force) {
  if (sourceTexts(rel)) return `skipped ${rel}: it is text, so quotes are checked against it as it is`;
  const ext = path.posix.extname(rel).toLowerCase();
  const chosen = extractors.find(x => x.mod.extensions.includes(ext));
  if (!chosen) return `failed ${rel}: no extractor in extractors reads ${ext || 'a file with no extension'}`;
  const { name, mod } = chosen;
  const hash = hashFile(rel);
  const out = `derived/${hash}.md`;
  const old = derivedText(hash);
  const same = old && old.data.extractor === name && String(old.data.extractor_version) === mod.version;
  if (same && !force) return `unchanged ${rel}: ${out}`;
  let result;
  try {
    result = await mod.extract(vaultPath(...rel.split('/')));
  } catch (e) {
    return `failed ${rel}: ${name} threw: ${e?.message ?? e}`;
  }
  let text;
  let count;
  try {
    const ok = checked(name, mod, result);
    text = rendered(name, mod.version, rel, ok);
    count = plural(ok.parts.length, ok.shape === 'page' ? 'page' : 'part');
  } catch (e) {
    if (e instanceof Failed) return `failed ${rel}: ${e.message}`;
    throw e;
  }
  const secrets = unallowedSecrets(text, { derived: true });
  // Nothing is written, so scan.mjs would skip the file. The findings are listed here as scan.mjs lists them, with lines
  // counted in the text extract would have written, so the user can remove or allow each one.
  if (secrets.length) {
    const found = secrets.map(x => secretLine(rel, x));
    const it = secrets.length === 1 ? 'it' : 'them';
    return [`failed ${rel}: its text holds ${plural(secrets.length, 'key- or token-shaped value')}. Remove ${it}, or add an allow id to privacy.allow in vault.config.json if it isn't a secret, then extract again:`, ...found].join('\n');
  }
  writeText(vaultPath('derived', `${hash}.md`), text);
  if (!old || same) return `wrote ${rel}: ${out} (${name} ${mod.version}, ${count})`;
  return `replaced ${rel}: ${out} (${name} ${mod.version} over ${old.data.extractor} ${old.data.extractor_version})`;
}

async function main(args) {
  if (args.includes('--help')) return console.log(USAGE);
  const flags = args.filter(a => a.startsWith('--'));
  const unknown = flags.find(f => f !== '--force');
  const refs = args.filter(a => !a.startsWith('--'));
  if (unknown || !refs.length) {
    console.error(unknown ? `${unknown} isn't a flag extract.mjs takes.\n${USAGE}` : USAGE);
    process.exitCode = 2;
    return;
  }
  const rels = [];
  for (const ref of refs) {
    const rel = rawFile(fromRoot(ref));
    if (!rel) {
      console.error(`${ref} is not a file under raw/.\n${USAGE}`);
      process.exitCode = 2;
      return;
    }
    rels.push(rel);
  }
  const names = config().extractors;
  const loaded = (Array.isArray(names) ? names : []).map(name => ({ name, ...loadExtractor(name) }));
  const problems = loaded.flatMap(x => x.problems ?? []);
  if (problems.length) {
    console.error(`${problems.join('\n')}\nFix vault.config.json's extractors, which node tools/lint.mjs checks, then extract again.`);
    process.exitCode = 1;
    return;
  }
  const lines = [];
  for (const rel of rels) lines.push(await extractOne(rel, loaded, flags.includes('--force')));
  console.log(lines.join('\n'));
  if (lines.some(l => l.startsWith('failed '))) process.exitCode = 1;
}

try {
  await main(process.argv.slice(2));
} catch (e) {
  console.error(`extract failed: ${e.message}`);
  process.exitCode = 2;
}
