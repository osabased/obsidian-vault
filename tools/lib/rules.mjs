import fs from 'node:fs';
import path from 'node:path';
import { parse } from './frontmatter.mjs';
import { validGlob, overlapping } from './glob.mjs';
import { config, vaultPath, shortHash, toPosix, today, inside } from './vault.mjs';

export const LIST_FIELDS = ['applies_to', 'triggers', 'keywords'];
export const KEY_RE = /^[a-z0-9-]+\/[a-z0-9-]+$/;
export const BASES = { taste: ['stated', 'inferred', 'pick', 'reading'], knowledge: ['stated', 'failure', 'source'] };
export const joinList = (xs, word) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} ${word} ${xs.at(-1)}`);
export const wrongBasis = (kind, basis) => (kind === 'knowledge' ? `a knowledge rule's basis must be ${joinList(BASES.knowledge, 'or')}`
  : BASES.knowledge.includes(basis) ? `basis ${basis} is for knowledge rules; set kind: knowledge` : `basis must be ${joinList(BASES.taste, 'or')}`);
export const isUrl = s => typeof s === 'string' && /^https?:\/\/\S+$/i.test(s);
export const normTopic = s => String(s ?? '').trim().toLowerCase();
export const validDay = s => typeof s === 'string' && /^\d{4}-\d\d-\d\d$/.test(s) && !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().startsWith(s);
export const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HEAD = [
  '# Taste rules',
  "Follow these unless the user's current request or the project's own instructions say otherwise. If an edit is refused with taste rules, apply them and retry the edit.",
];

export const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
export const byKey = ([a], [b]) => cmp(a, b);

export function toKey(ref) {
  let s = String(ref).trim().replace(/^`+|`+$/g, '').trim().replace(/\.+$/, '');
  // An unquoted [[link]] in the frontmatter reads as a list in a list, which leaves [link].
  const link = s.match(/^\[\[?([^\]|#]+)[^\]]*\]\]?$/);
  if (link) s = link[1];
  return s.trim().replace(/\\/g, '/').replace(/^\.?\/?wiki\//i, '').replace(/\.md$/i, '').toLowerCase();
}

// A file's path from the vault root as the disk spells it, so each file has one spelling; null when there's no such file.
export function vaultFile(rel) {
  try {
    const real = fs.realpathSync.native(vaultPath(rel));
    return fs.statSync(real).isFile() ? path.relative(fs.realpathSync.native(vaultPath()), real).split(path.sep).join('/') : null;
  } catch {
    return null;
  }
}

export function tryRegex(source) {
  try { return new RegExp(source); } catch { return null; }
}

const escapeRegExp = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const mentions = (word, text) => new RegExp(`(?<!\\w)${escapeRegExp(word)}(?!\\w)`, 'i').test(text);

const asList = v => (v === null || v === undefined ? [] : Array.isArray(v) ? v.map(String) : null);
// Obsidian writes a list-type property as a list even when it holds one link.
const single = v => (Array.isArray(v) && v.length === 1 ? v[0] : v);

function field(lead, name) {
  const m = lead.match(new RegExp(`^[ \\t]*(?:\\*\\*)?${name}(?::\\*\\*|\\*\\*:|:)[ \\t]*(.*)$`, 'm'));
  return m ? m[1].trim() : '';
}

export function parseNote(text, rel) {
  const { data, body, ok } = parse(text);
  const parts = rel.replace(/^wiki\//i, '').replace(/\.md$/i, '').split('/');
  const lead = body.split(/^## /m)[0];
  const successor = single(data.superseded_by);
  const note = {
    rel,
    key: parts.join('/'),
    domain: parts.length > 1 ? parts[0] : '',
    slug: parts.at(-1),
    depth: parts.length,
    ok,
    data,
    body,
    type: data.type,
    kind: data.kind ?? 'taste',
    as_of: data.as_of ?? null,
    always: data.always === true,
    topic: typeof data.topic === 'string' ? normTopic(data.topic) : '',
    summary: typeof data.summary === 'string' ? data.summary.trim() : '',
    superseded_by: typeof successor === 'string' && successor.trim() ? toKey(successor) : null,
    do: field(lead, 'Do'),
    not: field(lead, 'Not'),
    because: field(lead, 'Because'),
  };
  for (const f of LIST_FIELDS) note[f] = asList(data[f]);
  return note;
}

const sentence = s => (/[.!?…]$/.test(s) ? s : `${s}.`);

export const ruleText = n => [
  `Do: ${sentence(n.do)}`, `Not: ${sentence(n.not)}`,
  ...(n.because ? [`Because: ${sentence(n.because)}`] : []),
  ...(n.kind === 'knowledge' ? [`As of ${n.as_of}.`] : []),
].join(' ');

export const ruleTextParts = n => (n.kind === 'knowledge' ? 'Do, Not, Because and the as_of date' : 'Do, Not and Because');

export const clip = (s, max) => (s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`);

// Lint, its topic count and liveRules each ask about the same parsed notes, so each note is checked once.
const checked = new WeakMap();
export function noteErrors(n) {
  if (!checked.has(n)) checked.set(n, checkNote(n));
  return checked.get(n);
}

function checkNote(n) {
  if (!n.ok) return ['no frontmatter'];
  const errs = [];
  if (!KEBAB.test(n.slug) || (n.domain && !KEBAB.test(n.domain))) errs.push('file and folder names must be lowercase-kebab-case');
  if (n.type !== 'rule' && n.type !== 'page') errs.push('type must be rule or page');
  if (n.domain && n.data.domain !== undefined && n.data.domain !== n.domain) errs.push(`domain is ${n.data.domain} but the note is in wiki/${n.domain}/`);
  if (n.data.domain === undefined) errs.push('no domain');
  if (n.type !== 'rule') return errs;
  if (!BASES[n.kind]) errs.push('kind must be taste or knowledge');
  else if (!BASES[n.kind].includes(n.data.basis)) errs.push(wrongBasis(n.kind, n.data.basis));
  if (n.kind === 'knowledge') {
    if (!validDay(n.as_of)) errs.push('a knowledge rule needs as_of, the day it was last checked, as YYYY-MM-DD');
    else if (n.as_of > today()) errs.push(`as_of ${n.as_of} is in the future`);
    if (!n.applies_to?.length) errs.push('a knowledge rule needs applies_to: it reaches the agent only on matching edits');
    if (n.keywords?.length || n.always) errs.push('a knowledge rule reaches the agent only on matching edits, so it takes no keywords or always: true');
  } else if (n.kind === 'taste' && n.as_of !== null) errs.push('as_of is only for knowledge rules; taste rules never expire');
  if (!n.do) errs.push('no **Do:** line');
  if (!n.not) errs.push('no **Not:** line');
  for (const f of LIST_FIELDS) if (n[f] === null) errs.push(`${f} must be a list`);
  for (const g of n.applies_to ?? []) if (!validGlob(g)) errs.push(`bad glob in applies_to: ${g}`);
  for (const t of n.triggers ?? []) if (!tryRegex(t)) errs.push(`bad regex in triggers: ${t}`);
  if (n.data.always !== undefined && n.data.always !== null && typeof n.data.always !== 'boolean') errs.push('always must be true or false');
  if (n.data.superseded_by != null && typeof single(n.data.superseded_by) !== 'string') errs.push('superseded_by must name one note');
  return errs;
}

export function loadNotes() {
  const root = vaultPath('wiki');
  const notes = [];
  const walk = dir => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch {}
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && /\.md$/i.test(e.name)) {
        notes.push({ ...parseNote(fs.readFileSync(full, 'utf8'), `wiki/${path.relative(root, full).replace(/\\/g, '/')}`), saved: fs.statSync(full).mtimeMs });
      }
    }
  };
  walk(root);
  const resolve = resolver(notes);
  for (const n of notes) if (n.superseded_by) n.superseded_by = resolve(n.superseded_by);
  return notes.sort((a, b) => cmp(a.key, b.key));
}

export function readNote(key) {
  if (!KEY_RE.test(key)) return null;
  try {
    return parseNote(fs.readFileSync(`${vaultPath('wiki', ...key.split('/'))}.md`, 'utf8'), `wiki/${key}.md`);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

export const knownDomain = d => d === 'global' || Object.hasOwn(config().domains, d);

// Why a rule note never reaches a session, or null when it does. A superseded note says so on its own.
function undelivered(n) {
  if (n.depth !== 2) return 'it is not directly in wiki/<domain>/';
  if (!knownDomain(n.domain)) return `${n.domain} isn't a domain in vault.config.json`;
  return noteErrors(n)[0] ?? null;
}

const isLive = n => n.type === 'rule' && !n.superseded_by && !undelivered(n);
export const isTopicPage = n => n.type === 'page' && n.data.source == null;

export function byTopic(notes) {
  const used = new Map();
  for (const n of notes.filter(x => x.topic)) {
    const mine = used.get(n.domain) ?? used.set(n.domain, new Map()).get(n.domain);
    mine.set(n.topic, [...(mine.get(n.topic) ?? []), n]);
  }
  return used;
}

// Each domain's live rules by topic, so lint and propose's help agree on which topics are in use.
export const topicNotes = (notes = loadNotes()) => byTopic(notes.filter(isLive));

// Each domain's topics: the ones vault.config.json lists, in its order, then the others its live rules and pages have.
export function domainTopics(notes = loadNotes()) {
  const { domains } = config();
  const used = topicNotes(notes);
  const pages = byTopic(notes.filter(n => n.type === 'page' && n.depth === 2 && !noteErrors(n).length));
  return new Map([...new Set(['global', ...Object.keys(domains)])].map(d => {
    const known = (domains[d]?.topics ?? []).map(normTopic).filter(Boolean);
    const more = [...(used.get(d)?.keys() ?? []), ...(pages.get(d)?.keys() ?? [])].sort();
    return [d, [...new Set([...known, ...more])]];
  }));
}

// The rules in the vault, read from the notes as they are now.
export function liveRules(notes = loadNotes()) {
  const rules = {};
  for (const n of notes.filter(isLive)) {
    const text = ruleText(n);
    rules[n.key] = {
      domain: n.domain, topic: n.topic, text,
      // Only the delivered wording counts, so an edit to a rule's evidence or globs doesn't deliver it again.
      hash: shortHash(text),
      kind: n.kind, always: n.always, applies_to: n.applies_to, triggers: n.triggers, keywords: n.keywords,
    };
  }
  return rules;
}

// Obsidian saves a note every few seconds while the user types, so a note saved in the last settleSeconds
// waits rather than reach sessions half-written.
export function settledNotes(notes = loadNotes()) {
  const since = Date.now() - config().delivery.settleSeconds * 1000;
  return notes.filter(n => n.saved <= since);
}

export const settledRules = (notes = loadNotes()) => liveRules(settledNotes(notes));

// For each pair of two domains' project folders where one holds the other, the folder each domain's globs sit under
// when both are read from the outer one, since the gate matches a domain's globs from its own folder.
function nestedFolders(da, db) {
  const projects = d => config().domains[d]?.projects ?? [];
  return projects(da).flatMap(pa => projects(db).flatMap(pb => {
    const bUnderA = inside(pa, pb);
    if (bUnderA !== null) return [['', bUnderA]];
    const aUnderB = inside(pb, pa);
    return aUnderB !== null ? [[aUnderB, '']] : [];
  }));
}

// The globs two rules on one topic share, when both can gate one file: a domain's rules meet its own and global's,
// and another domain's when their project folders nest.
export function sharedFiles(a, b) {
  if (!a.topic || a.topic !== b.topic) return null;
  const [as, bs] = [a.applies_to ?? [], b.applies_to ?? []];
  if (a.domain === b.domain || [a.domain, b.domain].includes('global')) return overlapping(as, bs);
  for (const folders of nestedFolders(a.domain, b.domain)) {
    const pair = overlapping(as, bs, folders);
    if (pair) return pair;
  }
  return null;
}

export const ruleLine = (k, r) => `- ${k}: ${clip(r.text, config().delivery.maxRuleChars)}`;

export function domainOrder(domains) {
  const known = Object.keys(config().domains);
  const rank = d => (d === 'global' ? -1 : known.includes(d) ? known.indexOf(d) : known.length);
  return [...new Set(domains)].sort((a, b) => rank(a) - rank(b) || cmp(a, b));
}

export const domainTitle = d => (d === 'global' ? 'Every project' : config().domains[d]?.title ?? 'not in vault.config.json');

const isRule = line => line.startsWith('- ');
const alwaysEntries = rules => Object.entries(rules).filter(([, r]) => r.always).sort(byKey);
export const alwaysIn = (rules, scope) => alwaysEntries(rules).filter(([, r]) => scope.includes(r.domain));

// The keys go in the order their rule lines do.
function alwaysLines(rules, domains) {
  const entries = alwaysIn(rules, domains);
  const lines = [];
  const keys = [];
  for (const d of domainOrder(domains)) {
    const mine = entries.filter(([, r]) => r.domain === d);
    if (!mine.length) continue;
    lines.push('', `## ${d}`, ...mine.map(([k, r]) => ruleLine(k, r)));
    keys.push(...mine.map(([k]) => k));
  }
  return { lines, keys };
}

export function alwaysSize(rules, domains) {
  const { lines } = alwaysLines(rules, domains);
  if (!lines.length) return { lines: 0, bytes: 0 };
  const all = [...HEAD, ...lines];
  return { lines: all.length, bytes: Buffer.byteLength(all.join('\n')) };
}

// The always rules' block for a session start, and the rules it holds: rules that don't fit are left to active.md.
export function alwaysContext(domains, rules = liveRules()) {
  const { lines, keys } = alwaysLines(rules, domains);
  if (!lines.length) return { text: '', keys: [] };
  const { activeMaxLines, activeMaxBytes } = config().delivery;
  const fits = xs => xs.length <= activeMaxLines && Buffer.byteLength(xs.join('\n')) <= activeMaxBytes;
  if (fits([...HEAD, ...lines])) return { text: [...HEAD, ...lines].join('\n'), keys };
  const tail = shown => ['', `(${keys.length - shown} more didn't fit. See ${toPosix(vaultPath('active.md'))}.)`];
  const out = [...HEAD];
  let shown = 0;
  for (const line of lines) {
    const next = shown + (isRule(line) ? 1 : 0);
    if (!fits([...out, line, ...tail(next)])) break;
    out.push(line);
    shown = next;
  }
  while (out.length > HEAD.length && !isRule(out.at(-1))) out.pop();
  // The lines kept are the first ones, so the rules shown are the first keys.
  return { text: [...out, ...tail(shown)].join('\n'), keys: keys.slice(0, shown) };
}

export function renderActive(rules) {
  const out = [
    '# Always-on rules',
    '',
    "Generated by tools/build.mjs from the notes in wiki/. Do not edit. Sessions load these at start: global rules in every project, the others in their domain's projects.",
  ];
  const entries = alwaysEntries(rules);
  if (!entries.length) out.push('', 'None yet.');
  for (const d of domainOrder(entries.map(([, r]) => r.domain))) {
    out.push('', `## ${d} · ${domainTitle(d)}`, '', ...entries.filter(([, r]) => r.domain === d).map(([k, r]) => ruleLine(k, r)));
  }
  return `${out.join('\n')}\n`;
}

export const linkTo = key => `[[wiki/${key}|${key.split('/').at(-1)}]]`;

// Obsidian writes a bare [[slug]] when no other note has that name.
export function resolver(notes) {
  const bySlug = new Map();
  for (const n of notes) bySlug.set(n.slug, bySlug.has(n.slug) ? null : n.key);
  return k => (k.includes('/') ? k : bySlug.get(k) ?? k);
}

// An unclosed fence runs to the end of the note.
const FENCES = /^ {0,3}(`{3,}|~{3,})[\s\S]*?(?:^ {0,3}\1[^\n]*$|(?![\s\S]))/gm;

const heading = s => s.split(/\r?\n/)[0].trim();
const sections = n => n.body.replace(FENCES, '').split(/^## /m);
// Inside a table Obsidian escapes the alias pipe as \|.
const targets = text => [...text.matchAll(/\[\[[^\]]*\]\]/g)].map(m => m[0].slice(2, -2).split(/\\?[|#]/)[0].trim());

export const linksUnder = (n, title) => targets(sections(n).slice(1).find(s => heading(s) === title) ?? '').map(toKey);

// The session prefixes the Evidence lines give, first seen first.
export function evidenceSessions(n) {
  const evidence = sections(n).slice(1).find(s => heading(s).toLowerCase() === 'evidence') ?? '';
  return [...new Set([...evidence.matchAll(/^- [^·\n]*· [^·\n]*· session ([^\s·]+)/gm)].map(m => m[1]))];
}

// The user's quoted words are left out: a broken link there could be fixed only by editing them.
export const QUOTED = ['evidence', 'you said'];

export function noteLinks(n) {
  const [lead, ...rest] = sections(n);
  return [lead, ...rest.filter(s => !QUOTED.includes(heading(s).toLowerCase()))].flatMap(s => targets(s.replace(/`[^`\n]*`/g, '')));
}

// /ingest links a page and its rules both ways, but a link added by hand in Obsidian may be on one side only.
function refPages(notes, resolve) {
  const pages = new Set(notes.filter(n => n.type === 'page').map(n => n.key));
  const refs = new Map();
  const add = (rule, page) => refs.set(rule, (refs.get(rule) ?? new Set()).add(page));
  for (const n of notes) {
    if (n.type === 'page') for (const k of linksUnder(n, 'Rules')) add(resolve(k), n.key);
    else if (n.type === 'rule') for (const k of linksUnder(n, 'Examples').map(resolve)) if (pages.has(k)) add(n.key, k);
  }
  return refs;
}

function indexLine(n, refs) {
  const link = linkTo(n.key);
  if (n.type === 'page') return `- ${link} · ${isTopicPage(n) ? 'topic page' : 'ref page'} · ${n.summary ? clip(n.summary, 150) : '(no summary)'}`;
  const why = n.superseded_by ? null : undelivered(n);
  const gone = n.superseded_by ? ` · superseded by ${linkTo(n.superseded_by)}` : why ? ` · not delivered: ${why}` : '';
  const kind = n.kind === 'knowledge' ? ` · knowledge as of ${n.as_of ?? '(no date)'}` : '';
  const from = [...(refs.get(n.key) ?? [])].sort(cmp);
  return `- ${link}${gone}${kind} · Do: ${clip(n.do || '(missing)', 100)}${from.length ? ` · from ${from.map(linkTo).join(', ')}` : ''}`;
}

// Notes with no topic get a section of their own after the topics, so no topic a note names can merge with it.
// Its heading is capitalized and topic headings lowercase, so they can't read the same either.
const NO_TOPIC = Symbol('No topic');
// A topic's pages come before its rules: sessions read the pages, and the hooks deliver the rules.
const pagesFirst = (a, b) => (b.type === 'page') - (a.type === 'page') || cmp(a.key, b.key);

export function renderIndex(notes) {
  const { domains } = config();
  const refs = refPages(notes, resolver(notes));
  const out = ['# Index', '', 'Generated by tools/build.mjs from the notes in wiki/. Do not edit.'];
  const nested = notes.filter(n => n.depth > 1);
  const sections = domainOrder([...Object.keys(domains), ...nested.map(n => n.domain)])
    .map(d => [d, `## ${d} · ${domainTitle(d)}`, nested.filter(n => n.domain === d)]);
  const top = notes.filter(n => n.depth === 1);
  if (top.length) sections.push(['', '## (top level)', top]);
  for (const [d, head, mine] of sections) {
    out.push('', head);
    if (!mine.length) {
      out.push('', 'No notes yet.');
      continue;
    }
    const topics = (domains[d]?.topics ?? []).map(normTopic);
    const groups = new Map();
    for (const n of mine) {
      const g = n.topic || NO_TOPIC;
      groups.set(g, [...(groups.get(g) ?? []), n]);
    }
    const rank = g => (g === NO_TOPIC ? topics.length + 1 : topics.includes(g) ? topics.indexOf(g) : topics.length);
    for (const g of [...groups.keys()].sort((a, b) => rank(a) - rank(b) || cmp(a, b))) {
      out.push('', `### ${typeof g === 'symbol' ? g.description : g}`, '', ...groups.get(g).sort(pagesFirst).map(n => indexLine(n, refs)));
    }
  }
  return `${out.join('\n')}\n`;
}
