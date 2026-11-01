import { runHook, config, inVaultFolder, readableDomains, everywhereDomains } from '../lib/vault.mjs';
import { loadNotes, settledNotes, liveRules, livePages, alwaysIn, ruleLine, pageLine, fitContext, cmp, mentions } from '../lib/rules.mjs';
import { touchSession, turnStarted, sessionDomains, markAlways, markShown, markFirst, markPages } from '../lib/sessions.mjs';

// Session start marks the always rules it loads, so these are the ones written, reworded or settled since,
// or the ones of a domain the session moved into. A section's keys are the rules its items show.
function late(sid, scope, rules) {
  const due = markAlways(sid, alwaysIn(rules, scope));
  return { noun: 'rule', head: 'Taste rules that apply for the rest of this session:', items: due.map(([k, r]) => ruleLine(k, r)), keys: due.map(([k]) => k) };
}

const mentioned = (entries, scope, said) => entries
  .filter(([, note]) => note.keywords?.length && scope.includes(note.domain))
  .map(([key, note]) => ({ key, note, score: new Set(note.keywords.filter(kw => mentions(kw, said)).map(kw => kw.toLowerCase())).size }))
  .filter(h => h.score > 0)
  .sort((a, b) => b.score - a.score || cmp(a.key, b.key));

function excerpts(sid, scope, rules, said) {
  const ranked = mentioned(Object.entries(rules).filter(([, r]) => !r.always), scope, said);
  const hits = markFirst('excerpts', sid, ranked, config().delivery.maxPromptExcerpts, h => `${h.key}|${h.note.hash}`);
  return { noun: 'rule', head: 'Taste rules that may apply to this request:', items: hits.map(h => ruleLine(h.key, h.note)), keys: hits.map(h => h.key) };
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
  const rules = liveRules(notes);
  const pages = markPages(input, mentioned(Object.entries(livePages(notes)), readableDomains(doms, vaultFolder), said));
  const sections = [
    registered ? late(sid, scope, rules) : null,
    excerpts(sid, heard, rules, said),
    { noun: 'page', head: 'Vault pages on this request. Read the ones that bear on it:', items: pages.map(h => pageLine(h.key, h.note)) },
  ];
  const { text: context, kept } = fitContext(sections);
  // A rule cut for room isn't counted as shown.
  markShown(sid, sections.flatMap((s, i) => s?.keys?.slice(0, kept[i]) ?? []));
  return context ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } } : null;
});
