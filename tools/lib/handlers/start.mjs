import { sessionReach, inVaultFolder, isQuiet, readableDomains, vaultPath, toPosix, guarded, config, plural, clock, daysBetween } from '../vault.mjs';
import { statusLine } from '../status.mjs';
import { alwaysContext, alwaysIn, fitContext, indexNote, scopeTopics, loadNotesAsync, settledNotes, liveRules, deliverable, deliveryFor, readDerived, clip, undelivered, knownDomain, joinList } from '../rules.mjs';
import { build } from '../build.mjs';
import { remaining } from '../deadline.mjs';
import { changedSinceBuild, noteTimes, refStats } from '../cache.mjs';
import { knowledgeDays } from '../sources.mjs';
import { touchSession, clearMarkers, markAlways, markShown, tidy, errorsSinceLint, sinceLint } from '../sessions.mjs';
import { proposeNote, pickNote, uncoveredNote } from '../instructions.mjs';

function errorsNote() {
  const errors = errorsSinceLint();
  if (!errors.length) return '';
  const { at, message } = errors.at(-1);
  const logged = `${plural(errors.length, 'error')} ${errors.length === 1 ? 'was' : 'were'} logged`;
  return `Taste vault: ${logged} in \`.state/errors.log\` since /lint last ran, the newest at ${clock(new Date(at))}: \`${clip(message, 200)}\`. Tell the user; /lint in \`${toPosix(vaultPath())}\` shows the count and the newest.`;
}

// Notes go live without a commit, so a note an error keeps from delivery would otherwise go unnoticed until /lint.
// A session in this folder also hears of notes outside any domain in vault.config.json.
function undeliveredNote(scope, vaultFolder, notes) {
  const broken = notes.filter(n => !n.superseded_by && (scope.includes(n.domain) || (vaultFolder && !knownDomain(n.domain))))
    .flatMap(n => {
      const why = undelivered(n);
      return why ? [`${n.key} (${clip(why, 120)})`] : [];
    });
  if (!broken.length) return '';
  const more = broken.length > 3 ? `, and ${broken.length - 3} more` : '';
  return `Taste vault: ${plural(broken.length, 'note')} ${broken.length === 1 ? "has an error and isn't" : "have an error and aren't"} delivered: ${broken.slice(0, 3).join(', ')}${more}. Tell the user; /lint in \`${toPosix(vaultPath())}\` lists the fixes.`;
}

// A vault nobody changes has nothing new to lint, however long it sits.
// The notes walked were stat'ed already, so only the other folders are.
function lintNote(notes, walked) {
  const { days, changed } = sinceLint([...notes.map(n => n.saved), ...(walked ? noteTimes(walked) : [])]);
  const { remindAfterDays, remindAfterNotes } = config().lint;
  if (!changed || (days !== null && days < remindAfterDays && changed < remindAfterNotes)) return '';
  const ran = days === null ? `hasn't run yet, and the vault has ${plural(changed, 'note')}`
    : `last ran ${days ? `${plural(days, 'day')} ago` : 'today'}, and ${plural(changed, 'note')} changed since`;
  return `Taste vault: /lint ${ran}. Remind the user to run /lint in \`${toPosix(vaultPath())}\`.`;
}

// A failed check doesn't move checked, so a source that only fails stays counted until a check goes through.
function sourcesNote(scope, derived) {
  const { sources = {}, domains = {} } = derived;
  const stale = new Set();
  const named = [];
  const limits = [];
  for (const d of scope) {
    const { checkAfterDays } = knowledgeDays(d);
    const old = (domains[d] ?? []).filter(id => {
      const checked = sources[id]?.checked;
      return !checked || daysBetween(checked) > checkAfterDays;
    });
    if (!old.length) continue;
    old.forEach(id => stale.add(id));
    named.push(d);
    limits.push(checkAfterDays);
  }
  if (!stale.size) return '';
  const verb = stale.size === 1 ? "hasn't" : "haven't";
  return `Taste vault: ${plural(stale.size, 'source')} the ${joinList(named, 'and')} notes cite ${verb} been checked in ${plural(Math.min(...limits), 'day')}. Remind the user to run /lint in \`${toPosix(vaultPath())}\`, which refreshes them.`;
}

export async function start(event, agent) {
  guarded('tidy', tidy);
  const hits = sessionReach(event.cwd);
  const doms = [...new Set(hits.map(d => d.domain))];
  const vaultFolder = inVaultFolder(event.cwd);
  const readable = readableDomains(doms, vaultFolder);
  // Compaction can drop the rules the gate and excerpts already showed, so they show them again.
  if (event.session && (event.reason === 'compact' || event.reason === 'clear')) clearMarkers(event.session);
  const scope = [...doms, 'global'];
  // A session in this folder hears of notes outside any domain too.
  const walked = vaultFolder ? null : readable;
  const notes = await loadNotesAsync(walked);
  // Notes edited in Obsidian go live without a build, and the always rules that don't fit point to active.md.
  // A build another tool is running already writes what changed, and one that waits longer would spend the hook's time.
  // A derived.json that is missing or corrupt counts as changed, so it is rebuilt once instead of failing every start. When
  // nothing needs building, the delivery below takes the copy read here rather than parse the file again.
  let derived;
  guarded('build', () => {
    const refs = refStats();
    derived = readDerived();
    if (derived && !changedSinceBuild(notes, walked, refs)) return;
    derived = undefined;
    try { build({ waitMs: Math.min(2000, remaining()), refs }); } catch (e) { if (e?.code !== 'ELOCKED') throw e; }
  });
  const ready = settledNotes(notes);
  const ctx = deliveryFor(hits, derived && { derived });
  const rules = deliverable(liveRules(ready), ctx);
  const always = alwaysContext(scope, rules);
  const topics = guarded('index note', () => scopeTopics(readable, ready), []);
  let propose = '';
  let pick = '';
  let uncovered = '';
  // Every session registers, so one in a folder no domain reaches can propose to global. Vault sessions get no note,
  // since /ingest tells them how.
  const registered = Boolean(event.session);
  if (registered) {
    touchSession(event, hits, agent.name);
    if (doms.length) {
      propose = proposeNote(event.session, agent, doms, vaultFolder);
      pick = pickNote(event.session);
    } else if (!vaultFolder) uncovered = uncoveredNote(event.session, agent, { quiet: isQuiet(event.cwd) });
  }
  // Compaction and /clear start the context again within one session, which already heard these lines.
  const again = ['compact', 'clear'].includes(event.reason);
  const errors = again ? [] : [guarded('hook errors', errorsNote), guarded('undelivered notes', () => undeliveredNote(readable, vaultFolder, ready))];
  const lead = [...errors, uncovered];
  // Errors rank first, then the line for a folder no domain reaches, the always rules, the instructions for proposing
  // and recording, and the topics.
  const { text: context, kept } = fitContext([
    ...lead,
    { noun: 'block of always rules', items: always.text ? [always.text] : [] },
    propose,
    pick,
    { noun: 'topic', items: topics, render: indexNote },
    again ? '' : guarded('lint reminder', () => lintNote(notes, walked)),
    again ? '' : guarded('source checks', () => sourcesNote(readable, ctx.derived)),
  ]);
  // Only the rules in the block count as shown, but those the block cut for size are marked too, since it points to
  // active.md for them. A block the output budget left out marks nothing, so the next prompt brings its rules.
  if (registered && kept[lead.length]) {
    markShown(event.session, always.keys);
    markAlways(event.session, alwaysIn(rules, scope));
  }
  const notice = again ? '' : guarded('status line', () => statusLine({ doms, vaultFolder, rules, notes: ready, readable, ctx }));
  return context || notice ? { context, notice } : null;
}
