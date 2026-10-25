// The glob's parts, which the gate's regex and the overlap check are both built from: 'any' (a ** that ends the glob),
// 'dirs' (a **/ that crosses folders), 'seg' (*, or ** inside a name), 'one' (?), a list of alternatives, or a character.
function parse(glob) {
  const parts = [];
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*' && glob[i + 1] === '*') {
      const whole = i === 0 || glob[i - 1] === '/';
      if (whole && i + 2 === glob.length) {
        parts.push('any');
        i++;
      } else if (whole && glob[i + 2] === '/') {
        parts.push('dirs');
        i += 2;
      } else {
        parts.push('seg');
        i++;
      }
    } else if (ch === '*') {
      parts.push('seg');
    } else if (ch === '?') {
      parts.push('one');
    } else if (ch === '{') {
      const close = glob.indexOf('}', i);
      const body = close < 0 ? '' : glob.slice(i + 1, close);
      if (close < 0 || body.includes('{')) throw new Error(`unbalanced braces in ${glob}`);
      parts.push(body.split(',').map(parse));
      i = close;
    } else if (ch === '}') {
      throw new Error(`unbalanced braces in ${glob}`);
    } else {
      parts.push({ ch });
    }
  }
  return parts;
}

const PATTERN = { any: '.*', dirs: '(?:.*/)?', seg: '[^/]*', one: '[^/]' };

function pattern(parts) {
  return parts.map(p => {
    if (Array.isArray(p)) return `(?:${p.map(pattern).join('|')})`;
    if (typeof p === 'string') return PATTERN[p];
    return /[\\^$.|+()[\]]/.test(p.ch) ? `\\${p.ch}` : p.ch;
  }).join('');
}

export const normGlob = glob => String(glob).replace(/\\/g, '/').replace(/^\.?\//, '');
export const globToRegExp = glob => new RegExp(`^${pattern(parse(normGlob(glob)))}$`, 'i');

export function validGlob(glob) {
  if (typeof glob !== 'string' || !glob.trim()) return false;
  try {
    globToRegExp(glob);
    return true;
  } catch {
    return false;
  }
}

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

// A glob the gate can't use gets null.
const automata = new Map();
function automatonOf(glob) {
  if (!automata.has(glob)) automata.set(glob, validGlob(glob) ? automaton(parse(normGlob(glob))) : null);
  return automata.get(glob);
}

// True when some path matches both globs, as the gate matches them.
function globsOverlap(a, b) {
  const [x, y] = [a, b].map(automatonOf);
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

// The first pair of globs, one from each list, that some path matches, reading each list's globs as under its folder.
export function overlapping(as, bs, [inA, inB] = ['', '']) {
  const under = (dir, g) => (dir && validGlob(g) ? `${dir}/${normGlob(g)}` : g);
  for (const a of as) for (const b of bs) if (globsOverlap(under(inA, a), under(inB, b))) return [a, b];
  return null;
}

export function specificity(glob) {
  const literal = glob.split('/').filter(s => s && !/[*?{]/.test(s)).length;
  return [literal, glob.replace(/[*?{},]/g, '').length];
}

export const bySpecificity = (a, b) => b[0] - a[0] || b[1] - a[1];

export function bestMatch(globs, rel) {
  const hits = globs.filter(g => validGlob(g) && globToRegExp(g).test(rel));
  return hits.sort((a, b) => bySpecificity(specificity(a), specificity(b)))[0] ?? null;
}
