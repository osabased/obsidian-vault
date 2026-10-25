import { runHook, config, domainsFor, inVaultFolder } from '../lib/vault.mjs';
import { settledRules, alwaysIn, ruleLine, cmp, mentions } from '../lib/rules.mjs';
import { touchSession, marked, mark, markAlways, markShown } from '../lib/sessions.mjs';

// Session start marks the always rules it loads, so these are the ones written, reworded or settled since,
// or the ones of a domain the session moved into.
function late(sid, scope, rules) {
  const due = alwaysIn(rules, scope).filter(([k, r]) => markAlways(sid, k, r));
  for (const [k] of due) markShown(sid, k);
  return due.length ? ['Taste rules that apply for the rest of this session:', ...due.map(([k, r]) => ruleLine(k, r))].join('\n') : '';
}

function excerpts(input, scope, rules) {
  const sid = input.session_id;
  const said = String(input.prompt ?? '');
  const hits = Object.entries(rules)
    .filter(([k, r]) => !r.always && r.keywords?.length && scope.includes(r.domain) && !marked('excerpts', sid, `${k}|${r.hash}`))
    .map(([k, r]) => ({ k, r, score: new Set(r.keywords.filter(kw => mentions(kw, said)).map(kw => kw.toLowerCase())).size }))
    .filter(h => h.score > 0)
    .sort((a, b) => b.score - a.score || cmp(a.k, b.k))
    .slice(0, config().delivery.maxPromptExcerpts);
  for (const h of hits) {
    mark('excerpts', sid, `${h.k}|${h.r.hash}`);
    markShown(sid, h.k);
  }
  return hits.length ? ['Taste rules that may apply to this request:', ...hits.map(h => ruleLine(h.k, h.r))].join('\n') : '';
}

runHook('prompt', input => {
  if (!input.session_id) return null;
  const doms = domainsFor(input.cwd).map(d => d.domain);
  const registered = doms.length > 0 || inVaultFolder(input.cwd);
  if (registered) touchSession(input);
  const scope = ['global', ...doms];
  const rules = settledRules();
  const context = [registered ? late(input.session_id, scope, rules) : '', excerpts(input, scope, rules)].filter(Boolean).join('\n\n');
  return context ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } } : null;
});
