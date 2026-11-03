import { domainsByMode, everywhereDomains, plural } from './vault.mjs';
import { joinList, livePages, deliverable } from './rules.mjs';

// The one line the user sees at session start and from /vault status: the domains that reach the folder, the rules and
// pages that can reach the session, and when rules are proposed. A session in the vault folder proposes as in corrections.
// An everywhere domain's keyword and tools rules reach every session, as the prompt and edit hooks deliver them.
export function statusLine({ doms, vaultFolder, rules, notes, readable, ctx }) {
  const scope = vaultFolder ? null : [...doms, 'global'];
  const everywhere = everywhereDomains();
  const reaches = r => !scope || scope.includes(r.domain) || (everywhere.includes(r.domain) && Boolean(r.keywords?.length || r.tools?.length));
  const reaching = Object.values(rules).filter(reaches);
  const always = reaching.filter(r => r.always).length;
  const pages = Object.values(deliverable(livePages(notes), ctx)).filter(p => readable.includes(p.domain)).length;
  const where = vaultFolder ? 'vault folder, every domain' : doms.length ? joinList(doms, 'and') : 'no domain here';
  const counted = `${plural(reaching.length, scope && !doms.length && !everywhere.length ? 'global rule' : 'rule')}${always ? ` (${always} always)` : ''}`;
  const modes = scope ? domainsByMode(['global', ...doms]) : new Map([['corrections', []]]);
  const proposals = modes.size === 1 ? [...modes.keys()][0] : [...modes].map(([mode, ds]) => `${joinList(ds, 'and')} ${mode}`).join(', ');
  return [`vault: ${where}`, counted, pages && plural(pages, 'page'), `proposals: ${proposals}`].filter(Boolean).join(' · ');
}
