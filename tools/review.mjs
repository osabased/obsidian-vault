import fs from 'node:fs';
import path from 'node:path';
import {
  config, plural, toPosix, pathKey, guarded, hookErrors, errorsLog, localDay, appendLog, isVaultOnly, sessionReach, cwdOf, queueRows, isMarkerName, domainsFor, isFileAt,
} from './lib/vault.mjs';
import {
  clip, normTopic, topicNotes, loadNotes, liveRules, evidenceSessions, validDay, byKey, cmp, sharedFiles, resolver, linkedKeys, evidenceSources, isSourcePage, joinList,
  rankPair, sourceItem, fitIn, readDerived, isDocSet, folderNames, unverifiedNow, packageId, comparedKeys, isTopicPage, linksUnder, byTopic, noteKeys,
  namesPackage, checkedWithOnly, hasRequires, pastVersions, filled,
} from './lib/rules.mjs';
import { lint, tally } from './lib/lint.mjs';
import { lintRan, lintDone, tidy, trackedSessions, sessionDomains, sessionName, sessionHits } from './lib/sessions.mjs';
import { anyReaders, liveRoots, projectVersions, rootOutside } from './lib/versions.mjs';
import { retirementsAsked } from './lib/queue.mjs';
import { subjectRows, liveRows, newestFirst, projectName } from './lib/picks.mjs';
import { UsageError } from './lib/input.mjs';
import { refSources, sourceVersion, sourceChains, noteCitations, newerCopies } from './lib/sources.mjs';

// Each section reads these once a run; a read that fails is tried again by the next section, which reports it too.
const once = f => {
  let got;
  return () => (got ??= f());
};

const notes = once(loadNotes);

const linted = once(() => {
  try {
    const found = lint(notes(), chains());
    return { counts: tally(found), found };
  } catch (e) {
    return { failed: e.message };
  }
});

const lintLine = () => `Lint: ${linted().counts ?? `failed: ${linted().failed}`}`;

function hookHealth() {
  const errors = hookErrors();
  if (!errors.length) return ['No hook errors.'];
  const { at, message } = errors.at(-1);
  return [`${plural(errors.length, 'hook error')} in ${toPosix(errorsLog())}`, `  newest: ${clip(`${at} ${message}`, 300)}`];
}

function section(title, lines) {
  try {
    const got = lines();
    return ['', title, ...(got.length ? got : ['None.'])];
  } catch (e) {
    return ['', title, `failed: ${e.message}`];
  }
}

function emptyTopics() {
  const used = topicNotes(notes());
  return Object.entries(config().domains).flatMap(([d, c]) => {
    if (isVaultOnly(d)) return [];
    const empty = (c.topics ?? []).filter(t => !used.get(d)?.has(normTopic(t)));
    return empty.length ? [`${d}: ${empty.join(', ')}`] : [];
  });
}

const liveNotes = once(() => {
  const byNote = new Map(notes().map(n => [n.key, n]));
  return Object.entries(liveRules(notes())).sort(byKey).map(([k, r]) => [k, r, byNote.get(k)]);
});
const tracked = once(trackedSessions);
// A session shown a rule before its move recorded the key it had then.
const shownTo = (t, n) => noteKeys(n).some(k => t.keys.has(k));

// Sessions are known only by the prefix an Evidence line gives; one whose markers were pruned, or that ran before
// the hooks recorded deliveries, is unknown.
function correctedAgain() {
  const seen = (s, n) => {
    const t = tracked().find(x => x.id.startsWith(s));
    return !t ? 'unknown' : shownTo(t, n) ? 'shown' : 'not shown';
  };
  return liveNotes().flatMap(([k, , n]) => {
    const later = evidenceSessions(n).slice(1);
    return later.length ? [`- ${k}: ${later.map(s => `session ${s} ${seen(s, n)}`).join(', ')}`] : [];
  });
}

// Counts the registered sessions in the rule's domain, active since it was written, that aren't in its Evidence.
function neverShown() {
  const registered = tracked().filter(t => t.cwd !== null);
  const domains = new Map(registered.map(t => [t.id, sessionDomains(t.id, t.cwd)]));
  return liveNotes().flatMap(([k, r, n]) => {
    if (tracked().some(t => shownTo(t, n))) return [];
    const created = validDay(n.data.created) ? n.data.created : '';
    const behind = new Set(evidenceSessions(n));
    const missed = registered.filter(t => (r.domain === 'global' || domains.get(t.id).includes(r.domain))
      && localDay(t.last) >= created && !behind.has(t.name)).length;
    return missed ? [{ k, missed, line: `- ${k}: ${plural(missed, 'session')}${created ? ` since ${created}` : ''}` }] : [];
  }).sort((a, b) => b.missed - a.missed || cmp(a.k, b.k)).map(x => x.line);
}

function globPairs() {
  const rules = liveNotes().filter(([, r]) => r.applies_to?.length);
  // Knowledge rules rank first by how their versions fit the projects this folder reaches.
  const fit = fitIn(sessionReach(cwdOf({})), cwdOf({}));
  const order = (na, nb) => {
    const rank = rankPair(na, nb, { fit });
    return !rank ? '' : ` · ${rank.first ? `${rank.first.key} ranks first` : 'neither ranks first'}: ${rank.why}`;
  };
  return rules.flatMap(([a, ra, na], i) => rules.slice(i + 1).flatMap(([b, rb, nb]) => {
    const pair = sharedFiles(ra, rb);
    return pair ? [`- ${a} and ${b}, on ${ra.topic}: '${pair[0]}' and '${pair[1]}'${order(na, nb)}`] : [];
  }));
}

const sourcePages = once(() => notes().filter(isSourcePage));
const resolve = once(() => resolver(notes()));

const chains = once(sourceChains);
const listed = once(folderNames);

// A file in a bundle is cited as part of the bundle, the one source a source page names. A page of a doc set is a source
// of its own, with its own copies.
const sourceKey = x => {
  const { file, bundle } = sourceItem(x);
  return (bundle && !isDocSet(bundle, listed()) ? bundle : file) ?? x;
};
const citations = once(() => noteCitations(notes(), chains()));
const derived = once(() => readDerived() ?? {});

// The copies of each source a note cites that are later in its chain than the latest one it cites, as [id, copies].
const laterCopies = n => [...citations()(n).latest].flatMap(([id, i]) => {
  const newer = newerCopies(chains(), id, i);
  return newer.length ? [[id, newer]] : [];
});

// A knowledge rule states a fact as of a day, so a source page on its topic dated after it, that the rule neither
// cites in its Evidence nor links, may say the fact has changed. So may a source page in any domain, on any topic, whose
// source is a later copy of one the rule cites.
function newerSources() {
  const dated = sourcePages().filter(s => s.topic && validDay(s.data.source_date)).sort((a, b) => cmp(a.key, b.key));
  return liveNotes().flatMap(([k, r, n]) => {
    if (!validDay(n.as_of)) return [];
    const after = dated.filter(s => s.domain === r.domain && s.topic === r.topic && s.data.source_date > n.as_of);
    const copies = new Set(laterCopies(n).flatMap(([, rels]) => rels));
    const later = copies.size ? sourcePages().filter(s => copies.has(sourceItem(s.data.source).file)) : [];
    const linked = new Set(linkedKeys(n, resolve()));
    const cited = new Set(evidenceSources(n).map(sourceKey));
    const newer = [...new Set([...after, ...later])].filter(s => !linked.has(s.key) && !cited.has(sourceKey(s.data.source))).sort((a, b) => cmp(a.key, b.key));
    const shown = s => (validDay(s.data.source_date) ? `${s.key} (dated ${s.data.source_date})` : `${s.key} (a later copy)`);
    return newer.length ? [`- ${k}, as of ${n.as_of}: ${joinList(newer.map(shown), 'and')}`] : [];
  });
}

// A note stays listed until its text changes, as the hooks label it, with the sources build found changed.
function unverifiedNotes() {
  return notes().filter(n => unverifiedNow(derived(), n)).sort((a, b) => cmp(a.key, b.key)).map(n => {
    const { since, sources } = unverifiedNow(derived(), n);
    const ids = Array.isArray(sources) ? sources.filter(id => chains().chains.has(id)) : [];
    const changed = ids.map(id => `${id}, newer copy ${chains().chains.get(id).at(-1)}`);
    return `- ${n.key}: since ${validDay(since) ? since : '(no date)'} · ${changed.join('; ') || '(the source is no longer in raw/refs/)'}`;
  });
}

function failedChecks() {
  const sources = derived().sources ?? {};
  return Object.keys(sources).sort(cmp).filter(id => sources[id]?.result === 'failed')
    .map(id => `- ${id}: last checked ${sources[id].checked ?? 'never'} · ${sources[id].why}`);
}

// A browser saves a whole web page as <name>.html, or .htm, and the files it shows in <name>_files/ beside it.
const savedPages = f => [...f.matchAll(/_files\//g)].flatMap(m => ['html', 'htm'].map(ext => `${f.slice(0, m.index)}.${ext}`));

// /ingest gives each file it takes in a source page, so a file a footnote cites but no source page names is still to do.
// A file saved from a URL is done once a source page names that URL, or a file saved from it with the same hash, and a
// file a saved page shows goes with that page. A copy with a sha256 is done only when a page names that file or a copy
// with the same URL and sha256, so a page on the bare URL names only the copies that have none. A copy with another hash
// is a new version of the source, still to do.
// A folder with a source.md is one source however many files it holds, named by the folder or a path in it.
// Only a file a source page could name is listed, which leaves out links to folders.
const unnamedSources = () => {
  const { loose, bundles } = refSources();
  const all = new Set(loose);
  const versions = new Map([...loose, ...bundles].map(f => [f, sourceVersion(f)]));
  const versionKey = v => `${v.url}\n${v.version}`;
  const hashKey = v => `${v.url}\n${v.sha256}`;
  const named = new Set();
  const urls = new Set();
  const pinned = new Set();
  const pinnedUrls = new Set();
  const hashes = new Set();
  for (const n of sourcePages()) {
    const item = sourceItem(n.data.source).rel;
    const v = item && versions.get(item);
    if (item) named.add(item);
    else if (n.data.source) urls.add(n.data.source);
    if (v?.sha256) hashes.add(hashKey(v));
    if (v?.version) {
      pinned.add(versionKey(v));
      pinnedUrls.add(v.url);
    } else if (v) {
      urls.add(v.url);
    }
  }
  return [...loose, ...bundles].filter(f => {
    const v = versions.get(f);
    const done = named.has(f) || (v?.sha256
      ? hashes.has(hashKey(v))
      : v && (urls.has(v.url) || (v.version ? pinned.has(versionKey(v)) : pinnedUrls.has(v.url))));
    return !done && !savedPages(f).some(p => all.has(p));
  }).sort();
};

function uncheckedQuotes() {
  if (linted().failed) throw new Error(linted().failed);
  return (linted().found.find(f => f.unchecked)?.unchecked ?? []).map(u => `- ${u.note} · ${u.cites} · "${clip(u.quote, 80)}"`);
}

function provisional() {
  return newestFirst(liveRows(subjectRows()).filter(r => r.status === 'provisional'))
    .map(r => `- ${localDay(r.at)} · ${projectName(r.project)}/${r.subject} · ${r.question}: "${r.pick}" (${r.id})`);
}

// A drop writes no note and needs no consent, so any session's shell can make one: the user sees each here.
function queueDrops() {
  const rows = queueRows();
  const keyOf = new Map(rows.filter(r => !r.decides).map(r => [r.id, r.key]));
  return newestFirst(rows.filter(r => r.decides && r.decision === 'dropped'))
    .map(r => `- ${r.decides} · ${keyOf.get(r.decides) ?? 'no entry'} · dropped ${localDay(r.at)} in session ${sessionName(String(r.session), r.agent)}`);
}

const knowledgeWithPackage = () => liveNotes().filter(([, r]) => namesPackage(r));

// /lint drafts a reword that fills each version in, once a reader can say what it is. A requires the user wrote wins over
// checked_with, so a rule with one needs none.
function uncheckedVersions() {
  if (!anyReaders()) return ['No version readers set.'];
  return knowledgeWithPackage().filter(([, r]) => !r.checked_with && !hasRequires(r)).map(([k, r]) => `- ${k}: ${packageId(r.package)}`);
}

// The versions read at one project root: those of the domains whose project it is, and global's. A domain whose project
// is a folder above it is read at that folder, its own root, so each version is named for the folder it was read in.
function rootVersions(root) {
  const own = domainsFor(root).filter(h => pathKey(h.root) === pathKey(root));
  return projectVersions(own, root, root);
}

// Every project a reader has read, not only this folder's, since /lint drafts a retirement for each rule listed. A rule
// whose retirement is open, or the user dropped, is left out.
function pastVersion() {
  const asked = retirementsAsked();
  const rules = liveNotes().filter(([k, r]) => checkedWithOnly(r) && !asked.has(k));
  if (!rules.length) return [];
  const projects = liveRoots().map(root => ({ root, versions: rootVersions(root) }));
  return rules.flatMap(([k, r]) => {
    const found = projects.flatMap(({ root, versions }) => pastVersions(r, versions).map(v => `${v} in ${root}`));
    return found.length ? [`- ${k}: checked with ${r.checked_with} · ${packageId(r.package)} ${joinList(found, 'and')}`] : [];
  });
}

// A session's projects: the roots of its domains, or the work tree its cwd is in.
const projectsOf = t => {
  const hits = sessionHits(t.id, t.cwd);
  return hits.length ? hits.map(h => h.root) : [rootOutside(hits, t.cwd)].filter(Boolean);
};
// A marker is a file or a link to one, as reach reads it. A worktree's or submodule's .git file marks no kind of project.
const rootFiles = root => {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter(e => (e.isFile() || (e.isSymbolicLink() && isFileAt(path.join(root, e.name)))) && isMarkerName(e.name) && e.name.toLowerCase() !== '.git')
      .map(e => e.name);
  } catch { return []; }
};

// A file every project shown a global rule has at its root, and some other project lacks, marks the kind of project the
// rule is about. No name is built in. A name every project has is in every other project too, so it marks none.
function domainCandidates() {
  const registered = tracked().filter(t => t.cwd !== null).map(t => ({ t, roots: projectsOf(t) }));
  const files = new Map();
  for (const { roots } of registered) for (const root of roots) if (!files.has(pathKey(root))) files.set(pathKey(root), new Set(rootFiles(root)));
  const [any, ...more] = files.values();
  const everywhere = new Set([...(any ?? [])].filter(name => more.every(f => f.has(name))));
  const byName = new Map();
  for (const [k, r, n] of liveNotes()) {
    if (r.domain !== 'global' || !r.applies_to?.length) continue;
    const shown = new Set(registered.filter(x => shownTo(x.t, n)).flatMap(x => x.roots.map(root => pathKey(root))));
    if (shown.size < config().suggestAfterProjects) continue;
    const [first, ...rest] = [...shown].map(root => files.get(root));
    for (const name of first) {
      if (everywhere.has(name) || !rest.every(f => f.has(name))) continue;
      const got = byName.get(name) ?? byName.set(name, { roots: new Set(), rules: [] }).get(name);
      for (const root of shown) got.roots.add(root);
      got.rules.push(k);
    }
  }
  return [...byName].sort(([a], [b]) => cmp(a, b)).map(([name, { roots, rules }]) => `- ${name}: ${plural(roots.size, 'project')} · ${rules.join(', ')}`);
}

const pagesOf = kind => notes().filter(n => n.type === 'page' && n.kind === kind);

function entityCandidates() {
  const paged = new Set(pagesOf('entity').map(n => packageId(n.data.package)).filter(Boolean));
  const byPackage = new Map();
  for (const [k, r] of knowledgeWithPackage()) {
    const id = packageId(r.package);
    if (!paged.has(id)) byPackage.set(id, [...(byPackage.get(id) ?? []), k]);
  }
  return [...byPackage].filter(([, keys]) => keys.length >= config().pages.entityAfterRules).sort(byKey)
    .map(([id, keys]) => `- ${id}: ${plural(keys.length, 'rule')} · ${keys.join(', ')}`);
}

// Two entity pages in one domain that do the same job, with no synthesis page comparing them.
function comparisonCandidates() {
  const compared = pagesOf('synthesis').map(n => new Set(comparedKeys(n, resolve())));
  const byJob = new Map();
  for (const n of pagesOf('entity')) {
    if (!filled(n.data.job)) continue;
    const job = `${n.domain}|${n.data.job.trim().toLowerCase()}`;
    byJob.set(job, [...(byJob.get(job) ?? []), n]);
  }
  return [...byJob.values()].flatMap(pages => pages.flatMap((a, i) => pages.slice(i + 1).flatMap(b => (
    compared.some(keys => keys.has(a.key) && keys.has(b.key)) ? [] : [`- ${a.key} and ${b.key}: ${a.data.job.trim()}`]))));
}

// A topic page links its rules under ## Rules, so a session that reads it finds them all.
function rollupCandidates() {
  const pages = byTopic(notes().filter(isTopicPage));
  return [...topicNotes(notes())].flatMap(([d, topics]) => [...topics].flatMap(([t, rules]) => {
    if (rules.length < config().pages.rollupAfterRules) return [];
    const page = pages.get(d)?.get(t)?.[0];
    if (!page) return [`- ${d}, ${t}: ${plural(rules.length, 'rule')}, no topic page`];
    const linked = new Set(linksUnder(page, 'Rules').map(x => resolve()(x)));
    const missing = rules.map(r => r.key).filter(k => !linked.has(k));
    return missing.length ? [`- ${d}, ${t}: ${page.rel} doesn't link ${joinList(missing, 'or')} under ## Rules`] : [];
  })).sort();
}

const status = () => [
  lintLine(), '', 'Hook health', ...hookHealth(),
  ...section('Listed topics no rule has yet', emptyTopics),
  ...section('Rules corrected again in later sessions', correctedAgain),
  ...section('Rules no session was shown', neverShown),
  ...section('Rules on one topic whose globs overlap', globPairs),
  ...section('Knowledge rules a newer source on their topic may override', newerSources),
  ...section('Notes a changed source has left unverified', unverifiedNotes),
  ...section('Source checks that failed', failedChecks),
  ...section("Quotes lint can't check", uncheckedQuotes),
  ...section('Provisional picks not yet confirmed', provisional),
  ...section('Review queue entries dropped', queueDrops),
  ...section('Knowledge rules with a package and no checked_with', uncheckedVersions),
  ...section('Rules past their version in a project', pastVersion),
  ...section('Global rules that keep matching one kind of project', domainCandidates),
  ...section('Libraries with enough rules for an entity page', entityCandidates),
  ...section('Entity pages that do the same job, with no comparison', comparisonCandidates),
  ...section('Topics whose rules need a topic page to roll them up', rollupCandidates),
  ...section('Sources in raw/refs/ no source page names', () => unnamedSources().map(f => `- ${f}`)),
].join('\n');

function runStatus() {
  console.log(status());
  const { counts } = linted();
  if (counts) guarded('lint log', () => appendLog([`lint · ${counts}`]));
  // /lint runs status first, so this is what quiets the session-start error line and reminder. A failed stamp is
  // logged, and session start reports it.
  guarded('lint stamp', lintRan);
  // Session start clears old sessions a few at a time; /lint clears the rest.
  guarded('tidy', () => tidy({ full: true }));
}

const COMMANDS = {
  status: runStatus,
  done: lintDone,
  sources: () => console.log(unnamedSources().join('\n') || 'Every file in raw/refs/ has a source page.'),
};
const USAGE = `usage: ${Object.keys(COMMANDS).map(c => `node tools/review.mjs ${c}`).join('\n       ')}`;

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (!Object.hasOwn(COMMANDS, cmd) || rest.length) throw new UsageError();
  COMMANDS[cmd]();
} catch (e) {
  if (e instanceof UsageError) {
    console.error(USAGE);
    process.exitCode = 2;
  } else {
    console.error(`review failed: ${e.message}`);
    process.exitCode = 1;
  }
}
