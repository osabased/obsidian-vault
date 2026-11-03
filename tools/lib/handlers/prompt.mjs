import { config } from '../vault.mjs';
import { alwaysIn, ruleLine, pageLine, fitContext, cmp, mentions, byFit } from '../rules.mjs';
import { touchSession, turnStarted, markAlways, markShown, markMany, markPages, unmarked, dueAlways, duePages } from '../sessions.mjs';
import { sessionView } from '../reach.mjs';

// Session start marks the always rules it loads, so these are the ones written, reworded or settled since,
// or the ones of a domain the session moved into. A section's keys are the rules its items show, and its mark marks
// the first n of them, once the output budget has said how many it keeps.
function late(sid, reach, rules) {
  const due = dueAlways(sid, alwaysIn(rules, reach.always));
  return {
    noun: 'rule', head: 'Taste rules that apply for the rest of this session:', items: due.map(([k, r]) => ruleLine(k, r)), keys: due.map(([k]) => k),
    mark: n => markAlways(sid, due.slice(0, n)),
  };
}

const mentioned = (entries, said) => entries
  .map(([key, note]) => ({ key, note, score: new Set(note.keywords.filter(kw => mentions(kw, said)).map(kw => kw.toLowerCase())).size }))
  .filter(h => h.score > 0)
  .sort((a, b) => b.score - a.score || byFit(a.note, b.note) || cmp(a.key, b.key));

function excerpts(sid, reach, rules, said) {
  const ranked = mentioned(Object.entries(rules).filter(([, r]) => reach.keyword(r)), said);
  const keyOf = h => `${h.key}|${h.note.hash}`;
  const hits = unmarked('excerpts', sid, ranked, keyOf, config().delivery.maxPromptExcerpts);
  return {
    noun: 'rule', head: 'Taste rules that may apply to this request:', items: hits.map(h => ruleLine(h.key, h.note)), keys: hits.map(h => h.key),
    mark: n => markMany('excerpts', sid, hits.slice(0, n).map(keyOf)),
  };
}

function pointers(event, reach, pageNotes, said) {
  const pages = duePages(event, mentioned(Object.entries(pageNotes).filter(([, p]) => reach.keywordPage(p)), said));
  return {
    noun: 'page', head: 'Vault pages on this request. Read the ones that bear on it:', items: pages.map(h => pageLine(h.key, h.note)),
    mark: n => markPages(event, pages.slice(0, n), Infinity),
  };
}

export async function prompt(event, agent) {
  const sid = event.session;
  if (!sid) return null;
  turnStarted(sid);
  touchSession(event, undefined, agent.name);
  const said = String(event.text ?? '');
  const { reach, rules, pages } = await sessionView(sid, event.cwd);
  const sections = [late(sid, reach, rules), excerpts(sid, reach, rules, said), pointers(event, reach, pages, said)];
  const { text: context, kept } = fitContext(sections);
  // What the budget cut is neither marked delivered nor counted as shown, so a later prompt brings it.
  sections.forEach((s, i) => s?.mark(kept[i]));
  markShown(sid, sections.flatMap((s, i) => s?.keys?.slice(0, kept[i]) ?? []));
  return context ? { context } : null;
}
