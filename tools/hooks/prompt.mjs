import { runHook, config, domainsFor, logError } from '../lib/vault.mjs';
import { readLedger, clip, cmp, byKey, mentions } from '../lib/rules.mjs';
import { parseCommands, runCommands } from '../lib/commands.mjs';
import { touchSession, marked, markDelivered } from '../lib/sessions.mjs';

const ruleLine = (k, r) => `- ${k}: ${clip(r.text, config().delivery.maxRuleChars)}`;

function late(session, scope, ledger) {
  const due = Object.entries(ledger.rules).sort(byKey)
    .filter(([, r]) => r.always && scope.includes(r.domain) && !(session.loaded[r.domain] >= r.confirmed_at))
    .filter(([k, r]) => markDelivered('excerpts', session.session, `always|${k}|${r.hash}`, k, r.hash));
  return due.length ? ['Taste rules the user confirmed that apply for the rest of this session:', ...due.map(([k, r]) => ruleLine(k, r))].join('\n') : '';
}

function excerpts(input, scope, ledger) {
  const sid = input.session_id;
  const said = String(input.prompt ?? '');
  const hits = Object.entries(ledger.rules)
    .filter(([k, r]) => !r.always && r.keywords?.length && scope.includes(r.domain) && !marked('excerpts', sid, `${k}|${r.hash}`))
    .map(([k, r]) => ({ k, r, score: new Set(r.keywords.filter(kw => mentions(kw, said)).map(kw => kw.toLowerCase())).size }))
    .filter(h => h.score > 0)
    .sort((a, b) => b.score - a.score || cmp(a.k, b.k))
    .slice(0, config().delivery.maxPromptExcerpts);
  for (const h of hits) markDelivered('excerpts', sid, `${h.k}|${h.r.hash}`, h.k, h.r.hash);
  return hits.length ? ['Taste rules the user confirmed that may apply to this request:', ...hits.map(h => ruleLine(h.k, h.r))].join('\n') : '';
}

runHook('prompt', input => {
  const cmds = parseCommands(input.prompt);
  // Blocking keeps the command away from the model; Claude Code shows the reason to the user instead.
  // A bare confirm or drop with no proposal to answer goes on to the model as an ordinary prompt.
  if (cmds) {
    try {
      const reply = runCommands(cmds, input);
      if (reply !== null) return { decision: 'block', reason: reply };
    } catch (e) {
      logError('prompt', e);
      return { decision: 'block', reason: `The taste hooks hit an error and may not have recorded that: ${e.message}` };
    }
  }
  if (!input.session_id) return null;
  const doms = domainsFor(input.cwd).map(d => d.domain);
  const session = doms.length ? touchSession(input) : null;
  const scope = ['global', ...doms];
  const ledger = readLedger();
  const context = [session ? late(session, scope, ledger) : '', excerpts(input, scope, ledger)].filter(Boolean).join('\n\n');
  return context ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } } : null;
});
