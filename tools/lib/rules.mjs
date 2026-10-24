import fs from 'node:fs';
import path from 'node:path';
import { parse } from './frontmatter.mjs';
import { validGlob } from './glob.mjs';
import { config, vaultPath, readJson, writeJson, writeText, shortHash, toPosix, today } from './vault.mjs';

export const LIST_FIELDS = ['applies_to', 'triggers', 'keywords', 'replaces'];
export const KEY_RE = /^[a-z0-9-]+\/[a-z0-9-]+$/;
export const BASES = { taste: ['stated', 'inferred', 'pick'], knowledge: ['stated', 'failure', 'source'] };
export const wrongBasis = (kind, basis) => (kind === 'knowledge' ? "a knowledge rule's basis must be stated, failure or source"
  : BASES.knowledge.includes(basis) ? `basis ${basis} is for knowledge rules; set kind: knowledge` : 'basis must be stated, inferred or pick');
export const isUrl = s => typeof s === 'string' && /^https?:\/\/\S+$/i.test(s);
export const validDay = s => typeof s === 'string' && /^\d{4}-\d\d-\d\d$/.test(s) && !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().startsWith(s);
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HEAD = [
  '# Taste rules (confirmed by the user)',
  "Follow these unless the user's current request or the project's own instructions say otherwise. If an edit is refused with taste rules, apply them and retry the edit.",
];

export const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
export const byKey = ([a], [b]) => cmp(a, b);

export function toKey(ref) {
  let s = String(ref).trim().replace(/^`+|`+$/g, '').trim().replace(/\.+$/, '');
  const link = s.match(/^\[\[([^\]|#]+)[^\]]*\]\]$/);
  if (link) s = link[1];
  return s.trim().replace(/\\/g, '/').replace(/^\.?\/?wiki\//i, '').replace(/\.md$/i, '').toLowerCase();
}

export function tryRegex(source) {
  try { return new RegExp(source); } catch { return null; }
}

export const escapeRegExp = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const mentions = (word, text) => new RegExp(`(?<!\\w)${escapeRegExp(word)}(?!\\w)`, 'i').test(text);

const asList = v => (v === null || v === undefined ? [] : Array.isArray(v) ? v.map(String) : null);

function field(lead, name) {
  const m = lead.match(new RegExp(`^[ \\t]*(?:\\*\\*)?${name}(?::\\*\\*|\\*\\*:|:)[ \\t]*(.*)$`, 'm'));
  return m ? m[1].trim() : '';
}

export function parseNote(text, rel) {
  const { data, body, ok } = parse(text);
  const parts = rel.replace(/^wiki\//i, '').replace(/\.md$/i, '').split('/');
  const lead = body.split(/^## /m)[0];
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
    status: data.status,
    kind: data.kind ?? 'taste',
    as_of: data.as_of ?? null,
    always: data.always === true,
    do: field(lead, 'Do'),
    not: field(lead, 'Not'),
    because: field(lead, 'Because'),
  };
  for (const f of LIST_FIELDS) note[f] = asList(data[f]);
  if (note.replaces) note.replaces = note.replaces.map(toKey);
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

// Knowledge fields join the hash only for knowledge rules, so taste rules keep the hashes they were confirmed with.
export const noteHash = n => shortHash(JSON.stringify({
  domain: n.domain, do: n.do, not: n.not, because: n.because,
  applies_to: n.applies_to ?? [], triggers: n.triggers ?? [], keywords: n.keywords ?? [], always: n.always,
  ...(n.kind === 'knowledge' ? { kind: n.kind, as_of: n.as_of } : {}),
}));

export function noteErrors(n) {
  if (!n.ok) return ['no frontmatter'];
  const errs = [];
  if (!KEBAB.test(n.slug) || (n.domain && !KEBAB.test(n.domain))) errs.push('file and folder names must be lowercase-kebab-case');
  if (n.type !== 'rule' && n.type !== 'page') errs.push('type must be rule or page');
  if (n.domain && n.data.domain !== undefined && n.data.domain !== n.domain) errs.push(`domain is ${n.data.domain} but the note is in wiki/${n.domain}/`);
  if (n.data.domain === undefined) errs.push('no domain');
  if (n.type !== 'rule') return errs;
  if (!['provisional', 'confirmed', 'outdated'].includes(n.status)) errs.push('status must be provisional, confirmed or outdated');
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
  return errs;
}

// A domain rule reaches only its domain's sessions, so it can't stand in for a rule that reaches others.
export function replaceProblem(n, t) {
  const d = t.split('/')[0];
  if (n.domain === 'global' || d === n.domain) return null;
  return `a ${n.domain} rule can't replace ${t}, which ${d === 'global' ? 'applies in every project' : `is a ${d} rule`}`;
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
      else if (e.isFile() && /\.md$/i.test(e.name)) notes.push(parseNote(fs.readFileSync(full, 'utf8'), `wiki/${path.relative(root, full).replace(/\\/g, '/')}`));
    }
  };
  walk(root);
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

export function readLedger() {
  const l = readJson(vaultPath('confirmed.json'), {});
  return { version: 1, ...l, rules: l.rules ?? {}, retired: l.retired ?? {} };
}

export const writeLedger = ledger => writeJson(vaultPath('confirmed.json'), ledger);

export function domainOrder(domains) {
  const known = Object.keys(config().domains);
  const rank = d => (d === 'global' ? -1 : known.includes(d) ? known.indexOf(d) : known.length);
  return [...new Set(domains)].sort((a, b) => rank(a) - rank(b) || cmp(a, b));
}

export const domainTitle = d => (d === 'global' ? 'Every project' : config().domains[d]?.title ?? 'not in taste.config.json');

const isRule = line => line.startsWith('- ');
const alwaysEntries = ledger => Object.entries(ledger.rules).filter(([, r]) => r.always).sort(byKey);

function alwaysLines(ledger, domains) {
  const { maxRuleChars } = config().delivery;
  const entries = alwaysEntries(ledger);
  const lines = [];
  const keys = [];
  for (const d of domainOrder(domains)) {
    const mine = entries.filter(([, r]) => r.domain === d);
    if (!mine.length) continue;
    lines.push('', `## ${d}`, ...mine.map(([k, r]) => `- ${k}: ${clip(r.text, maxRuleChars)}`));
    keys.push(...mine.map(([k]) => k));
  }
  return { lines, keys };
}

export function alwaysSize(ledger, domains) {
  const { lines } = alwaysLines(ledger, domains);
  if (!lines.length) return { lines: 0, bytes: 0 };
  const all = [...HEAD, ...lines];
  return { lines: all.length, bytes: Buffer.byteLength(all.join('\n')) };
}

export function alwaysContext(domains, ledger = readLedger()) {
  const { lines, keys } = alwaysLines(ledger, domains);
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
  return { text: [...out, ...tail(shown)].join('\n'), keys: keys.slice(0, shown) };
}

export function renderActive(ledger) {
  const { maxRuleChars } = config().delivery;
  const out = [
    '# Always-on rules',
    '',
    "Generated by tools/build.mjs from confirmed.json. Do not edit. Sessions load these at start: global rules in every project, the others in their domain's projects.",
  ];
  const entries = alwaysEntries(ledger);
  if (!entries.length) out.push('', 'None confirmed yet.');
  for (const d of domainOrder(entries.map(([, r]) => r.domain))) {
    out.push('', `## ${d} · ${domainTitle(d)}`, '', ...entries.filter(([, r]) => r.domain === d).map(([k, r]) => `- ${k}: ${clip(r.text, maxRuleChars)}`));
  }
  return `${out.join('\n')}\n`;
}

export const linkTo = key => `[[wiki/${key}|${key.split('/').at(-1)}]]`;

// An unclosed fence runs to the end of the note.
const FENCES = /^ {0,3}(`{3,}|~{3,})[\s\S]*?(?:^ {0,3}\1[^\n]*$|(?![\s\S]))/gm;

function linksUnder(n, heading) {
  const part = n.body.replace(FENCES, '').split(/^## /m).slice(1).find(s => s.split(/\r?\n/)[0].trim() === heading) ?? '';
  return [...part.matchAll(/\[\[[^\]]*\]\]/g)].map(m => toKey(m[0]));
}

// /ingest links a page and its rules both ways, but a link added by hand in Obsidian may be on one side only,
// and Obsidian writes a bare [[slug]] when no other note has that name.
function refPages(notes) {
  const pages = new Set(notes.filter(n => n.type === 'page').map(n => n.key));
  const bySlug = new Map();
  for (const n of notes) bySlug.set(n.slug, bySlug.has(n.slug) ? null : n.key);
  const resolve = k => (k.includes('/') ? k : bySlug.get(k) ?? k);
  const refs = new Map();
  const add = (rule, page) => refs.set(rule, (refs.get(rule) ?? new Set()).add(page));
  for (const n of notes) {
    if (n.type === 'page') for (const k of linksUnder(n, 'Rules')) add(resolve(k), n.key);
    else if (n.type === 'rule') for (const k of linksUnder(n, 'Examples').map(resolve)) if (pages.has(k)) add(n.key, k);
  }
  return refs;
}

function indexLine(n, ledger, refs) {
  const link = linkTo(n.key);
  if (n.type === 'page') return `- ${link} · page`;
  const entry = ledger.rules[n.key];
  const changed = entry && entry.hash !== noteHash(n) ? ' · changed since confirmed' : '';
  const kind = n.kind === 'knowledge' ? ` · knowledge as of ${n.as_of ?? '(no date)'}` : '';
  const from = [...(refs.get(n.key) ?? [])].sort(cmp);
  return `- ${link} · ${n.status ?? 'no status'}${changed}${kind} · Do: ${clip(n.do || '(missing)', 100)}${from.length ? ` · from ${from.map(linkTo).join(', ')}` : ''}`;
}

export function renderIndex(notes, ledger) {
  const { domains } = config();
  const refs = refPages(notes);
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
      out.push('', `### ${g}`, '', ...groups.get(g).map(n => indexLine(n, ledger, refs)));
    }
  }
  return `${out.join('\n')}\n`;
}

export function build({ check = false } = {}) {
  const ledger = readLedger();
  const files = { 'active.md': renderActive(ledger), 'index.md': renderIndex(loadNotes(), ledger) };
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
