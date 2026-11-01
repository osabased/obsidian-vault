import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from './frontmatter.mjs';
import { filesIn, vaultPath, memo, config } from './vault.mjs';
import { checkDeadline } from './deadline.mjs';
import {
  isUrl, validDay, rawFile, bundleOf, bundleAbove, folderNames, isDocSet, manifestNames, filled, parsedFile, normUrl, evidenceSources, footnotes, locate, linkedKeys,
  isSourcePage, undelivered, resolver, cmp, isMap, joinList,
} from './rules.mjs';

export const KINDS = ['pdf', 'video', 'audio', 'image'];
export const LOCATORS = 'Use #page=3, #t=00:12:31 or #L10-L20';
const HEX64 = /^[0-9a-f]{64}$/;

const sha256 = data => createHash('sha256').update(data).digest('hex');

const readRel = rel => fs.readFileSync(vaultPath(...rel.split('/')));

// Read in chunks, since a source may be a video too big to hold.
export function hashFile(rel) {
  const hash = createHash('sha256');
  const fd = fs.openSync(vaultPath(...rel.split('/')), 'r');
  try {
    const chunk = Buffer.allocUnsafe(1 << 20);
    for (let n = fs.readSync(fd, chunk, 0, chunk.length, null); n > 0; n = fs.readSync(fd, chunk, 0, chunk.length, null)) hash.update(chunk.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

// The lines a footnote may point at, so a binary or a file another program holds open has none.
export function lineCount(rel) {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(readRel(rel));
    if (text.includes('\0')) return null;
    return text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0;
  } catch {
    return null;
  }
}

// W3C Media Fragments: seconds, mm:ss or hh:mm:ss, with an optional fraction.
function npt(s) {
  const m = s.match(/^(?:(?:(\d+):)?([0-5]?\d):([0-5]\d)|(\d+))(?:\.\d+)?$/);
  if (!m) return null;
  return m[4] !== undefined ? Number(m[4]) : Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

export const clockTime = s => {
  const pad = n => String(n).padStart(2, '0');
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
};

const CLOCK = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/;
const BAD_TIME = 'Write a time as #t=hh:mm:ss, or in seconds';

function timeLocator(value) {
  if (value.startsWith('clock:')) {
    const parts = value.slice(6).split(',');
    return parts.length <= 2 && parts.every(p => CLOCK.test(p)) ? { kind: 'clock' } : { problem: BAD_TIME };
  }
  const parts = value.replace(/^npt:/, '').split(',');
  const [from, to] = parts;
  const start = from === '' ? null : npt(from);
  const end = parts.length === 2 ? npt(to) : null;
  if (parts.length > 2 || (from !== '' && start === null) || (parts.length === 2 ? end === null : from === '')) return { problem: BAD_TIME };
  if (start !== null && end !== null && end <= start) return { problem: 'A time range ends after it starts' };
  return { kind: 'time', start };
}

// A fragment that begins page=, t= or L and a digit is a locator and is checked; null is any other fragment.
export function parseLocator(fragment) {
  if (fragment.startsWith('page=')) {
    const page = fragment.slice(5);
    return /^[1-9]\d*$/.test(page) ? { kind: 'page', page: Number(page) } : { problem: 'A page is a number of 1 or more, as #page=3' };
  }
  if (fragment.startsWith('t=')) return timeLocator(fragment.slice(2));
  if (/^L\d/.test(fragment)) {
    const m = fragment.match(/^L(\d+)(?:-L(\d+))?$/);
    if (!m) return { problem: 'Write a line range as #L10-L20' };
    const [from, to] = [Number(m[1]), Number(m[2] ?? m[1])];
    if (!from) return { problem: 'Lines count from 1, as #L10 or #L10-L20' };
    return to < from ? { problem: 'A line range ends after it starts, as #L10-L20' } : { kind: 'lines', from, to };
  }
  return null;
}

// Page anchors [p. 3] and time anchors [t=00:12:31], as the seconds and numbers they stand for, and the ones that
// start like an anchor but aren't one.
export function anchorsIn(text) {
  const pages = new Set();
  const times = new Set();
  const bad = new Set();
  for (const [anchor] of text.matchAll(/\[(?:p\.|t=)[^\]\n]*\]/g)) {
    const page = anchor.match(/^\[p\. ([1-9]\d*)\]$/);
    const time = anchor.match(/^\[t=(\d\d+):([0-5]\d):([0-5]\d)\]$/);
    if (page) pages.add(Number(page[1]));
    else if (time) times.add(Number(time[1]) * 3600 + Number(time[2]) * 60 + Number(time[3]));
    else bad.add(anchor);
  }
  return { pages, times, bad: [...bad] };
}

export function derivedAnchors(hash) {
  const parsed = parsedFile(`derived/${hash}.md`);
  return parsed && anchorsIn(parsed.body);
}

// A relative path that stays inside its folder.
const insideFolder = p => !p.startsWith('/') && !p.split('/').includes('..') && !p.includes('\\');

// sha256sum's lines: the hash, two spaces, then the path from the bundle folder.
export function manifestLine(line) {
  const m = typeof line === 'string' ? line.match(/^([0-9a-f]{64}) {2}(\S.*)$/) : null;
  const file = m?.[2].replace(/^\.\//, '');
  return m && insideFolder(file) ? { hash: m[1], file } : null;
}

// The shape of the fields a saved source or a bundle's source.md starts with. Each is checked when it is there;
// a file's sha256 is the hash of what follows its frontmatter, and a bundle's is a list of lines, checked apart.
// replaces is checked only given the file's path and sourceChains().
export function sourceProblems(data, { body, bundle = false, rel, chains } = {}) {
  const out = [];
  const has = k => data[k] != null;
  if (has('url') && !isUrl(data.url)) out.push('url must be a URL starting http:// or https://');
  if (has('fetched') && !validDay(data.fetched)) out.push('fetched must be a date as YYYY-MM-DD');
  if (has('url') && !has('fetched') && !bundle) out.push('no fetched. A source saved from a URL gives the day it was fetched');
  if (has('etag') && !filled(data.etag)) out.push('etag must be text');
  if (has('last_modified') && !(filled(data.last_modified) && !Number.isNaN(Date.parse(data.last_modified)))) out.push('last_modified must be a date');
  if (has('repo') && !filled(data.repo)) out.push('repo must be the URL or name of the repository');
  if (has('commit') && !(typeof data.commit === 'string' && /^[0-9a-f]{7,64}$/.test(data.commit))) out.push('commit must be 7 to 64 hex digits');
  if (has('path') && !(filled(data.path) && insideFolder(data.path))) out.push('path must be a relative path inside the repo');
  if (has('repo') && !bundle) {
    for (const k of ['path', 'commit']) if (!has(k)) out.push(`no ${k}. A git source gives repo, path and commit`);
  }
  if (has('baseline') && data.baseline !== true) out.push('baseline must be true when present. Refresh sets it on the first copy it fetched of a source it had no sha256 for');
  if (has('replaces') && chains && rel) {
    const target = typeof data.replaces === 'string' ? rawFile(data.replaces) : null;
    const id = chains.files.get(rel)?.id;
    const others = (chains.replacedBy.get(target) ?? []).filter(r => r !== rel);
    if (!target?.startsWith('raw/refs/')) out.push(`replaces names ${data.replaces}, which isn't a file in raw/refs/. It names the copy this one replaces, by its path from the vault root`);
    else if (!id || chains.files.get(target)?.id !== id) out.push(`replaces names ${target}, which is a copy of another source`);
    else if (others.length) out.push(`${joinList(others, 'and')} ${others.length > 1 ? 'replace' : 'replaces'} ${target} too. One copy replaces each copy at most`);
  }
  if (!bundle && has('sha256')) {
    if (typeof data.sha256 !== 'string' || !HEX64.test(data.sha256)) out.push('sha256 must be 64 lowercase hex digits');
    else if (data.sha256 !== sha256(body)) out.push("sha256 doesn't match the text below the frontmatter, so the file changed after it was saved");
  }
  return out;
}

// The loose files in raw/refs/ and the bundles, each bundle once as its folder.
export function refSources() {
  const loose = new Set();
  const bundles = new Set();
  for (const f of filesIn(vaultPath('raw', 'refs'), '', 'raw/refs').filter(x => rawFile(x) === x)) {
    const bundle = bundleOf(f);
    (bundle ? bundles : loose).add(bundle ?? f);
  }
  return { loose: [...loose].sort(), bundles: [...bundles].sort() };
}

// Where a saved source came from and which copy of it this is, so a copy fetched again with different content is a new
// version of the same source. The version is the hash of the body, the commit, or for a bundle with a hash per file, the hash
// of those lines; a doc set's is its latest manifest copy's. A source with no URL or repo has none.
export function sourceVersion(rel) {
  let data;
  try {
    const folder = fs.statSync(vaultPath(...rel.split('/'))).isDirectory();
    if (!folder && !rel.endsWith('.md')) return null;
    if (folder && isDocSet(rel)) ({ data } = manifestChain(rel).at(-1));
    else ({ data } = parse(readRel(folder ? `${rel}/source.md` : rel).toString('utf8')));
    const where = isUrl(data.url) ? data.url : filled(data.repo) ? (folder || !filled(data.path) ? data.repo : `${data.repo} ${data.path}`) : null;
    if (!where) return null;
    const lines = Array.isArray(data.sha256) ? sha256(data.sha256.map(String).sort().join('\n')) : data.sha256;
    return { url: where, version: [data.commit, lines].find(v => filled(v)) ?? null, sha256: filled(lines) ? lines : null };
  } catch {
    return null;
  }
}

// A new copy's name starts with this: the previous copy's name without its extension, its .<8 hex> suffix and the -2
// a taken name gets.
export const copyStem = rel => path.posix.basename(rel).replace(/\.[^.]*$/, '').replace(/\.[0-9a-f]{8}(?:-\d+)?$/, '');
const isManifest = (rel, names = manifestNames()) => names.includes(`${copyStem(rel)}${path.posix.extname(rel)}`);

// Where a saved file came from, the same for every copy of it, or null for one refresh can't check.
export function sourceId(data) {
  if (isUrl(data.url)) return normUrl(data.url);
  if (filled(data.repo) && filled(data.path)) return `${data.repo} ${data.path}`;
  return null;
}

// A source's copies, oldest first. fetched can't order two copies from one day and mtimes don't survive a clone, so each
// copy names the one it replaces; copies that replace none, such as two that /ingest saved, go by fetched, then by name.
function ordered(rels, files) {
  const group = new Set(rels);
  const next = new Map();
  const roots = [];
  for (const r of rels) {
    const p = files.get(r).replacesFile;
    if (p && p !== r && group.has(p)) next.set(p, [...(next.get(p) ?? []), r]);
    else roots.push(r);
  }
  const byFetched = (a, b) => cmp(String(files.get(a).data.fetched ?? ''), String(files.get(b).data.fetched ?? '')) || cmp(a, b);
  const out = [];
  const seen = new Set();
  const walk = r => {
    if (seen.has(r)) return;
    seen.add(r);
    out.push(r);
    for (const n of (next.get(r) ?? []).sort(byFetched)) walk(n);
  };
  for (const r of roots.sort(byFetched)) walk(r);
  // Copies that replace each other in a ring have no first one.
  for (const r of [...rels].sort(byFetched)) walk(r);
  return out;
}

const fileEntry = (rel, id) => {
  const parsed = parsedFile(rel);
  if (!parsed) return null;
  const replacesFile = typeof parsed.data.replaces === 'string' ? rawFile(parsed.data.replaces) : null;
  return { id, data: parsed.data, body: parsed.body, ok: parsed.ok, errors: parsed.errors, replacesFile };
};

// A doc set's manifest and the copies refresh saved of it, oldest first, each as { rel, data }.
export function manifestChain(folder) {
  const names = manifestNames();
  const files = new Map();
  let entries = [];
  try { entries = fs.readdirSync(vaultPath(...folder.split('/')), { withFileTypes: true }); } catch {}
  for (const e of entries) {
    const rel = `${folder}/${e.name}`;
    if (!e.isFile() || !isManifest(rel, names)) continue;
    const entry = fileEntry(rel, folder);
    if (entry) files.set(rel, entry);
  }
  return ordered([...files.keys()], files).map(rel => ({ rel, data: files.get(rel).data }));
}

// Every saved source in raw/refs/, each as the chain of its copies: a file saved from a URL, one from a git repo, each
// page of a doc set, and a doc set's manifest, whose id is the set's folder. chains holds only the ones refresh can check,
// so not a set whose latest manifest gives no url. A bundle with a source.md is left out, since nothing fetches one yet.
// files maps each copy to { id, set, data, body, ok, errors, replacesFile }; unreadable lists the files that couldn't be read.
export function sourceChains() {
  const files = new Map();
  const unreadable = [];
  const names = manifestNames();
  const listed = folderNames();
  // The walk spells each path as the disk does, so a file's bundle goes by its folder, looked up once per folder.
  const bundleAt = memo(dir => bundleAbove(dir, listed));
  const setOf = memo(folder => (folder && isDocSet(folder, listed) ? folder : null));
  for (const f of filesIn(vaultPath('raw', 'refs'), '', 'raw/refs')) {
    checkDeadline();
    const bundle = bundleAt(path.posix.dirname(f));
    const set = setOf(bundle);
    if (bundle && !set) continue;
    const manifest = Boolean(set) && path.posix.dirname(f) === set && isManifest(f, names);
    if (!manifest && !f.endsWith('.md')) continue;
    if (rawFile(f) !== f) continue;
    const entry = fileEntry(f, null);
    if (!entry) {
      unreadable.push(f);
      continue;
    }
    entry.id = manifest ? set : sourceId(entry.data);
    if (entry.id) files.set(f, { ...entry, set, manifest });
  }
  const groups = new Map();
  for (const [rel, e] of files) groups.set(e.id, [...(groups.get(e.id) ?? []), rel]);
  const chains = new Map();
  for (const [id, rels] of [...groups].sort(([a], [b]) => cmp(a, b))) {
    const chain = ordered(rels, files);
    const latest = files.get(chain.at(-1));
    if (!latest.manifest || isUrl(latest.data.url)) chains.set(id, chain);
  }
  const replacedBy = new Map();
  for (const [rel, e] of files) if (e.replacesFile) replacedBy.set(e.replacesFile, [...(replacedBy.get(e.replacesFile) ?? []), rel]);
  return { chains, files, unreadable, replacedBy };
}

// The sources each note cites, as ids, and for each source whose copies it cites by file, the place in the chain of the
// latest copy it cites. Citations are its Evidence lines, its footnotes and the sources of the source pages it links; a
// page in a doc set is cited as its own source and as the set.
export function noteCitations(notes, chains) {
  const resolve = resolver(notes);
  const pages = new Map(notes.filter(isSourcePage).map(n => [n.key, n]));
  const at = new Map();
  for (const [id, rels] of chains.chains) rels.forEach((r, i) => at.set(r, [id, i]));
  const fileOf = memo(rawFile);
  const listed = folderNames();
  const placeOf = memo(ref => {
    const file = fileOf(ref);
    if (file && at.has(file)) return { file: at.get(file), set: chains.files.get(file)?.set ?? null };
    return { file: null, set: bundleOf(ref, listed) };
  });
  const asOfPlace = (id, day) => Math.max(0, chains.chains.get(id).findLastIndex(r => {
    const { fetched } = chains.files.get(r).data;
    return validDay(fetched) && fetched <= day;
  }));
  return n => {
    const refs = [
      ...evidenceSources(n),
      ...footnotes(n).defs.flatMap(d => (d.target ? [locate(d, fileOf).base] : [])),
      ...linkedKeys(n, resolve).flatMap(k => (typeof pages.get(k)?.data.source === 'string' ? [pages.get(k).data.source] : [])),
    ];
    const ids = new Set();
    const latest = new Map();
    for (const ref of refs) {
      if (isUrl(ref)) {
        const id = normUrl(ref);
        if (!chains.chains.has(id)) continue;
        ids.add(id);
        // A URL names no copy, so the note read the last one fetched by its as_of, or the first when all came after.
        if (validDay(n.as_of)) latest.set(id, Math.max(latest.get(id) ?? -1, asOfPlace(id, n.as_of)));
        continue;
      }
      const { file, set } = placeOf(ref);
      if (set && chains.chains.has(set)) ids.add(set);
      if (!file) continue;
      const [id, i] = file;
      ids.add(id);
      latest.set(id, Math.max(latest.get(id) ?? -1, i));
    }
    return { ids, latest };
  };
}

// The copies later in a source's chain than place i that aren't a baseline, so a note citing copy i hasn't seen them.
export const newerCopies = (chains, id, i) => chains.chains.get(id).slice(i + 1).filter(r => chains.files.get(r).data.baseline !== true);

// .state/derived.json from raw/refs/ and the notes: each source's chain and the check refresh last
// recorded for it, the delivered notes a changed source has left unverified, and per domain the sources its delivered
// notes cite. checked is the later of the check on record and the latest copy's fetched day, since a fetch is a check.
export function derive(notes, old = {}, chains = sourceChains()) {
  const was = isMap(old?.sources) ? old.sources : {};
  const sources = {};
  for (const [id, chain] of chains.chains) {
    const w = isMap(was[id]) ? was[id] : {};
    const fetched = chains.files.get(chain.at(-1)).data.fetched;
    sources[id] = {
      chain,
      checked: [w.checked, fetched].filter(validDay).sort().at(-1) ?? null,
      result: w.result ?? null, why: w.why ?? null, etag: w.etag ?? null, lastModified: w.lastModified ?? null,
    };
  }
  const cites = noteCitations(notes, chains);
  const unverified = {};
  const domains = {};
  for (const n of notes) {
    checkDeadline();
    if (n.superseded_by || undelivered(n)) continue;
    const { ids, latest } = cites(n);
    for (const id of ids) (domains[n.domain] ??= new Set()).add(id);
    const changed = [...latest].flatMap(([id, i]) => {
      const newer = newerCopies(chains, id, i);
      return newer.length ? [{ id, day: chains.files.get(newer[0]).data.fetched }] : [];
    });
    if (!changed.length) continue;
    unverified[n.key] = {
      contentHash: n.contentHash, since: changed.map(c => c.day).filter(validDay).sort()[0] ?? null, sources: changed.map(c => c.id).sort(cmp),
    };
  }
  const byName = ([a], [b]) => cmp(a, b);
  return { version: 1, sources, unverified, domains: Object.fromEntries(Object.entries(domains).sort(byName).map(([d, ids]) => [d, [...ids].sort(cmp)])) };
}

// A note's unverified entry holds only while the note says what build read, so an edit to cite the new copy clears it at
// once and a save that leaves the text as it was keeps it.
export const unverifiedNow = (derived, n) => {
  const e = derived?.unverified?.[n.key];
  return isMap(e) && typeof e.contentHash === 'string' && e.contentHash === n.contentHash ? e : null;
};

// The day counts for a domain: knowledge in vault.config.json, then the domain's own knowledge fields.
export function knowledgeDays(domain) {
  const own = config().domains[domain]?.knowledge;
  const out = { ...config().knowledge };
  for (const k of ['staleAfterDays', 'checkAfterDays']) if (isMap(own) && Number.isFinite(own[k])) out[k] = own[k];
  return out;
}
