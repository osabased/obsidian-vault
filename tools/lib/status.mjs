import { domainsByMode, plural } from './vault.mjs';
import { joinList } from './rules.mjs';

// The one line the user sees at session start and from /vault status: the domains that reach the folder, the rules and
// pages that reach the session, and when rules are proposed. A session in the vault folder proposes as in corrections.
export function statusLine({ doms, vaultFolder, rules, notes, readable }) {
  const scope = vaultFolder ? null : [...doms, 'global'];
  const reaching = Object.values(rules).filter(r => !scope || scope.includes(r.domain));
  const always = reaching.filter(r => r.always).length;
  const pages = notes.filter(n => n.type === 'page' && readable.includes(n.domain)).length;
  const where = vaultFolder ? 'vault folder, every domain' : doms.length ? joinList(doms, 'and') : 'no domain here';
  const counted = `${plural(reaching.length, scope && !doms.length ? 'global rule' : 'rule')}${always ? ` (${always} always)` : ''}`;
  const modes = scope ? domainsByMode(['global', ...doms]) : new Map([['corrections', []]]);
  const proposals = modes.size === 1 ? [...modes.keys()][0] : [...modes].map(([mode, ds]) => `${joinList(ds, 'and')} ${mode}`).join(', ');
  return [`vault: ${where}`, counted, pages && plural(pages, 'page'), `proposals: ${proposals}`].filter(Boolean).join(' · ');
}
