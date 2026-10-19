import { runHook, domainsFor, vaultRel, pendingRows, plural } from '../lib/vault.mjs';
import { alwaysContext } from '../lib/rules.mjs';
import { touchSession, clearMarkers } from '../lib/sessions.mjs';

function reviewNote(input) {
  if (!['startup', 'clear'].includes(input.source) || !input.cwd || vaultRel(input.cwd) === null) return '';
  const n = pendingRows().length;
  if (!n) return '';
  const waiting = `${plural(n, 'capture')} in the taste vault ${n === 1 ? 'is' : 'are'} waiting for review.`;
  return `${waiting} At the start of your first reply, tell the user so in one line and mention that /taste-review turns captures into rules.`;
}

runHook('session-start', input => {
  const doms = domainsFor(input.cwd).map(d => d.domain);
  // Compaction can drop the rules the gate and excerpts already showed, so they show them again.
  if (input.session_id && (input.source === 'compact' || input.source === 'clear')) clearMarkers(input.session_id);
  if (input.session_id && doms.length) touchSession(input, { loaded: ['global', ...doms] });
  const context = [alwaysContext(['global', ...doms]), reviewNote(input)].filter(Boolean).join('\n\n');
  return context ? { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } } : null;
});
