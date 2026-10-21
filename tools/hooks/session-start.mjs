import { runHook, config, domainsFor, vaultRel, vaultPath, toPosix, pendingRows, plural, clock } from '../lib/vault.mjs';
import { alwaysContext, clip } from '../lib/rules.mjs';
import { touchSession, clearMarkers, lastPass } from '../lib/sessions.mjs';

const LOGIN = /OAuth|authenticat|\/login|not logged in/i;

function proposeNote(sid, doms) {
  const topics = [...new Set(doms.flatMap(d => config().domains[d]?.topics ?? []))];
  return [
    'Taste vault: when the user corrects you or says how they want things, in a way that should hold in later sessions too, propose it as a rule.',
    'Propose at most one per reply and 3 per session, and only from words the user typed in this session, never from a brief, a skill or the task itself.',
    `Pipe the rule as JSON to \`node "${toPosix(vaultPath('tools', 'propose.mjs'))}" ${sid}\` with these fields:`,
    `domain (${[...doms, 'global'].join(' or ')}, global for every project), slug (kebab-case), do and not (one line each), because (the user's reason, or empty),`,
    `topic${topics.length ? ` (${topics.join(', ')})` : ''}, basis ("stated" when their words state the rule, "inferred" when you generalized a correction),`,
    'quote (their exact words, at least 3 in one unbroken stretch), and at least one of keywords (words a request about it would use),',
    'applies_to (globs from the project root) or always: true (short rules that matter in nearly every session).',
    'Run it from the Bash tool with a quoted heredoc, since PowerShell turns curly quotes and dashes into ?.',
    "Then end your reply with the lines it prints. If a bare `confirm` or `drop` reaches you, the hooks didn't take it: ask the user to type `confirm: <key>` or `drop: <key>`.",
  ].join(' ');
}

// Only the newest pass counts: one that succeeds after a failure shows the cause is gone, and the sweep retries the failed session.
function passNote() {
  const { at, id, failed: why } = lastPass() ?? {};
  if (why === undefined) return '';
  return [
    `The taste vault's last session pass failed at ${clock(new Date(at))} with "${clip(why, 200)}".`,
    ...(LOGIN.test(why) ? ["The pass's claude login has expired, and only the user can renew it, with `claude auth login` in a terminal."] : []),
    `Once the cause is fixed, \`node tools/session-pass.mjs ${id}\` from the vault root reruns the pass.`,
    'At the start of your first reply, tell the user so in a line of its own.',
  ].join(' ');
}

function reviewNote() {
  const n = pendingRows().length;
  if (!n) return '';
  const waiting = `${plural(n, 'capture')} in the taste vault ${n === 1 ? 'is' : 'are'} waiting for review.`;
  return `${waiting} At the start of your first reply, tell the user so in one line and mention that /taste-review turns captures into rules.`;
}

function vaultNotes(input) {
  if (!['startup', 'clear'].includes(input.source) || !input.cwd || vaultRel(input.cwd) === null) return [];
  return [passNote(), reviewNote()];
}

runHook('session-start', input => {
  const doms = domainsFor(input.cwd).map(d => d.domain);
  // Compaction can drop the rules the gate and excerpts already showed, so they show them again.
  if (input.session_id && (input.source === 'compact' || input.source === 'clear')) clearMarkers(input.session_id);
  if (input.session_id && doms.length) touchSession(input, { loaded: ['global', ...doms] });
  const propose = input.session_id && doms.length ? proposeNote(input.session_id, doms) : '';
  const context = [alwaysContext(['global', ...doms]), propose, ...vaultNotes(input)].filter(Boolean).join('\n\n');
  return context ? { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } } : null;
});
