import { domainsByMode, plural } from './vault.mjs';
import { joinList } from './rules.mjs';

// The one line the user sees at session start and from /vault status: the domains that reach the folder, the rules and
// pages that can reach the session by reach.mjs's routes, and when rules are proposed. A session in the vault folder
// reads every domain's pages and proposes as in corrections.
export function statusLine({ reach, rules, pages }) {
  const { doms, vaultFolder, heard } = reach;
  const reaching = Object.values(rules).filter(reach.rule);
  const always = reaching.filter(reach.always).length;
  const read = Object.values(pages).filter(reach.page).length;
  const where = vaultFolder ? `vault folder${doms.length ? `, ${joinList(doms, 'and')}` : ''}` : doms.length ? joinList(doms, 'and') : 'no domain here';
  const noun = !vaultFolder && heard.length === 1 ? 'global rule' : 'rule';
  const counted = `${plural(reaching.length, noun)}${always ? ` (${always} always)` : ''}`;
  const paged = read ? `${plural(read, 'page')}${vaultFolder ? ' (every domain)' : ''}` : '';
  const modes = vaultFolder ? new Map([['corrections', []]]) : domainsByMode(reach.own);
  const proposals = modes.size === 1 ? [...modes.keys()][0] : [...modes].map(([mode, ds]) => `${joinList(ds, 'and')} ${mode}`).join(', ');
  return [`vault: ${where}`, counted, paged, `proposals: ${proposals}`].filter(Boolean).join(' · ');
}
