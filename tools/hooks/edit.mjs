import fs from 'node:fs';
import { runHook, config, domainsFor, inside, vaultRel, toPosix, cwdOf, FILE_TOOLS, toolFile, shortHash, lf } from '../lib/vault.mjs';
import { settledNotes, liveRules, livePages, ruleLine, pagePointers, tryRegex, cmp, clip, parseNote, QUOTED } from '../lib/rules.mjs';
import { bestMatch, specificity, bySpecificity } from '../lib/glob.mjs';
import { marked, mark, markShown, markPages } from '../lib/sessions.mjs';

function vaultGuard(file, cwd) {
  const rel = vaultRel(file, cwd);
  if (rel === null) return null;
  const low = rel.toLowerCase();
  if (low === 'active.md' || low === 'index.md') return `${rel} is generated from the notes. Edit the notes instead, then run \`node tools/build.mjs\`.`;
  if (low === 'decisions.md') return `${rel} is generated from the picks in raw/picks/. Record picks with tools/pick.mjs instead.`;
  if (low === 'derived' || low.startsWith('derived/')) return 'derived/ is written by extraction, not edited by hand. A better extraction replaces the file.';
  if (low === '.state' || low.startsWith('.state/')) return ".state/ is the hooks' own bookkeeping. Leave it to them.";
  if (low === '.live' || low.startsWith('.live/')) return '`.live/` is a copy of `tools/` as of the last commit. Change `tools/` and commit instead.';
  if (low.startsWith('raw/')) {
    if (fs.existsSync(toPosix(file, cwd))) return `raw/ is append-only: ${rel} already exists and can't be changed. Put new material in a new file under raw/refs/.`;
    if (!/^raw\/refs\/./.test(low)) return 'raw/ is append-only. New files go under raw/refs/; tools/propose.mjs and tools/pick.mjs write the rest.';
  }
  return null;
}

const foldQuotes = s => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');

// Edit matches as Claude Code does: line endings and curly quotes don't count, and an old_string found more than
// once without replace_all fails, so that edit is left for the tool to refuse.
function replaced(text, e) {
  let from = lf(e.old_string);
  if (!from) return null;
  if (!text.includes(from)) {
    const i = foldQuotes(text).indexOf(foldQuotes(from));
    if (i < 0) return null;
    from = text.slice(i, i + from.length);
  }
  const parts = text.split(from);
  return parts.length > 2 && !e.replace_all ? null : parts.join(lf(e.new_string));
}

function textAfter(tool, ti, before) {
  if (tool === 'Write') return lf(ti.content);
  const edits = tool === 'MultiEdit' ? ti.edits ?? [] : tool === 'Edit' ? [ti] : null;
  return edits && edits.reduce((text, e) => (text === null ? null : replaced(text, e)), before);
}

// Fences are kept: a quote the user wrote inside one is still theirs.
const quotedLines = n => n.body.split(/^## /m).slice(1).filter(s => QUOTED.includes(s.split('\n')[0].trim().toLowerCase()))
  .flatMap(s => s.split('\n').slice(1).map(l => l.trim()).filter(Boolean));

const PAGE_KEEPS = 0.7;

// Notes are rewritten in place, so an edit that drops the user's words or most of a page is more likely a slip than a
// choice. The same edit sent again goes through, for when the user asked for it.
function noteGuard(input, file, cwd) {
  const rel = vaultRel(file, cwd);
  if (!rel || !/^wiki\/.+\.md$/i.test(rel)) return null;
  let before;
  try { before = lf(fs.readFileSync(toPosix(file, cwd), 'utf8')); } catch { return null; }
  const after = textAfter(input.tool_name, input.tool_input ?? {}, before);
  if (after === null) return null;
  const was = parseNote(before, rel);
  const kept = new Set(quotedLines(parseNote(after, rel)));
  const lost = quotedLines(was).filter(l => !kept.has(l));
  const why = [];
  if (lost.length) {
    why.push(`This edit removes the user's words or a rule's evidence from ${rel}:`, ...lost.slice(0, 3).map(l => `  ${clip(l, 160)}`));
    why.push('Lines under ## You said and ## Evidence stay as written. Add a line instead.');
  }
  if (was.type === 'page') {
    const ratio = after.trim().length / Math.max(1, before.trim().length);
    if (ratio < PAGE_KEEPS) why.push(`This edit cuts ${rel} to ${Math.round(ratio * 100)}% of its length. Add to the page or fix it in place instead.`);
  }
  if (!why.length || !mark('notes', input.session_id, `${rel.toLowerCase()}|${shortHash(after)}`)) return null;
  return [...why, 'If the user asked for this, retry the same edit. The retry is allowed.'].join('\n');
}

function newText(tool, ti) {
  if (tool === 'Write') return String(ti.content ?? '');
  if (tool === 'MultiEdit') return (ti.edits ?? []).map(e => e.new_string ?? '').join('\n');
  if (tool === 'NotebookEdit') return String(ti.new_source ?? '');
  return String(ti.new_string ?? '');
}

// Global's globs are read from the file's first project folder, or from the session's folder when no domain has the file.
function matcher(file, cwd) {
  const doms = domainsFor(file, cwd);
  const fallback = doms[0]?.rel ?? inside(cwd, file, cwd);
  return notes => Object.entries(notes).flatMap(([key, note]) => {
    const rel = note.domain === 'global' ? fallback : doms.find(d => d.domain === note.domain)?.rel;
    if (!note.applies_to?.length || typeof rel !== 'string') return [];
    const glob = bestMatch(note.applies_to, rel);
    return glob ? [{ key, note, rel, spec: specificity(glob) }] : [];
  });
}

function gate(input, matched) {
  const { maxRulesPerEdit, maxBlockChars } = config().delivery;
  const sid = input.session_id;
  const text = newText(input.tool_name, input.tool_input ?? {});
  const hits = [];
  for (const { key, note, rel, spec } of matched) {
    const triggered = note.triggers?.length > 0;
    if (triggered && !note.triggers.some(t => tryRegex(t)?.test(text))) continue;
    // The hash is in the id, so a reworded rule is refused once more on files it already gated.
    const id = `${key}|${note.hash}|${rel.toLowerCase()}`;
    if (!marked('gate', sid, id)) hits.push({ key, note, rel, id, triggered, spec });
  }
  if (!hits.length) return null;
  hits.sort((a, b) => Number(b.triggered) - Number(a.triggered) || bySpecificity(a.spec, b.spec) || cmp(a.key, b.key));
  const head = `Taste rules apply to ${hits[0].rel}:`;
  const foot = 'Revise this edit to follow them, then retry. The retry is allowed.';
  const shown = [];
  for (const hit of hits.slice(0, maxRulesPerEdit)) {
    const line = ruleLine(hit.key, hit.note);
    if (shown.length && [head, ...shown.map(s => s.line), line, foot].join('\n').length > maxBlockChars) break;
    shown.push({ ...hit, line });
  }
  for (const s of shown) {
    mark('gate', sid, s.id);
    markShown(sid, s.key);
  }
  return [head, ...shown.map(s => s.line), foot].join('\n');
}

const deny = why => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: why } });

runHook('edit', input => {
  if (!FILE_TOOLS.includes(input.tool_name)) return null;
  const file = toolFile(input.tool_name, input.tool_input ?? {});
  if (!file) return null;
  const cwd = cwdOf(input);
  const why = vaultGuard(file, cwd) ?? noteGuard(input, file, cwd);
  if (why) return deny(why);
  // The vault's notes and sources are the user's taste, not project work, so no rule gates them and no page applies.
  if (/^(?:wiki|raw)\//i.test(vaultRel(file, cwd) ?? '')) return null;
  const notes = settledNotes();
  const matching = matcher(file, cwd);
  const refused = gate(input, matching(liveRules(notes)));
  if (refused) return deny(refused);
  // A page comes up only on an edit that goes through, so the agent reads it beside the work rather than as a refusal.
  const due = markPages(input, matching(livePages(notes)).sort((a, b) => bySpecificity(a.spec, b.spec) || cmp(a.key, b.key)));
  if (!due.length) return null;
  const context = pagePointers(`Vault pages on ${due[0].rel}. Read the ones that bear on this work:`, due);
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: context } };
});
