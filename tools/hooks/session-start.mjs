import { runHook, domainsFor, inVaultFolder, vaultPath, toPosix, logError, config } from '../lib/vault.mjs';
import { alwaysContext, readLedger, loadNotes, clip } from '../lib/rules.mjs';
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

const PENDING_MAX = 8;

// A proposal the user never answered sits in the wiki as provisional; only the agent's reply can put it in front of them.
function pending(scope, ledger) {
  const notes = loadNotes().filter(n => n.type === 'rule' && n.status === 'provisional' && scope.includes(n.domain) && !ledger.rules[n.key]);
  if (!notes.length) return '';
  const shown = notes.slice(0, PENDING_MAX);
  const more = notes.length - shown.length;
  return [
    "Taste rules proposed earlier that still wait for the user's answer. Begin your first reply with these lines as they are, so they can confirm or drop them:",
    ...shown.map(n => `- ${n.key}: Do: ${clip(n.do || '(missing)', 120)}`),
    ...(more ? [`(${more} more in ${toPosix(vaultPath('index.md'))}.)`] : []),
    'Type `confirm: <key>` or `drop: <key>`; several keys on one line go with commas.',
  ].join('\n');
}

runHook('session-start', input => {
  try { tidy(); } catch (e) { logError('tidy', e); }
  const doms = domainsFor(input.cwd).map(d => d.domain);
  // Compaction can drop the rules the gate and excerpts already showed, so they show them again.
  if (input.session_id && (input.source === 'compact' || input.source === 'clear')) clearMarkers(input.session_id);
  const ledger = readLedger();
  const always = alwaysContext(['global', ...doms], ledger);
  let propose = '';
  let waiting = '';
  // Vault sessions register so /ingest can propose; the skill tells them how, so they get no note.
  if (input.session_id && (doms.length || inVaultFolder(input.cwd))) {
    touchSession(input, { loaded: ['global', ...doms] });
    for (const k of always.keys) markShown(input.session_id, k, ledger.rules[k].hash);
    if (doms.length) propose = proposeNote(input.session_id);
    waiting = pending(inVaultFolder(input.cwd) ? ['global', ...Object.keys(config().domains)] : ['global', ...doms], ledger);
  }
  const context = [always.text, waiting, propose].filter(Boolean).join('\n\n');
  return context ? { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } } : null;
});
