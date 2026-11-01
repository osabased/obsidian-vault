import fs from 'node:fs';
import path from 'node:path';
import { vaultPath, readJsonSafe, writeText, shortHash, toPosix, logError, config, filesIn } from './vault.mjs';
import { checkDeadline } from './deadline.mjs';
import { changedFiles } from './git.mjs';

// Reading and hashing every note costs more than a hook may spend, so each note's parsed text is kept in .state/cache/,
// one file per folder of wiki/, and read again only when its size or mtime changes. Each entry also keeps when its text
// was first seen, which settling reads, and whether git last found it unchanged from HEAD.

const CACHE = ['.state', 'cache'];
// A file saved within this long of being read may change again within the same mtime on a coarse file system, so it
// is read once more on a later call.
export const RACY_MS = 2000;
// Whether a file stat'ed at `at` with this mtime may yet change and keep it, so it must be read again.
export const isRacy = (at, mtimeMs) => Math.abs(at - mtimeMs) < RACY_MS;

// The config names domains in NFC and a folder may be stored NFD, so a folder goes by its NFC name.
const nfc = s => s.normalize('NFC');
const bucketOf = rel => {
  const parts = rel.split('/');
  return parts.length > 2 ? nfc(parts[1]) : '';
};
// Names starting with a dot are never walked, so .root can't be a folder's file.
const cacheFile = b => vaultPath(...CACHE, `${b === '' ? '.root' : /^[\p{L}\p{N}_-]+$/u.test(b) ? b : shortHash(b)}.json`);
const readBucket = (b, stamp) => {
  const c = readJsonSafe(cacheFile(b));
  return c?.stamp === stamp && c.notes && typeof c.notes === 'object' ? c.notes : {};
};

// The cache only saves reading time, so a write that fails (a read-only .state, a full disk, a file another program
// holds) leaves what this call read to this call, and is logged once.
let unsaved = false;

// Two hooks may write one file at once. Each entry it holds is the one read last, and a note gone from the folder this
// call walked is dropped.
function saveBucket(b, stamp, found, dropped) {
  const notes = readBucket(b, stamp);
  for (const [rel, e] of Object.entries(found)) if (!notes[rel] || notes[rel].at <= e.at) notes[rel] = e;
  for (const rel of dropped) delete notes[rel];
  try {
    writeText(cacheFile(b), JSON.stringify({ stamp, notes }));
  } catch (e) {
    if (!unsaved) logError('note cache', e);
    unsaved = true;
  }
}

function mdFiles(dir, deep) {
  const out = [];
  const walk = d => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch {}
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) { if (deep) walk(full); } else if (e.isFile() && /\.md$/i.test(e.name)) out.push(full);
    }
  };
  walk(dir);
  return out;
}

// The notes under wiki/<bucket>/ for each bucket named, or under all of wiki/ when buckets is null, as
// { rel, m, s, h, seen, at, clean, note }, where note is what read(rel, text) gave when the text was last read.
// stamp names the reader's version, so a cache another version of read wrote is read afresh.
export function cachedNotes(buckets, read, stamp) {
  const root = vaultPath('wiki');
  let tops = [];
  try { tops = fs.readdirSync(root, { withFileTypes: true }); } catch {}
  const dirs = new Map(tops.filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => [nfc(e.name), e.name]));
  const names = buckets
    ? [...new Set(buckets.filter(b => typeof b === 'string').map(nfc))].filter(b => b && !b.startsWith('.'))
    : ['', ...dirs.keys()];
  const out = [];
  for (const b of names) {
    const old = readBucket(b, stamp);
    const found = {};
    let changed = false;
    let whole = false;
    const files = b === '' ? mdFiles(root, false) : dirs.has(b) ? mdFiles(path.join(root, dirs.get(b)), true) : [];
    // A walk the deadline stops keeps what it read, and drops none of the notes it didn't reach.
    try {
      for (const full of files) {
        checkDeadline();
        const rel = `wiki/${path.relative(root, full).split(path.sep).join('/')}`;
        const e = old[rel];
        let st;
        let text;
        // A file another program holds for a moment keeps its last entry, but a note never read can't be served.
        try {
          st = fs.statSync(full, { throwIfNoEntry: false });
          if (!st) continue;
          // A file dated in the future would otherwise never be trusted.
          if (e && e.m === st.mtimeMs && e.s === st.size && !isRacy(e.at, e.m)) {
            found[rel] = e;
            continue;
          }
          text = fs.readFileSync(full, 'utf8');
        } catch (err) {
          if (err.code === 'ENOENT') continue;
          if (!e) throw err;
          found[rel] = e;
          continue;
        }
        const same = e && e.m === st.mtimeMs && e.s === st.size;
        const now = Date.now();
        const h = shortHash(text);
        const kept = e?.h === h;
        found[rel] = { m: st.mtimeMs, s: st.size, h, seen: kept ? e.seen : now, at: now, ...(kept && same && e.clean !== undefined ? { clean: e.clean } : {}), note: read(rel, text) };
        changed = true;
      }
      whole = true;
    } finally {
      const dropped = whole ? Object.keys(old).filter(rel => !found[rel]) : [];
      if (changed || dropped.length) saveBucket(b, stamp, found, dropped);
    }
    for (const [rel, e] of Object.entries(found)) out.push({ rel, ...e });
  }
  return out;
}

// The modified time of every note in wiki/ outside the folders skipped, from a stat of each file: the cache files hold
// whole notes, so reading them all would cost more.
export function noteTimes(skip = []) {
  const root = vaultPath('wiki');
  const skipped = new Set(skip.map(nfc));
  let tops = [];
  try { tops = fs.readdirSync(root, { withFileTypes: true }); } catch {}
  const dirs = tops.filter(e => e.isDirectory() && !e.name.startsWith('.') && !skipped.has(nfc(e.name)));
  const times = [];
  for (const full of [...mdFiles(root, false), ...dirs.flatMap(e => mdFiles(path.join(root, e.name), true))]) {
    checkDeadline();
    const st = fs.statSync(full, { throwIfNoEntry: false });
    if (st) times.push(st.mtimeMs);
  }
  return times;
}

// Asks git once which notes differ from HEAD, for the notes whose files changed since it last answered, and keeps the
// answer. A note git can't answer for counts as changed, so it settles the other two ways.
export function cleanFromGit(notes, stamp) {
  const unknown = notes.filter(n => n.clean === undefined);
  if (!unknown.length) return;
  const changed = changedFiles(vaultPath(), [vaultPath('wiki')], { ignored: true });
  const dirty = changed && new Set(changed.map(p => p.toLowerCase()));
  for (const n of unknown) n.clean = Boolean(dirty) && !dirty.has(toPosix(vaultPath(...n.rel.split('/'))).toLowerCase());
  const byBucket = Map.groupBy(unknown, n => bucketOf(n.rel));
  for (const [b, ns] of byBucket) {
    const notes = readBucket(b, stamp);
    const found = {};
    for (const n of ns) if (notes[n.rel]?.h === n.contentHash) found[n.rel] = { ...notes[n.rel], clean: n.clean };
    if (Object.keys(found).length) saveBucket(b, stamp, found, []);
  }
}

// A dot name, so no folder of wiki/ shares the file.
const BUILT = () => vaultPath(...CACHE, '.built.json');
const CONFIG = '.config';
const REFS = '.refs';
const CODE = '.derive';

// derived.json is a product of the code that derives it too: a commit that changes how derive reads the chains or the
// notes must not keep the file the old code wrote. This names that code, as the note cache's stamp names its reader.
let deriveStamp;
const codeStamp = () => (deriveStamp ??= shortHash(['sources.mjs', 'rules.mjs', 'frontmatter.mjs']
  .map(f => fs.readFileSync(path.join(import.meta.dirname, f), 'utf8')).join('\0')));

// The path, size and mtime of each file in raw/refs/, hashed. Derive reads every copy there, and a copy pulled from
// another machine changes no note, so a build skips derive only while this holds too.
export function refStats() {
  const root = vaultPath('raw', 'refs');
  const lines = [];
  for (const rel of filesIn(root)) {
    checkDeadline();
    const st = fs.statSync(path.join(root, ...rel.split('/')), { throwIfNoEntry: false });
    if (st) lines.push(`${rel}\0${st.size}\0${st.mtimeMs}`);
  }
  return shortHash(lines.sort().join('\n'));
}

// What each folder of wiki/ held, as one hash per folder of its notes' paths and texts, the config a build reads,
// raw/refs/ as refStats gives it, and the code that derives from them. A domain's paths differ per machine and shape no generated file.
function fingerprints(notes, refs) {
  const c = config();
  const domains = Object.fromEntries(Object.entries(c.domains).map(([d, { paths, ...x }]) => [d, x]));
  const by = Map.groupBy(notes, n => bucketOf(n.rel));
  return new Map([
    [CONFIG, shortHash(JSON.stringify({ ...c, domains }))],
    [REFS, refs],
    [CODE, codeStamp()],
    ...[...by].map(([b, ns]) => [b, shortHash(ns.map(n => `${n.rel}\0${n.contentHash}`).sort().join('\n'))]),
  ]);
}

// Whether the config, raw/refs/, the derive code, or a note in the folders walked, changed since the last build that markBuilt recorded.
export function changedSinceBuild(notes, buckets, refs = refStats()) {
  const built = readJsonSafe(BUILT());
  if (!built || typeof built !== 'object') return true;
  const now = fingerprints(notes, refs);
  const names = buckets ? new Set([CONFIG, REFS, CODE, ...buckets.map(nfc)]) : new Set([...Object.keys(built), ...now.keys()]);
  return [...names].some(b => (built[b] ?? '') !== (now.get(b) ?? ''));
}

export const markBuilt = (notes, refs = refStats()) => writeText(BUILT(), JSON.stringify(Object.fromEntries(fingerprints(notes, refs))));
