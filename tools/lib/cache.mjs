import fs from 'node:fs';
import path from 'node:path';
import { vaultPath, readJsonSafe, writeText, shortHash, toPosix } from './vault.mjs';
import { checkDeadline } from './deadline.mjs';
import { changedFiles } from './git.mjs';

// Reading and hashing every note costs more than a hook may spend, so each note's parsed text is kept in .state/cache/,
// one file per folder of wiki/, and read again only when its size or mtime changes. Each entry also keeps when its text
// was first seen, which settling reads, and whether git last found it unchanged from HEAD.

const CACHE = ['.state', 'cache'];
// A file saved within this long of being read may change again within the same mtime on a coarse file system, so it
// is read once more on a later call.
const RACY_MS = 2000;

const bucketOf = rel => {
  const parts = rel.split('/');
  return parts.length > 2 ? parts[1] : '';
};
// Names starting with a dot are never walked, so .root can't be a folder's file.
const cacheFile = b => vaultPath(...CACHE, `${b === '' ? '.root' : /^[\p{L}\p{N}_-]+$/u.test(b) ? b : shortHash(b)}.json`);
const readBucket = (b, stamp) => {
  const c = readJsonSafe(cacheFile(b));
  return c?.stamp === stamp && c.notes && typeof c.notes === 'object' ? c.notes : {};
};

// Two hooks may write one file at once. Each entry it holds is the one read last, and a note gone from the folder this
// call walked is dropped.
function saveBucket(b, stamp, found, dropped) {
  const notes = readBucket(b, stamp);
  for (const [rel, e] of Object.entries(found)) if (!notes[rel] || notes[rel].at <= e.at) notes[rel] = e;
  for (const rel of dropped) delete notes[rel];
  writeText(cacheFile(b), JSON.stringify({ stamp, notes }));
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
  const dirs = tops.filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => e.name);
  const names = buckets ? [...new Set(buckets)].filter(b => typeof b === 'string' && b && !b.startsWith('.')) : ['', ...dirs];
  const out = [];
  for (const b of names) {
    const old = readBucket(b, stamp);
    const found = {};
    let changed = false;
    const files = b === '' ? mdFiles(root, false) : dirs.includes(b) ? mdFiles(path.join(root, b), true) : [];
    for (const full of files) {
      checkDeadline();
      const rel = `wiki/${path.relative(root, full).split(path.sep).join('/')}`;
      const st = fs.statSync(full, { throwIfNoEntry: false });
      if (!st) continue;
      const e = old[rel];
      const same = e && e.m === st.mtimeMs && e.s === st.size;
      if (same && e.at - e.m >= RACY_MS) {
        found[rel] = e;
        continue;
      }
      let text;
      try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
      const now = Date.now();
      const h = shortHash(text);
      const kept = e?.h === h;
      found[rel] = { m: st.mtimeMs, s: st.size, h, seen: kept ? e.seen : now, at: now, ...(kept && same && e.clean !== undefined ? { clean: e.clean } : {}), note: read(rel, text) };
      changed = true;
    }
    const dropped = Object.keys(old).filter(rel => !found[rel]);
    if (changed || dropped.length) saveBucket(b, stamp, found, dropped);
    for (const [rel, e] of Object.entries(found)) out.push({ rel, ...e });
  }
  return out;
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

const BUILT = () => vaultPath(...CACHE, 'built.json');

// What each folder of wiki/ held, as one hash per folder of its notes' paths and texts.
function fingerprints(notes) {
  const by = Map.groupBy(notes, n => bucketOf(n.rel));
  return new Map([...by].map(([b, ns]) => [b, shortHash(ns.map(n => `${n.rel}\0${n.contentHash}`).sort().join('\n'))]));
}

// Whether a note in the folders walked changed since the last build that markBuilt recorded.
export function changedSinceBuild(notes, buckets) {
  const built = readJsonSafe(BUILT());
  if (!built || typeof built !== 'object') return true;
  const now = fingerprints(notes);
  const names = buckets ? new Set(buckets) : new Set([...Object.keys(built), ...now.keys()]);
  return [...names].some(b => (built[b] ?? '') !== (now.get(b) ?? ''));
}

export const markBuilt = notes => writeText(BUILT(), JSON.stringify(Object.fromEntries(fingerprints(notes))));
