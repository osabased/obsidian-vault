import { config, everywhereDomains, inVaultFolder } from './vault.mjs';
import { loadNotesAsync, settledNotes, liveRules, livePages, deliverable, deliveryFor } from './rules.mjs';
import { sessionHits } from './sessions.mjs';

// Which domains' notes reach a session, by the route each takes, for a session whose folder doms reach. The hooks
// deliver by these routes and the status line counts by them, so what it counts is what the session can get.
// - always rules load from the session's own domains: global and doms.
// - keyword and tools rules come from those and the everywhere domains. An always rule an everywhere domain's reach
//   doesn't load comes by its keywords like any other.
// - applies_to rules gate the edits in the session's own domains' projects, and applies_to pages those and, for an
//   everywhere domain's, every edit. An edit elsewhere takes its file's domains, which scope.mjs finds per file, so the
//   count leaves those out.
// - keyword pages come from the readable domains: those, and every domain in the vault folder, a vault-only domain's
//   among them.
export function routesOf(doms, vaultFolder) {
  doms = [...new Set(doms)];
  const own = [...new Set(['global', ...doms])];
  const heard = [...new Set([...doms, ...everywhereDomains(), 'global'])];
  const readable = vaultFolder ? [...new Set([...Object.keys(config().domains), 'global'])] : heard;
  const always = r => r.always && own.includes(r.domain);
  const keyword = r => r.keywords?.length && heard.includes(r.domain) && !always(r);
  const tool = r => r.tools?.length && heard.includes(r.domain);
  const fileRule = r => r.applies_to?.length && own.includes(r.domain);
  const filePage = p => p.applies_to?.length && heard.includes(p.domain);
  const keywordPage = p => p.keywords?.length && readable.includes(p.domain);
  return {
    doms, vaultFolder, own, heard, readable,
    always, keyword, tool, keywordPage,
    rule: r => always(r) || keyword(r) || tool(r) || fileRule(r),
    page: p => keywordPage(p) || filePage(p),
  };
}

// A running session as its prompts see it: its routes, and the notes, rules and pages delivery may give it. Session
// start finds the routes itself, since it is what records them.
export async function sessionView(sid, cwd) {
  const hits = sessionHits(sid, cwd);
  const reach = routesOf(hits.map(h => h.domain), inVaultFolder(cwd));
  const notes = settledNotes(await loadNotesAsync(reach.readable));
  return viewOf(reach, notes, deliveryFor(hits));
}

export function viewOf(reach, notes, ctx) {
  let pages;
  return {
    reach, notes, ctx,
    rules: deliverable(liveRules(notes), ctx),
    get pages() { return (pages ??= deliverable(livePages(notes), ctx)); },
  };
}
