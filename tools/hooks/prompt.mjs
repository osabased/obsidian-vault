import { runHook, config, inVaultFolder, readableDomains, everywhereDomains } from '../lib/vault.mjs';
import { loadNotes, settledNotes, liveRules, livePages, alwaysIn, ruleLine, pageLine, fitContext, cmp, mentions, deliverable, deliveryFor, byFit } from '../lib/rules.mjs';
import { touchSession, turnStarted, sessionDomains, markAlways, markShown, markMany, markPages, unmarked, dueAlways, duePages, sessionHits } from '../lib/sessions.mjs';

// Session start marks the always rules it loads, so these are the ones written, reworded or settled since,
// or the ones of a domain the session moved into. A section's keys are the rules its items show, and its mark marks
// the first n of them, once the output budget has said how many it keeps.
function late(sid, scope, rules) {
  const due = dueAlways(sid, alwaysIn(rules, scope));
  return {
    noun: 'rule', head: 'Taste rules that apply for the rest of this session:', items: due.map(([k, r]) => ruleLine(k, r)), keys: due.map(([k]) => k),
    mark: n => markAlways(sid, due.slice(0, n)),
  };
}

const mentioned = (entries, scope, said) => entries
  .filter(([, note]) => note.keywords?.length && scope.includes(note.domain))
  .map(([key, note]) => ({ key, note, score: new Set(note.keywords.filter(kw => mentions(kw, said)).map(kw => kw.toLowerCase())).size }))
  .filter(h => h.score > 0)
  .sort((a, b) => b.score - a.score || byFit(a.note, b.note) || cmp(a.key, b.key));

function excerpts(sid, scope, rules, said) {
  const ranked = mentioned(Object.entries(rules).filter(([, r]) => !r.always), scope, said);
  const keyOf = h => `${h.key}|${h.note.hash}`;
  const hits = unmarked('excerpts', sid, ranked, keyOf, config().delivery.maxPromptExcerpts);
  return {
    noun: 'rule', head: 'Taste rules that may apply to this request:', items: hits.map(h => ruleLine(h.key, h.note)), keys: hits.map(h => h.key),
    mark: n => markMany('excerpts', sid, hits.slice(0, n).map(keyOf)),
  };
}

function pointers(input, pageNotes, scope, said) {
  const pages = duePages(input, mentioned(Object.entries(pageNotes), scope, said));
  return {
    noun: 'page', head: 'Vault pages on this request. Read the ones that bear on it:', items: pages.map(h => pageLine(h.key, h.note)),
    mark: n => markPages(input, pages.slice(0, n), Infinity),
  };
}

runHook('prompt', input => {
  const sid = input.session_id;
  if (!sid) return null;
  turnStarted(sid);
  const doms = sessionDomains(sid, input.cwd);
  const vaultFolder = inVaultFolder(input.cwd);
  const registered = doms.length > 0 || vaultFolder;
  if (registered) touchSession(input);
  const scope = ['global', ...doms];
  const said = String(input.prompt ?? '');
  // An everywhere domain's keyword rules reach every session; its always rules only the sessions its reach puts it in.
  const heard = [...new Set([...scope, ...everywhereDomains()])];
  const notes = settledNotes(loadNotes(readableDomains(doms, vaultFolder)));
  const ctx = deliveryFor(sessionHits(sid, input.cwd));
  const rules = deliverable(liveRules(notes), ctx);
  const sections = [
    registered ? late(sid, scope, rules) : null,
    excerpts(sid, heard, rules, said),
    pointers(input, deliverable(livePages(notes), ctx), readableDomains(doms, vaultFolder), said),
  ];
  const { text: context, kept } = fitContext(sections);
  // What the budget cut is neither marked delivered nor counted as shown, so a later prompt brings it.
  sections.forEach((s, i) => s?.mark(kept[i]));
  markShown(sid, sections.flatMap((s, i) => s?.keys?.slice(0, kept[i]) ?? []));
  return context ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } } : null;
});
