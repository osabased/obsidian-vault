import fs from 'node:fs';
import { vaultPath, writeSettled, appendLog, config, plainText, plainLayout, restore, inside } from './vault.mjs';
import { KEY_RE, PAGE_WHERE, parseNote, noteErrors, noteLinks, vaultFile, knownDomain, joinList, loadNotes, rulePath } from './rules.mjs';
import { userNoteGuard } from './note-guards.mjs';
import { lintLinks, linkIndex, markdownFiles } from './lint.mjs';
import { openOffers } from './offers.mjs';
import { sha256 } from './sources.mjs';
import { refuse, line } from './input.mjs';

// A page change: the whole new text of a page under wiki/, offered as the diff the user agrees to. base, the hash of the
// file the offer was made against, comes only from a stored offer or a review queue entry, so keep can tell the page
// changed since, and an entry offered again can tell the page changed since it was made.

const PAGE_PATH = /^wiki\/([^/]+)\/[^/]+\/([^/]+)\.md$/i;

const PAGE_FIELDS = ['page', 'text', 'hold', 'asked'];

// The fewest removed and added lines that turn a into b, by Myers' diff, with the common head and tail taken off first,
// since a page change touches few lines of many. Removed lines come before added ones where both fit. Its work grows
// with the edits, so it gives null once they pass maxEdits.
function lineOps(a, b, maxEdits) {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const mid = middleOps(a.slice(head, a.length - tail), b.slice(head, b.length - tail), maxEdits);
  return mid && [...a.slice(0, head).map(l => [' ', l]), ...mid, ...a.slice(a.length - tail).map(l => [' ', l])];
}

// v[k] is how far along x the furthest path with k more removals than additions reaches; each round's v is kept to
// walk the path back.
function middleOps(x, y, maxEdits) {
  const [n, m] = [x.length, y.length];
  if (!n || !m) return n + m > maxEdits ? null : [...x.map(l => ['-', l]), ...y.map(l => ['+', l])];
  const most = Math.min(n + m, maxEdits);
  const off = most + 1;
  const v = new Int32Array(2 * most + 3);
  const trace = [];
  for (let d = 0; d <= most; d++) {
    trace.push(v.slice(off - d, off + d + 1));
    for (let k = -d; k <= d; k += 2) {
      let i = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let j = i - k;
      while (i < n && j < m && x[i] === y[j]) { i++; j++; }
      v[off + k] = i;
      if (i >= n && j >= m) return walkBack(x, y, trace);
    }
  }
  return null;
}

function walkBack(x, y, trace) {
  const out = [];
  let [i, j] = [x.length, y.length];
  for (let d = trace.length - 1; d > 0; d--) {
    const at = k => trace[d][k + d];
    const k = i - j;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const from = down ? k + 1 : k - 1;
    const [pi, pj] = [at(from), at(from) - from];
    while (i > pi && j > pj) { out.push([' ', x[--i]]); j--; }
    out.push(down ? ['+', y[--j]] : ['-', x[--i]]);
  }
  while (i > 0) out.push([' ', x[--i]]);
  return out.reverse();
}

// The characters any diff of a to b shows at least: a line is kept only against an equal line, so each line one side
// holds more often than the other is shown removed or added.
function diffFloor(a, b) {
  const count = new Map();
  for (const l of a) count.set(l, (count.get(l) ?? 0) + 1);
  for (const l of b) count.set(l, (count.get(l) ?? 0) - 1);
  let n = 0;
  for (const [l, c] of count) n += Math.abs(c) * (l.trimEnd().length + 2);
  return n;
}

const CONTEXT = 3;

// Held offers are released and kept together, so a page may link a rule or page this session has offered and not yet
// kept, whichever the user keeps first.
const offeredPaths = sid => openOffers(sid).flatMap(o => {
  if (o.kind === 'rule' && typeof o.key === 'string') return [rulePath(o.key)];
  if (o.kind === 'page' && typeof o.fields?.page === 'string') return [o.fields.page];
  return [];
}).map(p => p.replace(/\.md$/i, '').toLowerCase());

// The first link problem lint would report in the new text and not in the old: a link already there is lint's to report,
// since on a page with author: user the agent may not change it. A path this session offered can only clear a problem,
// so the offers are read only when one is left without them.
function newLinkProblem(n, was, notes, sid) {
  if (!noteLinks(n).length) return null;
  const { noteAt, named } = linkIndex([...notes.filter(x => x.rel.toLowerCase() !== n.rel.toLowerCase()), n]);
  const found = (x, md) => {
    const out = [];
    lintLinks(x, noteAt, named, md, (level, file, msg) => out.push(msg));
    return out;
  };
  const fresh = md => {
    const problems = found(n, md);
    if (!problems.length) return [];
    const had = new Set(was ? found(was, md) : []);
    return problems.filter(m => !had.has(m));
  };
  const self = n.rel.replace(/\.md$/i, '').toLowerCase();
  const left = fresh(markdownFiles([self]));
  if (!left.length) return null;
  const offered = offeredPaths(sid);
  return offered.length ? fresh(markdownFiles([self, ...offered]))[0] ?? null : left[0];
}

// A unified diff, three lines of context around each change.
function unifiedDiff(ops) {
  const at = [];
  let [ai, bi] = [1, 1];
  for (const [t] of ops) {
    at.push([ai, bi]);
    if (t !== '+') ai++;
    if (t !== '-') bi++;
  }
  const changed = ops.flatMap(([t], k) => (t === ' ' ? [] : [k]));
  const out = [];
  for (let k = 0; k < changed.length; k++) {
    const start = Math.max(0, changed[k] - CONTEXT);
    while (k + 1 < changed.length && changed[k + 1] - changed[k] <= 2 * CONTEXT) k++;
    const hunk = ops.slice(start, Math.min(ops.length, changed[k] + CONTEXT + 1));
    const aLen = hunk.filter(([t]) => t !== '+').length;
    const bLen = hunk.filter(([t]) => t !== '-').length;
    const [aStart, bStart] = at[start];
    out.push(`@@ -${aLen ? aStart : aStart - 1},${aLen} +${bLen ? bStart : bStart - 1},${bLen} @@`, ...hunk.map(([t, l]) => `${t}${l}`));
  }
  return out;
}

// The lines the user is shown, which are never cut: a new page whole, a changed one as a diff. Shown lines lose their
// trailing white space, since the agent passes them back to keep and may drop it, so a line the change adds may not end
// in any: what is written is what the user saw.
function offerLines(rel, before, after) {
  const fence = '`'.repeat(Math.max(3, ...[...`${before ?? ''}\n${after}`.matchAll(/`+/g)].map(r => r[0].length + 1)));
  const head = [`**Keep this page change?** ${rel} · ${before === null ? 'new' : 'change'}`, `${fence}${before === null ? 'markdown' : 'diff'}`];
  const cap = config().pages.maxOfferChars;
  const over = (size, least) => refuse(`the offer for ${rel} comes to ${least ? 'at least ' : ''}${size} characters, over pages.maxOfferChars (${cap}). Split the change into smaller ones and propose each.`);
  const frame = [...head, fence].join('\n').length;
  const [a, b] = [before === null ? [] : before.split('\n'), after.split('\n')];
  const least = before === null ? 0 : frame + diffFloor(a, b);
  if (least > cap) over(least, true);
  // Each changed line a diff shows takes at least its mark and a line break, so a diff with more changes than the cap
  // leaves room for can't fit, and is refused before the work of finding them all.
  const most = Math.max(0, Math.floor((cap - frame) / 2));
  const ops = lineOps(a, b, before === null ? Infinity : most);
  if (!ops) over(frame + 2 * (most + 1), true);
  const spaced = l => l !== l.trimEnd();
  let at = 0;
  let added = 0;
  for (const [t, l] of ops) {
    if (t !== '-') at++;
    if (t === '+' && !added && spaced(l)) added = at;
  }
  const shown = before === null ? after.replace(/\n$/, '').split('\n') : unifiedDiff(ops);
  const lines = [...head, ...shown.map(l => l.trimEnd()), fence];
  const size = lines.join('\n').length;
  if (size > cap) over(size, false);
  if (added) refuse(`line ${added} of text ends in white space, which the offer can't show. Take it off, then propose again.`);
  return lines;
}

// What the change would write, checked as lint checks a page, and the lines the user is shown. queued is the review
// queue entry the change is offered again from, and base the hash the offer or the entry was made against.
export function pageChange(p, { sid, domains, vault, kept, queued = null, base: expected = null }) {
  const unknown = Object.keys(p).find(k => !PAGE_FIELDS.includes(k));
  if (unknown) refuse(`${unknown} isn't a field of a page change, which takes ${joinList(PAGE_FIELDS, 'and')}.`);
  const page = line(p, 'page');
  if (typeof p.text !== 'string' || !p.text.trim()) refuse("text is missing: give the page's whole new text.");
  const rel = vaultFile(page) ?? page;
  const m = rel.match(PAGE_PATH);
  // path.join takes a backslash as a separator on Windows, so a folder like ..\.. would leave wiki/.
  if (!m || rel.includes('\\') || rel.split('/').some(s => s === '.' || s === '..')) refuse(PAGE_WHERE);
  const [, domain, slug] = m;
  if (!knownDomain(domain) || (!vault && !domains.includes(domain))) refuse(`the page's domain must be ${joinList(domains, 'or')}.`);
  const key = `${domain}/${slug}`;
  if (!KEY_RE.test(key)) refuse('slug must be lowercase-kebab-case.');
  const file = vaultPath(...rel.split('/'));
  if (inside(vaultPath('wiki', domain), file) === null) refuse(PAGE_WHERE);
  // Every domain, since a page may link a note in any of them.
  const notes = loadNotes();
  const taken = notes.find(n => n.key === key && n.rel.toLowerCase() !== rel.toLowerCase());
  if (taken) refuse(`${taken.rel} already exists. Pick another slug, or leave that note to the user.`);
  const raw = fs.existsSync(file) ? fs.readFileSync(file) : null;
  const base = raw && sha256(raw);
  if (kept && expected !== base) refuse(`${rel} changed since the offer, so it isn't what the user agreed to. Propose the change again.`);
  if (queued && expected !== base) refuse(`${rel} changed since \`${queued.id}\` was made from it, so it would undo that change. Drop \`${queued.id}\` and draft the change again from the page as it is now.`);
  const { text: before = null, ...layout } = raw ? plainLayout(raw.toString('utf8')) : { eol: '\n', bom: false };
  const after = plainText(p.text);
  if (before === after) refuse(`${rel} already holds this text.`);
  const was = before === null ? null : parseNote(before, rel);
  if (was?.type === 'rule') refuse(`${rel} is a rule. Change it with change and key.`);
  const n = parseNote(after, rel);
  if (n.type === 'rule') refuse(`the text would make ${rel} a rule. Propose a rule with do and not instead.`);
  const guard = userNoteGuard(rel, before ?? '', after);
  if (guard) refuse(guard);
  const [err] = noteErrors(n);
  if (err) refuse(`${err}.`);
  const link = newLinkProblem(n, was, notes, sid);
  if (link) refuse(`${rel} ${link}.`);
  return { rel, key, domain, file, text: after, base, layout, lines: offerLines(rel, before, after) };
}

// In the page's own line endings and byte order mark, settled so the page reaches sessions at once.
export function writePage(c, name) {
  writeSettled(c.file, restore(c.text, c.layout));
  appendLog([`wrote page ${c.key} · session ${name}`]);
  return `Wrote ${c.rel}.`;
}
