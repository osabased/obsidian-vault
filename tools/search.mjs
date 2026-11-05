import { parseArgs } from 'node:util';
import { vaultPath, toPosix, filesIn } from './lib/vault.mjs';
import { loadNotes, undelivered, isRetired, kindLabel, normTopic, clip, cmp, PAGE_KINDS } from './lib/rules.mjs';
import { parse } from './lib/frontmatter.mjs';
import { sourceTexts } from './lib/quotes.mjs';
import { UsageError, failure, readInput, schemaOf, schemaArg } from './lib/input.mjs';

const KINDS = ['rule', 'taste', 'knowledge', 'page', ...PAGE_KINDS];
const USAGE = `usage: node tools/search.mjs "<words>" [--domain <domain>] [--kind <kind>] [--topic <topic>] [--raw] [--limit <n>]
       node tools/search.mjs --help explains the ranking and the options`;
const HELP = `${USAGE.split('\n')[0]}

Ranks the notes in wiki/ by the words, best match first. A word counts most in a note's name and keywords, then in
its summary, topic and Do, Not and Because lines, then in its body, so a page's keywords work as its synonyms: give it
the words a search for it would use that its text doesn't. Case, accents and plural endings don't count, and common
words such as "the" and "with" match nothing.

  --domain <domain>  only notes in that domain
  --kind <kind>      only rules (rule, or taste or knowledge for one kind) or pages (page, or topic, concept, entity,
                     synthesis or source for one kind)
  --topic <topic>    only notes on that topic
  --raw              the files under raw/refs/ too, which --domain, --kind and --topic leave out
  --limit <n>        at most n results, 10 by default

Superseded rules are left out. A note the hooks don't deliver says why.`;

const FIELDS = [
  { name: 'words', type: 'string', required: true, help: ['the words to look for'] },
  { name: 'domain', type: 'string', help: ['only notes in that domain'] },
  { name: 'kind', type: 'string', enum: KINDS, help: ['only rules (rule, taste or knowledge) or pages (page, topic, concept, entity, synthesis or source)'] },
  { name: 'topic', type: 'string', help: ['only notes on that topic'] },
  { name: 'raw', type: 'boolean', help: ['true to search the files under raw/refs/ too, which domain, kind and topic leave out'] },
  { name: 'limit', type: 'number', help: ['at most this many results, 10 by default'] },
];
const SUMMARY = "Ranks the vault's notes by the words, best match first, with each one's path and the line that matched. Words in a note's name and keywords count most; plural endings and common words don't count.";

// The argv form's options, so both forms go through search() alike.
function optionsOf(p) {
  const extra = Object.keys(p).find(k => !FIELDS.some(f => f.name === k));
  if (extra) throw new UsageError(`${extra} isn't a field.`);
  const text = k => (p[k] === undefined || typeof p[k] === 'string' ? p[k] : (() => { throw new UsageError(`${k} must be a string.`); })());
  if (typeof p.words !== 'string') throw new UsageError('words must be a string.');
  if (p.raw !== undefined && typeof p.raw !== 'boolean') throw new UsageError('raw must be true or false.');
  if (p.limit !== undefined && typeof p.limit !== 'number') throw new UsageError('limit must be a number.');
  return { words: p.words.trim(), o: { domain: text('domain'), kind: text('kind'), topic: text('topic'), raw: p.raw, limit: p.limit === undefined ? undefined : String(p.limit) } };
}

const STOP = new Set('an and are as at be but by can do does for from has have how in is it its not of on or so than that the then there these they this to was we were what when which who why will with you your'.split(' '));
// Roughly singular, so "buttons" finds "button" and "entries" finds "entry". Both sides fold alike, so a word folded
// wrongly still finds itself.
const stem = w => (w.length > 4 && w.endsWith('ies') ? `${w.slice(0, -3)}y` : w.length > 3 && /[^isu]s$/.test(w) ? w.slice(0, -1) : w);
const words = s => (String(s ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])
  .filter(w => !STOP.has(w)).map(stem);

// BM25 with each field's words counted by its weight, so a word in a note's name weighs as three in its body.
const K1 = 1.2;
const B = 0.75;
function bag(fields) {
  const tf = new Map();
  let len = 0;
  for (const [weight, text] of fields) {
    const ws = words(text);
    for (const w of ws) tf.set(w, (tf.get(w) ?? 0) + weight);
    len += weight * ws.length;
  }
  return { tf, len };
}

function rank(docs, terms) {
  const avg = docs.reduce((s, d) => s + d.len, 0) / docs.length || 1;
  const idf = new Map(terms.map(t => {
    const df = docs.filter(d => d.tf.has(t)).length;
    return [t, Math.log(1 + (docs.length - df + 0.5) / (df + 0.5))];
  }));
  const score = d => terms.reduce((s, t) => {
    const f = d.tf.get(t) ?? 0;
    return s + (f && (idf.get(t) * f * (K1 + 1)) / (f + K1 * (1 - B + (B * d.len) / avg)));
  }, 0);
  return docs.map(d => ({ ...d, score: score(d) })).filter(d => d.score > 0).sort((a, b) => b.score - a.score || cmp(a.key, b.key));
}

const label = n => (n.type === 'rule' ? (n.kind === 'knowledge' ? 'knowledge rule' : 'rule') : n.type === 'page' ? kindLabel(n.kind) : 'note');

// A rule's lead is its Do, Not and Because lines, which count in their own field, so its body counts from its first
// section.
const noteDoc = n => ({
  key: n.key, rel: n.rel, body: n.body, topic: n.topic, label: label(n), why: undelivered(n),
  line: n.type === 'rule' ? (n.do ? `Do: ${clip(n.do, 150)}` : '') : clip(n.summary, 150),
  ...bag([
    [3, [n.slug.replace(/-/g, ' '), ...(n.keywords ?? [])].join(' ')], [2, [n.summary, n.topic, n.do, n.not, n.because].join(' ')],
    [1, n.type === 'rule' ? n.body.split(/^## /m).slice(1).join('\n') : n.body],
  ]),
});

// A page a browser saved whole keeps the files it shows in <name>_files/, which are part of that one source.
function rawDocs() {
  return filesIn(vaultPath('raw', 'refs')).filter(f => !f.split('/').slice(0, -1).some(d => d.endsWith('_files'))).flatMap(f => {
    const rel = `raw/refs/${f}`;
    let texts;
    try { texts = sourceTexts(rel); } catch { return []; }
    if (!texts) return [];
    const { body } = parse(texts[0]);
    return [{ key: rel, rel, body, topic: '', label: 'raw file', why: null, line: '', ...bag([[3, f.replace(/\.[^./]+$/, '').replace(/[-_/]/g, ' ')], [1, body]]) }];
  });
}

// The sentence that holds the most of the words, unless its words only repeat the line shown above it.
function snippet(body, terms, shown) {
  const seen = ` ${words(shown).join(' ')} `;
  let best = '';
  let most = 0;
  for (const s of body.split(/\r?\n|(?<=[.!?])\s+/)) {
    const text = s.trim().replace(/^(?:[-*+>]|#+|\d+\.)\s+/, '');
    const ws = words(text);
    if (!ws.length || seen.includes(` ${ws.join(' ')} `)) continue;
    const n = new Set(ws.filter(w => terms.includes(w))).size;
    if (n > most) [best, most] = [text, n];
  }
  return best && clip(best, 160);
}

function fits(n, kind) {
  if (kind === 'rule' || kind === 'page') return n.type === kind;
  return n.type === (PAGE_KINDS.includes(kind) ? 'page' : 'rule') && n.kind === kind;
}

function search(query, o) {
  if (!query) throw new UsageError();
  const limit = o.limit === undefined ? 10 : /^\d+$/.test(o.limit) && Number(o.limit) > 0 ? Number(o.limit) : null;
  if (!limit || (o.kind !== undefined && !KINDS.includes(o.kind))) throw new UsageError();
  const filtered = o.domain !== undefined || o.kind !== undefined || o.topic !== undefined;
  const notes = loadNotes().filter(n => !isRetired(n) && (o.domain === undefined || n.domain === o.domain.toLowerCase())
    && (o.topic === undefined || n.topic === normTopic(o.topic)) && (o.kind === undefined || fits(n, o.kind)));
  const terms = [...new Set(words(query))];
  const hits = terms.length ? rank([...notes.map(noteDoc), ...(o.raw && !filtered ? rawDocs() : [])], terms) : [];
  if (!hits.length) return `No notes${o.raw ? ' or files under raw/refs/' : ''} match "${query}".`;
  const out = hits.slice(0, limit).flatMap((h, i) => {
    const snip = snippet(h.body, terms, h.line);
    return [
      `${i + 1}. ${h.key} · ${h.label}${h.topic ? ` · topic ${h.topic}` : ''}${h.why ? ` · not delivered: ${h.why}` : ''}`,
      ...(h.line ? [`   ${h.line}`] : []),
      `   ${toPosix(vaultPath(...h.rel.split('/')))}`,
      ...(snip ? [`   > ${snip}`] : []),
    ];
  });
  const more = hits.length - limit;
  if (more > 0) out.push(`${more} more matched. Raise --limit to see ${more > 1 ? 'them' : 'it'}.`);
  return out.join('\n');
}

const OPTIONS = { domain: { type: 'string' }, kind: { type: 'string' }, topic: { type: 'string' }, raw: { type: 'boolean' }, limit: { type: 'string' }, help: { type: 'boolean' } };

try {
  const argv = process.argv.slice(2);
  if (schemaArg(argv)) {
    console.log(JSON.stringify(schemaOf(SUMMARY, FIELDS)));
    process.exit(0);
  }
  if (argv[0] === '--json') {
    if (argv.length > 1) throw new UsageError();
    const { words: w, o } = optionsOf(readInput());
    console.log(search(w, o));
    process.exit(0);
  }
  let args;
  try { args = parseArgs({ args: process.argv.slice(2), options: OPTIONS, allowPositionals: true }); } catch { throw new UsageError(); }
  const { values, positionals } = args;
  console.log(values.help ? HELP : search(positionals.join(' ').trim(), values));
} catch (e) {
  const f = failure(e, 'search', USAGE);
  console.error(f.message);
  process.exitCode = f.code;
}
