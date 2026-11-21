import fs from 'node:fs';
import path from 'node:path';
import v8 from 'node:v8';
import { parse, yamlQuote } from './frontmatter.mjs';
import { validGlob, overlapping, entryParts, globListProblems } from './glob.mjs';
import { config, vaultPath, shortHash, toPosix, today, inside, plural, isVaultOnly, memo, readJson, statePath, logError } from './vault.mjs';
import { cachedNotes, cleanFromGit, noteStats } from './cache.mjs';
import { SEMVER, SCHEMES, fitOf, checkedFit, movedOnFrom, projectVersions, rootOutside, osvPackage, compareFor, comparable, compareSemver } from './versions.mjs';
import { checkDeadline } from './deadline.mjs';

export const LIST_FIELDS = ['applies_to', 'triggers', 'keywords', 'tools'];
// Slugs and domains take lowercase letters, modifier letters (ー, 々, ʻ), letters of scripts with no case (CJK and the
// like), digits and combining marks, read in NFC, so a name never has an uppercase letter and two spellings of one name
// compare equal.
export const KEY_RE = /^[\p{Ll}\p{Lm}\p{Lo}\p{Nd}\p{M}-]+\/[\p{Ll}\p{Lm}\p{Lo}\p{Nd}\p{M}-]+$/u;
const PREFERENCE_BASES = ['stated', 'inferred', 'pick', 'reading'];
export const BASES = { taste: PREFERENCE_BASES, practice: PREFERENCE_BASES, knowledge: ['stated', 'failure', 'source'] };
export const RULE_KINDS = Object.keys(BASES);
export const PAGE_WHERE = 'page must be a page under wiki/, like wiki/<domain>/<folder>/<slug>.md.';
export const rulePath = key => `wiki/${key.replace('/', '/rules/')}.md`;
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
export const KEBAB = /^[\p{Ll}\p{Lm}\p{Lo}\p{Nd}\p{M}]+(?:-[\p{Ll}\p{Lm}\p{Lo}\p{Nd}\p{M}]+)*$/u;
const nfc = s => String(s).normalize('NFC');
const HEAD = [
  '# Rules',
  "Follow these unless the user's current request or the project's own instructions say otherwise. If an edit is refused with rules, apply them and retry the edit.",
];

export const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
export const byKey = ([a], [b]) => cmp(a, b);

export function toKey(ref) {
  let s = String(ref).trim().replace(/^`+|`+$/g, '').trim().replace(/\.+$/, '');
  // An unquoted [[link]] in the frontmatter reads as a list in a list, which leaves [link].
  const link = s.match(/^\[\[?([^\]|#]+)[^\]]*\]\]?$/);
  if (link) s = link[1];
  return nfc(s.trim().replace(/\\/g, '/').replace(/^\.?\/?wiki\//i, '').replace(/\.md$/i, '').toLowerCase());
}

// A note's key is its domain and name, whichever folder of the domain holds it.
export const keyOf = ref => {
  const parts = toKey(ref).split('/');
  return parts.length > 2 ? `${parts[0]}/${parts.at(-1)}` : parts.join('/');
};

// The vault root as the disk spells it, which doesn't change while a tool runs.
let realRoot;
const rootOnDisk = () => (realRoot ??= fs.realpathSync.native(vaultPath()));

// A file's frontmatter and body, or null when it can't be read.
export function parsedFile(rel) {
  try { return parse(fs.readFileSync(vaultPath(...rel.split('/')), 'utf8')); } catch { return null; }
}

// A file's or folder's path from the vault root as the disk spells it, so each has one spelling, with its stat; null
// when there's nothing at the path.
export function diskRel(ref) {
  try {
    const real = fs.realpathSync.native(vaultPath(ref));
    return { rel: path.relative(rootOnDisk(), real).split(path.sep).join('/'), stat: fs.statSync(real) };
  } catch {
    return null;
  }
}

// A file's path from the vault root as the disk spells it; null when there's no such file.
export const vaultFile = ref => {
  const at = diskRel(ref);
  return at?.stat.isFile() ? at.rel : null;
};

// Spelled as the disk spells it, so two pages that name one file name it the same way.
export const rawFile = ref => {
  const rel = typeof ref === 'string' ? vaultFile(ref) : null;
  return rel?.startsWith('raw/') ? rel : null;
};

// V8's linear engine runs a trigger in time proportional to the text, where backtracking took 17 s on one long line. The
// flag is refused in NODE_OPTIONS, so it is set here.
v8.setFlagsFromString('--enable-experimental-regexp-engine');

// The trigger as a linear-time RegExp, or null when it doesn't compile or the engine refuses it (see regexError).
export function tryRegex(source) {
  try { return new RegExp(source, 'l'); } catch { return null; }
}

// Why a trigger can't be used, or null when it can.
export function regexError(source) {
  try { new RegExp(source, 'l'); return null; } catch (e) {
    return /linear time/.test(e.message)
      ? `trigger ${source} can't run in linear time. The linear regex engine refuses backreferences, lookaheads, counted repeats like {1000}, and the i and u flags`
      : `bad regex in triggers: ${source}`;
  }
}

export const escapeRegExp = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const mentions = (word, text) => new RegExp(`(?<!\\w)${escapeRegExp(word)}(?!\\w)`, 'i').test(text);

// An item that isn't text, such as `- a: b` read as a map, is the note's error (itemErrors), not a string.
const asList = v => (v === null || v === undefined ? [] : Array.isArray(v) ? v.filter(x => typeof x === 'string') : null);
// Obsidian writes a list-type property as a list even when it holds one link.
const single = v => (Array.isArray(v) && v.length === 1 ? v[0] : v);

export const leadPattern = name => `^[ \\t]*(?:\\*\\*)?${name}(?::\\*\\*|\\*\\*:|:)`;

function field(lead, name) {
  const m = lead.match(new RegExp(`${leadPattern(name)}[ \\t]*(.*)$`, 'm'));
  return m ? m[1].trim() : '';
}

export const parseNote = (text, rel) => noteFrom(parse(text), rel);

function noteFrom({ data, body, ok, errors }, rel) {
  const parts = nfc(rel).replace(/^wiki\//i, '').replace(/\.md$/i, '').split('/');
  const lead = body.split(/^## /m)[0];
  const successor = single(data.superseded_by);
  const before = single(data.moved_from);
  const note = {
    rel,
    key: parts.length > 1 ? `${parts[0]}/${parts.at(-1)}` : parts[0],
    domain: parts.length > 1 ? parts[0] : '',
    folder: parts.slice(1, -1).join('/'),
    slug: parts.at(-1),
    depth: parts.length,
    ok,
    parseErrors: errors,
    data,
    body,
    type: data.type,
    kind: single(data.kind) ?? (data.type === 'page' ? null : 'taste'),
    as_of: data.as_of ?? null,
    always: data.always === true,
    author: single(data.author) ?? (data.type === 'page' ? 'agent' : null),
    requires: data.requires ?? null,
    package: data.package ?? null,
    checked_with: data.checked_with ?? null,
    retired: data.retired ?? null,
    moved_from: typeof before === 'string' && before.trim() ? toKey(before) : null,
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

export const sentence = s => (/[.!?…]$/.test(s) ? s : `${s}.`);

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

function targetError(entry, namespaces) {
  const namespace = typeof entry === 'string' ? entryParts(entry).namespace : 'file';
  return namespace === 'file' || Object.hasOwn(namespaces, namespace)
    ? `bad glob in applies_to: ${entry}`
    : `applies_to names namespace ${namespace}, which vault.config.json doesn't declare under namespaces`;
}

const shownItem = x => (isMap(x) ? Object.entries(x).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', ')
  : typeof x === 'string' ? x : JSON.stringify(x));

export function notTextError(f, x) {
  const item = shownItem(x);
  const quoted = yamlQuote(item);
  const how = quoted[0] === '"' ? 'Double-quote' : 'Single-quote';
  return isMap(x) ? `${f} item ${item} reads as a key and value, not text. ${how} an item that holds ": ", as in ${quoted}`
    : `${f} item ${item} isn't text. ${how} it, as in ${quoted}`;
}

// YAML reads an unquoted `- TextSize: 1[0-9]` as a map, as Obsidian does, so a list item is checked for text before
// anything reads it.
function itemErrors(data) {
  return [...LIST_FIELDS, 'superseded_by'].flatMap(f => (Array.isArray(data[f]) ? data[f] : []).filter(x => typeof x !== 'string').map(x => notTextError(f, x)));
}

function listErrors(n) {
  const { namespaces } = config();
  const globs = n.applies_to ?? [];
  return [
    ...itemErrors(n.data),
    ...LIST_FIELDS.filter(f => n[f] === null).map(f => `${f} must be a list`),
    ...globs.filter(g => !validGlob(g, namespaces)).map(g => targetError(g, namespaces)),
    ...globListProblems(globs, namespaces),
    ...(n.tools ?? []).filter(x => !/^\S+$/.test(x)).map(x => `tools must name each tool exactly, with no spaces: ${x === '' ? '(empty)' : x}`),
    ...(n.triggers ?? []).map(t => regexError(t)).filter(Boolean),
  ];
}

export const hasChannel = n => n.always === true || ['applies_to', 'keywords', 'tools'].some(f => n[f]?.length);

const EVENTS = ['introduced', 'fixed', 'last_affected', 'limit'];
export const isMap = x => x !== null && typeof x === 'object' && !Array.isArray(x);
export const filled = x => typeof x === 'string' && x.trim() !== '';
const oneEvent = e => isMap(e) && Object.keys(e).length === 1 && EVENTS.includes(Object.keys(e)[0]) && filled(Object.values(e)[0]);

// The shape of OSV's affected entries (https://ossf.github.io/osv-schema/). Which ecosystems exist is the version
// readers' business, so the name isn't checked against any.
function requiresErrors(req) {
  if (req === null) return [];
  if (!Array.isArray(req) || !req.every(isMap)) return ['requires must be a list of { package, ranges } entries, as in OSV affected'];
  return req.flatMap((r, i) => {
    const at = `requires entry ${i + 1}`;
    const errs = [];
    if (!isMap(r.package) || !filled(r.package.ecosystem) || !filled(r.package.name)) errs.push(`${at}: package needs an ecosystem and a name`);
    if (!Array.isArray(r.ranges) || !r.ranges.length || !r.ranges.every(isMap)) return [...errs, `${at}: ranges must be a list of { type, events }`];
    for (const { type, events } of r.ranges) {
      if (!SCHEMES.includes(type)) errs.push(`${at}: a range type must be ${joinList(SCHEMES, 'or')}`);
      if (!Array.isArray(events) || !events.length || !events.every(oneEvent)) {
        errs.push(`${at}: each event is one of introduced, fixed, last_affected or limit, with a version`);
        continue;
      }
      if (type !== 'SEMVER') continue;
      for (const [[k, v]] of events.map(e => Object.entries(e))) if (!SEMVER.test(v) && !(k === 'introduced' && v === '0')) errs.push(`${at}: ${v} is not a semver version`);
    }
    return [...new Set(errs)];
  });
}

export const packageId = p => {
  const pkg = osvPackage(p);
  return pkg ? `${pkg.ecosystem}/${pkg.name}` : null;
};
export const PACKAGE_SHAPE = 'package must be an ecosystem and a name, as in OSV: package: { ecosystem: npm, name: <name> }';

// checked_with is read as delivery reads it, so a version the rule's ecosystem can't compare, which would leave the rule
// version unknown in every project, is an error.
function packageErrors(n) {
  const errs = [];
  const pkg = osvPackage(n.package);
  if (n.package !== null && !pkg) errs.push(PACKAGE_SHAPE);
  if (n.checked_with !== null && !filled(n.checked_with)) errs.push("checked_with must be the version the rule was checked with, in quotes, such as '1.4.0'");
  else if (n.checked_with !== null && n.package === null) errs.push('checked_with needs package, the library whose version it gives');
  else if (n.checked_with !== null && pkg) {
    const compare = compareFor(n.domain, pkg.ecosystem);
    if (compare === compareSemver && !SEMVER.test(n.checked_with)) errs.push(`checked_with must be a whole semver version, in quotes, such as '1.4.0', since ${pkg.ecosystem} versions are semver: ${n.checked_with} isn't one`);
    else if (compare && !comparable(compare, n.checked_with)) errs.push(`checked_with ${n.checked_with} isn't a version the ${pkg.ecosystem} reader can compare`);
  }
  return errs;
}

const alwaysErrors = n => (n.data.always != null && typeof n.data.always !== 'boolean' ? ['always must be true or false'] : []);

function checkNote(n) {
  const errs = n.clash ? [`${joinList(n.clash, 'and')} ${n.clash.length > 1 ? 'have' : 'has'} this note's name too. Rename one: each name is used once in a domain`] : [];
  if (!n.ok) return [...errs, 'no frontmatter'];
  errs.push(...n.parseErrors);
  if (!KEBAB.test(n.slug) || (n.domain && !KEBAB.test(n.domain))) errs.push('file and folder names must be lowercase-kebab-case');
  if (n.type !== 'rule' && n.type !== 'page') errs.push('type must be rule or page');
  if (n.domain && n.data.domain !== undefined && (typeof n.data.domain === 'string' ? nfc(n.data.domain) : n.data.domain) !== n.domain) errs.push(`domain is ${n.data.domain} but the note is in wiki/${n.domain}/`);
  if (n.data.domain === undefined) errs.push('no domain');
  if (n.type === 'page') {
    return [...errs, ...listErrors(n), ...alwaysErrors(n), ...(['user', 'agent'].includes(n.author) ? [] : ['author must be user or agent']), ...requiresErrors(n.requires)];
  }
  if (n.type !== 'rule') return errs;
  if (isVaultOnly(n.domain)) errs.push(`${n.domain} is vault-only, so it holds pages only. Put the rule in a domain that reaches projects, or in global`);
  if (!BASES[n.kind]) errs.push(`kind must be ${joinList(RULE_KINDS, 'or')}`);
  else if (!BASES[n.kind].includes(n.data.basis)) errs.push(wrongBasis(n.kind, n.data.basis));
  if (n.kind === 'knowledge') {
    if (!validDay(n.as_of)) errs.push('a knowledge rule needs as_of, the day it was last checked, as YYYY-MM-DD');
    else if (n.as_of > today()) errs.push(`as_of ${n.as_of} is in the future`);
    errs.push(...requiresErrors(n.requires), ...packageErrors(n));
  } else if (BASES[n.kind]) {
    if (n.as_of !== null) errs.push(`as_of is only for knowledge rules; ${n.kind} rules never expire`);
    if (n.requires !== null) errs.push(`requires is for knowledge rules and pages; a ${n.kind} rule holds whatever the version`);
    if (n.package !== null || n.checked_with !== null) errs.push(`package and checked_with are for knowledge rules; a ${n.kind} rule holds whatever the version`);
  }
  if (n.retired !== null && !validDay(n.retired)) errs.push('retired must be the day the rule was retired, as YYYY-MM-DD');
  if (n.data.retired_because !== undefined && !filled(n.data.retired_because)) errs.push('retired_because must say in one line why the rule was retired');
  if (n.data.moved_from !== undefined && (!n.moved_from || !KEY_RE.test(n.moved_from) || n.moved_from === n.key)) {
    errs.push('moved_from must name the key the rule had before its move, as <domain>/<slug>');
  }
  if (n.author !== null) errs.push('author is only for pages');
  if (!hasChannel(n)) errs.push('a rule needs keywords, applies_to, tools or always: true, or nothing brings it up');
  if (!n.do) errs.push('no **Do:** line');
  if (!n.not) errs.push('no **Not:** line');
  errs.push(...listErrors(n), ...alwaysErrors(n));
  const sup = n.data.superseded_by;
  const badItem = Array.isArray(sup) && sup.some(x => typeof x !== 'string');
  if (sup != null && typeof single(sup) !== 'string' && !badItem) errs.push('superseded_by must name one note');
  return errs;
}

const parsed = (_rel, text) => parse(text);
// The cache keeps what parsed() read, in cache.mjs's shape, so a change to either, or to frontmatter.mjs, makes it read
// every note again.
let parserStamp;
const stamp = () => (parserStamp ??= shortHash([
  ...['frontmatter.mjs', 'cache.mjs'].map(f => fs.readFileSync(path.join(import.meta.dirname, f), 'utf8')),
  String(parsed),
].join('\0')));

// The notes under wiki/<domain>/ for each domain given, or every note in wiki/. pre is noteStats() of the same domains.
export function loadNotes(domains, pre) {
  const notes = cachedNotes(domains ?? null, parsed, stamp(), pre)
    .map(e => ({ ...noteFrom(e.note, e.rel), saved: e.m, size: e.s, seen: e.seen, clean: e.clean, contentHash: e.h }));
  // A key names one note, so two notes in two folders of a domain with one name would each answer for the other.
  const rels = new Map();
  for (const n of notes) rels.set(n.key, [...(rels.get(n.key) ?? []), n.rel]);
  for (const n of notes) if (rels.get(n.key).length > 1) n.clash = rels.get(n.key).filter(r => r !== n.rel);
  const resolve = resolver(notes);
  for (const n of notes) if (n.superseded_by) n.superseded_by = resolve(n.superseded_by);
  return notes.sort((a, b) => cmp(a.key, b.key));
}

// loadNotes with every note stat'ed at once, which a hook awaits.
export const loadNotesAsync = async domains => loadNotes(domains, await noteStats(domains ?? null));

// The keys a note answers to: its own, and the one it had before a move.
export const noteKeys = n => (n.moved_from ? [n.key, n.moved_from] : [n.key]);

// Each key to its note, a note's own key before the old key of a moved one, and the first note sorted by key first.
export function notesByKey(notes) {
  const by = new Map();
  for (const n of notes) if (!by.has(n.key)) by.set(n.key, n);
  for (const n of notes) if (n.moved_from && !by.has(n.moved_from)) by.set(n.moved_from, n);
  return by;
}

// A key a note had before a move still finds it.
export function readNote(key, notes = loadNotes()) {
  const k = nfc(key);
  return KEY_RE.test(k) ? notesByKey(notes).get(k) ?? null : null;
}

export const knownDomain = d => d === 'global' || Object.hasOwn(config().domains, d);

// Why a note never reaches a session, or null when it does. A superseded note says so on its own.
export function undelivered(n) {
  if (n.depth < 2) return 'it is not in a domain folder, wiki/<domain>/';
  if (!knownDomain(n.domain)) return `${n.domain} isn't a domain in vault.config.json`;
  return noteErrors(n)[0] ?? null;
}

// A retired field that isn't a day is an error, which undelivered names, not a retirement.
export const isRetired = n => Boolean(n.superseded_by || validDay(n.retired));
export const isLive = n => n.type === 'rule' && !isRetired(n) && !undelivered(n);
export const isTopicPage = n => n.type === 'page' && n.kind === 'topic';
export const isSourcePage = n => n.type === 'page' && n.kind === 'source';
// The keys of the entity pages a synthesis page compares, as its compares field names them.
export const comparedKeys = (n, resolve) => (Array.isArray(n.data.compares) ? n.data.compares.filter(filled).map(x => resolve(keyOf(x))) : []);

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
      domain: n.domain, topic: n.topic, rel: n.rel, text,
      // Only the delivered wording counts, so an edit to a rule's evidence or globs doesn't deliver it again.
      hash: shortHash(text),
      kind: n.kind, always: n.always, applies_to: n.applies_to, triggers: n.triggers, keywords: n.keywords, tools: n.tools,
      requires: n.requires, package: n.package, checked_with: n.checked_with, contentHash: n.contentHash,
    };
  }
  return rules;
}

// Obsidian saves a note every few seconds while the user types, so a note waits rather than reach sessions half-written,
// until its text has held for settleSeconds or its file was last saved that long ago. A checkout or a sync gives every
// file a fresh mtime without changing its text, and committed text isn't half-typed, so a note git finds unchanged from
// HEAD is settled too; git is asked only about notes the other two tests leave waiting.
export function settledNotes(notes = loadNotes()) {
  const window = config().delivery.settleSeconds * 1000;
  const now = Date.now();
  const held = n => n.saved <= now - window || now - n.seen >= window;
  if (notes.some(n => n.clean === undefined && !held(n))) cleanFromGit(notes, stamp());
  return notes.filter(n => n.clean || held(n));
}

export const settledRules = (notes = loadNotes()) => liveRules(settledNotes(notes));

// The pages the hooks point sessions to, read from the notes as they are now.
export function livePages(notes = loadNotes()) {
  const pages = {};
  for (const n of notes) {
    if (n.type !== 'page' || n.superseded_by || !(n.keywords?.length || n.applies_to?.length) || undelivered(n)) continue;
    pages[n.key] = {
      rel: n.rel, domain: n.domain, kind: n.kind, summary: n.summary, keywords: n.keywords, applies_to: n.applies_to, triggers: n.triggers,
      requires: n.requires, contentHash: n.contentHash,
    };
  }
  return pages;
}

export const kindLabel = kind => (PAGE_KINDS.includes(kind) ? `${kind} page` : 'page');
// Where lint and a page change say a note of its type and kind goes, for a note kindFolder gives a folder.
export const kindPlace = (n, domain) => {
  const what = n.type === 'rule' ? 'rule' : kindLabel(n.kind);
  return `${/^[aeiou]/.test(what) ? 'an' : 'a'} ${what} goes in wiki/${domain}/${kindFolder(n)}/`;
};

// A bare line leaves out the summary, for the pages past what a refusal describes.
export const pageLine = (k, p, bare = false) => `- ${k} (${kindLabel(p.kind)}): ${p.summary && !bare ? `${clip(sentence(p.summary), 150)} ` : ''}${toPosix(vaultPath(...p.rel.split('/')))}${labelled(p)}`;

let corrupt = false;

// .state/derived.json, or null when it is missing. Refresh and build write it, and build rewrites a corrupt one, so a
// corrupt one reads as missing and is logged once, by name, rather than fail every hook until the user finds the file.
export function readDerived() {
  const file = statePath('derived.json');
  try {
    const got = readJson(file, null);
    if (got === null || isMap(got)) return got;
    throw new Error('not a JSON object');
  } catch (e) {
    if (!corrupt) logError(`.state/derived.json is corrupt, so it is read as empty until a build rewrites it`, e);
    corrupt = true;
    return null;
  }
}

// A note's unverified entry holds only while the note says what build read, so an edit to cite the new copy clears it at
// once and a save that leaves the text as it was keeps it.
export const unverifiedNow = (derived, n) => {
  const e = derived?.unverified?.[n.key];
  return isMap(e) && typeof e.contentHash === 'string' && e.contentHash === n.contentHash ? e : null;
};

// What a project's lockfiles and .state/derived.json say of the notes a hook matched, read only when a note asks.
// A missing derived.json means nothing is unverified, and readDerived reads a corrupt one as missing. A hook
// that delivers for several projects passes the first one's context as shared, so derived.json is read once. fallback
// is rootOutside's root for no hits, worked out from cwd when not given.
export function deliveryFor(hits, shared, cwd, fallback) {
  let versions;
  let derived;
  return {
    get versions() { return (versions ??= projectVersions(hits, cwd, fallback)); },
    get derived() { return shared ? shared.derived : (derived ??= readDerived() ?? {}); },
  };
}

// The notes a project gets, as [key, note] entries, { key, note } items or a map of notes by key: those its lockfile
// rules out are dropped, and the rest carry labels for a version the lockfile can't settle and for a source that changed
// since the note's copy. A label changes a rule's hash, which the markers hold, so a rule shown before is shown again.
// An unverified entry holds as unverifiedNow says, the same test review lists them by. ctx is deliveryFor's, which
// every caller passes, so none delivers without the labels.
export function deliverable(items, ctx) {
  const one = (key, note) => {
    checkDeadline();
    const fit = noteFit(note, () => ctx.versions);
    if (fit?.fit === 'mismatch') return null;
    const u = unverifiedNow(ctx.derived, { key, contentHash: note.contentHash });
    const labels = [
      ...(fit?.fit === 'unknown' ? ['version unknown'] : []),
      ...(u ? [validDay(u.since) ? `source changed on ${u.since}` : 'source changed'] : []),
    ];
    if (!fit && !labels.length) return note;
    const hash = labels.length ? { hash: shortHash(`${note.text ?? note.rel}\0${labels.join(' · ')}`) } : {};
    return { ...note, fit: fit?.fit ?? null, labels, ...hash };
  };
  if (!Array.isArray(items)) {
    return Object.fromEntries(Object.entries(items).flatMap(([k, n]) => { const x = one(k, n); return x ? [[k, x]] : []; }));
  }
  return items.flatMap(it => {
    const [key, note] = Array.isArray(it) ? it : [it.key, it.note];
    const x = one(key, note);
    return !x ? [] : Array.isArray(it) ? [[key, x]] : [{ ...it, note: x }];
  });
}

// An empty requires list requires nothing.
export const hasRequires = n => Array.isArray(n.requires) && n.requires.length > 0;

export const namesPackage = n => n.kind === 'knowledge' && Boolean(packageId(n.package));

// The rules whose version checked_with gives: a requires the user wrote wins over the checked_with propose filled. /lint
// offers to retire one once a project moves past it.
export const checkedWithOnly = n => namesPackage(n) && Boolean(n.checked_with) && !hasRequires(n);

// Null for a note neither gives.
export function noteFit(n, versions) {
  if (hasRequires(n)) return fitOf(n.requires, n.domain, versions());
  return checkedWithOnly(n) ? checkedFit(n.package, n.checked_with, n.domain, versions()) : null;
}

// The versions in the projects given that have moved past the one a rule was checked with.
export const pastVersions = (n, versions) => (checkedWithOnly(n) ? movedOnFrom(n.package, n.checked_with, n.domain, versions) : []);

// Within a rank, a note its project's version settles comes before one it can't.
export const byFit = (a, b) => Number(a?.fit === 'unknown') - Number(b?.fit === 'unknown');

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

export const maxChars = kind => (kind === 'knowledge' ? config().delivery.maxKnowledgeRuleChars : config().delivery.maxRuleChars);

// The labels deliverable gave a note, after its clipped text, so a cut never drops one.
const labelled = x => (x.labels ?? []).map(l => ` · ${l}`).join('');

export const ruleLine = (k, r) => `- ${k}: ${clip(r.text, maxChars(r.kind))}${labelled(r)}`;

// For a rule a refusal has no room to show in full: enough to tell whether to open the note.
export const rulePointer = (k, r) => `- ${k}: ${clip(r.text, 70)}${labelled(r)} ${toPosix(vaultPath(...r.rel.split('/')))}`;

const pointToIndex = max => list => `(Left out to stay within ${max} characters: ${list}. \`${toPosix(vaultPath('index.md'))}\` lists the rest.)`;

// Fits a hook's output to delivery.maxContextChars, since an agent may replace a longer one with a file path and a
// preview. Sections come in rank order; a plain string is one item. A section is { noun, items, head?, render? }: its
// text is `head` and the kept items on lines, or render(kept). Items are kept from the top while they fit; the first
// section that loses one ends the fill, and one line says what was left out: leftOut(list), which by default says that
// index.md lists the rest. `tail` is kept whatever the budget. `gap` sets the sections apart, a blank line by default.
// Returns the text and, for each section passed, how many of its items the text holds.
export function fitContext(sections, { max = config().delivery.maxContextChars, tail = '', gap = '\n\n', leftOut = pointToIndex(max) } = {}) {
  const all = sections.map(s => (typeof s === 'string' || !s ? { noun: 'note', items: s ? [s] : [] } : s));
  const join = parts => parts.filter(Boolean).join(gap);
  const body = (s, n) => (n ? (s.render ? s.render(s.items.slice(0, n)) : [s.head, ...s.items.slice(0, n)].filter(Boolean).join('\n')) : '');
  const overflow = kept => {
    const counts = new Map();
    all.forEach((s, i) => { if (s.items.length > kept[i]) counts.set(s.noun, (counts.get(s.noun) ?? 0) + s.items.length - kept[i]); });
    const left = [...counts].map(([noun, n]) => plural(n, noun));
    return left.length ? leftOut(joinList(left, 'and')) : '';
  };
  const render = kept => join([...all.map((s, i) => body(s, kept[i])), overflow(kept), tail]);
  const full = all.map(s => s.items.length);
  if (render(full).length <= max) return { text: render(full), kept: full };
  // The line's worst case, with every item left out, is reserved so it always fits.
  const reserve = join([overflow(all.map(() => 0)), tail]).length + gap.length;
  const kept = all.map(() => 0);
  let used = 0;
  for (let i = 0; i < all.length; i++) {
    const cost = n => (n ? body(all[i], n).length + (used ? gap.length : 0) : 0);
    let n = 0;
    while (n < all[i].items.length && used + cost(n + 1) + reserve <= max) n++;
    kept[i] = n;
    if (n < all[i].items.length) break;
    used += cost(n);
  }
  return { text: render(kept), kept };
}

export function domainOrder(domains) {
  const known = Object.keys(config().domains);
  const rank = d => (d === 'global' ? -1 : known.includes(d) ? known.indexOf(d) : known.length);
  return [...new Set(domains)].sort((a, b) => rank(a) - rank(b) || cmp(a, b));
}

export const domainTitle = d => (d === 'global' ? 'Every project' : config().domains[d]?.title ?? 'not in vault.config.json');

const isRule = line => line.startsWith('- ');
const alwaysEntries = rules => Object.entries(rules).filter(([, r]) => r.always).sort((a, b) => byFit(a[1], b[1]) || byKey(a, b));
export const alwaysIn = (rules, reaches) => alwaysEntries(rules).filter(([, r]) => reaches(r));

// The keys go in the order their rule lines do.
function alwaysLines(rules, reaches) {
  const entries = alwaysIn(rules, reaches);
  const lines = [];
  const keys = [];
  for (const d of domainOrder(entries.map(([, r]) => r.domain))) {
    const mine = entries.filter(([, r]) => r.domain === d);
    if (!mine.length) continue;
    lines.push('', `## ${d}`, ...mine.map(([k, r]) => ruleLine(k, r)));
    keys.push(...mine.map(([k]) => k));
  }
  return { lines, keys };
}

export function alwaysSize(rules, reaches) {
  const { lines } = alwaysLines(rules, reaches);
  if (!lines.length) return { lines: 0, bytes: 0 };
  const all = [...HEAD, ...lines];
  return { lines: all.length, bytes: Buffer.byteLength(all.join('\n')) };
}

// The always rules' block for a session start, and the rules it holds: rules that don't fit are left to active.md.
export function alwaysContext(reaches, rules = liveRules()) {
  const { lines, keys } = alwaysLines(rules, reaches);
  if (!lines.length) return { text: '', keys: [] };
  const { activeMaxLines, activeMaxBytes, maxContextChars } = config().delivery;
  const fits = xs => xs.length <= activeMaxLines && Buffer.byteLength(xs.join('\n')) <= Math.min(activeMaxBytes, maxContextChars);
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

// The topics a session start names, which a subagent hears too.
export function scopeTopics(scope, notes) {
  const all = domainTopics(notes);
  return [...new Set(scope.flatMap(d => all.get(d) ?? []))];
}

export function indexNote(topics) {
  if (!topics.length) return '';
  return [
    `Vault: \`${toPosix(vaultPath())}\` holds the user's preferences and notes, on ${joinList(topics, 'and')}. Before deciding something it would settle, read \`${toPosix(vaultPath('index.md'))}\` and the pages it lists, or call the vault's \`search\` tool.`,
    `File a useful answer that draws on the vault back as a page, as \`${toPosix(vaultPath('reference', 'notes.md'))}\` says under Pages.`,
  ].join(' ');
}

export function renderActive(rules) {
  const out = [
    '# Always-on rules',
    '',
    "Generated by tools/build.mjs from the notes in wiki/. Do not edit. Sessions load these at start: global rules in every session, the others in the sessions their domain reaches.",
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
export const linkTo = (key, rel = rulePath(key)) => `[[${rel.replace(/\.md$/i, '')}|${key.split('/').at(-1)}]]`;

// Obsidian writes a bare [[slug]] when no other note has that name, and the tools write a note's path from the vault
// root. A key, or a path through a folder of the domain the note isn't in, still names the note, and so does the key
// a note had before a move.
export function resolver(notes) {
  const bySlug = new Map();
  for (const n of notes) bySlug.set(n.slug, bySlug.has(n.slug) ? null : n.key);
  const byPath = new Map(notes.map(n => [toKey(n.rel), n.key]));
  const known = notesByKey(notes);
  const current = k => known.get(k)?.key ?? k;
  return k => byPath.get(k) ?? (k.includes('/') ? current(keyOf(k)) : bySlug.get(k) ?? k);
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
export const sectionLines = (n, title) => sectionNamed(n, title).split(/\r?\n/).slice(1);

const byUser = a => typeof a === 'string' && a.trim().toLowerCase() === 'user';
export const isUserPage = n => n.type === 'page' && byUser(n.author);
// Any note marked author: user, as the edit guard reads it; null for a note that doesn't exist yet.
export const wroteByUser = n => byUser(n?.author);
// The edit guard and lint --fix read the file as it is, so any note marked author: user counts, a malformed one too.
export const authoredByUser = text => byUser(single(parse(text).data.author));

export const AGENT_NOTES = /^## agent notes\s*$/i;
export const TOP_HEADING = /^#{1,2}(?:\s|$)/;

// Where `## Agent notes` starts and ends in a note's lines: the heading's index, and the index of the next `# ` or `## `
// heading or the end. A heading inside a code fence doesn't count.
export function agentNotesSpan(lines) {
  let fence = null;
  let at = -1;
  for (let i = 0; i < lines.length; i++) {
    const f = lines[i].match(/^ {0,3}(`{3,}|~{3,})/)?.[1];
    if (fence) {
      if (f && f[0] === fence[0] && f.length >= fence.length) fence = null;
    } else if (f) {
      fence = f;
    } else if (at < 0) {
      if (AGENT_NOTES.test(lines[i])) at = i;
    } else if (TOP_HEADING.test(lines[i])) {
      return { at, end: i };
    }
  }
  return at < 0 ? null : { at, end: lines.length };
}

// What the user wrote on a page of their own: the body without the agent's notes.
export function userWords(text) {
  const lines = parse(text).body.split('\n');
  const span = agentNotesSpan(lines);
  return (span ? [...lines.slice(0, span.at), ...lines.slice(span.end)] : lines).join('\n');
}

// An Evidence line is <day> · <kind> · session <id> · <what backs it>, the last part as propose.mjs's evidenceLine
// writes it for the kind. A stated line quoting a page of the user's has that page's path where the session goes.
// A line in another form comes back without a kind. id is the proposal's, the last in the brackets that end the line.
const EVIDENCE_KINDS = ['stated', 'correction', 'source', 'failure', 'choice', "agent's reading"];
const evidenceLines = n => [...sectionNamed(n, 'evidence').matchAll(/^- .*$/gm)].map(([line]) => {
  const m = line.match(/^- [^·]*· ([^·]*)· (?:session ([^\s·]+)|(wiki\/.+?\.md)(?= · |\s*$))(?: · (.*))?/);
  const cite = m?.[4] ?? '';
  return { line: line.trim(), day: line.match(/^- (\d{4}-\d\d-\d\d)\b/)?.[1], kind: m?.[1].trim(), session: m?.[2], note: m?.[3], cite, id: cite.match(/\((?:[^()]*; proposed as )?([^();\s]+)\)[ \t]*$/)?.[1] };
});

// The fit of each note for the projects given, for rankPair, or undefined when they hold no project root, so as_of
// decides. The lockfiles are read at the first note asked about, so a ranking that never asks reads none.
export function fitIn(hits, cwd) {
  const fallback = rootOutside(hits, cwd);
  if (!hits.some(h => typeof h.root === 'string') && !fallback) return undefined;
  let versions;
  return n => noteFit(n, () => (versions ??= projectVersions(hits, cwd, fallback)));
}

// The session prefixes the Evidence lines give, first seen first, leaving out the lines of the proposals in skip.
export const evidenceSessions = (n, skip) => [...new Set(evidenceLines(n).flatMap(e => (skip?.has(e.id) ? [] : e.session ?? [])))];
export const evidenceSources = n => evidenceLines(n).filter(e => e.kind === 'source').flatMap(e => e.cite.match(/^(.+?) · dated /)?.[1] ?? []);

const PREFERENCE_RANK = ['stated', 'pick', 'inferred', 'reading'];
const newestEvidence = n => evidenceLines(n).flatMap(e => e.day ?? []).sort().at(-1) ?? '';
// Each test, a note's value where higher wins and what to say when it decides, in the order AGENTS.md's Evidence
// section gives.
const RANKS = {
  taste: {
    tests: [
      [n => -PREFERENCE_RANK.indexOf(n.data.basis), (w, l) => `basis ${w.data.basis} over ${l.data.basis}`],
      [n => evidenceLines(n).length, (w, l) => `${plural(evidenceLines(w).length, 'Evidence line')} to ${evidenceLines(l).length}`],
      [newestEvidence, (w, l) => `evidence from ${newestEvidence(w)} over ${newestEvidence(l) || 'no date'}`],
    ],
    tie: 'same basis, Evidence count and newest Evidence date',
  },
  knowledge: { tests: [[n => n.as_of, (w, l) => `as_of ${w.as_of} over ${l.as_of}`]], tie: 'same as_of' },
};

// A note with no requires holds for any version, so it ranks with a match.
const FIT_RANK = { match: 2, none: 2, unknown: 1, mismatch: 0 };
const fitName = f => f?.fit ?? 'none';
const fitWins = f => ({ match: `version match (${f?.why})`, none: 'no version requirement', unknown: 'version unknown' })[fitName(f)];
const fitLoses = f => ({ unknown: 'version unknown', mismatch: 'mismatch' })[fitName(f)];

// Taste and practice rules are both the user's preferences, so they rank against each other.
const rankGroup = kind => (kind === 'knowledge' ? kind : 'taste');

// Which of two rules that may contradict to recommend first, or null for a preference and a knowledge rule, which
// aren't ranked against each other. fit gives a note's fit for the project the ranking is for; without it, versions
// tie and as_of decides.
export function rankPair(a, b, { fit } = {}) {
  const rank = rankGroup(a.kind) === rankGroup(b.kind) ? RANKS[rankGroup(a.kind)] : null;
  if (!rank) return null;
  const tests = a.kind === 'knowledge' && fit ? [[n => FIT_RANK[fitName(fit(n))], (w, l) => `${fitWins(fit(w))} over ${fitLoses(fit(l))}`], ...rank.tests] : rank.tests;
  for (const [value, why] of tests) {
    const [x, y] = [value(a), value(b)];
    if (x !== y) return x > y ? { first: a, last: b, why: why(a, b) } : { first: b, last: a, why: why(b, a) };
  }
  return { first: null, why: rank.tie };
}

// The quotes of the user's words, of sources and of recorded rows, with what each is checked against. A line from a
// row, whose id comes before the proposal's, quotes the row rather than the session; any other line gives the
// proposal's id, whose inbox row holds the quote. A line lint can't read comes back as the line alone.
export const evidenceQuotes = n => evidenceLines(n).flatMap(({ line, kind, session, note, cite }) => {
  if (!EVIDENCE_KINDS.includes(kind) || (note && kind !== 'stated')) return [{ line }];
  if (!['stated', 'correction', 'source'].includes(kind)) return [];
  const m = cite.match(/^(?:(.+?) · dated [^·]* · )?["“](.*)["”](?: \(([^()]*)\))?[ \t]*$/);
  if (!m || (kind === 'source') !== (m[1] !== undefined)) return [{ line }];
  const [, source, quote, ids = ''] = m;
  if (!ids.includes(';')) return [{ session, note, source, quote, id: ids || undefined }];
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

// Each edit parses the text it's given afresh, so the edits to one file apply one after another, and an edit for a link
// another one already rewrote finds nothing left to change.
export function editBody(text, rel, edits) {
  const n = parseNote(text, rel);
  const at = text.length - n.body.length;
  return edits(n).sort((a, b) => b.at - a.at)
    .reduce((t, e) => `${t.slice(0, at + e.at)}${e.text}${t.slice(at + e.at + e.length)}`, text);
}

// Rewrites the links whose target picks gives to name note. A link keeps its heading and alias. One with no alias gets
// the note's name, escaped in a table row as Obsidian escapes it.
export function relink(rel, picks, note) {
  const to = note.rel.replace(/\.md$/i, '');
  return text => editBody(text, rel, n => noteLinkSpans(n).filter(s => picks(s.target)).map(s => {
    if (!s.wiki) return { at: s.at, length: s.raw.length, text: note.rel };
    const row = /^\s*\|/.test(n.body.slice(n.body.lastIndexOf('\n', s.at) + 1, s.at));
    const alias = /\\?\|/.test(s.rest) ? '' : `${row ? '\\|' : '|'}${note.slug}`;
    return { at: s.at, length: s.raw.length + s.rest.length, text: `${to}${s.rest}${alias}` };
  }));
}

// A footnote's target is a file under raw/ or a URL, in backticks or not, then ` · ` and its date when it has one.
// It may end in a #locator, which fragment holds without the #, or null when the target has none.
// Definitions are read with inline code kept, so a target in backticks survives. A citation may sit before a colon,
// so only a definition's own [^id]: at the start of its line is left out of the citations.
export function footnotes(n) {
  const defs = [...proseBody(n).matchAll(/^\[\^([^\]\s]+)\]:[ \t]*(.*)$/gm)].map(m => {
    const raw = m[2].split(' · ')[0].trim();
    const target = raw.replace(/^`([^`]*)`$/, '$1');
    const hash = target.indexOf('#');
    return {
      id: m[1], target, raw, at: m.index + m[0].length - m[2].length,
      base: hash < 0 ? target : target.slice(0, hash), fragment: hash < 0 ? null : target.slice(hash + 1),
    };
  });
  const cited = new Set([...unquoted(n).replace(/^\[\^[^\]\s]+\]:/gm, '').matchAll(/\[\^([^\]\s]+)\]/g)].map(m => m[1]));
  return { defs, cited };
}

// A file whose name holds a # is taken whole, so only a target that names no such file is split at it. A caller that
// locates many footnotes passes a memo of rawFile, since each lookup costs a realpath.
export const locate = (d, fileOf = rawFile) => (isUrl(d.target) || !fileOf(d.target) ? { base: d.base, fragment: d.fragment } : { base: d.target, fragment: null });

const isFileAt = (...xs) => fs.statSync(vaultPath(...xs), { throwIfNoEntry: false })?.isFile() ?? false;

// A folder under raw/refs/ holding a manifest such as llms.txt and no source.md is a doc set: one source, whose pages
// each have their own url and copies.
export const manifestNames = () => [].concat(config().docSets?.manifests ?? []).filter(m => filled(m) && !/[\\/]/.test(m));
// The names in a folder, read once per folder for one caller. stat ignores case on Windows and macOS, and a manifest
// counts only under the name the config gives it, as isManifest in sources.mjs reads it.
export const folderNames = () => memo(dir => {
  try { return new Set(fs.readdirSync(vaultPath(...dir.split('/')))); } catch { return new Set(); }
});
const hasManifest = (dir, names) => manifestNames().some(m => isFileAt(...dir.split('/'), m) && names(dir).has(m));
export const isDocSet = (folder, names = folderNames()) => !isFileAt(...folder.split('/'), 'source.md') && hasManifest(folder, names);

// A folder under raw/refs/ holding a source.md is one source, a bundle, and so is a doc set; so is the outermost such
// folder around a path in it. The path may be a file, the folder, or the folder with a slash or a different case; the
// folder comes back as the disk spells it, or null when the path is in no bundle or doc set.
export function bundleOf(ref, names = folderNames()) {
  if (typeof ref !== 'string' || !ref) return null;
  const at = diskRel(ref);
  const parts = at?.rel.split('/');
  if (parts?.[0] !== 'raw' || parts[1] !== 'refs') return null;
  const dirs = at.stat.isDirectory() ? parts : parts.slice(0, -1);
  return bundleAbove(dirs.join('/'), names);
}

// The outermost bundle or doc set at or above a folder under raw/refs/ spelled as the disk spells it, or null.
export function bundleAbove(folder, names = folderNames()) {
  const dirs = folder.split('/');
  for (let i = 3; i <= dirs.length; i++) {
    const dir = dirs.slice(0, i).join('/');
    if (isFileAt(dir, 'source.md') || hasManifest(dir, names)) return dir;
  }
  return null;
}

// A source as one item: the bundle a path is in, else the file under raw/.
export function sourceItem(ref) {
  const file = rawFile(ref);
  const bundle = bundleOf(file ?? ref);
  return { file, bundle, rel: bundle ?? file };
}

export const sourceOf = s => (typeof s.data.source === 'string' ? s.data.source : s.key);

// /ingest saves a web page as a file whose frontmatter gives its url, and saves it again when it changes. A file that
// can't be read gives none.
export function savedUrl(rel) {
  const url = rel.endsWith('.md') ? parsedFile(rel)?.data.url : null;
  return isUrl(url) ? url : null;
}

// One web page however a note spells it: without its #fragment or a trailing slash, and with its host in lowercase.
export function normUrl(u) {
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
  // Pages cite the same few files over and over, and each lookup asks the disk.
  const urls = new Map();
  const idOf = memo(ref => {
    const { bundle, rel } = isUrl(ref) ? {} : sourceItem(ref);
    if (rel && !urls.has(rel)) urls.set(rel, savedUrl(bundle ? `${bundle}/source.md` : rel));
    const url = rel ? urls.get(rel) : isUrl(ref) ? ref : null;
    return url ? normUrl(url) : rel ?? ref;
  });
  const defIds = new Map();
  const defId = d => {
    if (!defIds.has(d.target)) defIds.set(d.target, idOf(locate(d).base));
    return defIds.get(d.target);
  };
  const idAt = new Map(notes.filter(isSourcePage).map(n => [n.key, idOf(sourceOf(n))]));
  return n => {
    const cited = new Set(footnotes(n).defs.flatMap(d => (d.target ? [defId(d)] : [])));
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
  const why = isRetired(n) ? null : undelivered(n);
  const ended = [...(validDay(n.retired) ? [`retired on ${n.retired}`] : []), ...(n.superseded_by ? [`superseded by ${link(n.superseded_by)}`] : [])];
  const gone = ended.length ? ` · ${ended.join(' · ')}` : why ? ` · not delivered: ${why}` : '';
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
