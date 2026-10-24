import fs from 'node:fs';
import path from 'node:path';
import { parse } from './frontmatter.mjs';
import { validGlob } from './glob.mjs';
import { config, vaultPath, writeText, shortHash, toPosix, today } from './vault.mjs';

export const LIST_FIELDS = ['applies_to', 'triggers', 'keywords'];
export const KEY_RE = /^[a-z0-9-]+\/[a-z0-9-]+$/;
export const BASES = { taste: ['stated', 'inferred', 'pick'], knowledge: ['stated', 'failure', 'source'] };
export const wrongBasis = (kind, basis) => (kind === 'knowledge' ? "a knowledge rule's basis must be stated, failure or source"
  : BASES.knowledge.includes(basis) ? `basis ${basis} is for knowledge rules; set kind: knowledge` : 'basis must be stated, inferred or pick');
export const isUrl = s => typeof s === 'string' && /^https?:\/\/\S+$/i.test(s);
export const validDay = s => typeof s === 'string' && /^\d{4}-\d\d-\d\d$/.test(s) && !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().startsWith(s);
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
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

export function noteErrors(n) {
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
  if (!knownDomain(n.domain)) return `${n.domain} isn't a domain in taste.config.json`;
  return noteErrors(n)[0] ?? null;
}

const isLive = n => n.type === 'rule' && !n.superseded_by && !undelivered(n);

// The rules in the vault, read from the notes as they are now.
export function liveRules(notes = loadNotes()) {
  const rules = {};
  for (const n of notes.filter(isLive)) {
    const text = ruleText(n);
    rules[n.key] = {
      domain: n.domain, topic: String(n.data.topic ?? '').trim().toLowerCase(), text,
      // Only the delivered wording counts, so an edit to a rule's evidence or globs doesn't deliver it again.
      hash: shortHash(text),
      always: n.always, applies_to: n.applies_to, triggers: n.triggers, keywords: n.keywords,
    };
  }
  return rules;
}

// The rules the hooks deliver. Obsidian saves a note every few seconds while the user types,
// so a note saved in the last settleSeconds waits rather than reach sessions half-written.
export function settledRules(notes = loadNotes()) {
  const since = Date.now() - config().delivery.settleSeconds * 1000;
  return liveRules(notes.filter(n => n.saved <= since));
}

export const ruleLine = (k, r) => `- ${k}: ${clip(r.text, config().delivery.maxRuleChars)}`;

export function domainOrder(domains) {
  const known = Object.keys(config().domains);
  const rank = d => (d === 'global' ? -1 : known.includes(d) ? known.indexOf(d) : known.length);
  return [...new Set(domains)].sort((a, b) => rank(a) - rank(b) || cmp(a, b));
}

export const domainTitle = d => (d === 'global' ? 'Every project' : config().domains[d]?.title ?? 'not in taste.config.json');

const isRule = line => line.startsWith('- ');
const alwaysEntries = rules => Object.entries(rules).filter(([, r]) => r.always).sort(byKey);
export const alwaysIn = (rules, scope) => alwaysEntries(rules).filter(([, r]) => scope.includes(r.domain));

function alwaysLines(rules, domains) {
  const entries = alwaysIn(rules, domains);
  const lines = [];
  for (const d of domainOrder(domains)) {
    const mine = entries.filter(([, r]) => r.domain === d);
    if (mine.length) lines.push('', `## ${d}`, ...mine.map(([k, r]) => ruleLine(k, r)));
  }
  return lines;
}

export function alwaysSize(rules, domains) {
  const lines = alwaysLines(rules, domains);
  if (!lines.length) return { lines: 0, bytes: 0 };
  const all = [...HEAD, ...lines];
  return { lines: all.length, bytes: Buffer.byteLength(all.join('\n')) };
}

export function alwaysContext(domains, rules = liveRules()) {
  const lines = alwaysLines(rules, domains);
  if (!lines.length) return '';
  const { activeMaxLines, activeMaxBytes } = config().delivery;
  const fits = xs => xs.length <= activeMaxLines && Buffer.byteLength(xs.join('\n')) <= activeMaxBytes;
  if (fits([...HEAD, ...lines])) return [...HEAD, ...lines].join('\n');
  const total = lines.filter(isRule).length;
  const tail = shown => ['', `(${total - shown} more didn't fit. See ${toPosix(vaultPath('active.md'))}.)`];
  const out = [...HEAD];
  let shown = 0;
  for (const line of lines) {
    const next = shown + (isRule(line) ? 1 : 0);
    if (!fits([...out, line, ...tail(next)])) break;
    out.push(line);
    shown = next;
  }
  while (out.length > HEAD.length && !isRule(out.at(-1))) out.pop();
  return [...out, ...tail(shown)].join('\n');
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
function resolver(notes) {
  const bySlug = new Map();
  for (const n of notes) bySlug.set(n.slug, bySlug.has(n.slug) ? null : n.key);
  return k => (k.includes('/') ? k : bySlug.get(k) ?? k);
}

// An unclosed fence runs to the end of the note.
const FENCES = /^ {0,3}(`{3,}|~{3,})[\s\S]*?(?:^ {0,3}\1[^\n]*$|(?![\s\S]))/gm;

function linksUnder(n, heading) {
  const part = n.body.replace(FENCES, '').split(/^## /m).slice(1).find(s => s.split(/\r?\n/)[0].trim() === heading) ?? '';
  return [...part.matchAll(/\[\[[^\]]*\]\]/g)].map(m => toKey(m[0]));
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
  if (n.type === 'page') return `- ${link} · page`;
  const why = n.superseded_by ? null : undelivered(n);
  const gone = n.superseded_by ? ` · superseded by ${linkTo(n.superseded_by)}` : why ? ` · not delivered: ${why}` : '';
  const kind = n.kind === 'knowledge' ? ` · knowledge as of ${n.as_of ?? '(no date)'}` : '';
  const from = [...(refs.get(n.key) ?? [])].sort(cmp);
  return `- ${link}${gone}${kind} · Do: ${clip(n.do || '(missing)', 100)}${from.length ? ` · from ${from.map(linkTo).join(', ')}` : ''}`;
}

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
    const topics = domains[d]?.topics ?? [];
    const groups = new Map();
    for (const n of mine) {
      const g = n.type === 'page' ? 'pages' : (typeof n.data.topic === 'string' && n.data.topic) || 'no topic';
      groups.set(g, [...(groups.get(g) ?? []), n]);
    }
    const rank = g => (topics.includes(g) ? topics.indexOf(g) : topics.length);
    for (const g of [...groups.keys()].sort((a, b) => rank(a) - rank(b) || cmp(a, b))) {
      out.push('', `### ${g}`, '', ...groups.get(g).map(n => indexLine(n, refs)));
    }
  }
  return `${out.join('\n')}\n`;
}

export function build({ check = false, notes = loadNotes() } = {}) {
  const files = { 'active.md': renderActive(liveRules(notes)), 'index.md': renderIndex(notes) };
  const stale = [];
  for (const [name, text] of Object.entries(files)) {
    let current = '';
    try { current = fs.readFileSync(vaultPath(name), 'utf8').replace(/\r\n/g, '\n'); } catch {}
    if (current === text) continue;
    stale.push(name);
    if (!check) writeText(vaultPath(name), text);
  }
  return stale;
}
