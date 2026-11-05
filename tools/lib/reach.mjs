import { config, everywhereDomains, inVaultFolder } from './vault.mjs';
import { loadNotesAsync, settledNotes, liveRules, livePages, deliverable, deliveryFor } from './rules.mjs';
import { sessionHits } from './sessions.mjs';

// Which domains' notes reach a session, by the route each takes. doms are the domains the session's folder is in; own
// is those and global; heard is own and the everywhere domains. The hooks deliver by these routes and the status line
// counts by them, so what it counts is what the session can get.
// - always: an always rule of own.
// - keyword: a keyword rule of heard. An everywhere domain's always rule comes this way where own leaves it out.
// - tool: a tools rule of heard naming a tool the agent sends its edit hook, other than a file tool, which edits bring.
// - fileRule: an applies_to rule of own. An edit in another domain's project takes its file's domains, which scope.mjs
//   finds per file, so the count leaves those out.
// - filePage: an applies_to page of heard.
// - keywordPage: a keyword page of the readable domains: heard, or in the vault folder every domain, a vault-only one's
//   among them.
// Without an agent, a tools rule counts whatever tool it names.
export function routesOf(doms, vaultFolder, agent) {
  doms = [...new Set(doms)];
  const own = [...new Set(['global', ...doms])];
  const heard = [...new Set([...doms, ...everywhereDomains(), 'global'])];
  const readable = vaultFolder ? [...new Set([...Object.keys(config().domains), 'global'])] : heard;
  const sent = agent ? t => agent.sends(t) && !agent.fileTools.includes(t) : () => true;
  const always = r => r.always && own.includes(r.domain);
  const keyword = r => r.keywords?.length && heard.includes(r.domain) && !always(r);
  const tool = r => r.tools?.some(sent) && heard.includes(r.domain);
  const fileRule = r => r.applies_to?.length && own.includes(r.domain);
  const filePage = p => p.applies_to?.length && heard.includes(p.domain);
  const keywordPage = p => p.keywords?.length && readable.includes(p.domain);
  return {
    doms, vaultFolder, own, heard, readable,
    always, keyword, tool, fileRule, filePage, keywordPage,
    rule: r => always(r) || keyword(r) || tool(r) || fileRule(r),
    page: p => keywordPage(p) || filePage(p),
  };
}

export const routesFor = (hits, cwd, agent) => routesOf(hits.map(h => h.domain), inVaultFolder(cwd), agent);

// A running session as a prompt in cwd sees it: its routes, and the notes, rules and pages delivery may give it. Session
// start finds the routes itself, since it is what records them.
export async function sessionView(sid, cwd, agent) {
  const hits = sessionHits(sid, cwd);
  const reach = routesFor(hits, cwd, agent);
  const notes = settledNotes(await loadNotesAsync(reach.readable));
  return viewOf(reach, notes, deliveryFor(hits, null, cwd));
}

const reaching = (notes, reaches) => Object.fromEntries(Object.entries(notes).filter(([, n]) => reaches(n)));

export function viewOf(reach, notes, ctx) {
  return {
    reach, notes, ctx,
    rules: deliverable(reaching(liveRules(notes), reach.rule), ctx),
    pages: deliverable(reaching(livePages(notes), reach.page), ctx),
  };
}
