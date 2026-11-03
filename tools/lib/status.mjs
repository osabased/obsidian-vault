import { domainsByMode, inVaultFolder, plural } from './vault.mjs';
import { proposeDomains } from './sessions.mjs';
import { joinList } from './rules.mjs';

// The modes propose.mjs keeps to for a session: those of the domains it may propose to, or corrections when it began in
// the vault folder. A start with no session to register can't propose, and shows its folder's.
function proposalModes(reach, entry) {
  if (entry ? inVaultFolder(entry.cwd) : reach.vaultFolder) return new Map([['corrections', []]]);
  return domainsByMode(entry ? ['global', ...proposeDomains(entry)] : reach.own);
}

// The one line the user sees at session start and from /vault status: the domains that reach the folder, the rules and
// pages a view of the session holds, which are those reach.mjs's routes bring, and when rules are proposed. A session in
// the vault folder reads every domain's pages.
export function statusLine({ reach, rules, pages }, entry) {
  const { doms, vaultFolder } = reach;
  const reaching = Object.values(rules);
  const always = reaching.filter(reach.always).length;
  const read = Object.keys(pages).length;
  const list = joinList(doms, 'and');
  const where = vaultFolder ? ['vault folder', ...(doms.length ? [list] : [])].join(', ') : list || 'no domain here';
  const noun = reach.heard.some(d => d !== 'global') ? 'rule' : 'global rule';
  const counted = `${plural(reaching.length, noun)}${always ? ` (${always} always)` : ''}`;
  const paged = read ? `${plural(read, 'page')}${vaultFolder ? ' (every domain)' : ''}` : '';
  const modes = proposalModes(reach, entry);
  const proposals = modes.size === 1 ? [...modes.keys()][0] : [...modes].map(([mode, ds]) => `${joinList(ds, 'and')} ${mode}`).join(', ');
  return [`vault: ${where}`, counted, paged, `proposals: ${proposals}`].filter(Boolean).join(' · ');
}
