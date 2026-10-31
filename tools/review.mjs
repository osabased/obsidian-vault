import { config, plural, toPosix, guarded, hookErrors, errorsLog, domainsFor, localDay, appendLog, filesIn, vaultPath } from './lib/vault.mjs';
import {
  clip, normTopic, topicNotes, loadNotes, liveRules, evidenceSessions, validDay, byKey, cmp, sharedFiles, isResearch, rawFile, resolver, linkedKeys, evidenceSources, isSourcePage, joinList,
  savedUrl, rankPair,
} from './lib/rules.mjs';
import { lint, tally } from './lib/lint.mjs';
import { lintRan, lintDone, trackedSessions } from './lib/sessions.mjs';
import { subjectRows, liveRows, newestFirst, projectName } from './lib/picks.mjs';
import { UsageError } from './lib/input.mjs';

// Each section reads these once a run; a read that fails is tried again by the next section, which reports it too.
const once = f => {
  let got;
  return () => (got ??= f());
};

const notes = once(loadNotes);

const linted = once(() => {
  try {
    return { counts: tally(lint(notes())) };
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
    if (isResearch(d)) return [];
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
  const domains = new Map(registered.map(t => [t.id, domainsFor(t.cwd).map(d => d.domain)]));
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
  const order = (na, nb) => {
    const rank = rankPair(na, nb);
    return !rank ? '' : ` · ${rank.first ? `${rank.first.key} ranks first` : 'neither ranks first'}: ${rank.why}`;
  };
  return rules.flatMap(([a, ra, na], i) => rules.slice(i + 1).flatMap(([b, rb, nb]) => {
    const pair = sharedFiles(ra, rb);
    return pair ? [`- ${a} and ${b}, on ${ra.topic}: '${pair[0]}' and '${pair[1]}'${order(na, nb)}`] : [];
  }));
}

const sourcePages = once(() => notes().filter(isSourcePage));
const resolve = once(() => resolver(notes()));

// A knowledge rule states a fact as of a day, so a source page on its topic dated after it, that the rule neither
// cites in its Evidence nor links, may say the fact has changed.
function newerSources() {
  const dated = sourcePages().filter(s => s.topic && validDay(s.data.source_date)).sort((a, b) => cmp(a.key, b.key));
  return liveNotes().flatMap(([k, r, n]) => {
    if (!validDay(n.as_of)) return [];
    const after = dated.filter(s => s.domain === r.domain && s.topic === r.topic && s.data.source_date > n.as_of);
    if (!after.length) return [];
    const linked = new Set(linkedKeys(n, resolve()));
    const cited = new Set(evidenceSources(n));
    const newer = after.filter(s => !linked.has(s.key) && !cited.has(rawFile(s.data.source) ?? s.data.source));
    return newer.length ? [`- ${k}, as of ${n.as_of}: ${joinList(newer.map(s => `${s.key} (dated ${s.data.source_date})`), 'and')}`] : [];
  });
}

// A browser saves a whole web page as <name>.html, or .htm, and the files it shows in <name>_files/ beside it.
const savedPages = f => [...f.matchAll(/_files\//g)].flatMap(m => ['html', 'htm'].map(ext => `${f.slice(0, m.index)}.${ext}`));

// /ingest gives each file it takes in a source page, so a file a footnote cites but no source page names is still to do.
// A file saved from a URL is done once a source page names that URL or another file saved from it, and a file a saved
// page shows goes with that page. Only a file a source page could name is listed, which leaves out links to folders.
const unnamedSources = () => {
  const files = filesIn(vaultPath('raw', 'refs'), '', 'raw/refs').filter(f => rawFile(f) === f);
  const all = new Set(files);
  const urls = new Map(files.map(f => [f, savedUrl(f)]));
  const named = new Set(sourcePages().flatMap(n => {
    const f = rawFile(n.data.source);
    return f ? [f, urls.get(f)] : [n.data.source];
  }).filter(Boolean));
  return files.filter(f => !named.has(f) && !named.has(urls.get(f)) && !savedPages(f).some(p => all.has(p))).sort();
};

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
