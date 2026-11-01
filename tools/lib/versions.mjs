import fs from 'node:fs';
import path from 'node:path';
import { config, statePath, readJsonSafe, writeJson, logError, toPosix } from './vault.mjs';
import { extension } from './ext.mjs';
import { RACY_MS } from './cache.mjs';

export const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
export const SCHEMES = ['SEMVER', 'ECOSYSTEM'];

const sign = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const NUMERIC = /^\d+$/;

function semverParts(v) {
  const m = typeof v === 'string' ? v.match(SEMVER) : null;
  if (!m) throw new Error(`${v} is not a semver version`);
  return { core: m.slice(1, 4).map(BigInt), pre: m[4] ? m[4].split('.') : [] };
}

// SemVer 2.0.0 precedence: build metadata doesn't count, a prerelease comes before its release, and prerelease
// identifiers compare numerically when both are digits, with digits before letters.
export function compareSemver(a, b) {
  const [x, y] = [semverParts(a), semverParts(b)];
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return sign(x.core[i], y.core[i]);
  if (!x.pre.length || !y.pre.length) return Math.sign(y.pre.length) - Math.sign(x.pre.length);
  for (let i = 0; i < Math.min(x.pre.length, y.pre.length); i++) {
    const [p, q] = [x.pre[i], y.pre[i]];
    if (p === q) continue;
    const [np, nq] = [NUMERIC.test(p), NUMERIC.test(q)];
    if (np && nq) return sign(BigInt(p), BigInt(q));
    return np ? -1 : nq ? 1 : sign(p, q);
  }
  return sign(x.pre.length, y.pre.length);
}

// OSV's range evaluation (https://ossf.github.io/osv-schema/): events apply sorted by version, '0' first; introduced
// opens the range, fixed closes it before its version and last_affected after its own. A limit isn't one of those
// events but a cap apart from them: the version must come before one of the limits.
export function inRange(version, events, compare) {
  const pairs = events.map(e => Object.entries(e)[0]);
  const limits = pairs.filter(([kind, at]) => kind === 'limit' && at !== '*').map(([, at]) => at);
  if (limits.length && !limits.some(at => compare(version, at) < 0)) return false;
  const order = ([, a], [, b]) => (a === b ? 0 : a === '0' ? -1 : b === '0' ? 1 : compare(a, b));
  let open = false;
  for (const [kind, at] of pairs.filter(([kind]) => kind !== 'limit').sort(order)) {
    if (kind === 'introduced') {
      if (at === '0' || compare(version, at) >= 0) open = true;
    } else if (kind === 'last_affected' ? compare(version, at) > 0 : compare(version, at) >= 0) {
      open = false;
    }
  }
  return open;
}

export const readerNames = d => {
  const names = config().domains[d]?.readers;
  return Array.isArray(names) ? names.filter(x => typeof x === 'string') : [];
};

const readers = new Map();
export function reader(name) {
  if (!readers.has(name)) readers.set(name, extension('readers', name, ['read']));
  return readers.get(name);
}

const fileStat = p => {
  try {
    const st = fs.statSync(p, { throwIfNoEntry: false });
    return st?.isFile() ? st : null;
  } catch { return null; }
};

// A lockfile at a monorepo's root serves its packages, and a project's own repository is as far up as one can belong
// to it.
function lockfileAbove(root, names) {
  for (let dir = path.resolve(root); ; dir = path.dirname(dir)) {
    for (const name of names) {
      const file = path.join(dir, name);
      const st = fileStat(file);
      if (st) return { file, st };
    }
    if (fs.existsSync(path.join(dir, '.git')) || path.dirname(dir) === dir) return null;
  }
}

let cache;
let dirty = false;
let unsaved = false;
const versionsFile = () => statePath('versions.json');
const cached = () => {
  if (!cache) {
    const c = readJsonSafe(versionsFile());
    cache = c && typeof c === 'object' && !Array.isArray(c) ? c : {};
  }
  return cache;
};

const asVersions = x => {
  if (x === null || typeof x !== 'object' || Array.isArray(x)) throw new Error('read() returned no { package: version } object');
  return Object.fromEntries(Object.entries(x).filter(([, v]) => typeof v === 'string'));
};

// The versions the reader finds for a project, or null when it has no lockfile or the reader throws. A lockfile is read
// again when its stat changes, or while its mtime is close to the last read; a throw is logged once per stat.
function versionsAt(root, name, r) {
  const found = lockfileAbove(root, Array.isArray(r.lockfiles) ? r.lockfiles.filter(x => typeof x === 'string' && x) : []);
  if (!found) return null;
  const key = `${toPosix(root)}|${name}`;
  const lockfile = toPosix(found.file);
  const e = cached()[key];
  const same = e && e.lockfile === lockfile && e.mtimeMs === found.st.mtimeMs && e.size === found.st.size;
  if (same && Math.abs(e.at - e.mtimeMs) >= RACY_MS) return e.versions ?? null;
  const entry = { lockfile, mtimeMs: found.st.mtimeMs, size: found.st.size, at: Date.now() };
  try {
    entry.versions = asVersions(r.read(path.dirname(found.file)));
  } catch (err) {
    if (!(same && e.error)) logError(`reader ${name} on ${lockfile}`, err);
    entry.error = String(err?.message ?? err);
  }
  cache[key] = entry;
  dirty = true;
  return entry.versions ?? null;
}

// A reader that won't load, missing or with no read function, is skipped, so its ecosystem reads as unknown. Its error
// is logged once, until the error changes or the reader loads.
function loaded(name) {
  const key = `reader ${name}`;
  try {
    const r = reader(name);
    if (Object.hasOwn(cached(), key)) {
      delete cache[key];
      dirty = true;
    }
    return r;
  } catch (err) {
    const message = String(err?.message ?? err);
    if (cached()[key] !== message) {
      logError(key, err);
      cache[key] = message;
      dirty = true;
    }
    return null;
  }
}

function save() {
  if (!dirty) return;
  dirty = false;
  try { writeJson(versionsFile(), cache); } catch (e) {
    if (!unsaved) logError('version cache', e);
    unsaved = true;
  }
}

// For each domain with readers, one entry per project root: each reader's ecosystem with the versions it read there,
// or null where it read none. Global reaches every project, so its readers read at each root the hits reach.
export function projectVersions(hits) {
  const out = new Map();
  const seen = new Set();
  for (const { domain, root } of [...hits, ...hits.map(h => ({ domain: 'global', root: h.root }))]) {
    const names = readerNames(domain);
    if (!names.length || typeof root !== 'string' || seen.has(`${domain}|${toPosix(root).toLowerCase()}`)) continue;
    seen.add(`${domain}|${toPosix(root).toLowerCase()}`);
    const byEcosystem = new Map();
    for (const name of names) {
      const r = loaded(name);
      if (r) byEcosystem.set(r.ecosystem, { versions: versionsAt(root, name, r), compare: r.scheme === 'ECOSYSTEM' ? r.compare : compareSemver });
    }
    out.set(domain, [...(out.get(domain) ?? []), byEcosystem]);
  }
  save();
  return out;
}

const combine = fits => (fits.some(f => f.fit === 'match') ? fits.find(f => f.fit === 'match')
  : fits.length && fits.every(f => f.fit === 'mismatch') ? fits[0] : { fit: 'unknown' });

function entryFit(entry, byEcosystem) {
  const got = byEcosystem.get(entry.package.ecosystem);
  if (!got?.versions) return { fit: 'unknown' };
  const { name } = entry.package;
  if (!Object.hasOwn(got.versions, name)) return { fit: 'mismatch', why: `no ${name}` };
  const version = got.versions[name];
  try {
    const hit = entry.ranges.some(r => inRange(version, r.events, r.type === 'SEMVER' ? compareSemver : got.compare));
    return { fit: hit ? 'match' : 'mismatch', why: `${name} ${version}` };
  } catch {
    return { fit: 'unknown' };
  }
}

// A note's fit for the projects given: match, mismatch or unknown, with the package and version that decided it; null
// for a note with no requires. Several entries, or several roots of the note's domain, match when one matches and
// mismatch when all do.
export function fitOf(requires, domain, versions) {
  if (!Array.isArray(requires) || !requires.length) return null;
  const roots = versions.get(domain) ?? [];
  if (!roots.length) return { fit: 'unknown' };
  return combine(roots.map(byEcosystem => combine(requires.map(entry => entryFit(entry, byEcosystem)))));
}
