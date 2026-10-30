import path from 'node:path';
import { appendLog, vaultRel } from './lib/vault.mjs';
import { KEY_RE, readNote, keyOf, isUrl, rawFile, loadNotes } from './lib/rules.mjs';
import { build } from './lib/build.mjs';
import { UsageError } from './lib/input.mjs';

const USAGE = `usage: node tools/log.mjs <page>
       node tools/log.mjs ingest [--batch] <source> <page>...
       node tools/log.mjs query "<question>" <page>...
A page is wiki/<domain>/<folder>/<slug>.md, or its full path. A source is a file under raw/ or a URL.`;

// A session outside the vault passes full paths.
const fromRoot = ref => (path.isAbsolute(ref) && vaultRel(ref)) || ref;

let notes;
function pageKey(ref) {
  const key = keyOf(fromRoot(ref));
  if (!KEY_RE.test(key)) throw new UsageError();
  const n = readNote(key, notes ??= loadNotes());
  if (n?.type !== 'page') throw new Error(`${n ? `${n.rel} is not a page` : `${ref} has no note`}.`);
  return key;
}

function sourceRef(ref) {
  if (isUrl(ref)) return ref;
  const rel = rawFile(fromRoot(ref));
  if (!rel) throw new Error(`${ref} is not a URL or a file under raw/ that exists.`);
  return rel;
}

const pageList = refs => [...new Set(refs.map(pageKey))].join(', ');

// One line per operation, naming every page it wrote, so log.md reads as what happened rather than file by file.
function entry([cmd, ...rest]) {
  if (cmd === 'ingest') {
    const batch = rest[0] === '--batch';
    const [source, ...pages] = batch ? rest.slice(1) : rest;
    if (!source || !pages.length) throw new UsageError();
    return `ingest ${sourceRef(source)}${batch ? ' · batch' : ''} · pages ${pageList(pages)}`;
  }
  if (cmd === 'query') {
    const [question = '', ...pages] = rest;
    const asked = question.replace(/\s+/g, ' ').trim();
    if (!asked || !pages.length) throw new UsageError();
    return `query "${asked}" · filed in ${pageList(pages)}`;
  }
  if (cmd === undefined || rest.length) throw new UsageError();
  return `wrote page ${pageKey(cmd)}`;
}

try {
  const line = entry(process.argv.slice(2));
  // Built first, so a failed build logs nothing and a retry doesn't log the operation twice.
  build();
  const sid = process.env.CLAUDE_CODE_SESSION_ID;
  appendLog([`${line}${sid ? ` · session ${sid.slice(0, 8)}` : ''}`]);
  console.log(`Logged in log.md: ${line}\nRebuilt index.md.`);
} catch (e) {
  if (e instanceof UsageError) {
    console.error(USAGE);
    process.exitCode = 2;
  } else {
    console.error(`Not logged: ${e.message}`);
    process.exitCode = 1;
  }
}
