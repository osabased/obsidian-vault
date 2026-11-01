import fs from 'node:fs';
import path from 'node:path';
import { parse } from './frontmatter.mjs';
import { validGlob, overlapping } from './glob.mjs';
import { config, vaultPath, shortHash, toPosix, today, inside, plural } from './vault.mjs';

export const LIST_FIELDS = ['applies_to', 'triggers', 'keywords'];
const PAGE_LIST_FIELDS = ['applies_to', 'keywords'];
export const KEY_RE = /^[a-z0-9-]+\/[a-z0-9-]+$/;
export const BASES = { taste: ['stated', 'inferred', 'pick', 'reading'], knowledge: ['stated', 'failure', 'source'] };
export const PAGE_KINDS = ['topic', 'concept', 'entity', 'synthesis', 'source'];
const FOLDERS = { topic: 'topics', concept: 'concepts', entity: 'entities', synthesis: 'syntheses', source: 'sources' };
// The folder of its domain a note's type and kind put it in, or null for a page with no kind lint knows.
export const kindFolder = n => (n.type === 'rule' ? 'rules' : n.type === 'page' ? FOLDERS[n.kind] ?? null : null);
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

// A note's key is its domain and name, whichever folder of the domain holds it.
export const keyOf = ref => {
  const parts = toKey(ref).split('/');
  return parts.length > 2 ? `${parts[0]}/${parts.at(-1)}` : parts.join('/');
};

// A file's path from the vault root as the disk spells it, so each file has one spelling; null when there's no such file.
export function vaultFile(rel) {
  try {
    const real = fs.realpathSync.native(vaultPath(rel));
    return fs.statSync(real).isFile() ? path.relative(fs.realpathSync.native(vaultPath()), real).split(path.sep).join('/') : null;
  } catch {
    return null;
  }
}

// Spelled as the disk spells it, so two pages that name one file name it the same way.
export const rawFile = ref => {
  const rel = typeof ref === 'string' ? vaultFile(ref) : null;
  return rel?.startsWith('raw/') ? rel : null;
};

export function tryRegex(source) {
  try { return new RegExp(source); } catch { return null; }
}

export const escapeRegExp = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
    key: parts.length > 1 ? `${parts[0]}/${parts.at(-1)}` : parts[0],
    domain: parts.length > 1 ? parts[0] : '',
    folder: parts.slice(1, -1).join('/'),
    slug: parts.at(-1),
    depth: parts.length,
    ok,
    data,
    body,
    type: data.type,
    kind: single(data.kind) ?? (data.type === 'page' ? null : 'taste'),
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

const listErrors = (n, fields) => [
  ...fields.filter(f => n[f] === null).map(f => `${f} must be a list`),
  ...(n.applies_to ?? []).filter(g => !validGlob(g)).map(g => `bad glob in applies_to: ${g}`),
];

function checkNote(n) {
  const errs = n.clash ? [`${joinList(n.clash, 'and')} ${n.clash.length > 1 ? 'have' : 'has'} this note's name too. Rename one: each name is used once in a domain`] : [];
  if (!n.ok) return [...errs, 'no frontmatter'];
  if (!KEBAB.test(n.slug) || (n.domain && !KEBAB.test(n.domain))) errs.push('file and folder names must be lowercase-kebab-case');
  if (n.type !== 'rule' && n.type !== 'page') errs.push('type must be rule or page');
  if (n.domain && n.data.domain !== undefined && n.data.domain !== n.domain) errs.push(`domain is ${n.data.domain} but the note is in wiki/${n.domain}/`);
  if (n.data.domain === undefined) errs.push('no domain');
  if (n.type === 'page') return [...errs, ...listErrors(n, PAGE_LIST_FIELDS)];
  if (n.type !== 'rule') return errs;
  if (isResearch(n.domain)) errs.push(`${n.domain} is vault-only, so it holds pages only. Put the rule in a domain that reaches projects, or in global`);
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
  errs.push(...listErrors(n, LIST_FIELDS));
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
  // A key names one note, so two notes in two folders of a domain with one name would each answer for the other.
  const rels = new Map();
  for (const n of notes) rels.set(n.key, [...(rels.get(n.key) ?? []), n.rel]);
  for (const n of notes) if (rels.get(n.key).length > 1) n.clash = rels.get(n.key).filter(r => r !== n.rel);
  const resolve = resolver(notes);
  for (const n of notes) if (n.superseded_by) n.superseded_by = resolve(n.superseded_by);
  return notes.sort((a, b) => cmp(a.key, b.key));
}

export const readNote = (key, notes = loadNotes()) => (KEY_RE.test(key) ? notes.find(n => n.key === key) ?? null : null);

export const knownDomain = d => d === 'global' || Object.hasOwn(config().domains, d);
// A vaultOnly domain reaches no project session, so it holds only pages, which sessions read from the vault folder. It
// is set in vault.config.json rather than read from missing paths, so a domain is vault-only on every machine or none.
// Global rules apply in every project, so an entry that only lists global's topics doesn't make it one.
export const isResearch = d => d !== 'global' && Object.hasOwn(config().domains, d) && config().domains[d].vaultOnly === true;

// Why a note never reaches a session, or null when it does. A superseded note says so on its own.
export function undelivered(n) {
  if (n.depth < 2) return 'it is not in a domain folder, wiki/<domain>/';
  if (!knownDomain(n.domain)) return `${n.domain} isn't a domain in vault.config.json`;
  return noteErrors(n)[0] ?? null;
}

const isLive = n => n.type === 'rule' && !n.superseded_by && !undelivered(n);
export const isTopicPage = n => n.type === 'page' && n.kind === 'topic';
export const isSourcePage = n => n.type === 'page' && n.kind === 'source';

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
  const pages = byTopic(notes.filter(n => n.type === 'page' && n.depth > 1 && !noteErrors(n).length));
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

// The pages the hooks point sessions to, read from the notes as they are now.
export function livePages(notes = loadNotes()) {
  const pages = {};
  for (const n of notes) {
    if (n.type !== 'page' || !(n.keywords?.length || n.applies_to?.length) || undelivered(n)) continue;
    pages[n.key] = { rel: n.rel, domain: n.domain, kind: n.kind, summary: n.summary, keywords: n.keywords, applies_to: n.applies_to };
  }
  return pages;
}

export const kindLabel = kind => (PAGE_KINDS.includes(kind) ? `${kind} page` : 'page');

const pageLine = (k, p) => `- ${k} (${kindLabel(p.kind)}): ${p.summary ? `${clip(sentence(p.summary), 150)} ` : ''}${toPosix(vaultPath(...p.rel.split('/')))}`;

export const pagePointers = (head, due) => (due.length ? [head, ...due.map(h => pageLine(h.key, h.note))].join('\n') : '');

// For each pair of two domains' paths where one holds the other, the folder each domain's globs sit under when both
// are read from the outer one, since the gate matches a domain's globs from its own folder. Two domains with markers
// meet in a folder that holds both markers, read from the same root; where a marker folder sits in another domain's
// path can't be known ahead, so that pair isn't listed.
function nestedFolders(da, db) {
  const paths = d => config().domains[d]?.paths ?? [];
  const marked = d => Array.isArray(config().domains[d]?.markers) && config().domains[d].markers.length > 0;
  const nested = paths(da).flatMap(pa => paths(db).flatMap(pb => {
    const bUnderA = inside(pa, pb);
    if (bUnderA !== null) return [['', bUnderA]];
    const aUnderB = inside(pb, pa);
    return aUnderB !== null ? [[aUnderB, '']] : [];
  }));
  return marked(da) && marked(db) ? [['', ''], ...nested] : nested;
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

// A note is linked by its path from the vault root. Only superseded_by can name a key with no note, and only a rule
// takes it, so that link points where the rule would go.
export const linkTo = (key, rel = `wiki/${key.replace('/', '/rules/')}.md`) => `[[${rel.replace(/\.md$/i, '')}|${key.split('/').at(-1)}]]`;

// Obsidian writes a bare [[slug]] when no other note has that name, and the tools write a note's path from the vault
// root. A key, or a path through a folder of the domain the note isn't in, still names the note.
export function resolver(notes) {
  const bySlug = new Map();
  for (const n of notes) bySlug.set(n.slug, bySlug.has(n.slug) ? null : n.key);
  const byPath = new Map(notes.map(n => [toKey(n.rel), n.key]));
  return k => byPath.get(k) ?? (k.includes('/') ? keyOf(k) : bySlug.get(k) ?? k);
}

// An unclosed fence runs to the end of the note.
const FENCES = /^ {0,3}(`{3,}|~{3,})[\s\S]*?(?:^ {0,3}\1[^\n]*$|(?![\s\S]))/gm;

const heading = s => s.split(/\r?\n/)[0].trim();
// Lint and the index each read a note's sections several ways, so each body is split once.
const split = new WeakMap();
const sections = n => {
  if (!split.has(n)) split.set(n, n.body.replace(FENCES, '').split(/^## /m));
  return split.get(n);
};
// Inside a table Obsidian escapes the alias pipe as \|. A markdown link that starts with ./ or ../ is read from the
// note's folder and any other from the vault root, so each comes back as its path from the vault root.
// Each link comes with where its path starts and its path as written.
const linkSpans = (text, rel) => [
  ...[...text.matchAll(/\[\[([^\]]*)\]\]/g)].map(m => {
    const raw = m[1].split(/\\?[|#]/)[0];
    return { at: m.index + 2, raw, rest: m[1].slice(raw.length), target: raw.trim(), wiki: true };
  }),
  ...[...text.matchAll(/\]\(([^()\s]+\.md)(?:#[^()\s]*)?\)/gi)].filter(m => !/^[a-z][\w+.-]*:/i.test(m[1])).map(m => ({
    at: m.index + 2, raw: m[1], target: /^\.\.?\//.test(m[1]) ? path.posix.join(path.posix.dirname(rel), m[1]) : m[1],
  })),
];
const targets = (text, rel) => linkSpans(text, rel).map(s => s.target);

export const linksUnder = (n, title) => targets(sections(n).slice(1).find(s => heading(s) === title) ?? '', n.rel).map(toKey);

const sectionNamed = (n, title) => sections(n).slice(1).find(s => heading(s).toLowerCase() === title.toLowerCase()) ?? '';
export const hasSection = (n, title) => sectionNamed(n, title) !== '';

// An Evidence line is <day> · <kind> · session <id> · <what backs it>, the last part as propose.mjs's evidenceLine
// writes it for the kind. A line in another form comes back without a kind.
const EVIDENCE_KINDS = ['stated', 'correction', 'source', 'failure', 'choice', "agent's reading"];
const evidenceLines = n => [...sectionNamed(n, 'evidence').matchAll(/^- .*$/gm)].map(([line]) => {
  const m = line.match(/^- [^·]*· ([^·]*)· session ([^\s·]+)(?: · (.*))?/);
  return { line: line.trim(), day: line.match(/^- (\d{4}-\d\d-\d\d)\b/)?.[1], kind: m?.[1].trim(), session: m?.[2], cite: m?.[3] ?? '' };
});

// The session prefixes the Evidence lines give, first seen first.
export const evidenceSessions = n => [...new Set(evidenceLines(n).flatMap(e => e.session ?? []))];
export const evidenceSources = n => evidenceLines(n).filter(e => e.kind === 'source').flatMap(e => e.cite.match(/^(.+?) · dated /)?.[1] ?? []);

const TASTE_RANK = ['stated', 'pick', 'inferred', 'reading'];
const newestEvidence = n => evidenceLines(n).flatMap(e => e.day ?? []).sort().at(-1) ?? '';
// Each test, a note's value where higher wins and what to say when it decides, in the order AGENTS.md's Evidence
// section gives.
const RANKS = {
  taste: {
    tests: [
      [n => -TASTE_RANK.indexOf(n.data.basis), (w, l) => `basis ${w.data.basis} over ${l.data.basis}`],
      [n => evidenceLines(n).length, (w, l) => `${plural(evidenceLines(w).length, 'Evidence line')} to ${evidenceLines(l).length}`],
      [newestEvidence, (w, l) => `evidence from ${newestEvidence(w)} over ${newestEvidence(l) || 'no date'}`],
    ],
    tie: 'same basis, Evidence count and newest Evidence date',
  },
  knowledge: { tests: [[n => n.as_of, (w, l) => `as_of ${w.as_of} over ${l.as_of}`]], tie: 'same as_of' },
};

// Which of two rules that may contradict to recommend first, or null for a taste rule and a knowledge rule, which
// aren't ranked against each other.
export function rankPair(a, b) {
  const rank = a.kind === b.kind ? RANKS[a.kind] : null;
  if (!rank) return null;
  for (const [value, why] of rank.tests) {
    const [x, y] = [value(a), value(b)];
    if (x !== y) return x > y ? { first: a, last: b, why: why(a, b) } : { first: b, last: a, why: why(b, a) };
  }
  return { first: null, why: rank.tie };
}

// The quotes of the user's words, of sources and of recorded rows, with what each is checked against. A line from a
// row, whose id comes before the proposal's, quotes the row rather than the session. A line lint can't read comes back
// as the line alone.
export const evidenceQuotes = n => evidenceLines(n).flatMap(({ line, kind, session, cite }) => {
  if (!EVIDENCE_KINDS.includes(kind)) return [{ line }];
  if (!['stated', 'correction', 'source'].includes(kind)) return [];
  const m = cite.match(/^(?:(.+?) · dated [^·]* · )?["“](.*)["”](?: \(([^()]*)\))?[ \t]*$/);
  if (!m || (kind === 'source') !== (m[1] !== undefined)) return [{ line }];
  const [, source, quote, ids = ''] = m;
  if (!ids.includes(';')) return [{ session, source, quote }];
  const pick = kind === 'stated' && ids.match(/^(\S+); proposed as \S+$/)?.[1];
  return pick ? [{ pick, quote }] : [{ line }];
});

// A line in any other form comes back without a session, so lint can say it can't check it.
export const youSaid = n => [...sectionNamed(n, 'you said').matchAll(/^- .*$/gm)].map(([line]) => {
  const m = line.match(/^- [^·]*· session ([^\s·]+) · ["“](.*)["”][ \t]*$/);
  return { line: line.trim(), session: m?.[1], quote: m?.[2] };
});

// The user's quoted words are left out: a broken link there could be fixed only by editing them.
export const QUOTED = ['evidence', 'you said'];

// Fences and quoted sections are blanked rather than cut, so an offset into what the checks read is one into the body,
// and lint --fix can change what a check found in place.
const blank = s => s.replace(/[^\n]/g, ' ');
const prose = new WeakMap();
const proseBody = n => {
  if (!prose.has(n)) {
    const parts = n.body.replace(FENCES, blank).split(/^(?=## )/m);
    prose.set(n, parts.map(s => (s.startsWith('## ') && QUOTED.includes(heading(s.slice(3)).toLowerCase()) ? blank(s) : s)).join(''));
  }
  return prose.get(n);
};
const unquotedText = new WeakMap();
const unquoted = n => {
  if (!unquotedText.has(n)) unquotedText.set(n, proseBody(n).replace(/`[^`\n]*`/g, blank));
  return unquotedText.get(n);
};

export const noteLinkSpans = n => linkSpans(unquoted(n), n.rel);
export const noteLinks = n => noteLinkSpans(n).map(s => s.target);
export const linkedKeys = (n, resolve) => noteLinks(n).map(t => resolve(toKey(t)));

// A footnote's target is a file under raw/ or a URL, in backticks or not, then ` · ` and its date when it has one.
// Definitions are read with inline code kept, so a target in backticks survives. A citation may sit before a colon,
// so only a definition's own [^id]: at the start of its line is left out of the citations.
export function footnotes(n) {
  const defs = [...proseBody(n).matchAll(/^\[\^([^\]\s]+)\]:[ \t]*(.*)$/gm)].map(m => {
    const raw = m[2].split(' · ')[0].trim();
    return { id: m[1], target: raw.replace(/^`([^`]*)`$/, '$1'), raw, at: m.index + m[0].length - m[2].length };
  });
  const cited = new Set([...unquoted(n).replace(/^\[\^[^\]\s]+\]:/gm, '').matchAll(/\[\^([^\]\s]+)\]/g)].map(m => m[1]));
  return { defs, cited };
}

export const sourceOf = s => (typeof s.data.source === 'string' ? s.data.source : s.key);

// /ingest saves a web page as a file whose frontmatter gives its url, and saves it again when it changes. A file that
// can't be read gives none.
export function savedUrl(rel) {
  if (!rel.endsWith('.md')) return null;
  let url;
  try { ({ url } = parse(fs.readFileSync(vaultPath(rel), 'utf8')).data); } catch { return null; }
  return isUrl(url) ? url : null;
}

// One web page however a note spells it: without its #fragment or a trailing slash, and with its host in lowercase.
function normUrl(u) {
  try {
    const url = new URL(u);
    url.hash = '';
    return url.href.replace(/\/$/, '');
  } catch {
    return u;
  }
}

// The sources a page draws on, each once however it's named, a file saved from a web page as that page's URL: the ones
// its footnotes cite and the sources of the source pages it links. The source pages it draws on are the ones it links
// and the ones whose source a footnote cites, not every page on a source it reached through a link.
export function citedSources(notes, resolve) {
  const urls = new Map();
  const idOf = ref => {
    const rel = rawFile(ref);
    if (rel && !urls.has(rel)) urls.set(rel, savedUrl(rel));
    const url = rel ? urls.get(rel) : isUrl(ref) ? ref : null;
    return url ? normUrl(url) : rel ?? ref;
  };
  const idAt = new Map(notes.filter(isSourcePage).map(n => [n.key, idOf(sourceOf(n))]));
  return n => {
    const cited = new Set(footnotes(n).defs.flatMap(d => (d.target ? [idOf(d.target)] : [])));
    const linked = new Set(linkedKeys(n, resolve).filter(k => idAt.has(k)));
    return {
      sources: new Set([...cited, ...[...linked].map(k => idAt.get(k))]),
      pages: new Set([...idAt].flatMap(([k, id]) => (linked.has(k) || cited.has(id) ? [k] : []))),
    };
  };
}

// A source page is one source, so it shows no count.
function drawsOn(notes, resolve) {
  const cited = citedSources(notes, resolve);
  return n => {
    if (isSourcePage(n)) return '';
    const count = cited(n).sources.size;
    return ` · ${count ? plural(count, 'source') : 'no sources'}`;
  };
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

function indexLine(n, refs, sources, link) {
  if (n.type === 'page') {
    const [why] = noteErrors(n);
    return `- ${link(n.key)} · ${kindLabel(n.kind)}${sources(n)}${why ? ` · not valid: ${why}` : ''} · ${n.summary ? clip(n.summary, 150) : '(no summary)'}`;
  }
  const why = n.superseded_by ? null : undelivered(n);
  const gone = n.superseded_by ? ` · superseded by ${link(n.superseded_by)}` : why ? ` · not delivered: ${why}` : '';
  const kind = n.kind === 'knowledge' ? ` · knowledge as of ${n.as_of ?? '(no date)'}` : '';
  const from = [...(refs.get(n.key) ?? [])].sort(cmp);
  return `- ${link(n.key)}${gone}${kind} · Do: ${clip(n.do || '(missing)', 100)}${from.length ? ` · from ${from.map(link).join(', ')}` : ''}`;
}

// Notes with no topic get a section of their own after the topics, so no topic a note names can merge with it.
// Its heading is capitalized and topic headings lowercase, so they can't read the same either.
const NO_TOPIC = Symbol('No topic');
// A topic's pages come before its rules, in PAGE_KINDS order: sessions read the pages, the topic page first, and the
// hooks deliver the rules.
const kindRank = n => (n.type !== 'page' ? PAGE_KINDS.length + 1 : PAGE_KINDS.includes(n.kind) ? PAGE_KINDS.indexOf(n.kind) : PAGE_KINDS.length);
const pagesFirst = (a, b) => kindRank(a) - kindRank(b) || cmp(a.key, b.key);

export function renderIndex(notes) {
  const { domains } = config();
  const resolve = resolver(notes);
  const refs = refPages(notes, resolve);
  const sources = drawsOn(notes, resolve);
  const relOf = new Map(notes.map(n => [n.key, n.rel]));
  const link = key => linkTo(key, relOf.get(key));
  const out = [
    '# Index', '',
    'Generated by tools/build.mjs from the notes in wiki/. Do not edit. To find notes by their words rather than their topic, run `node tools/search.mjs "<words>"` from the vault folder; `--help` lists its filters.',
  ];
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
      out.push('', `### ${typeof g === 'symbol' ? g.description : g}`, '', ...groups.get(g).sort(pagesFirst).map(n => indexLine(n, refs, sources, link)));
    }
  }
  return `${out.join('\n')}\n`;
}
