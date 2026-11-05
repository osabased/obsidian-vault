import fs from 'node:fs';
import path from 'node:path';
import { config, statePath, readJsonSafe, writeJson, logError, toPosix, pathKey, inVaultFolder, topOf, mainCheckout, inside } from './vault.mjs';
import { extension } from './ext.mjs';
import { isRacy } from './cache.mjs';

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

// A session in no domain is a project of its own: the work tree its cwd is in, or cwd outside one. An edit to a file
// below cwd is in the file's work tree, which may be a repository nested in cwd's. A worktree is its main checkout's
// project. The vault folder is no project.
export function rootOutside(hits, cwd, file) {
  if (hits.length || typeof cwd !== 'string' || inVaultFolder(cwd)) return null;
  const top = topOf(typeof file === 'string' && inside(cwd, file, cwd) !== null ? toPosix(file, cwd) : cwd);
  return top ? mainCheckout(toPosix(top)) : cwd;
}

// A package as OSV names it, its ecosystem and name trimmed, or null where either is missing.
export function osvPackage(p) {
  if (p === null || typeof p !== 'object' || Array.isArray(p) || typeof p.ecosystem !== 'string' || typeof p.name !== 'string') return null;
  const [ecosystem, name] = [p.ecosystem.trim(), p.name.trim()];
  return ecosystem && name ? { ecosystem, name } : null;
}

// SemVer's breaking line: a newer major, or a newer minor while both are below 1.0.
const MOVED_ON = {
  major(checked, now) {
    const [[a0, a1], [b0, b1]] = [semverParts(checked).core, semverParts(now).core];
    return b0 > a0 || (a0 === 0n && b0 === 0n && b1 > a1);
  },
};

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

export const anyReaders = () => ['global', ...Object.keys(config().domains)].some(d => readerNames(d).length);

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
// to it. Outside a repository, a root has no project above it to share a lockfile with.
function lockfileAbove(root, names) {
  const start = path.resolve(root);
  const last = topOf(start) ? null : start;
  for (let dir = start; ; dir = path.dirname(dir)) {
    for (const name of names) {
      const file = path.join(dir, name);
      const st = fileStat(file);
      if (st) return { file, st };
    }
    if (dir === last || fs.existsSync(path.join(dir, '.git')) || path.dirname(dir) === dir) return null;
  }
}

let cache;
let dirty = false;
let unsaved = false;
const versionsFile = () => statePath('versions.json');
// A project's entries are keyed by its root folded, since hooks get one folder spelled in more than one case; each
// entry keeps the root as it was first spelled, to show.
const rootKey = root => pathKey(root);
const isRootKey = k => !k.startsWith('reader ') && k.includes('|');
const splitKey = k => [k.slice(0, k.lastIndexOf('|')), k.slice(k.lastIndexOf('|') + 1)];
const cached = () => {
  if (!cache) {
    const c = readJsonSafe(versionsFile());
    cache = c && typeof c === 'object' && !Array.isArray(c) ? c : {};
    for (const k of Object.keys(cache).filter(isRootKey)) {
      const [root, name] = splitKey(k);
      const key = `${root.toLowerCase()}|${name}`;
      if (key === k) continue;
      const e = { root, ...cache[k] };
      if (!(cache[key]?.at >= e.at)) cache[key] = e;
      delete cache[k];
      dirty = true;
    }
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
  const key = `${rootKey(root)}|${name}`;
  const lockfile = toPosix(found.file);
  const e = cached()[key];
  const same = e && e.lockfile === lockfile && e.mtimeMs === found.st.mtimeMs && e.size === found.st.size;
  if (same && !isRacy(e.at, e.mtimeMs)) return e.versions ?? null;
  const entry = { root: e?.root ?? toPosix(root), lockfile, mtimeMs: found.st.mtimeMs, size: found.st.size, at: Date.now() };
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

// How a domain's readers compare an ecosystem's versions, as delivery does: the reader's own compare on the ECOSYSTEM
// scheme, SemVer's on any other. Null where no reader reads the ecosystem, or the reader's compare is missing, since
// delivery compares nothing there.
export function compareFor(domain, ecosystem) {
  for (const name of readerNames(domain)) {
    const r = loaded(name);
    if (r?.ecosystem !== ecosystem) continue;
    if (r.scheme !== 'ECOSYSTEM') return compareSemver;
    return typeof r.compare === 'function' ? r.compare : null;
  }
  return null;
}

export function comparable(compare, version) {
  try {
    compare(version, version);
    return true;
  } catch { return false; }
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
// or null where it read none. Global reaches every project, so its readers read at each root the hits reach, or at
// fallback, rootOutside's root, for no hits.
export function projectVersions(hits, cwd, fallback = rootOutside(hits, cwd)) {
  const out = new Map();
  const seen = new Set();
  const globalRoots = fallback ? [{ domain: 'global', root: fallback }] : hits.map(h => ({ domain: 'global', root: h.root }));
  for (const { domain, root } of [...hits, ...globalRoots]) {
    const names = readerNames(domain);
    if (!names.length || typeof root !== 'string' || seen.has(`${domain}|${rootKey(root)}`)) continue;
    seen.add(`${domain}|${rootKey(root)}`);
    const byEcosystem = new Map();
    for (const name of names) {
      const r = loaded(name);
      if (!r) continue;
      const own = r.scheme === 'ECOSYSTEM';
      byEcosystem.set(r.ecosystem, {
        versions: versionsAt(root, name, r),
        compare: own ? r.compare : compareSemver,
        movedOn: own ? (typeof r.movedOn === 'function' ? r.movedOn : null) : MOVED_ON[config().knowledge.movedOn],
      });
    }
    out.set(domain, [...(out.get(domain) ?? []), byEcosystem]);
  }
  save();
  return out;
}

// The project roots a reader has read, as .state/versions.json records them. A root whose folder is gone is dropped
// from the file, since nothing prunes it otherwise.
export function liveRoots() {
  const roots = new Map();
  for (const k of Object.keys(cached()).filter(isRootKey)) {
    const [folded] = splitKey(k);
    if (!roots.has(folded)) roots.set(folded, { shown: cache[k]?.root ?? folded, keys: [] });
    roots.get(folded).keys.push(k);
  }
  const live = [];
  for (const { shown, keys } of roots.values()) {
    if (fs.existsSync(shown)) {
      live.push(shown);
      continue;
    }
    for (const k of keys) delete cache[k];
    dirty = true;
  }
  save();
  return live;
}

// The versions of pkg in the projects given that have moved on from checked, for a rule /lint offers to retire. A
// project without the package isn't one: the rule is about a library it doesn't use.
export function movedOnFrom(given, checked, domain, versions) {
  const pkg = osvPackage(given);
  return !pkg ? [] : (versions.get(domain) ?? []).flatMap(byEcosystem => {
    const got = byEcosystem.get(pkg.ecosystem);
    if (!got?.versions || !got.movedOn || !Object.hasOwn(got.versions, pkg.name)) return [];
    try {
      return got.movedOn(checked, got.versions[pkg.name]) ? [got.versions[pkg.name]] : [];
    } catch { return []; }
  });
}

const combine = fits => (fits.some(f => f.fit === 'match') ? fits.find(f => f.fit === 'match')
  : fits.length && fits.every(f => f.fit === 'mismatch') ? fits[0] : { fit: 'unknown' });

function entryFit(entry, byEcosystem) {
  const pkg = osvPackage(entry.package);
  const got = pkg && byEcosystem.get(pkg.ecosystem);
  if (!got?.versions) return { fit: 'unknown' };
  const { name } = pkg;
  if (!Object.hasOwn(got.versions, name)) return { fit: 'mismatch', why: `no ${name}` };
  const version = got.versions[name];
  try {
    const hit = entry.ranges.some(r => inRange(version, r.events, r.type === 'SEMVER' ? compareSemver : got.compare));
    return { fit: hit ? 'match' : 'mismatch', why: `${name} ${version}` };
  } catch {
    return { fit: 'unknown' };
  }
}

function checkedEntryFit(pkg, checked, byEcosystem) {
  const got = byEcosystem.get(pkg.ecosystem);
  if (!got?.versions || !got.movedOn) return { fit: 'unknown' };
  if (!Object.hasOwn(got.versions, pkg.name)) return { fit: 'mismatch', why: `no ${pkg.name}` };
  const version = got.versions[pkg.name];
  try {
    return { fit: got.movedOn(checked, version) ? 'mismatch' : 'match', why: `${pkg.name} ${version}` };
  } catch {
    return { fit: 'unknown' };
  }
}

// A knowledge rule's fit from the version it was checked with: a mismatch where the project's version has moved on
// from it, or the project lacks the package. Null for a rule with no package or checked_with.
export function checkedFit(given, checked, domain, versions) {
  const pkg = osvPackage(given);
  if (!pkg || typeof checked !== 'string') return null;
  const roots = versions.get(domain) ?? [];
  if (!roots.length) return { fit: 'unknown' };
  return combine(roots.map(byEcosystem => checkedEntryFit(pkg, checked, byEcosystem)));
}

// The version of pkg the projects given hold for domain, with how its ecosystem compares versions, or null where none
// does or they hold different ones, since a rule records one version it was checked with.
export function versionIn(given, domain, versions) {
  const pkg = osvPackage(given);
  if (!pkg) return null;
  const held = new Map();
  for (const byEcosystem of versions.get(domain) ?? []) {
    const got = byEcosystem.get(pkg.ecosystem);
    const v = got?.versions && Object.hasOwn(got.versions, pkg.name) ? String(got.versions[pkg.name]) : null;
    // A version its ecosystem can't compare would give the rule a checked_with lint refuses, so it is as good as none.
    if (v !== null && comparable(got.compare, v)) held.set(v, got.compare);
  }
  const [only] = held.size === 1 ? held : [];
  return only ? { version: only[0], compare: only[1] } : null;
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
