import { runHook, config, inVaultFolder, readableDomains, everywhereDomains } from '../lib/vault.mjs';
import { settledNotes, liveRules, livePages, alwaysIn, ruleLine, pagePointers, cmp, mentions } from '../lib/rules.mjs';
import { touchSession, sessionDomains, markAlways, markShown, markFirst, markPages } from '../lib/sessions.mjs';

// Session start marks the always rules it loads, so these are the ones written, reworded or settled since,
// or the ones of a domain the session moved into.
function late(sid, scope, rules) {
  const due = alwaysIn(rules, scope).filter(([k, r]) => markAlways(sid, k, r));
  for (const [k] of due) markShown(sid, k);
  return due.length ? ['Taste rules that apply for the rest of this session:', ...due.map(([k, r]) => ruleLine(k, r))].join('\n') : '';
}

const mentioned = (entries, scope, said) => entries
  .filter(([, note]) => note.keywords?.length && scope.includes(note.domain))
  .map(([key, note]) => ({ key, note, score: new Set(note.keywords.filter(kw => mentions(kw, said)).map(kw => kw.toLowerCase())).size }))
  .filter(h => h.score > 0)
  .sort((a, b) => b.score - a.score || cmp(a.key, b.key));

function excerpts(sid, scope, rules, said) {
  const ranked = mentioned(Object.entries(rules).filter(([, r]) => !r.always), scope, said);
  const hits = markFirst('excerpts', sid, ranked, config().delivery.maxPromptExcerpts, h => `${h.key}|${h.note.hash}`);
  for (const h of hits) markShown(sid, h.key);
  return hits.length ? ['Taste rules that may apply to this request:', ...hits.map(h => ruleLine(h.key, h.note))].join('\n') : '';
}

runHook('prompt', input => {
  const sid = input.session_id;
  if (!sid) return null;
  const doms = sessionDomains(sid, input.cwd);
  const vaultFolder = inVaultFolder(input.cwd);
  const registered = doms.length > 0 || vaultFolder;
  if (registered) touchSession(input);
  const scope = ['global', ...doms];
  const said = String(input.prompt ?? '');
  // An everywhere domain's keyword rules reach every session; its always rules only the sessions its reach puts it in.
  const heard = [...new Set([...scope, ...everywhereDomains()])];
  const notes = settledNotes();
  const rules = liveRules(notes);
  const pages = markPages(input, mentioned(Object.entries(livePages(notes)), readableDomains(doms, vaultFolder), said));
  const context = [
    registered ? late(sid, scope, rules) : '',
    excerpts(sid, heard, rules, said),
    pagePointers('Vault pages on this request. Read the ones that bear on it:', pages),
  ].filter(Boolean).join('\n\n');
  return context ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } } : null;
});
