import fs from 'node:fs';
import { runHook, config, domainsFor, everywhereDomains, inside, vaultRel, toPosix, cwdOf, FILE_TOOLS, toolFile, shortHash, lf } from '../lib/vault.mjs';
import {
  loadNotes, settledNotes, liveRules, livePages, ruleLine, rulePointer, pageLine, fitContext, tryRegex, cmp, clip, parseNote, QUOTED, agentNotesSpan, authoredByUser, AGENT_NOTES, TOP_HEADING,
} from '../lib/rules.mjs';
import { bestMatch, specificity, bySpecificity } from '../lib/glob.mjs';
import { parse } from '../lib/frontmatter.mjs';
import { marked, mark, markShown, markPages } from '../lib/sessions.mjs';

function vaultGuard(file, cwd) {
  const rel = vaultRel(file, cwd);
  if (rel === null) return null;
  const low = rel.toLowerCase();
  if (low === 'active.md' || low === 'index.md') return `${rel} is generated from the notes. Edit the notes instead, then run \`node tools/build.mjs\`.`;
  if (low === 'vault.local.json') return `${rel} lists this machine's project folders for each domain. Leave it to the user.`;
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

function matchIn(text, from) {
  if (text.includes(from)) return from;
  const i = foldQuotes(text).indexOf(foldQuotes(from));
  if (i >= 0) return text.slice(i, i + from.length);
  const decoded = from.replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
  return decoded !== from && text.includes(decoded) ? decoded : null;
}

// Edit matches as Claude Code does: line endings and curly quotes don't count, a character old_string spells as an
// escape such as \u00e9 matches itself, and an empty old_string writes a file that is missing or blank. An old_string
// found more than once without replace_all fails, so that edit is left for the tool to refuse.
function replaced(text, e) {
  if (!e.old_string) return text.trim() ? null : lf(e.new_string);
  const from = matchIn(text, lf(e.old_string));
  if (from === null) return null;
  const parts = text.split(from);
  return parts.length > 2 && !e.replace_all ? null : parts.join(lf(e.new_string));
}

// A BOM is the editor's, not the text's, so the guards compare the files without it.
const textOf = s => lf(s).replace(/^\uFEFF/, '');

function textAfter(tool, ti, before) {
  if (tool === 'Write') return textOf(ti.content);
  const edits = tool === 'MultiEdit' ? ti.edits ?? [] : tool === 'Edit' ? [ti] : null;
  return edits && edits.reduce((text, e) => (text === null ? null : replaced(text, e)), before);
}

// Fences are kept: a quote the user wrote inside one is still theirs.
const quotedLines = n => n.body.split(/^## /m).slice(1).filter(s => QUOTED.includes(s.split('\n')[0].trim().toLowerCase()))
  .flatMap(s => s.split('\n').slice(1).map(l => l.trim()).filter(Boolean));

const headingLine = l => TOP_HEADING.test(l);

// A page the user wrote may gain lines under `## Agent notes`, or that heading with lines at its end, and nothing else.
// Lines added without a heading in the way are the same text wherever the diff puts them, so any placement inside the
// section is enough. Added lines can still move where the section ends, as an unclosed fence does, so the section must
// end after the edit where it ended before.
function bodyNotesAdded(before, after) {
  const [b, a] = [before, after].map(s => s.split('\n'));
  const span = agentNotesSpan(b);
  const now = agentNotesSpan(a);
  if (!span) {
    if (!after.startsWith(before)) return false;
    const rest = after.slice(before.length);
    const gap = rest.match(/^\n*/)[0];
    if (!gap && before && !before.endsWith('\n')) return false;
    const [first, ...added] = rest.slice(gap.length).split('\n');
    const at = a.length - added.length - 1;
    return AGENT_NOTES.test(first) && added.some(l => l.trim()) && !added.some(headingLine) && now?.at === at && now.end === a.length;
  }
  if (a.length < b.length || now?.at !== span.at || a.length - now.end !== b.length - span.end) return false;
  let head = 0;
  while (head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < b.length && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  if (head + tail < b.length) return false;
  const at = Math.max(span.at + 1, b.length - tail);
  return at <= Math.min(span.end, head) && !a.slice(at, at + a.length - b.length).some(headingLine);
}

// A frontmatter line can read as a heading or a fence, so the section is found in the body, and the frontmatter must
// stay as it was.
const frontmatter = text => {
  const { body, ok } = parse(text);
  return ok ? text.slice(0, text.length - body.length).replace(/\n$/, '') : '';
};
const onlyNotesAdded = (before, after) => frontmatter(before) === frontmatter(after) && bodyNotesAdded(parse(before).body, parse(after).body);

const usersOwn = rel => `${rel} is the user's own writing, so it stays as they wrote it. Add notes as new lines under ## Agent notes, and change nothing else in the file.`;

function userNoteGuard(rel, before, after) {
  if (authoredByUser(after) && !authoredByUser(before)) {
    return `${rel} would be marked author: user. The user sets author: user themselves; the agent doesn't make a page theirs.`;
  }
  if (!authoredByUser(before) || after === before || onlyNotesAdded(before, after)) return null;
  return usersOwn(rel);
}

const PAGE_KEEPS = 0.7;

// Notes are rewritten in place, so an edit that drops the user's words or most of a page is more likely a slip than a
// choice. The same edit sent again goes through, for when the user asked for it.
function noteGuard(input, file, cwd) {
  const rel = vaultRel(file, cwd);
  if (!rel || !/^wiki\/.+\.md$/i.test(rel)) return null;
  let before = null;
  if (fs.existsSync(toPosix(file, cwd))) {
    try { before = textOf(fs.readFileSync(toPosix(file, cwd), 'utf8')); } catch { return null; }
  }
  const after = textAfter(input.tool_name, input.tool_input ?? {}, before ?? '');
  // Claude Code refuses an edit it can't apply before the hook runs, so one the guard can't follow still applies.
  if (after === null) return authoredByUser(before ?? '') ? usersOwn(rel) : null;
  // A user's page gets no second try: a retry of an edit that changes their words would be the slip the guard is for.
  const owned = userNoteGuard(rel, before ?? '', after);
  if (owned) return owned;
  if (before === null) return null;
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
// An everywhere domain's pages reach every edit, read as global's when its reach doesn't take in the file; its rules
// gate only where its reach does.
function matcher(file, cwd) {
  const doms = domainsFor(file, cwd);
  const fallback = doms[0]?.rel ?? inside(cwd, file, cwd);
  const everywhere = everywhereDomains();
  return (notes, pages = false) => Object.entries(notes).flatMap(([key, note]) => {
    const own = doms.find(d => d.domain === note.domain)?.rel;
    const rel = note.domain === 'global' || (pages && own === undefined && everywhere.includes(note.domain)) ? fallback : own;
    if (!note.applies_to?.length || typeof rel !== 'string') return [];
    const glob = bestMatch(note.applies_to, rel);
    return glob ? [{ key, note, rel, spec: specificity(glob) }] : [];
  });
}

// A note with triggers comes up only on an edit whose new text matches one.
const fires = (note, text) => !note.triggers?.length || note.triggers.some(t => tryRegex(t)?.test(text));

// The rules due on this edit, most specific first: the ones this session was not yet refused with on this file.
function dueRules(input, matched, text) {
  const hits = [];
  for (const { key, note, rel, spec } of matched) {
    const triggered = note.triggers?.length > 0;
    if (!fires(note, text)) continue;
    // The hash is in the id, so a reworded rule is refused once more on files it already gated.
    const id = `${key}|${note.hash}|${rel.toLowerCase()}`;
    if (!marked('gate', input.session_id, id)) hits.push({ key, note, rel, id, triggered, spec });
  }
  return hits.sort((a, b) => Number(b.triggered) - Number(a.triggered) || bySpecificity(a.spec, b.spec) || cmp(a.key, b.key));
}

// One refusal carries everything due on the file, so the retry goes through. The top rules come in full, up to
// maxRulesPerEdit and maxBlockChars; the other rules and the pages past maxPages come as one line each, and whatever
// the output budget has no room for is named in its overflow line. Everything due counts as shown either way.
function refusal(input, hits, pages) {
  const { maxRulesPerEdit, maxBlockChars, maxPages } = config().delivery;
  const sid = input.session_id;
  const rel = (hits[0] ?? pages[0]).rel;
  const head = `Taste rules apply to ${rel}:`;
  const foot = `Revise this edit to follow ${!pages.length ? 'them' : hits.length ? 'them and the pages' : 'the pages'}, then retry. The retry is allowed.`;
  const full = [];
  for (const hit of hits.slice(0, maxRulesPerEdit)) {
    const line = ruleLine(hit.key, hit.note);
    if (full.length && [head, ...full.map(s => s.line), line, foot].join('\n').length > maxBlockChars) break;
    full.push({ ...hit, line });
  }
  const { text, kept } = fitContext([
    { noun: 'rule', head, items: full.map(s => s.line) },
    { noun: 'rule pointer', head: 'Also due, in brief. Open the ones that bear on this edit:', items: hits.slice(full.length).map(h => rulePointer(h.key, h.note)) },
    { noun: 'page', head: `Vault pages on ${rel}. Read the ones that bear on this work:`, items: pages.map((h, i) => pageLine(h.key, h.note, i >= maxPages)) },
  ], { tail: foot, gap: '\n' });
  for (const hit of hits) mark('gate', sid, hit.id);
  for (const s of full.slice(0, kept[0])) markShown(sid, s.key);
  return text;
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
  const notes = settledNotes(loadNotes([...domainsFor(file, cwd).map(d => d.domain), 'global', ...everywhereDomains()]));
  const matching = matcher(file, cwd);
  const text = newText(input.tool_name, input.tool_input ?? {});
  const hits = dueRules(input, matching(liveRules(notes)), text);
  // A page is told of once per session, so the refusal marks every page due, not only the first maxPages.
  const pages = markPages(input, matching(livePages(notes), true).filter(m => fires(m.note, text)).sort((a, b) => bySpecificity(a.spec, b.spec) || cmp(a.key, b.key)), Infinity);
  return hits.length || pages.length ? deny(refusal(input, hits, pages)) : null;
});
