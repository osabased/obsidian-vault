import { domainsByMode, inVaultFolder, plural, guarded, queueRows } from './vault.mjs';
import { proposeDomains } from './sessions.mjs';
import { joinList, namesPackage, hasRequires, pastVersions } from './rules.mjs';
import { openEntries, retirementsAsked } from './queue.mjs';
import { anyReaders } from './versions.mjs';

// The modes propose.mjs keeps to for a session: those of the domains it may propose to, or ask when it began in the
// vault folder, which offers whatever the mode. A start with no session to register can't propose, and shows its folder's.
function proposalModes(reach, entry) {
  if (entry ? inVaultFolder(entry.cwd) : reach.vaultFolder) return new Map([['ask', []]]);
  return domainsByMode(entry ? ['global', ...proposeDomains(entry)] : reach.own);
}

// Every open entry, whichever session queued it, since all of them wait for the user's /lint.
function queueCount(rows) {
  const open = openEntries(rows);
  if (!open.length) return '';
  const unattended = open.filter(r => r.unattended).length;
  return `queue ${open.length}${unattended ? ` (${unattended} unattended)` : ''}`;
}

// The rules /lint offers to retire for this session's projects, less those a retirement entry already asks about. A
// project without the package hasn't moved past a version of it. With no reader set, no version is known, for a rule's
// package or its requires.
function versionCount(reached, ctx, rows) {
  const rules = Object.entries(reached).filter(([, r]) => namesPackage(r) || hasRequires(r));
  if (!anyReaders()) return rules.length ? 'no version readers set' : '';
  const asked = retirementsAsked(rows);
  const past = rules.filter(([key, r]) => !asked.has(key) && pastVersions(r, ctx.versions).length).length;
  return past ? `${plural(past, 'rule')} past ${past === 1 ? 'its' : 'their'} version here` : '';
}

// The one line the user sees at session start and from /vault status: the domains that reach the folder, the rules and
// pages a view of the session holds, which are those reach.mjs's routes bring, when rules are proposed, and what waits for
// the user. A session in the vault folder reads every domain's pages.
export function statusLine({ reach, reached, rules, pages, ctx }, entry) {
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
  const rows = guarded('queue rows', queueRows, []);
  const waiting = [guarded('queue count', () => queueCount(rows)), guarded('version count', () => versionCount(reached, ctx, rows))];
  return [`vault: ${where}`, counted, paged, `proposals: ${proposals}`, ...waiting].filter(Boolean).join(' · ');
}
