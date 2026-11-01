import { config, sessionReach, toolsPath, toPosix, inside } from './vault.mjs';
import { loadNotes, settledNotes, liveRules, deliverable, deliveryFor, ruleLine, cmp } from './rules.mjs';
import { entryParts, normGlob } from './glob.mjs';
import { byName } from './ext.mjs';

// Each format is tools/adapters/<name>/compile.mjs, loaded by its path, since an agent with no hooks has no adapter.mjs.
const formats = byName(name => toolsPath('adapters', name, 'compile.mjs'));
export const hasFormat = formats.has;
export const formatNamed = formats.load;

const optedIn = d => (Array.isArray(config().domains[d]?.compile) ? config().domains[d].compile.filter(hasFormat) : []);

// What compiling a project would write: the domains of the project that opt in, with their project roots, and the
// formats they list. Null when no domain that opts in reaches it.
export function reachOf(project) {
  const hits = sessionReach(project);
  const domains = [...new Set(hits.map(h => h.domain))].filter(d => optedIn(d).length);
  return domains.length ? { hits, domains, formats: [...new Set(domains.flatMap(optedIn))].sort(cmp) } : null;
}

const byFirst = ([a], [b]) => cmp(a, b);

// The rules a session in the project would be shown by its files and its prompts, grouped so the bytes are fixed. Only
// the formats' file notion exists, so namespace globs and tools rules go. A rule with triggers is listed under its globs.
export function sectionsFor(root, { hits, domains }, notes) {
  const rules = deliverable(liveRules(settledNotes(notes.filter(n => n.domain === 'global' || domains.includes(n.domain)))), deliveryFor(hits));
  const always = [];
  const files = new Map();
  const keywords = new Map();
  // A domain's globs start at its project root, which can sit below the folder compiled into.
  const under = d => (d === 'global' ? [''] : [...new Set(hits.filter(h => h.domain === d).map(h => inside(root, h.root) ?? ''))].sort(cmp));
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
export function compileFor(project, reach, notes = loadNotes()) {
  const root = toPosix(project);
  const sections = sectionsFor(root, reach, notes);
  return reach.formats.flatMap(format => formatNamed(format).compile(sections, root).map(r => ({ format, ...r })));
}
