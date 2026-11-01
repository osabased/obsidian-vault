import fs from 'node:fs';
import { runHook, vaultRel, vaultOwn, cwdOf, plainText } from '../lib/vault.mjs';
import { loadNotesAsync, settledNotes, liveRules, deliverable, deliveryFor, ruleLine, fitContext } from '../lib/rules.mjs';
import { changedFiles } from '../lib/git.mjs';
import { checkDeadline } from '../lib/deadline.mjs';
import { fileScope, dueRules, gatedFile } from '../lib/scope.mjs';
import { turnStart, marked, markMany, markShown } from '../lib/sessions.mjs';

// Triggers are tested against the whole file as it is now, since a shell command leaves no new text to test. A file too
// big to read in a hook fires no trigger.
const MAX_TEXT = 1 << 20;
function textOf(file, size) {
  if (size > MAX_TEXT) return '';
  try { return plainText(fs.readFileSync(file, 'utf8')); } catch { return ''; }
}

// The files changed in the project and saved since the turn began that no Edit or Write call reached through the gate:
// what a shell command wrote, or the user saved in an editor meanwhile.
function shellWritten(input, cwd, since) {
  const files = [];
  for (const file of changedFiles(cwd) ?? []) {
    checkDeadline();
    if (vaultOwn(vaultRel(file)) || marked('gate', input.session_id, gatedFile(since, file))) continue;
    const st = fs.statSync(file, { throwIfNoEntry: false });
    if (st?.isFile() && st.mtimeMs >= since) files.push({ file, size: st.size });
  }
  return files;
}

// Each file's rules are listed under it; a rule already listed under an earlier file is named again without its text.
// Every rule due is marked gated on its file, so the next stop, and a later edit of that file, pass. The markers alone
// keep it to one continuation per file, so stop_hook_active is not consulted: a file a continuation writes still gets
// its rules, and Claude Code ends the turn after 8 continuations in a row whatever the hook says.
runHook('stop', async input => {
  const sid = input.session_id;
  const since = sid ? turnStart(sid) : null;
  if (since === null) return null;
  const cwd = cwdOf(input);
  const files = shellWritten(input, cwd, since);
  if (!files.length) return null;
  const scoped = files.map(f => ({ ...f, ...fileScope(f.file, cwd) }));
  const rules = liveRules(settledNotes(await loadNotesAsync([...new Set(scoped.flatMap(s => s.domains))])));
  const listed = new Set();
  const sections = [];
  const shared = deliveryFor([]);
  for (const { file, size, matching, hits: reach } of scoped) {
    checkDeadline();
    const hits = dueRules(input, deliverable(matching(rules), deliveryFor(reach, shared)), () => textOf(file, size));
    if (!hits.length) continue;
    sections.push({
      noun: 'rule', head: `${hits[0].rel}:`, hits,
      items: hits.map(h => (listed.has(h.key) ? `- ${h.key}` : (listed.add(h.key), ruleLine(h.key, h.note)))),
    });
  }
  if (!sections.length) return null;
  const lead = sections.length === 1
    ? 'Taste rules apply to a file this turn wrote. Re-read the change against them before you stop.'
    : 'Taste rules apply to files this turn wrote. Re-read the changes against them before you stop.';
  const { text, kept } = fitContext([lead, ...sections], { gap: '\n' });
  markMany('gate', sid, sections.flatMap(s => s.hits.map(h => h.id)));
  markShown(sid, [...new Set(sections.flatMap((s, i) => s.hits.slice(0, kept[i + 1]).map(h => h.key)))]);
  return { hookSpecificOutput: { hookEventName: 'Stop', additionalContext: text } };
});
