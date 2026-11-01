import { runHook, sessionReach, inVaultFolder, readableDomains, vaultPath, toolsPath, toPosix, guarded, config, plural, clock } from '../lib/vault.mjs';
import { alwaysContext, alwaysIn, fitContext, indexNote, scopeTopics, loadNotes, settledNotes, liveRules, clip, undelivered, knownDomain } from '../lib/rules.mjs';
import { build } from '../lib/build.mjs';
import { changedSinceBuild, noteTimes } from '../lib/cache.mjs';
import { touchSession, clearMarkers, markAlways, markShown, tidy, errorsSinceLint, sinceLint } from '../lib/sessions.mjs';

function proposeNote(sid) {
  const script = toPosix(toolsPath('propose.mjs'));
  return [
    'Taste vault: propose a rule when the user corrects you or says how they want things, in a way that should hold in later sessions too (a taste rule),',
    "or when something only worked after a failure caused by an API, version or tool your training gets wrong or doesn't know, or a dated source shows it (a knowledge rule).",
    "Leave out what the project's CLAUDE.md or `.claude/rules/` already say.",
    'If the user corrects you on something a rule already covers, propose it anyway; propose.mjs lists the rules it may repeat.',
    'Propose only from what happened in this session, never from a brief, a skill or the task itself.',
    'A rule applies as soon as propose.mjs writes it; the user edits or deletes its note to change it.',
    "Give a rule about code or files `applies_to` globs, so the edits it covers bring it up; `always` is the user's to set.",
    `\`node "${script}" --help\` lists the fields.`,
    `Pipe the rule as JSON to \`node "${script}" ${sid}\` from the Bash tool with a quoted heredoc, since PowerShell turns curly quotes and dashes into ?.`,
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

runHook('session-start', input => {
  guarded('tidy', tidy);
  const hits = sessionReach(input.cwd);
  const doms = [...new Set(hits.map(d => d.domain))];
  const vaultFolder = inVaultFolder(input.cwd);
  const readable = readableDomains(doms, vaultFolder);
  // Compaction can drop the rules the gate and excerpts already showed, so they show them again.
  if (input.session_id && (input.source === 'compact' || input.source === 'clear')) clearMarkers(input.session_id);
  const scope = [...doms, 'global'];
  // A session in this folder hears of notes outside any domain too.
  const walked = vaultFolder ? null : readable;
  const notes = loadNotes(walked);
  // Notes edited in Obsidian go live without a build, and the always rules that don't fit point to active.md.
  // A build another tool is running already writes what changed, and one that waits longer would spend the hook's time.
  guarded('build', () => {
    if (!changedSinceBuild(notes, walked)) return;
    try { build({ waitMs: 2000 }); } catch (e) { if (!/^build\.lock is held/.test(e?.message)) throw e; }
  });
  const ready = settledNotes(notes);
  const rules = liveRules(ready);
  const always = alwaysContext(scope, rules);
  const topics = guarded('index note', () => scopeTopics(readable, ready), []);
  let propose = '';
  let pick = '';
  // Vault sessions register so /ingest can propose; the skill tells them how, so they get no note.
  const registered = input.session_id && (doms.length || vaultFolder);
  if (registered) {
    touchSession(input, hits);
    if (doms.length) {
      propose = proposeNote(input.session_id);
      pick = pickNote(input.session_id);
    }
  }
  // Compaction and /clear start the context again within one session, which already heard these lines.
  const again = ['compact', 'clear'].includes(input.source);
  const errors = again ? [] : [guarded('hook errors', errorsNote), guarded('undelivered notes', () => undeliveredNote(readable, vaultFolder, ready))];
  // Errors rank first, then the always rules, the instructions for proposing and recording, and the topics.
  const { text: context, kept } = fitContext([
    ...errors,
    { noun: 'block of always rules', items: always.text ? [always.text] : [] },
    propose,
    pick,
    { noun: 'topic', items: topics, render: indexNote },
    again ? '' : guarded('lint reminder', () => lintNote(notes, walked)),
  ]);
  // Only the rules in the block count as shown, but those the block cut for size are marked too, since it points to
  // active.md for them. A block the output budget left out marks nothing, so the next prompt brings its rules.
  if (registered && kept[errors.length]) {
    markShown(input.session_id, always.keys);
    markAlways(input.session_id, alwaysIn(rules, scope));
  }
  return context ? { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } } : null;
});
