import { sessionReach, inVaultFolder, readableDomains, vaultPath, toolsPath, toPosix, guarded, config, plural, clock, daysBetween } from '../vault.mjs';
import { alwaysContext, alwaysIn, fitContext, indexNote, scopeTopics, loadNotesAsync, settledNotes, liveRules, deliverable, deliveryFor, readDerived, clip, undelivered, knownDomain, joinList } from '../rules.mjs';
import { build } from '../build.mjs';
import { remaining } from '../deadline.mjs';
import { changedSinceBuild, noteTimes, refStats } from '../cache.mjs';
import { knowledgeDays } from '../sources.mjs';
import { touchSession, clearMarkers, markAlways, markShown, tidy, errorsSinceLint, sinceLint } from '../sessions.mjs';

function proposeNote(sid, agent) {
  const script = toPosix(toolsPath('propose.mjs'));
  return [
    'Taste vault: propose a rule when the user corrects you or says how they want things, in a way that should hold in later sessions too (a taste rule),',
    "or when something only worked after a failure caused by an API, version or tool your training gets wrong or doesn't know, or a dated source shows it (a knowledge rule).",
    "Leave out what the project's own agent instructions already say; a compiled taste-vault section in them is the vault's copy.",
    'If the user corrects you on something a rule already covers, propose it anyway; propose.mjs lists the rules it may repeat.',
    'Propose only from what happened in this session, never from a brief, a skill or the task itself.',
    'A rule applies as soon as propose.mjs writes it; the user edits or deletes its note to change it.',
    "Give a rule about code or files `applies_to` globs, so the edits it covers bring it up; `always` is the user's to set.",
    `\`node "${script}" --help\` lists the fields.`,
    `Pipe the rule as JSON to \`node "${script}" ${sid}\` ${agent.proposeShell}.`,
    'Then end your reply with the lines it prints.',
  ].join(' ');
}

function pickNote(sid) {
  const script = toPosix(toolsPath('pick.mjs'));
  return [
    'Taste vault: when the user picks between options you showed them, or comments on one piece of work, record it by piping JSON',
    `to \`node "${script}" ${sid}\` the same way; a pick you make alone while the user is away is provisional.`,
    `Before building or reviewing a piece that has picks, run \`node "${script}" show ${sid} <subject>\` and keep to what it prints.`,
    `\`node "${script}" --help\` lists the fields.`,
  ].join(' ');
}

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
  // Vault sessions register so /ingest can propose; the skill tells them how, so they get no note.
  const registered = event.session && (doms.length || vaultFolder);
  if (registered) {
    touchSession(event, hits, agent.name);
    if (doms.length) {
      propose = proposeNote(event.session, agent);
      pick = pickNote(event.session);
    }
  }
  // Compaction and /clear start the context again within one session, which already heard these lines.
  const again = ['compact', 'clear'].includes(event.reason);
  const errors = again ? [] : [guarded('hook errors', errorsNote), guarded('undelivered notes', () => undeliveredNote(readable, vaultFolder, ready))];
  // Errors rank first, then the always rules, the instructions for proposing and recording, and the topics.
  const { text: context, kept } = fitContext([
    ...errors,
    { noun: 'block of always rules', items: always.text ? [always.text] : [] },
    propose,
    pick,
    { noun: 'topic', items: topics, render: indexNote },
    again ? '' : guarded('lint reminder', () => lintNote(notes, walked)),
    again ? '' : guarded('source checks', () => sourcesNote(readable, ctx.derived)),
  ]);
  // Only the rules in the block count as shown, but those the block cut for size are marked too, since it points to
  // active.md for them. A block the output budget left out marks nothing, so the next prompt brings its rules.
  if (registered && kept[errors.length]) {
    markShown(event.session, always.keys);
    markAlways(event.session, alwaysIn(rules, scope));
  }
  return context ? { context } : null;
}
