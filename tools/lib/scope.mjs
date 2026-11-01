import { domainsFor, everywhereDomains, inside, toPosix } from './vault.mjs';
import { tryRegex, cmp } from './rules.mjs';
import { bestMatch, specificity, bySpecificity } from './glob.mjs';
import { marked, agentKey } from './sessions.mjs';

// Global's globs are read from the file's first project folder, or from the session's folder when no domain has the file.
// An everywhere domain's pages reach every edit, read as global's when its reach doesn't take in the file; its rules
// gate only where its reach does.
export function matcher(file, cwd) {
  const doms = domainsFor(file, cwd);
  const fallback = doms[0]?.rel ?? inside(cwd, file, cwd);
  const everywhere = everywhereDomains();
  return (notes, pages = false) => Object.entries(notes).flatMap(([key, note]) => {
    const own = doms.find(d => d.domain === note.domain)?.rel;
    const rel = note.domain === 'global' || (pages && own === undefined && everywhere.includes(note.domain)) ? fallback : own;
    if (!note.applies_to?.length || typeof rel !== 'string') return [];
    const glob = bestMatch(note.applies_to, rel);
    return glob ? [{ key, note, rel, place: rel.toLowerCase(), spec: specificity(glob) }] : [];
  });
}

export const fileScope = (file, cwd) => ({ domains: [...domainsFor(file, cwd).map(d => d.domain), 'global', ...everywhereDomains()], matching: matcher(file, cwd) });

// A note with triggers comes up only on an edit whose new text matches one.
export const fires = (note, text) => !note.triggers?.length || note.triggers.some(t => tryRegex(t)?.test(text));

// The rules due on this edit, most specific first: the ones this session was not yet refused with on this file.
export function dueRules(input, matched, text) {
  const hits = [];
  for (const { key, note, rel, place, spec } of matched) {
    const triggered = note.triggers?.length > 0;
    if (!fires(note, text)) continue;
    // The hash is in the id, so a reworded rule is refused once more on files it already gated.
    const id = agentKey(input, `${key}|${note.hash}|${place}`);
    if (!marked('gate', input.session_id, id)) hits.push({ key, note, rel, id, triggered, spec });
  }
  return hits.sort((a, b) => Number(b.triggered) - Number(a.triggered) || bySpecificity(a.spec, b.spec) || cmp(a.key, b.key));
}

// A file an Edit or Write call reached through the gate, by any agent of the session. The Stop hook leaves these out,
// so the changed files it is left with are the ones a shell command wrote.
export const gatedFile = (file, cwd) => `file|${toPosix(file, cwd).toLowerCase()}`;
