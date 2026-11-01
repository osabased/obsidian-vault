import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { parse } from './frontmatter.mjs';
import { filesIn, vaultPath } from './vault.mjs';
import { isUrl, validDay, rawFile, bundleOf, filled, parsedFile } from './rules.mjs';

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
export function sourceProblems(data, { body, bundle = false } = {}) {
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
// of those lines. A source with no URL or repo has none.
export function sourceVersion(rel) {
  let data;
  try {
    const folder = fs.statSync(vaultPath(...rel.split('/'))).isDirectory();
    if (!folder && !rel.endsWith('.md')) return null;
    ({ data } = parse(readRel(folder ? `${rel}/source.md` : rel).toString('utf8')));
    const where = isUrl(data.url) ? data.url : filled(data.repo) ? (folder || !filled(data.path) ? data.repo : `${data.repo} ${data.path}`) : null;
    if (!where) return null;
    const lines = Array.isArray(data.sha256) ? sha256(data.sha256.map(String).sort().join('\n')) : data.sha256;
    return { url: where, version: [data.commit, lines].find(v => filled(v)) ?? null, sha256: filled(lines) ? lines : null };
  } catch {
    return null;
  }
}
