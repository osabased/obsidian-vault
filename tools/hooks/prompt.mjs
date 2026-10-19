import crypto from 'node:crypto';
import { runHook, config, domainsFor, safeId, logError, appendJsonl, inboxFile } from '../lib/vault.mjs';
import { capturable, normText } from '../lib/capture.mjs';
import { readLedger, clip, cmp, byKey, escapeRegExp } from '../lib/rules.mjs';
import { parseCommands, runCommands } from '../lib/commands.mjs';
import { touchSession, maybeSweep, mark, marked } from '../lib/sessions.mjs';

const ruleLine = (k, r) => `- ${k}: ${clip(r.text, config().delivery.maxRuleChars)}`;

function capture(input, session) {
  const at = new Date().toISOString();
  const rows = capturable(input.prompt)
    .filter(c => mark('captured', session.session, normText(c.text)))
    .map(c => ({
      id: `c-${crypto.randomBytes(4).toString('hex')}`, at, source: 'regex', kinds: c.kinds, text: c.text,
      session: session.session, transcript: session.transcript, cwd: session.cwd, domain: session.domain,
    }));
  appendJsonl(inboxFile(), rows);
}

function late(session, scope, ledger) {
  const lines = Object.entries(ledger.rules).sort(byKey)
    .filter(([, r]) => r.always && scope.includes(r.domain) && !(session.loaded[r.domain] >= r.confirmed_at))
    .filter(([k, r]) => mark('excerpts', session.session, `always|${k}|${r.hash}`))
    .map(([k, r]) => ruleLine(k, r));
  return lines.length ? ['Taste rules the user confirmed that apply for the rest of this session:', ...lines].join('\n') : '';
}

function excerpts(input, scope, ledger) {
  const sid = input.session_id;
  const said = String(input.prompt ?? '');
  const mentions = kw => new RegExp(`(?<!\\w)${escapeRegExp(kw)}(?!\\w)`, 'i').test(said);
  const hits = Object.entries(ledger.rules)
    .filter(([k, r]) => !r.always && r.keywords?.length && scope.includes(r.domain) && !marked('excerpts', sid, `${k}|${r.hash}`))
    .map(([k, r]) => ({ k, r, score: new Set(r.keywords.filter(mentions).map(kw => kw.toLowerCase())).size }))
    .filter(h => h.score > 0)
    .sort((a, b) => b.score - a.score || cmp(a.k, b.k))
    .slice(0, config().delivery.maxPromptExcerpts);
  for (const h of hits) mark('excerpts', sid, `${h.k}|${h.r.hash}`);
  return hits.length ? ['Taste rules the user confirmed that may apply to this request:', ...hits.map(h => ruleLine(h.k, h.r))].join('\n') : '';
}

runHook('prompt', input => {
  const cmds = parseCommands(input.prompt);
  // Blocking keeps the command away from the model; Claude Code shows the reason to the user instead.
  if (cmds) {
    try {
      return { decision: 'block', reason: runCommands(cmds, input) };
    } catch (e) {
      logError('prompt', e);
      return { decision: 'block', reason: `The taste hooks hit an error and may not have recorded that: ${e.message}` };
    }
  }
  if (!input.session_id) return null;
  const doms = domainsFor(input.cwd).map(d => d.domain);
  const session = doms.length ? touchSession(input) : null;
  try { maybeSweep(safeId(input.session_id)); } catch (e) { logError('sweep', e); }
  if (session) capture(input, session);
  const scope = ['global', ...doms];
  const ledger = readLedger();
  const context = [session ? late(session, scope, ledger) : '', excerpts(input, scope, ledger)].filter(Boolean).join('\n\n');
  return context ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } } : null;
});
