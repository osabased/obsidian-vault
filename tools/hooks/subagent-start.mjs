import { runHook, inVaultFolder, readableDomains, guarded } from '../lib/vault.mjs';
import { alwaysContext, fitContext, indexNote, scopeTopics, loadNotes, settledNotes, liveRules, deliverable, deliveryFor } from '../lib/rules.mjs';
import { sessionDomains, sessionHits, markShown } from '../lib/sessions.mjs';

// A subagent starts with none of its parent's context, so it hears what a session start gives: the always rules and the
// topics of the session's domains. They count as shown in the session, but not as delivered to it: the parent's next
// prompt still gets an always rule that changed.
runHook('subagent-start', input => {
  const doms = sessionDomains(input.session_id, input.cwd);
  const vaultFolder = inVaultFolder(input.cwd);
  const readable = readableDomains(doms, vaultFolder);
  const ready = settledNotes(loadNotes(vaultFolder ? null : readable));
  const always = alwaysContext([...doms, 'global'], deliverable(liveRules(ready), deliveryFor(sessionHits(input.session_id, input.cwd))));
  const topics = guarded('index note', () => scopeTopics(readable, ready), []);
  if (input.session_id) markShown(input.session_id, always.keys);
  const { text: context } = fitContext([
    { noun: 'block of always rules', items: always.text ? [always.text] : [] },
    { noun: 'topic', items: topics, render: indexNote },
  ]);
  return context ? { hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: context } } : null;
});
