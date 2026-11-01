import { config, plural, toPosix, guarded, hookErrors, errorsLog, localDay, appendLog, isVaultOnly, sessionReach, cwdOf } from './lib/vault.mjs';
import {
  clip, normTopic, topicNotes, loadNotes, liveRules, evidenceSessions, validDay, byKey, cmp, sharedFiles, resolver, linkedKeys, evidenceSources, isSourcePage, joinList,
  rankPair, sourceItem, fitIn, readDerived, isDocSet, folderNames, unverifiedNow,
} from './lib/rules.mjs';
import { lint, tally } from './lib/lint.mjs';
import { lintRan, lintDone, tidy, trackedSessions, sessionDomains } from './lib/sessions.mjs';
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

// Sessions are known only by the prefix an Evidence line gives; one whose markers were pruned, or that ran before
// the hooks recorded deliveries, is unknown.
function correctedAgain() {
  const seen = (s, k) => {
    const t = tracked().find(x => x.id.startsWith(s));
    return !t ? 'unknown' : t.keys.has(k) ? 'shown' : 'not shown';
  };
  return liveNotes().flatMap(([k, , n]) => {
    const later = evidenceSessions(n).slice(1);
    return later.length ? [`- ${k}: ${later.map(s => `session ${s} ${seen(s, k)}`).join(', ')}`] : [];
  });
}

// Counts the registered sessions in the rule's domain, active since it was written, that aren't in its Evidence.
function neverShown() {
  const registered = tracked().filter(t => t.cwd !== null);
  const domains = new Map(registered.map(t => [t.id, sessionDomains(t.id, t.cwd)]));
  return liveNotes().flatMap(([k, r, n]) => {
    if (tracked().some(t => t.keys.has(k))) return [];
    const created = validDay(n.data.created) ? n.data.created : '';
    const behind = new Set(evidenceSessions(n));
    const missed = registered.filter(t => (r.domain === 'global' || domains.get(t.id).includes(r.domain))
      && localDay(t.last) >= created && !behind.has(t.id.slice(0, 8))).length;
    return missed ? [{ k, missed, line: `- ${k}: ${plural(missed, 'session')}${created ? ` since ${created}` : ''}` }] : [];
  }).sort((a, b) => b.missed - a.missed || cmp(a.k, b.k)).map(x => x.line);
}

function globPairs() {
  const rules = liveNotes().filter(([, r]) => r.applies_to?.length);
  // Knowledge rules rank first by how their versions fit the projects this folder reaches.
  const fit = fitIn(sessionReach(cwdOf({})));
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
