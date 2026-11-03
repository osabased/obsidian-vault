import fs from 'node:fs';
import { config, domainsFor, everywhereDomains, vaultRel, vaultOwn, toPosix, cwdOf, shortHash, plainText, inVaultFolder } from '../vault.mjs';
import { reachOf } from '../reach.mjs';
import {
  loadNotesAsync, settledNotes, liveRules, livePages, deliverable, deliveryFor, byFit, ruleLine, rulePointer, pageLine, fitContext, cmp, clip, parseNote, QUOTED, agentNotesSpan, authoredByUser, AGENT_NOTES, TOP_HEADING, isMap,
} from '../rules.mjs';
import { matchTarget, targetNames, specificity, bySpecificity } from '../glob.mjs';
import { matcher, fileScope, fires, dueRules, gatedFile } from '../scope.mjs';
import { parse } from '../frontmatter.mjs';
import { extension } from '../ext.mjs';
import { mark, marked, markMany, markShown, markPages, duePages, agentKey, keyHash, sessionHits, turnStart } from '../sessions.mjs';

function vaultGuard(file, cwd) {
  const rel = vaultRel(file, cwd);
  if (!vaultOwn(rel)) return null;
  const low = rel.toLowerCase();
  if (low === 'active.md' || low === 'index.md') return `${rel} is generated from the notes. Edit the notes instead, then run \`node tools/build.mjs\`.`;
  if (low === 'vault.local.json') return `${rel} lists this machine's project folders for each domain. \`node tools/domain.mjs\` adds a session's folder once the user agrees to a new domain; otherwise leave it to the user.`;
  if (low === 'decisions.md') return `${rel} is generated from the picks in raw/picks/. Record picks with tools/pick.mjs instead.`;
  if (low === 'derived' || low.startsWith('derived/')) return 'derived/ is written by extraction, not edited by hand. A better extraction replaces the file.';
  if (low === '.state' || low.startsWith('.state/')) return ".state/ is the hooks' own bookkeeping. Leave it to them.";
  if (low === '.live' || low.startsWith('.live/')) return '`.live/` is a copy of `tools/` as of the last commit. Change `tools/` and commit instead.';
  if (low === '.sources' || low.startsWith('.sources/')) return '`.sources/` holds the clones `tools/refresh.mjs` checks git sources in. Leave it to refresh.';
  if (low.startsWith('raw/')) {
    if (fs.existsSync(toPosix(file, cwd))) return `raw/ is append-only: ${rel} already exists and can't be changed. Put new material in a new file under raw/refs/.`;
    if (!/^raw\/refs\/./.test(low)) return 'raw/ is append-only. New files go under raw/refs/; tools/propose.mjs and tools/pick.mjs write the rest.';
  }
  return null;
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
function noteGuard(event, file, cwd) {
  const rel = vaultRel(file, cwd);
  if (!rel || !/^wiki\/.+\.md$/i.test(rel)) return null;
  let before = null;
  if (fs.existsSync(toPosix(file, cwd))) {
    try { before = plainText(fs.readFileSync(toPosix(file, cwd), 'utf8')); } catch { return null; }
  }
  const after = event.after ? event.after(before ?? '') : null;
  // The agent refuses an edit it can't apply before the hook runs, so one the guard can't follow still applies. A tool
  // config maps to the file namespace comes with no after, so the guard can't follow it either.
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
  if (!why.length || !mark('notes', event.session, agentKey(event, `${rel.toLowerCase()}|${shortHash(after)}`))) return null;
  return [...why, 'If the user asked for this, retry the same edit. The retry is allowed.'].join('\n');
}

// A tool that edits something other than files is gated once config maps it to a namespace, naming the fields of its
// input that hold the target's path and the new text. A call the adapter gave a target edits a file, which config can't
// map.
function mapped(event) {
  if (event.target) return null;
  const tool = event.tool;
  const tools = config().editTools;
  return isMap(tools) && Object.hasOwn(tools, tool) && isMap(tools[tool]) ? tools[tool] : null;
}

const inputAt = (ti, field) => String(field).replace(/^tool_input\./, '').split('.')
  .reduce((x, k) => (x !== null && typeof x === 'object' && Object.hasOwn(x, k) ? x[k] : undefined), ti);
const asText = x => (x === undefined || x === null ? '' : typeof x === 'string' ? x : JSON.stringify(x));

// What the edit changes: a file, or a name in the namespace config maps the tool to. A mapped call without the path
// would pass ungated, so it fails loudly instead.
function target(event) {
  if (event.target) return event.target;
  const m = mapped(event);
  if (!m) return null;
  const path = inputAt(event.args ?? {}, m.path);
  if (typeof path !== 'string' || !path) throw new Error(`editTools.${event.tool}.path is ${m.path}, which this call's input doesn't hold as text`);
  return { namespace: m.namespace, path };
}

function newText(event) {
  const m = mapped(event);
  if (m) return m.after ? asText(inputAt(event.args ?? {}, m.after)) : '';
  return event.added ?? '';
}

// The file each project root's alias for the namespace maps the name to. An alias, tools/ext/aliases/<name>.mjs,
// exports toFile(names, root): given the name's parts, escapes read, and a project root, it returns the file's path,
// absolute or from the root, or null where the project lacks what it reads.
function aliasedFiles(t, hits, namespaces) {
  const names = targetNames(t, namespaces);
  if (!names) return [];
  const files = hits.flatMap(({ domain, root }) => {
    const aliases = config().domains[domain]?.aliases;
    const name = isMap(aliases) && Object.hasOwn(aliases, t.namespace) ? aliases[t.namespace] : null;
    if (name === null) return [];
    const file = extension('aliases', name, ['toFile']).toFile(names, root);
    return typeof file === 'string' && file ? [toPosix(file, root)] : [];
  });
  return [...new Set(files)];
}

// A name has no folder to take domains from, so it takes the session's. Through an alias it also matches the globs of
// the file it maps to, and a rule both match refuses once.
function nameScope(t, cwd, hits) {
  const { namespaces } = config();
  const doms = [...new Set(hits.map(h => h.domain))];
  const files = aliasedFiles(t, hits, namespaces);
  const everywhere = everywhereDomains();
  const place = `${t.namespace}:${t.path}`;
  const own = (notes, pages) => Object.entries(notes).flatMap(([key, note]) => {
    if (note.domain !== 'global' && !doms.includes(note.domain) && !(pages && everywhere.includes(note.domain))) return [];
    const glob = note.applies_to?.length ? matchTarget(note.applies_to, t, namespaces) : null;
    return glob ? [{ key, note, rel: place, place, spec: specificity(glob, namespaces) }] : [];
  });
  const viaFiles = files.map(f => matcher(f, cwd));
  return {
    domains: [...doms, ...files.flatMap(f => domainsFor(f, cwd).map(d => d.domain)), 'global', ...everywhere],
    hits: [...hits, ...files.flatMap(f => domainsFor(f, cwd))],
    matching: (notes, pages = false) => [...own(notes, pages), ...viaFiles.flatMap(m => m(notes, pages))]
      .filter((m, i, all) => all.findIndex(x => x.key === m.key) === i),
  };
}

// A call to a tool with rules on its name, in the domains a prompt's keywords reach. Each rule tests its triggers
// against the call's whole input, and is no more specific than `**`.
function toolScope(event, tool, cwd, hits) {
  const reach = reachOf([...new Set(hits.map(h => h.domain))], inVaultFolder(cwd));
  const domains = reach.heard;
  const text = plainText(asText(event.args));
  const place = `tool:${tool}`;
  return {
    domains, hits,
    matching: notes => Object.entries(notes).flatMap(([key, note]) => (reach.tool(note) && note.tools.includes(tool)
      ? [{ key, note, rel: tool, place, spec: [0, 0], text }] : [])),
  };
}

// A mapped call is reached by its target's rules and its name's. A rule both reach comes once, as its target's, and its
// triggers test the call's whole input too, as they would had only its name reached it.
function scopeOf(event, t, cwd) {
  if (event.target) return fileScope(t.path, cwd);
  const hits = sessionHits(event.session, cwd);
  const tool = toolScope(event, event.tool, cwd, hits);
  const own = !t ? null : t.namespace === 'file' ? fileScope(t.path, cwd) : nameScope(t, cwd, hits);
  if (!own) return tool;
  return {
    domains: [...new Set([...own.domains, ...tool.domains])],
    hits: own.hits,
    matching: (notes, pages = false) => {
      const mine = own.matching(notes, pages);
      if (pages) return mine;
      const named = new Map(tool.matching(notes).map(m => [m.key, m]));
      return [...mine.map(m => (named.has(m.key) ? { ...m, alt: named.get(m.key).text } : m)), ...[...named.values()].filter(m => !mine.some(x => x.key === m.key))];
    },
  };
}

// One refusal carries everything due on the file, so the retry goes through. The top rules come in full, up to
// maxRulesPerEdit and maxBlockChars; the other rules and the pages past maxPages come as one line each, and whatever
// the output budget has no room for is named in its overflow line. Every rule and page due is gated on the file, so the
// retry passes, but only what the refusal shows counts as shown, so a page left out still comes up on another file.
function refusal(event, hits, pages, written) {
  const { maxRulesPerEdit, maxBlockChars, maxPages } = config().delivery;
  const sid = event.session;
  const first = hits[0] ?? pages[0];
  const noun = first.place.startsWith('tool:') ? 'call' : 'edit';
  const head = `Taste rules apply to ${first.rel}:`;
  const foot = `Revise this ${noun} to follow ${!pages.length ? 'them' : hits.length ? 'them and the pages' : 'the pages'}, then retry. The retry is allowed.`;
  const full = [];
  for (const hit of hits.slice(0, maxRulesPerEdit)) {
    const line = ruleLine(hit.key, hit.note);
    if (full.length && [head, ...full.map(s => s.line), line, foot].join('\n').length > maxBlockChars) break;
    full.push({ ...hit, line });
  }
  const { text, kept } = fitContext([
    { noun: 'rule', head, items: full.map(s => s.line) },
    { noun: 'rule pointer', head: `Also due, in brief. Open the ones that bear on this ${noun}:`, items: hits.slice(full.length).map(h => rulePointer(h.key, h.note)) },
    { noun: 'page', head: `Vault pages on ${pages[0]?.rel}. Read the ones that bear on this work:`, items: pages.map((h, i) => pageLine(h.key, h.note, i >= maxPages)) },
  ], { tail: foot, gap: '\n' });
  markMany('gate', sid, [...hits.map(h => h.id), ...pages.map(p => p.id), ...written]);
  markShown(sid, hits.slice(0, kept[0] + kept[1]).map(h => h.key));
  markPages(event, pages.slice(0, kept[2]), Infinity);
  return text;
}

export async function preTool(event) {
  const t = target(event);
  const cwd = cwdOf(event);
  if (t?.namespace === 'file') {
    const why = vaultGuard(t.path, cwd) ?? noteGuard(event, t.path, cwd);
    if (why) return { deny: why };
    if (vaultOwn(vaultRel(t.path, cwd))) return null;
  }
  const { domains, hits: reach, matching } = scopeOf(event, t, cwd);
  const notes = settledNotes(await loadNotesAsync(domains));
  const text = plainText(newText(event));
  const ctx = deliveryFor(reach);
  const matched = deliverable(matching(liveRules(notes)), ctx);
  const hits = dueRules(event, matched, text);
  // A page is told of once per session wherever it comes up, and is gated on each file as a rule is, so a page the
  // budget left out of a refusal doesn't refuse the retry.
  const pages = duePages(event, deliverable(matching(livePages(notes), true), ctx).filter(m => fires(m.note, text))
    .sort((a, b) => bySpecificity(a.spec, b.spec) || byFit(a.note, b.note) || cmp(a.key, b.key)), Infinity)
    .map(m => ({ ...m, id: agentKey(event, `page|${keyHash(m.key, m.note.hash)}|${m.place}`) }))
    .filter(m => !marked('gate', event.session, m.id));
  // Only a file some rule covers can matter to the Stop hook, which checks a turn only once the prompt hook has stamped
  // it, so the others cost no write.
  const turn = t?.namespace === 'file' && matched.length ? turnStart(event.session) : null;
  const written = turn === null ? [] : [gatedFile(turn, t.path, cwd)];
  if (hits.length || pages.length) return { deny: refusal(event, hits, pages, written) };
  markMany('gate', event.session, written);
  return null;
}
