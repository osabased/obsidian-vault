// A namespace is a separator, an escape character, and the character that stands for a separator in the text a glob is
// matched against. Files have no escape: normGlob has already turned their backslashes into slashes.
const FILE = { separator: '/', escape: null, mark: '/' };
const MARK = '\uE000';
// The escape is one character, which outside the BMP is two UTF-16 units.
const escAt = (s, i, ns) => ns.escape !== null && s.startsWith(ns.escape, i);
export const NAMESPACE_NAME = /^[a-z][a-z0-9_-]+$/;

// The glob's parts, which the gate's regex and the overlap check are both built from: 'any' (a ** that ends the glob),
// 'dirs' (a **/ that crosses folders), 'seg' (*, or ** inside a name), 'one' (?), a list of alternatives, or a character.
function parse(glob, ns) {
  const parts = [];
  const sepAt = i => glob.startsWith(ns.separator, i);
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    const last = parts[parts.length - 1];
    if (escAt(glob, i, ns)) {
      const j = i + ns.escape.length;
      const next = j < glob.length ? String.fromCodePoint(glob.codePointAt(j)) : ns.escape;
      parts.push({ ch: next });
      i = j < glob.length ? j + next.length - 1 : j - 1;
    } else if (sepAt(i)) {
      parts.push({ ch: ns.mark, sep: true });
      i += ns.separator.length - 1;
    } else if (ch === '*' && glob[i + 1] === '*') {
      const whole = !last || last.sep || last === 'dirs';
      if (whole && i + 2 === glob.length) {
        parts.push('any');
        i++;
      } else if (whole && sepAt(i + 2)) {
        parts.push('dirs');
        i += 1 + ns.separator.length;
      } else {
        parts.push('seg');
        i++;
      }
    } else if (ch === '*') {
      parts.push('seg');
    } else if (ch === '?') {
      parts.push('one');
    } else if (ch === '{') {
      const { close, alts } = braces(glob, i, ns);
      parts.push(alts.map(alt => parse(alt, ns)));
      i = close;
    } else if (ch === '}') {
      throw new Error(`unbalanced braces in ${glob}`);
    } else {
      parts.push({ ch });
    }
  }
  return parts;
}

function braces(glob, open, ns) {
  const alts = [];
  let from = open + 1;
  for (let j = open + 1; j < glob.length; j++) {
    const ch = glob[j];
    if (escAt(glob, j, ns)) j += ns.escape.length;
    else if (ch === '{') break;
    else if (ch === ',' || ch === '}') {
      alts.push(glob.slice(from, j));
      from = j + 1;
      if (ch === '}') return { close: j, alts };
    }
  }
  throw new Error(`unbalanced braces in ${glob}`);
}

const PATTERN = m => ({ any: '.*', dirs: `(?:.*${m})?`, seg: `[^${m}]*`, one: `[^${m}]` });

function pattern(parts, mark) {
  return parts.map(p => {
    if (Array.isArray(p)) return `(?:${p.map(alt => pattern(alt, mark)).join('|')})`;
    if (typeof p === 'string') return PATTERN(mark)[p];
    return /[\\^$.|+()[\]*?{}]/.test(p.ch) ? `\\${p.ch}` : p.ch;
  }).join('');
}

export const normGlob = glob => String(glob).replace(/\\/g, '/').replace(/^\.?\//, '');
export const globToRegExp = glob => new RegExp(`^${pattern(parse(normGlob(glob), FILE), FILE.mark)}$`, 'i');

// An entry of an applies_to list: an optional leading !, an optional lowercase '<namespace>:' prefix, then a glob. A
// prefix needs two characters so that a drive letter such as c:/ stays a file glob.
export function entryParts(entry) {
  const negated = entry.startsWith('!');
  const rest = negated ? entry.slice(1) : entry;
  const at = rest.indexOf(':');
  const namespace = at > 0 ? rest.slice(0, at) : '';
  return NAMESPACE_NAME.test(namespace) ? { negated, namespace, glob: rest.slice(at + 1) } : { negated, namespace: 'file', glob: rest };
}

// Two spellings of one entry get one key. File globs ignore case and slash style; names in a namespace do not.
export function entryKey(entry) {
  const { negated, namespace, glob } = entryParts(entry);
  return (negated ? '!' : '') + (namespace === 'file' ? normGlob(glob).toLowerCase() : `${namespace}:${glob}`);
}

// A namespace the config declares badly, or doesn't declare, gets null.
function declOf(namespace, namespaces) {
  if (namespace === 'file') return FILE;
  const d = namespaces && Object.hasOwn(namespaces, namespace) ? namespaces[namespace] : null;
  const ok = typeof d?.separator === 'string' && d.separator && typeof d.escape === 'string' && [...d.escape].length === 1;
  return ok ? { separator: d.separator, escape: d.escape, mark: MARK } : null;
}

// An entry the gate can't use gets null. A hook checks and matches every note's entries on each edit, so each one
// compiles once for its namespace's declaration.
const compilations = new Map();
function compiled(entry, namespaces) {
  if (typeof entry !== 'string') return null;
  const { negated, namespace, glob } = entryParts(entry);
  const ns = declOf(namespace, namespaces);
  if (!ns || !glob.trim() || glob.startsWith('!')) return null;
  const key = `${ns.separator}\0${ns.escape}\0${entry}`;
  if (!compilations.has(key)) {
    try {
      const regex = ns === FILE ? globToRegExp(glob) : new RegExp(`^${pattern(parse(glob, ns), ns.mark)}$`, 's');
      compilations.set(key, { negated, namespace, ns, regex });
    } catch {
      compilations.set(key, null);
    }
  }
  return compilations.get(key);
}

export const validGlob = (entry, namespaces) => compiled(entry, namespaces) !== null;

// The parts as an automaton, with edges labelled null (no character), 'any', 'seg' (any but /) or a lowercase character.
function automaton(parts) {
  const edges = [[]];
  const state = () => edges.push([]) - 1;
  const loop = (from, label) => {
    const s = state();
    edges[from].push([null, s]);
    edges[s].push([label, s]);
    return s;
  };
  const walk = (ps, from) => ps.reduce((at, p) => {
    if (p === 'any' || p === 'seg') return loop(at, p);
    const end = state();
    if (Array.isArray(p)) {
      for (const alt of p) edges[walk(alt, at)].push([null, end]);
    } else if (p === 'dirs') {
      edges[at].push([null, end]);
      edges[loop(at, 'any')].push(['/', end]);
    } else {
      edges[at].push([p === 'one' ? 'seg' : p.ch.toLowerCase(), end]);
    }
    return end;
  }, from);
  return { edges, end: walk(parts, 0) };
}

const meets = (x, y) => x === 'any' || y === 'any' || (x === 'seg' ? y !== '/' : y === 'seg' ? x !== '/' : x === y);

// A folder's name is spelled out, character by character, since glob syntax has no escape for a file's characters.
const folderParts = dir => (dir ? [...`${dir}/`].map(ch => (ch === '/' ? { ch, sep: true } : { ch })) : []);

// A glob the gate can't use gets null.
const automata = new Map();
function automatonOf(glob, dir) {
  const key = `${dir}|${glob}`;
  if (!automata.has(key)) {
    try {
      automata.set(key, automaton([...folderParts(dir), ...parse(normGlob(glob), FILE)]));
    } catch {
      automata.set(key, null);
    }
  }
  return automata.get(key);
}

// True when some path matches both globs, as the gate matches them.
function globsOverlap(a, b) {
  const [x, y] = [a, b].map(([glob, dir]) => automatonOf(glob, dir));
  if (!x || !y) return false;
  const seen = new Set();
  const todo = [[0, 0]];
  while (todo.length) {
    const [p, q] = todo.pop();
    if (seen.has(`${p},${q}`)) continue;
    seen.add(`${p},${q}`);
    if (p === x.end && q === y.end) return true;
    for (const [l, to] of x.edges[p]) {
      if (l === null) todo.push([to, q]);
      else for (const [m, too] of y.edges[q]) if (m !== null && meets(l, m)) todo.push([to, too]);
    }
    for (const [m, too] of y.edges[q]) if (m === null) todo.push([p, too]);
  }
  return false;
}

// The first pair of entries, one from each list, that some file path matches, reading each list's globs as under its
// folder. A ! entry is left out, so the pair may be one the exclusions rule out but never misses a real overlap.
// Namespaced entries are left out: they match no file.
export function overlapping(as, bs, [inA, inB] = ['', '']) {
  const globs = list => list.flatMap(entry => {
    if (typeof entry !== 'string') return [];
    const { negated, namespace, glob } = entryParts(entry);
    return negated || namespace !== 'file' || !validGlob(entry) ? [] : [[entry, glob]];
  });
  for (const [a, ga] of globs(as)) for (const [b, gb] of globs(bs)) if (globsOverlap([ga, inA], [gb, inB])) return [a, b];
  return null;
}

export function specificity(entry, namespaces) {
  const { namespace, glob } = entryParts(entry);
  const sep = declOf(namespace, namespaces)?.separator ?? '/';
  const literal = glob.split(sep).filter(s => s && !/[*?{]/.test(s)).length;
  return [literal, glob.replace(/[*?{},]/g, '').length];
}

export const bySpecificity = (a, b) => b[0] - a[0] || b[1] - a[1];

// Entries of one namespace apply in order, as in a .gitignore: the last one that matches decides. The result is the
// most specific entry that adds the subject and that no later ! entry removes, or null when none does.
function select(list, namespace, namespaces, subject) {
  let hits = [];
  for (const entry of list) {
    const c = compiled(entry, namespaces);
    if (!c || c.namespace !== namespace || !c.regex.test(subject)) continue;
    if (c.negated) hits = [];
    else hits.push(entry);
  }
  return hits.sort((a, b) => bySpecificity(specificity(a, namespaces), specificity(b, namespaces)))[0] ?? null;
}

export const bestMatch = (globs, rel) => select(globs, 'file', undefined, rel);

// A target's path is written with its namespace's escape character; its segments are compared as names.
function subjectOf(path, ns) {
  let subject = '';
  for (let i = 0; i < path.length; i++) {
    if (escAt(path, i, ns) && i + ns.escape.length < path.length) {
      i += ns.escape.length;
      subject += path[i];
    } else if (ns !== FILE && path.startsWith(ns.separator, i)) {
      subject += ns.mark;
      i += ns.separator.length - 1;
    } else subject += path[i];
  }
  return subject;
}

export function matchTarget(list, { namespace = 'file', path }, namespaces) {
  const ns = declOf(namespace, namespaces);
  return ns ? select(list, namespace, namespaces, subjectOf(path, ns)) : null;
}

// The names a target's path holds, with the escapes read, or null in a namespace the config doesn't declare.
export function targetNames({ namespace = 'file', path }, namespaces) {
  const ns = declOf(namespace, namespaces);
  return ns ? subjectOf(path, ns).split(ns.mark) : null;
}

// What lint should show about a whole list, beyond each entry: a ! entry that has no earlier entry in its namespace to
// remove from.
export function globListProblems(list, namespaces) {
  const added = new Set();
  return list.flatMap(entry => {
    const c = compiled(entry, namespaces);
    if (!c) return [];
    if (!c.negated) added.add(c.namespace);
    if (c.negated && !added.has(c.namespace)) {
      const what = c.namespace === 'file' ? 'files' : `${c.namespace} targets`;
      return [`exclusion in applies_to comes before any entry that adds ${what}: ${entry}`];
    }
    return [];
  });
}
