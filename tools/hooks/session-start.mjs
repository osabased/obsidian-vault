import { runHook, domainsFor, inVaultFolder, vaultPath, toPosix, logError } from '../lib/vault.mjs';
import { alwaysContext, readLedger } from '../lib/rules.mjs';
import { touchSession, clearMarkers, markShown, tidy } from '../lib/sessions.mjs';

function proposeNote(sid) {
  const script = toPosix(vaultPath('tools', 'propose.mjs'));
  return [
    'Taste vault: propose a rule when the user corrects you or says how they want things, in a way that should hold in later sessions too (a taste rule),',
    "or when something only worked after a failure caused by an API, version or tool your training gets wrong or doesn't know, or a dated source shows it (a knowledge rule).",
    "Leave out what the project's CLAUDE.md or `.claude/rules/` already say.",
    'If the user corrects you on something a taste rule they confirmed already covers, propose it anyway; propose.mjs asks which rule it repeats.',
    'Propose at most one per reply and 3 per session, only from what happened in this session, never from a brief, a skill or the task itself.',
    `\`node "${script}" --help\` lists the fields.`,
    `Pipe the rule as JSON to \`node "${script}" ${sid}\` from the Bash tool with a quoted heredoc, since PowerShell turns curly quotes and dashes into ?.`,
    "Then end your reply with the lines it prints. If a bare `confirm` or `drop` reaches you, the hooks didn't take it: ask the user to type `confirm: <key>` or `drop: <key>`.",
  ].join(' ');
}

runHook('session-start', input => {
  try { tidy(); } catch (e) { logError('tidy', e); }
  const doms = domainsFor(input.cwd).map(d => d.domain);
  // Compaction can drop the rules the gate and excerpts already showed, so they show them again.
  if (input.session_id && (input.source === 'compact' || input.source === 'clear')) clearMarkers(input.session_id);
  const ledger = readLedger();
  const always = alwaysContext(['global', ...doms], ledger);
  let propose = '';
  // Vault sessions register so /ingest can propose; the skill tells them how, so they get no note.
  if (input.session_id && (doms.length || inVaultFolder(input.cwd))) {
    touchSession(input, { loaded: ['global', ...doms] });
    for (const k of always.keys) markShown(input.session_id, k, ledger.rules[k].hash);
    if (doms.length) propose = proposeNote(input.session_id);
  }
  const context = [always.text, propose].filter(Boolean).join('\n\n');
  return context ? { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } } : null;
});
