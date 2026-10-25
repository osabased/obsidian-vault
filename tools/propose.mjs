import fs from 'node:fs';
import crypto from 'node:crypto';
import {
  config, vaultPath, proposeDomains, readJsonSafe, writeSettled, appendJsonl, appendLog, inboxFile, proposalRows, recordedRows, statePath, withLock, safeId, today, toPosix,
} from './lib/vault.mjs';
import {
  KEY_RE, BASES, wrongBasis, parseNote, noteErrors, ruleText, ruleTextParts, readNote, liveRules, build, mentions, isUrl, validDay, byKey, normTopic, domainTopics, vaultFile, joinList,
} from './lib/rules.mjs';
import { normGlob } from './lib/glob.mjs';
import { registry, marked, mark } from './lib/sessions.mjs';

const RUN = 'usage: node tools/propose.mjs <session-id> < rule.json';
const USAGE = `${RUN}\n       node tools/propose.mjs --help lists the fields of rule.json`;

const help = () => [
  RUN,
  '',
  'rule.json is an object with these fields:',
  "  domain       this session's domain (any domain in the vault folder), or global for every project",
  '  slug         lowercase-kebab-case',
  '  kind         "taste" (the default), or "knowledge" for a fact about an API, version or tool',
  "               that your training gets wrong or doesn't know",
  '  do, not      one line each',
  "  because      the user's reason, or for knowledge the cause; empty rather than invented",
  "  topic        a short topic; reuse one the domain's rules or pages have, or one of its listed topics:",
  ...topicLines(),
  '  basis        and what to cite for it, written into the note as given:',
  "    stated       the user's words state the rule. quote: their words",
  '    inferred     taste only: you generalized a correction. quote: the words you generalized',
  "    pick         taste only: the user's recorded answer from an earlier session backs the rule.",
  '                 pick: the id of a row in raw/picks/ (q-) or of an older user-written row in raw/inbox/ (c-, p-).',
  "                 The row's own words are cited; a row backs one rule.",
  "    reading      taste only: your own reading of what you saw, labelled as yours. reading: what you saw, in one line",
  '    failure      knowledge only: something worked only after a failure.',
  '                 error: one line of the error as it was printed',
  '                 fix: what fixed it, in one line',
  '                 file: the file you fixed, from the project root',
  '    source       knowledge only: a dated source shows it.',
  '                 source: its URL, or a file under raw/refs/',
  '                 source_date: when the source was published or last updated, as YYYY-MM-DD',
  "                 quote: the source's words",
  '  keywords     words a request about it would use',
  '  applies_to   globs from the project root',
  '  triggers     regexes tested against the new text of an edit; when given, the rule applies only if one matches',
  '  always       true for short rules that matter in nearly every session',
  '               A taste rule needs keywords, applies_to or always: true. A knowledge rule needs applies_to',
  '               and takes no keywords or always.',
  '',
  'If the rule may repeat ones in the vault, propose.mjs lists them and refuses once. If it repeats one, update',
  'that note instead; if not, propose it again.',
  '',
  "A knowledge rule's as_of is set for you: the source_date for a source, today otherwise.",
].join('\n');

const topicLines = () => [...domainTopics()].flatMap(([d, topics]) => (topics.length ? [`                 ${d}: ${topics.join(', ')}`] : []));

class UsageError extends Error {}
class Refused extends Error {}

const refuse = msg => { throw new Refused(`Not proposed: ${msg}`); };

function readInput() {
  let p;
  try { p = JSON.parse(fs.readFileSync(0, 'utf8').replace(/^﻿/, '')); } catch { throw new UsageError(); }
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new UsageError();
  return p;
}

function line(p, name, required = true) {
  const v = p[name] ?? '';
  if (typeof v !== 'string') refuse(`${name} must be a string.`);
  if (required && !v.trim()) refuse(`${name} is missing.`);
  if (/[\r\n]/.test(v.trim())) refuse(`${name} must be one line.`);
  return v.trim();
}

function list(p, name) {
  const v = p[name] ?? [];
  if (!Array.isArray(v) || v.some(x => typeof x !== 'string' || !x.trim() || /[\r\n]/.test(x))) refuse(`${name} must be a list of one-line strings.`);
  return v.map(x => x.trim());
}

function sessionOf(sid) {
  const own = process.env.CLAUDE_CODE_SESSION_ID;
  if (own && own !== sid) refuse(`${sid} isn't this session, which is ${own}.`);
  const entry = readJsonSafe(registry(safeId(sid)));
  const domains = proposeDomains(entry?.cwd);
  if (!domains.length) refuse(`the taste vault has no session ${sid} from a domain's project folder or the vault folder. Pass the session id from the taste vault's note at session start, or $CLAUDE_CODE_SESSION_ID in the vault folder.`);
  return { ...entry, domains };
}

const REFS = /^raw\/refs\/./i;

function evidence(f, p) {
  if (f.basis === 'pick') return pickEvidence(line(p, 'pick'), f.domain);
  if (f.basis === 'failure') {
    const [error, fix, file] = ['error', 'fix', 'file'].map(name => line(p, name));
    return { kind: 'failure', said: error, fix, cite: `${file} · "${error}" · fixed by: ${fix}` };
  }
  // Unquoted, so it doesn't read as anyone's words.
  if (f.basis === 'reading') {
    const reading = line(p, 'reading');
    return { kind: 'reading', label: "agent's reading", said: reading, cite: reading };
  }
  if (f.basis !== 'source') {
    const quote = line(p, 'quote');
    return { kind: f.basis === 'inferred' ? 'correction' : 'stated', said: quote, cite: `"${quote}"` };
  }
  const [source, date, quote] = ['source', 'source_date', 'quote'].map(name => line(p, name));
  if (!isUrl(source) && !REFS.test(source)) refuse('source must be a URL or a file under raw/refs/.');
  let cited = source;
  if (REFS.test(source)) {
    // Cited as the disk spells it, so each file has one spelling.
    cited = vaultFile(source);
    if (cited === null) refuse(`there's no file at ${source} in the vault.`);
    if (!REFS.test(cited)) refuse('source must be a file under raw/refs/.');
  }
  if (!validDay(date)) refuse('source_date must be a date as YYYY-MM-DD.');
  if (date > today()) refuse("source_date can't be in the future.");
  return { kind: 'source', said: quote, date, cite: `${cited} · dated ${date} · "${quote}"` };
}

// A pick's label is the user's answer verbatim, and an older captured row holds their message; either backs a rule
// on its own, so the row's text is cited and nothing has to be typed again.
function pickEvidence(id, domain) {
  const row = recordedRows().find(r => r.id === id);
  if (!row) refuse(`there's no row ${id} in raw/picks/ or raw/inbox/.`);
  if (row.domain && row.domain !== domain && domain !== 'global') refuse(`${id} was recorded in ${row.domain}, not ${domain}.`);
  const from = { pick: id, day: String(row.at ?? '').slice(0, 10) || today(), session: String(row.session ?? '').slice(0, 8) || 'unknown' };
  if (typeof row.pick === 'string' && row.pick) {
    const said = row.notes ? `${row.pick} — ${row.notes}` : row.pick;
    const others = (row.options ?? []).map(o => o.label).filter(l => l !== row.pick);
    const cite = `"${said}"${others.length ? `, picked over ${others.map(l => `"${l}"`).join(' and ')}` : ''}${row.question ? ` for "${row.question}"` : ''}`;
    return { ...from, kind: 'choice', said, cite };
  }
  if (typeof row.text === 'string' && row.text.trim()) return { ...from, kind: 'stated', said: row.text.trim(), cite: `"${row.text.trim()}"` };
  refuse(`${id} holds no answer or message to quote.`);
}

const OVERLAP = 0.2;
const STOPWORDS = new Set(('a all an and any are as at be because but by can cant didnt do doesnt dont for from in is isnt it its must never not of on or '
  + 'should that the their theirs them these they this those to use was we were with wont you your yours').split(' '));
// Curly quotes read as straight ones. Apostrophes go first so "don't" reads as the stopword dont rather than as don, which every Not line shares.
const normText = s => String(s)
  .toLowerCase()
  .replace(/[‘’ʼ]/g, "'")
  .replace(/[“”]/g, '"')
  .replace(/\s+/g, ' ')
  .trim();

const words = s => new Set((normText(s).replace(/'/g, '').match(/[\p{L}\p{N}]+/gu) ?? [])
  .filter(w => w.length > 2 && !STOPWORDS.has(w) && !/^\p{N}+$/u.test(w))
  .map(w => (w.length > 3 ? w.replace(/s$/, '') : w)));

function overlap(x, y) {
  const shared = [...x].filter(w => y.has(w)).length;
  return shared / (x.size + y.size - shared || 1);
}

const globKey = g => normGlob(g).toLowerCase();

const SHORTLIST = 5;
const TOPIC_LIST = 20;

// While a topic holds few rules the agent judges them all, words shared or not. Topics are free text, so case doesn't count.
function onTopic(f, rules) {
  const mine = Object.entries(rules).filter(([, r]) => r.domain === f.domain && r.topic === normTopic(f.topic));
  return mine.length <= TOPIC_LIST ? mine.sort(byKey) : [];
}

// Paraphrases share few words, so a shared glob or keyword lists a rule too; the agent judges which it repeats.
function lookalikes(f, text, scope, rules) {
  const globs = new Set(f.applies_to.map(globKey));
  const mine = words(text);
  const close = [];
  for (const [k, r] of Object.entries(rules)) {
    if (!scope.includes(r.domain)) continue;
    const glob = (r.applies_to ?? []).some(g => globs.has(globKey(g)));
    const theirs = [r.text, ...(r.keywords ?? [])].join('\n');
    const keyword = f.keywords.some(w => mentions(w, theirs));
    const share = overlap(mine, words(r.text));
    if (glob || keyword || share >= OVERLAP) close.push({ entry: [k, r], score: glob + keyword + share });
  }
  return close.sort((a, b) => b.score - a.score || byKey(a.entry, b.entry)).map(c => c.entry);
}

// The retry goes through once every rule on the list, and the note its words back, was shown for this proposal.
function checkRepeats(f, text, scope, rules, same) {
  const topic = onTopic(f, rules);
  const all = lookalikes(f, text, scope, rules);
  const inTopic = new Set(topic.map(([k]) => k));
  const others = all.filter(([k]) => !inTopic.has(k));
  const alike = others.slice(0, SHORTLIST).sort(byKey);
  const shown = [...topic, ...alike];
  const ids = [...shown.map(([k, r]) => `${f.slug}|${k}|${r.hash}`), ...(same ? [`${f.slug}|words|${same.id}`] : [])];
  if (ids.every(id => marked('repeats', f.sid, id))) return [...all.filter(([k]) => inTopic.has(k)), ...alike].sort(byKey).map(([k]) => k);
  for (const id of ids) mark('repeats', f.sid, id);
  const more = others.length - alike.length;
  const item = ([k, r]) => `- ${k}: ${r.text}`;
  const it = same ? 'It' : 'it';
  const listed = topic.length ? [
    `${it} may repeat rules already in the vault.`,
    `Every ${f.domain} rule on ${f.topic}:`,
    ...topic.map(item),
    ...(alike.length ? ['Others that share words, globs or keywords:', ...alike.map(item)] : []),
  ] : alike.length ? [`${it} may repeat these rules:`, ...alike.map(item)] : [];
  refuse([
    ...(same ? [`these words already back ${same.note}${gone(same.note)}.`] : []),
    ...listed,
    ...(more ? [`${more} more match less closely and aren't listed.`] : []),
    listed.length ? `If it repeats one, update that note in ${toPosix(vaultPath('wiki'))} instead. If it says something new, propose it again.`
      : "If this rule says something that one doesn't, propose it again.",
  ].join('\n'));
}

function gone(key) {
  const n = readNote(key);
  return !n ? ', which has since been deleted' : n.superseded_by ? ', which has since been retired' : '';
}

const sameList = (a, b) => Array.isArray(a) && a.length === b.length && a.every((x, i) => x === b[i]);

function checkReadBack(n, f) {
  const fields = [
    ['domain', n.data.domain === f.domain], ['kind', n.kind === f.kind], ['basis', n.data.basis === f.basis],
    ['as_of', n.as_of === (f.as_of ?? null)], ['topic', n.data.topic === f.topic], ['always', n.data.always === f.always],
    ['applies_to', sameList(n.applies_to, f.applies_to)], ['triggers', sameList(n.triggers, f.triggers)], ['keywords', sameList(n.keywords, f.keywords)],
    ['do', n.do === f.do], ['not', n.not === f.not], ['because', n.because === f.because],
  ];
  const bad = fields.find(([, ok]) => !ok);
  if (bad) refuse(`${bad[0]} doesn't survive as YAML. Rephrase it.`);
}

const yaml = s => (/^[a-z0-9-]+$/i.test(s) ? s : `'${s.replace(/'/g, "''")}'`);
const yamlList = (name, xs) => (xs.length ? [`${name}:`, ...xs.map(x => `  - '${x.replace(/'/g, "''")}'`)] : [`${name}: []`]);

// A pick is cited from the day and session it was recorded in.
const evidenceLine = (f, e) => `- ${e.day ?? f.day} · ${e.label ?? e.kind} · session ${e.session ?? f.sid.slice(0, 8)} · ${e.cite} (${e.pick ? `${e.pick}; proposed as ` : ''}${f.id})`;

const noteText = (f, e) => [
  '---', 'type: rule', `domain: ${f.domain}`, `kind: ${f.kind}`, `basis: ${f.basis}`, ...(f.as_of ? [`as_of: ${f.as_of}`] : []),
  `topic: ${yaml(f.topic)}`, `always: ${f.always}`,
  ...yamlList('applies_to', f.applies_to), ...yamlList('triggers', f.triggers), ...yamlList('keywords', f.keywords),
  `created: ${f.day}`, `updated: ${f.day}`, '---', '',
  `**Do:** ${f.do}`, `**Not:** ${f.not}`, `**Because:**${f.because ? ` ${f.because}` : ''}`, '',
  '## Examples', '', '## Evidence', evidenceLine(f, e), '',
].join('\n');

function propose(sid, p) {
  const session = sessionOf(sid);
  const domains = [...session.domains, 'global'];
  const f = { sid, domain: line(p, 'domain'), slug: line(p, 'slug') };
  if (!domains.includes(f.domain)) refuse(`domain must be ${joinList(domains, 'or')}.`);
  const key = `${f.domain}/${f.slug}`;
  if (!KEY_RE.test(key)) refuse('slug must be lowercase-kebab-case.');
  f.kind = line(p, 'kind', false) || 'taste';
  if (!BASES[f.kind]) refuse('kind must be taste or knowledge.');
  f.topic = line(p, 'topic');
  f.basis = line(p, 'basis');
  if (!BASES[f.kind].includes(f.basis)) refuse(`${wrongBasis(f.kind, f.basis)}.`);
  Object.assign(f, { do: line(p, 'do'), not: line(p, 'not'), because: line(p, 'because', false) });
  Object.assign(f, { applies_to: list(p, 'applies_to'), triggers: list(p, 'triggers'), keywords: list(p, 'keywords'), always: p.always ?? false });
  if (typeof f.always !== 'boolean') refuse('always must be true or false.');
  if (f.kind === 'taste' && !f.always && !f.applies_to.length && !f.keywords.length) refuse('give it keywords, applies_to or always: true, or nothing will deliver it.');
  const scope = f.domain === 'global' ? domains : [f.domain, 'global'];
  const e = evidence(f, p);
  if (f.kind === 'knowledge') f.as_of = e.date ?? today();

  const at = new Date().toISOString();
  Object.assign(f, { day: today(), id: `a-${crypto.randomBytes(4).toString('hex')}` });
  const text = noteText(f, e);
  const n = parseNote(text, `wiki/${key}.md`);
  checkReadBack(n, f);
  const [err] = noteErrors(n);
  if (err) refuse(`${err}.`);
  const { maxRuleChars } = config().delivery;
  if (ruleText(n).length > maxRuleChars) refuse(`${ruleTextParts(n)} come to ${ruleText(n).length} characters; keep them under ${maxRuleChars} together.`);

  return withLock(statePath('propose.lock'), () => {
    const rows = proposalRows();
    // Any later session can re-propose a recorded answer, so each one backs a single rule.
    const earlier = e.pick && rows.find(r => r.pick === e.pick);
    if (earlier) refuse(`${e.pick} was already proposed as ${earlier.note}.`);
    if (readNote(key)) refuse(`wiki/${key}.md already exists. Pick another slug, or leave that note to the user.`);
    // One correction can back two rules, so the same words refuse once and the retry goes through.
    // One error can show several facts, so a failure matches an earlier one only with the same fix.
    const same = rows.find(r => normText(r.text ?? '') === normText(e.said) && (!e.fix || normText(r.fix ?? '') === normText(e.fix)));
    // Read under the lock, so a proposal written meanwhile is on the list.
    const overlaps = checkRepeats(f, ruleText(n), scope, liveRules(), same);
    const file = `${vaultPath('wiki', f.domain, f.slug)}.md`;
    writeSettled(file, text);
    appendJsonl(inboxFile(), [{
      id: f.id, at, source: 'agent', kind: e.kind, text: e.said, ...(e.fix ? { fix: e.fix } : {}),
      note: key, session: sid, transcript: session.transcript ?? null, cwd: session.cwd ?? null, domain: f.domain, ...(e.pick ? { pick: e.pick } : {}),
    }]);
    appendLog([`wrote ${key} · session ${sid.slice(0, 8)}`]);
    build();
    const reply = [
      `**New ${f.kind === 'knowledge' ? 'knowledge rule' : 'rule'}** ${key}: ${ruleText(n)}`,
      ...(overlaps.length ? [`It may overlap ${joinList(overlaps, 'and')}.`] : []),
      `It applies from now on. To change or remove it, edit or delete ${toPosix(file)}.`,
    ];
    return [`Wrote wiki/${key}.md. End your reply with these ${['two', 'three'][reply.length - 2]} lines as they are:`, '', ...reply].join('\n');
  });
}

const [sid, ...rest] = process.argv.slice(2);
try {
  if (sid === '--help' && !rest.length) console.log(help());
  else if (!sid || rest.length) throw new UsageError();
  else console.log(propose(sid, readInput()));
} catch (e) {
  if (e instanceof UsageError) {
    console.error(USAGE);
    process.exitCode = 2;
  } else if (e instanceof Refused) {
    console.error(e.message);
    process.exitCode = 1;
  } else {
    console.error(`propose failed: ${e.message}`);
    process.exitCode = 1;
  }
}
