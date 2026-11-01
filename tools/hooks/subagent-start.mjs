import { runHook, inVaultFolder, readableDomains, guarded } from '../lib/vault.mjs';
import { alwaysContext, indexNote, loadNotes, settledNotes, liveRules } from '../lib/rules.mjs';
import { sessionDomains, markShown } from '../lib/sessions.mjs';

// A subagent starts with none of its parent's context, so it hears what a session start gives: the always rules and the
// topics of the session's domains. They count as shown in the session, but not as delivered to it: the parent's next
// prompt still gets an always rule that changed.
runHook('subagent-start', input => {
  const doms = sessionDomains(input.session_id, input.cwd);
  const vaultFolder = inVaultFolder(input.cwd);
  const readable = readableDomains(doms, vaultFolder);
  const ready = settledNotes(loadNotes(vaultFolder ? null : readable));
  const always = alwaysContext([...doms, 'global'], liveRules(ready));
  const index = guarded('index note', () => indexNote(readable, ready));
  if (input.session_id) for (const k of always.keys) markShown(input.session_id, k);
  const context = [always.text, index].filter(Boolean).join('\n\n');
  return context ? { hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: context } } : null;
});
