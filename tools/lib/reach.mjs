import { everywhereDomains, readableDomains, inVaultFolder } from './vault.mjs';
import { loadNotesAsync, settledNotes, liveRules, livePages, deliverable, deliveryFor } from './rules.mjs';
import { sessionDomains, sessionHits } from './sessions.mjs';

// Which domains' notes reach a session, by the route each takes, for a session whose folder doms reach. The hooks
// deliver by these routes and the status line counts by them, so what it counts is what the session can get.
// - always rules load from the session's own domains: global and doms.
// - keyword and tools rules come from those and the everywhere domains. An always rule an everywhere domain's reach
//   doesn't load comes by its keywords like any other.
// - applies_to rules gate the edits in the session's own domains' projects. An edit elsewhere takes its file's domains,
//   which scope.mjs finds per file, so the count leaves those out.
// - pages come from the readable domains: those, and every domain in the vault folder.
export function reachOf(doms, vaultFolder) {
  const own = [...new Set(['global', ...doms])];
  const heard = [...new Set([...own, ...everywhereDomains()])];
  const readable = readableDomains(doms, vaultFolder);
  const always = r => Boolean(r.always) && own.includes(r.domain);
  const keyword = r => Boolean(r.keywords?.length) && heard.includes(r.domain) && !always(r);
  const tool = r => Boolean(r.tools?.length) && heard.includes(r.domain);
  const file = r => Boolean(r.applies_to?.length) && own.includes(r.domain);
  return {
    doms, vaultFolder, own, heard, readable,
    always, keyword, tool,
    rule: r => always(r) || keyword(r) || tool(r) || file(r),
    page: p => readable.includes(p.domain),
  };
}

// A running session as its prompts see it: its reach, and the notes, rules and pages delivery may give it. Session
// start finds the reach itself, since it is what records it.
export async function sessionView(sid, cwd) {
  const reach = reachOf(sessionDomains(sid, cwd), inVaultFolder(cwd));
  const notes = settledNotes(await loadNotesAsync(reach.readable));
  return viewOf(reach, notes, deliveryFor(sessionHits(sid, cwd)));
}

export function viewOf(reach, notes, ctx) {
  let pages;
  return {
    reach, notes, ctx,
    rules: deliverable(liveRules(notes), ctx),
    get pages() { return (pages ??= deliverable(livePages(notes), ctx)); },
  };
}
