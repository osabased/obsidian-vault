import fs from 'node:fs';
import crypto from 'node:crypto';
import { vaultPath, writeSettled, appendLog, config, plainText, inside } from './vault.mjs';
import { KEY_RE, parseNote, noteErrors, vaultFile, knownDomain, joinList, loadNotes } from './rules.mjs';
import { userNoteGuard } from './note-guards.mjs';
import { lintLinks, markdownFiles } from './lint.mjs';
import { allOffers } from './offers.mjs';
import { refuse, line } from './input.mjs';

// A page change: the whole new text of a page under wiki/, offered as the diff the user agrees to. base, the hash of the
// file the offer was made against, comes only from a stored offer or a review queue entry, so keep can tell the page
// changed since, and an entry offered again can tell the page changed since it was made.

const PAGE_PATH = /^wiki\/([^/]+)\/[^/]+\/([^/]+)\.md$/i;
const WHERE = 'page must be a page under wiki/, like wiki/<domain>/<folder>/<slug>.md.';

export const PAGE_FIELDS = ['page', 'text', 'hold', 'asked'];

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

// Longest common subsequence of lines, with the common head and tail taken off first, since a page change touches few
// lines of many. Removed lines come before added ones where both fit.
function lineOps(a, b) {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const x = a.slice(head, a.length - tail);
  const y = b.slice(head, b.length - tail);
  const lcs = Array.from({ length: x.length + 1 }, () => new Uint32Array(y.length + 1));
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  }
  const mid = [];
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) { mid.push([' ', x[i]]); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) mid.push(['-', x[i++]]);
    else mid.push(['+', y[j++]]);
  }
  while (i < x.length) mid.push(['-', x[i++]]);
  while (j < y.length) mid.push(['+', y[j++]]);
  return [...a.slice(0, head).map(l => [' ', l]), ...mid, ...a.slice(a.length - tail).map(l => [' ', l])];
}

const CONTEXT = 3;

// Held offers are released and kept together, so a page may link a rule or page this session has offered and not yet
// kept, whichever the user keeps first.
const OPEN = new Set(['held', 'pending', 'used']);
const offeredPaths = sid => allOffers().filter(o => o.session === String(sid) && OPEN.has(o.state)).flatMap(o => {
  if (o.kind === 'rule' && typeof o.key === 'string') return [`wiki/${o.key.replace('/', '/rules/')}`];
  if (o.kind === 'page' && typeof o.fields?.page === 'string') return [o.fields.page.replace(/\.md$/i, '')];
  return [];
}).map(p => p.toLowerCase());

// The first link problem lint would report in the new text and not in the old: a link already there is lint's to report,
// since on a page with author: user the agent may not change it.
function newLinkProblem(n, was, notes, offered) {
  const md = markdownFiles();
  for (const p of [n.rel.replace(/\.md$/i, '').toLowerCase(), ...offered]) {
    md.paths.add(p);
    md.names.add(p.split('/').at(-1));
  }
  const all = [...notes.filter(x => x.rel.toLowerCase() !== n.rel.toLowerCase()), n];
  const noteAt = new Map(all.map(x => [x.key, x]));
  const named = new Map();
  for (const x of all) named.set(x.slug, [...(named.get(x.slug) ?? []), x]);
  const found = x => {
    const out = [];
    lintLinks(x, noteAt, named, md, (level, file, msg) => out.push(msg));
    return out;
  };
  const had = new Set(was ? found(was) : []);
  return found(n).find(m => !had.has(m));
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

// What the change would write, checked as lint checks a page, and the lines the user is shown, which are never cut. Shown
// lines lose their trailing white space, since the agent passes them back to keep and may drop it, so a line the change
// adds may not end in any: what is written is what the user saw. queued is the review queue entry the change is offered
// again from, whose base it is checked against.
export function pageChange(p, { sid, domains, vault, kept, queued = null }) {
  const allowed = kept && !queued ? [...PAGE_FIELDS, 'base'] : PAGE_FIELDS;
  const unknown = Object.keys(p).find(k => !allowed.includes(k));
  if (unknown) refuse(`${unknown} isn't a field of a page change, which takes ${joinList(PAGE_FIELDS, 'and')}.`);
  const page = line(p, 'page');
  if (typeof p.text !== 'string' || !p.text.trim()) refuse("text is missing: give the page's whole new text.");
  const rel = vaultFile(page) ?? page;
  const m = rel.match(PAGE_PATH);
  // path.join takes a backslash as a separator on Windows, so a folder like ..\.. would leave wiki/.
  if (!m || rel.includes('\\') || rel.split('/').some(s => s === '.' || s === '..')) refuse(WHERE);
  const [, domain, slug] = m;
  if (!knownDomain(domain) || (!vault && !domains.includes(domain))) refuse(`the page's domain must be ${joinList(domains, 'or')}.`);
  const key = `${domain}/${slug}`;
  if (!KEY_RE.test(key)) refuse('slug must be lowercase-kebab-case.');
  const file = vaultPath(...rel.split('/'));
  if (inside(vaultPath('wiki', domain), file) === null) refuse(WHERE);
  // Every domain, since a page may link a note in any of them.
  const notes = loadNotes();
  const taken = notes.find(n => n.key === key && n.rel.toLowerCase() !== rel.toLowerCase());
  if (taken) refuse(`${taken.rel} already exists. Pick another slug, or leave that note to the user.`);
  const raw = fs.existsSync(file) ? fs.readFileSync(file) : null;
  const base = raw && sha256(raw);
  const expected = queued ? queued.fields.base ?? null : p.base ?? null;
  if (kept && expected !== base) refuse(`${rel} changed since the offer, so it isn't what the user agreed to. Propose the change again.`);
  if (queued && expected !== base) refuse(`${rel} changed since \`${queued.id}\` was made from it, so it would undo that change. Drop \`${queued.id}\` and draft the change again from the page as it is now.`);
  const text = raw?.toString('utf8');
  const before = raw && plainText(text);
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
  const link = newLinkProblem(n, was, notes, offeredPaths(sid));
  if (link) refuse(`${rel} ${link}.`);
  const fence = '`'.repeat(Math.max(3, ...[...`${before ?? ''}\n${after}`.matchAll(/`+/g)].map(r => r[0].length + 1)));
  const head = [`**Keep this page change?** ${rel} · ${before === null ? 'new' : 'change'}`, `${fence}${before === null ? 'markdown' : 'diff'}`];
  const cap = config().pages.maxOfferChars;
  const over = (size, least) => refuse(`the offer for ${rel} comes to ${least ? 'at least ' : ''}${size} characters, over pages.maxOfferChars (${cap}). Split the change into smaller ones and propose each.`);
  const [a, b] = [before, after].map(s => s?.split('\n'));
  const spaced = l => l !== l.trimEnd();
  let shown;
  let added;
  if (before === null) {
    shown = after.replace(/\n$/, '').split('\n');
    added = shown.findIndex(spaced) + 1;
  } else {
    // The diff takes time and memory in the product of the lines that differ, so an offer that can't fit is refused first.
    const least = [...head, fence].join('\n').length + diffFloor(a, b);
    if (least > cap) over(least, true);
    const ops = lineOps(a, b);
    let at = 0;
    added = 0;
    for (const [t, l] of ops) {
      if (t !== '-') at++;
      if (t === '+' && !added && spaced(l)) added = at;
    }
    shown = unifiedDiff(ops);
  }
  const lines = [...head, ...shown.map(l => l.trimEnd()), fence];
  const size = lines.join('\n').length;
  if (size > cap) over(size, false);
  if (added) refuse(`line ${added} of text ends in white space, which the offer can't show. Take it off, then propose again.`);
  const eol = text?.includes('\r\n') ? '\r\n' : '\n';
  return { rel, key, domain, file, text: after, base, eol, bom: text?.startsWith('\uFEFF') ?? false, lines };
}

// In the page's own line endings and byte order mark, settled so the page reaches sessions at once.
export function writePage(c, name) {
  writeSettled(c.file, `${c.bom ? '\uFEFF' : ''}${c.eol === '\n' ? c.text : c.text.replace(/\n/g, c.eol)}`);
  appendLog([`wrote page ${c.key} · session ${name}`]);
  return `Wrote ${c.rel}.`;
}
