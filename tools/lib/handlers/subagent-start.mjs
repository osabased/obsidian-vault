import { inVaultFolder, readableDomains, guarded } from '../vault.mjs';
import { alwaysContext, fitContext, indexNote, scopeTopics, loadNotesAsync, settledNotes, liveRules, deliverable, deliveryFor } from '../rules.mjs';
import { sessionDomains, sessionHits, markShown } from '../sessions.mjs';

// A subagent starts with none of its parent's context, so it hears what a session start gives: the always rules and the
// topics of the session's domains. They count as shown in the session, but not as delivered to it: the parent's next
// prompt still gets an always rule that changed.
export async function subagentStart(event) {
  const doms = sessionDomains(event.session, event.cwd);
  const vaultFolder = inVaultFolder(event.cwd);
  const readable = readableDomains(doms, vaultFolder);
  const ready = settledNotes(await loadNotesAsync(vaultFolder ? null : readable));
  const always = alwaysContext([...doms, 'global'], deliverable(liveRules(ready), deliveryFor(sessionHits(event.session, event.cwd))));
  const topics = guarded('index note', () => scopeTopics(readable, ready), []);
  if (event.session) markShown(event.session, always.keys);
  const { text: context } = fitContext([
    { noun: 'block of always rules', items: always.text ? [always.text] : [] },
    { noun: 'topic', items: topics, render: indexNote },
  ]);
  return context ? { context } : null;
}
