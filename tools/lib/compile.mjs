import fs from 'node:fs';
import { createRequire } from 'node:module';
import { config, sessionReach, toolsPath, toPosix, inside, mainCheckout } from './vault.mjs';
import { loadNotes, settledNotes, liveRules, deliverable, deliveryFor, ruleLine, cmp } from './rules.mjs';
import { entryParts, normGlob } from './glob.mjs';
import { AGENT_NAME } from './agents.mjs';

// Each format is tools/adapters/<name>/compile.mjs, loaded by its path, since an agent with no hooks has no adapter.mjs.
const fileOf = name => toolsPath('adapters', name, 'compile.mjs');
export const hasFormat = name => typeof name === 'string' && AGENT_NAME.test(name) && fs.existsSync(fileOf(name));

// Hooks run synchronously, and require loads an ES module synchronously from Node 22.12 on.
const load = createRequire(import.meta.url);

export const formatNamed = name => load(fileOf(name));

const optedIn = d => (Array.isArray(config().domains[d]?.compile) ? config().domains[d].compile.filter(hasFormat) : []);

// What compiling a project would write: the domains of the project that opt in, with their project roots, and the
// formats they list. Null when no domain that opts in reaches it.
export function reachOf(project) {
  const hits = sessionReach(project);
  const domains = [...new Set(hits.map(h => h.domain))].filter(d => optedIn(d).length);
  return domains.length ? { hits, domains, formats: [...new Set(domains.flatMap(optedIn))].sort(cmp) } : null;
}

const byFirst = ([a], [b]) => cmp(a, b);

// A domain's globs start at its project root, which can sit below the folder compiled into. Project roots are main
// checkouts, so a worktree is read as its main checkout. Null when a root sits outside the folder, above it say.
const rootsUnder = (root, hits, d) => {
  const rels = hits.filter(h => h.domain === d).map(h => inside(mainCheckout(root), h.root));
  return rels.includes(null) ? null : [...new Set(rels)].sort(cmp);
};

// The rules a session in the project would be shown by its files and its prompts, grouped so the bytes are fixed. Only
// the formats' file notion exists, so namespace globs and tools rules go. A rule with triggers is listed under its globs.
// The section goes to other machines and repos, so it holds only what committed files say: a project's lockfile can
// drop a rule or label it, and .state/, which is this machine's, labels nothing.
export function sectionsFor(root, { hits, domains }, notes) {
  const rules = deliverable(liveRules(settledNotes(notes.filter(n => n.domain === 'global' || domains.includes(n.domain)))), deliveryFor(hits, { derived: {} }));
  const always = [];
  const files = new Map();
  const keywords = new Map();
  const under = d => (d === 'global' ? [''] : rootsUnder(root, hits, d));
  const group = (map, id, entry, key, line) => map.set(id, { ...entry, rules: [...(map.get(id)?.rules ?? []), [key, line]] });
  for (const [key, r] of Object.entries(rules)) {
    const line = ruleLine(key, r);
    if (r.always) {
      always.push([key, line]);
      continue;
    }
    const globs = (r.applies_to ?? []).map(e => entryParts(e)).filter(p => p.namespace === 'file');
    if (globs.some(p => !p.negated)) {
      const placed = under(r.domain).flatMap(rel => globs.map(p => `${p.negated ? '!' : ''}${rel ? `${rel}/${normGlob(p.glob)}` : p.glob}`));
      group(files, JSON.stringify(placed), { globs: placed }, key, line);
    }
    if (r.keywords?.length) group(keywords, JSON.stringify(r.keywords), { keywords: r.keywords }, key, line);
  }
  const lines = rs => rs.sort(byFirst).map(([, line]) => line);
  const grouped = map => [...map.entries()].sort(byFirst).map(([, g]) => ({ ...g, lines: lines(g.rules), rules: undefined }));
  return { always: lines(always), files: grouped(files), keywords: grouped(keywords) };
}

// One result per format, each { format, path, text, rules, state, changed, refused? } as the format's compile returns it.
// A folder below a domain's project root would get globs that start in the wrong place, so it is refused whole, as
// { path, refused } for the folder, naming the root to compile instead.
export function compileFor(project, reach, notes = loadNotes()) {
  const root = toPosix(project);
  const above = reach.domains.find(d => !rootsUnder(root, reach.hits, d));
  if (above) {
    const outside = reach.hits.find(h => h.domain === above && inside(mainCheckout(root), h.root) === null).root;
    const refused = `the ${above} rules' globs start at ${outside}, which holds this folder. Run node tools/compile.mjs ${/\s/.test(outside) ? `"${outside}"` : outside} instead.`;
    return [{ path: root, text: null, rules: 0, state: 'refused', changed: 0, refused }];
  }
  const sections = sectionsFor(root, reach, notes);
  return reach.formats.flatMap(format => formatNamed(format).compile(sections, root).map(r => ({ format, ...r })));
}
