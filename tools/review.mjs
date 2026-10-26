import { config, plural, toPosix, guarded, hookErrors, errorsLog, domainsFor, localDay } from './lib/vault.mjs';
import { clip, normTopic, topicNotes, loadNotes, liveRules, evidenceSessions, validDay, byKey, cmp, sharedFiles } from './lib/rules.mjs';
import { lint, tally } from './lib/lint.mjs';
import { lintRan, trackedSessions } from './lib/sessions.mjs';
import { subjectRows, laterRows, newestFirst, projectName } from './lib/picks.mjs';

const USAGE = 'usage: node tools/review.mjs status';

class UsageError extends Error {}

// Each section reads these once a run; a read that fails is tried again by the next section, which reports it too.
const once = f => {
  let got;
  return () => (got ??= f());
};

const notes = once(loadNotes);

function lintLine() {
  try {
    return `Lint: ${tally(lint(notes()))}`;
  } catch (e) {
    return `Lint: failed: ${e.message}`;
  }
}

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
  return rules.flatMap(([a, ra], i) => rules.slice(i + 1).flatMap(([b, rb]) => {
    const pair = sharedFiles(ra, rb);
    return pair ? [`- ${a} and ${b}, on ${ra.topic}: '${pair[0]}' and '${pair[1]}'`] : [];
  }));
}

function provisional() {
  const rows = subjectRows();
  const later = laterRows(rows);
  return newestFirst(rows.filter(r => r.status === 'provisional' && !later.has(r.id)))
    .map(r => `- ${localDay(r.at)} · ${projectName(r.project)}/${r.subject} · ${r.question}: "${r.pick}" (${r.id})`);
}

const status = () => [
  lintLine(), '', 'Hook health', ...hookHealth(),
  ...section('Listed topics no rule has yet', emptyTopics),
  ...section('Rules corrected again in later sessions', correctedAgain),
  ...section('Rules no session was shown', neverShown),
  ...section('Rules on one topic whose globs overlap', globPairs),
  ...section('Provisional picks not yet confirmed', provisional),
].join('\n');

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (cmd !== 'status' || rest.length) throw new UsageError();
  console.log(status());
  // /lint runs status first, so this is what quiets the session-start error line and reminder. A failed stamp is
  // logged, and session start reports it.
  guarded('lint stamp', lintRan);
} catch (e) {
  if (e instanceof UsageError) {
    console.error(USAGE);
    process.exitCode = 2;
  } else {
    console.error(`review failed: ${e.message}`);
    process.exitCode = 1;
  }
}
