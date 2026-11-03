import { appendLog, fromRoot, readJsonSafe, safeId } from './lib/vault.mjs';
import { KEY_RE, readNote, keyOf, isUrl, rawFile, loadNotes } from './lib/rules.mjs';
import { build } from './lib/build.mjs';
import { UsageError, readInput, schemaOf, schemaArg } from './lib/input.mjs';
import { currentSession, shortName } from './lib/agents.mjs';
import { registry } from './lib/sessions.mjs';

const USAGE = `usage: node tools/log.mjs <page>
       node tools/log.mjs ingest [--batch] <source> <page>...
       node tools/log.mjs query "<question>" <page>...
A page is wiki/<domain>/<folder>/<slug>.md, or its full path. A source is a file under raw/ or a URL.`;

const FIELDS = [
  { name: 'pages', type: 'string[]', required: true, help: ['the pages written, each wiki/<domain>/<folder>/<slug>.md or its full path; exactly one unless ingest or query is given'] },
  { name: 'ingest', type: 'string', help: ['a file under raw/ or a URL: logs an ingest of it that wrote pages'] },
  { name: 'batch', type: 'boolean', help: ['true with ingest, for an ingest done without the user'] },
  { name: 'query', type: 'string', help: ['the question an answer was filed back for in pages; instead of ingest'] },
];
const SUMMARY = 'Logs one operation in log.md and rebuilds index.md: a page you changed on its own (pages alone), an ingest of a source (ingest, pages), or an answer filed back as a page (query, pages).';

// The argv form's words, so both forms go through entry() and log the same line.
function argvOf(p) {
  const bad = why => { throw new UsageError(why); };
  const extra = Object.keys(p).find(k => !FIELDS.some(f => f.name === k));
  if (extra) bad(`${extra} isn't a field.`);
  if (!Array.isArray(p.pages) || !p.pages.length || p.pages.some(x => typeof x !== 'string')) bad('pages must be a list of at least one page.');
  if (p.ingest !== undefined && p.query !== undefined) bad('give at most one of ingest and query.');
  if (p.batch !== undefined && (typeof p.batch !== 'boolean' || p.ingest === undefined)) bad('batch is true or false, and goes with ingest.');
  if (p.ingest !== undefined) return typeof p.ingest === 'string' ? ['ingest', ...(p.batch ? ['--batch'] : []), p.ingest, ...p.pages] : bad('ingest must be a string.');
  if (p.query !== undefined) return typeof p.query === 'string' ? ['query', p.query, ...p.pages] : bad('query must be a string.');
  if (p.pages.length !== 1) bad('a page alone takes exactly one page.');
  return p.pages;
}

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

const args = process.argv.slice(2);
try {
  if (schemaArg(args)) {
    console.log(JSON.stringify(schemaOf(SUMMARY, FIELDS)));
    process.exit(0);
  }
  const json = args[0] === '--json';
  if (json && args.length > 2) throw new UsageError();
  const line = entry(json ? argvOf(readInput()) : args);
  // Built first, so a failed build logs nothing and a retry doesn't log the operation twice.
  build();
  const sid = json ? args[1] : undefined;
  const own = sid ? { id: sid, agent: readJsonSafe(registry(safeId(sid)))?.agent } : currentSession();
  appendLog([`${line}${own ? ` · session ${shortName(own.id, own.agent)}` : ''}`]);
  console.log(`Logged in log.md: ${line}\nRebuilt index.md.`);
} catch (e) {
  if (e instanceof UsageError) {
    console.error(e.message ? `${e.message}
${USAGE}` : USAGE);
    process.exitCode = 2;
  } else {
    console.error(`Not logged: ${e.message}`);
    process.exitCode = 1;
  }
}
