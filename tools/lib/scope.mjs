import { domainsFor, everywhereDomains, inside, toPosix } from './vault.mjs';
import { tryRegex, cmp, byFit } from './rules.mjs';
import { bestMatch, specificity, bySpecificity } from './glob.mjs';
import { marked, agentKey } from './sessions.mjs';

// Global's globs are read from the file's first project folder, or from the session's folder when no domain has the file.
// An everywhere domain's pages reach every edit, read as global's when its reach doesn't take in the file; its rules
// gate only where its reach does.
export function matcher(file, cwd, doms = domainsFor(file, cwd)) {
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

export function fileScope(file, cwd) {
  const doms = domainsFor(file, cwd);
  return { domains: [...doms.map(d => d.domain), 'global', ...everywhereDomains()], hits: doms, matching: matcher(file, cwd, doms) };
}

// A note with triggers comes up only on an edit whose new text matches one.
export const fires = (note, text) => !note.triggers?.length || note.triggers.some(t => tryRegex(t)?.test(text));

// The rules due on this edit, most specific first: the ones this session was not yet refused with on this file. The text
// may be given as a function, so a file is read only when a due rule has triggers. An item that carries its own text,
// as a rule a tool's name reaches does, tests its triggers against that.
export function dueRules(input, matched, text) {
  let cached;
  const read = typeof text === 'function' ? () => (cached ??= text()) : () => text;
  const hits = [];
  for (const { key, note, rel, place, spec, text: own } of matched) {
    const triggered = note.triggers?.length > 0;
    // The hash is in the id, so a reworded rule is refused once more on files it already gated.
    const id = agentKey(input, `${key}|${note.hash}|${place}`);
    if (marked('gate', input.session_id, id) || (triggered && !fires(note, own ?? read()))) continue;
    hits.push({ key, note, rel, id, triggered, spec });
  }
  return hits.sort((a, b) => Number(b.triggered) - Number(a.triggered) || bySpecificity(a.spec, b.spec) || byFit(a.note, b.note) || cmp(a.key, b.key));
}

// A file an Edit or Write call reached through the gate this turn, by any agent of the session. The Stop hook leaves
// these out of the turn's check, so the changed files it is left with are the ones a shell command wrote. A covered
// file the gate let through with no rule due, because a trigger missed the edit's text, stays out for the rest of that
// turn even if a shell command then writes the trigger's text into it; a later turn checks it again.
export const gatedFile = (turn, file, cwd) => `file|${turn}|${toPosix(file, cwd).toLowerCase()}`;
