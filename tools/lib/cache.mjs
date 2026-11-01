import fs from 'node:fs';
import path from 'node:path';
import { vaultPath, readJsonSafe, writeText, shortHash, toPosix, logError, config, filesIn } from './vault.mjs';
import { checkDeadline } from './deadline.mjs';
import { changedFiles } from './git.mjs';

// Reading and hashing every note costs more than a hook may spend, so each note's parsed text is kept in .state/cache/,
// one file per folder of wiki/, and read again only when its size or mtime changes. Each entry also keeps when its text
// was first seen, which settling reads, and whether git last found it unchanged from HEAD. The frontmatter of each copy in
// raw/refs/ is kept the same way, in .refs.json.

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
// Names starting with a dot are never walked, so .root and .refs, which holds the copies in raw/refs/, can't be a folder's file.
const REFS_BUCKET = '.refs';
const cacheFile = b => vaultPath(...CACHE, `${b === '' ? '.root' : b === REFS_BUCKET || /^[\p{L}\p{N}_-]+$/u.test(b) ? b : shortHash(b)}.json`);
// A hand edit or a bad sync merge can leave an entry without its times, which would otherwise fail every call until the
// cache is deleted, so an entry of the wrong shape is a miss.
const sound = e => e !== null && typeof e === 'object' && [e.m, e.s, e.at].every(Number.isFinite);
const readBucket = (b, stamp, c = readJsonSafe(cacheFile(b))) => {
  if (c?.stamp !== stamp || !c.notes || typeof c.notes !== 'object') return {};
  return Object.fromEntries(Object.entries(c.notes).filter(([, e]) => sound(e)));
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

// Each bucket named, or every one when buckets is null, with the notes its folder of wiki/ holds.
function walks(root, buckets) {
  let tops = [];
  try { tops = fs.readdirSync(root, { withFileTypes: true }); } catch {}
  const dirs = new Map(tops.filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => [nfc(e.name), e.name]));
  const names = buckets
    ? [...new Set(buckets.filter(b => typeof b === 'string').map(nfc))].filter(b => b && !b.startsWith('.'))
    : ['', ...dirs.keys()];
  return names.map(b => ({ b, files: b === '' ? mdFiles(root, false) : dirs.has(b) ? mdFiles(path.join(root, dirs.get(b)), true) : [] }));
}

// On Windows a stat opens the file, so at thousands of notes, stats taken one at a time are most of a hook's time, and
// taken at once they cost a fraction of it. A hook awaits this and hands the result to cachedNotes. The cache files are
// read while the stats run. A file whose stat failed for any reason but its absence is left out, so cachedNotes stats it
// again and meets the error itself.
export async function noteStats(buckets) {
  const walked = walks(vaultPath('wiki'), buckets);
  const files = walked.flatMap(w => w.files);
  const pending = Promise.all(files.map(f => fs.promises.stat(f).catch(e => (e.code === 'ENOENT' || e.code === 'ENOTDIR' ? null : undefined))));
  const caches = new Map(walked.map(({ b }) => [b, readJsonSafe(cacheFile(b))]));
  const stats = await pending;
  return { walked, caches, stats: new Map(files.map((f, i) => [f, stats[i]]).filter(([, st]) => st !== undefined)) };
}

// The notes under wiki/<bucket>/ for each bucket named, or under all of wiki/ when buckets is null, as
// { rel, m, s, h, seen, at, clean, note }, where note is what read(rel, text) gave when the text was last read.
// stamp names the reader's version, so a cache another version of read wrote is read afresh. pre is noteStats() for
// the same buckets, taken just before; a file its stats don't hold is stat'ed here.
export function cachedNotes(buckets, read, stamp, pre) {
  const root = vaultPath('wiki');
  const stats = pre?.stats ?? new Map();
  const out = [];
  for (const { b, files } of pre?.walked ?? walks(root, buckets)) {
    const old = readBucket(b, stamp, pre?.caches.get(b));
    const found = {};
    let changed = false;
    let whole = false;
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
          st = stats.has(full) ? stats.get(full) : fs.statSync(full, { throwIfNoEntry: false });
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

// What read(rel) gave for each file named, from .state/cache/.refs.json while the file's size and mtime hold, as a Map in
// the order given. Reading every copy in raw/refs/ costs seconds at thousands of copies, so only the ones that changed are
// read. read returns null for a file it can't use, which is never kept, so read sees it again on every call. lstat keys
// the cache, so a file that becomes a link is read again, and so is one whose lstat fails, since read meets the file
// itself. A kept value that fits(value) refuses is read again too.
export function cachedFiles(rels, read, stamp, fits = v => v !== null && typeof v === 'object') {
  const old = readBucket(REFS_BUCKET, stamp);
  const found = {};
  const out = new Map();
  let changed = false;
  let whole = false;
  try {
    for (const rel of rels) {
      checkDeadline();
      const e = old[rel];
      let st = null;
      try { st = fs.lstatSync(vaultPath(...rel.split('/'))); } catch {}
      if (st && e && fits(e.value) && e.m === st.mtimeMs && e.s === st.size && !isRacy(e.at, e.m)) {
        found[rel] = e;
        out.set(rel, e.value);
        continue;
      }
      const value = read(rel);
      if (value === null) continue;
      out.set(rel, value);
      if (!st) continue;
      found[rel] = { m: st.mtimeMs, s: st.size, at: Date.now(), value };
      changed = true;
    }
    whole = true;
  } finally {
    const dropped = whole ? Object.keys(old).filter(rel => !found[rel]) : [];
    if (changed || dropped.length) saveBucket(REFS_BUCKET, stamp, found, dropped);
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
