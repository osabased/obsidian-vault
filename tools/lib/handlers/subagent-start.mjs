import { guarded } from '../vault.mjs';
import { alwaysContext, fitContext, indexNote, scopeTopics } from '../rules.mjs';
import { markShown } from '../sessions.mjs';
import { sessionView } from '../reach.mjs';

// A subagent starts with none of its parent's context, so it hears what a session start gives: the always rules and the
// topics of the session's domains. They count as shown in the session, but not as delivered to it: the parent's next
// prompt still gets an always rule that changed.
export async function subagentStart(event) {
  const { reach, notes, rules } = await sessionView(event.session, event.cwd);
  const always = alwaysContext(reach.own, rules);
  const topics = guarded('index note', () => scopeTopics(reach.readable, notes), []);
  if (event.session) markShown(event.session, always.keys);
  const { text: context } = fitContext([
    { noun: 'block of always rules', items: always.text ? [always.text] : [] },
    { noun: 'topic', items: topics, render: indexNote },
  ]);
  return context ? { context } : null;
}
