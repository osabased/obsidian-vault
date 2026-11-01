import fs from 'node:fs';
import crypto from 'node:crypto';
import {
  vaultPath, writeSettled, appendJsonl, appendLog, inboxFile, proposalRows, pickRows, statePath, withLock, today, localDay, toPosix, guarded,
  shortHash, isVaultOnly,
} from './lib/vault.mjs';
import {
  KEY_RE, BASES, wrongBasis, parseNote, noteErrors, ruleText, ruleTextParts, loadNotes, readNote, liveRules, mentions, isUrl, validDay, byKey, normTopic, domainTopics, vaultFile, joinList,
  sharedFiles, rankPair, maxChars,
} from './lib/rules.mjs';
import { build } from './lib/build.mjs';
import { entryKey } from './lib/glob.mjs';
import { typedMessages, saidIn, normText, sourceTexts, userPageTexts } from './lib/quotes.mjs';
import { ownEntry, marked, markMany, wasShown, carryMarkers, proposeDomains } from './lib/sessions.mjs';
import { setField, yamlQuote, plainSafe } from './lib/frontmatter.mjs';
import { subjectRows, laterRows, endedBy, otherLabels } from './lib/picks.mjs';
import { UsageError, readInput, refuse, failure, line } from './lib/input.mjs';

const RUN = 'usage: node tools/propose.mjs <session-id> < rule.json';
const USAGE = `${RUN}\n       node tools/propose.mjs --help lists the fields of rule.json`;

const help = () => [
  RUN,
  '',
  'rule.json is an object with these fields:',
  "  domain       this session's domain (in the vault folder, any domain that isn't vaultOnly), or global for every project",
  '  slug         lowercase-kebab-case',
  '  kind         "taste" (the default), or "knowledge" for a fact about an API, version or tool',
  "               that your training gets wrong or doesn't know",
  '  do, not      one line each',
  "  because      the user's reason, or for knowledge the cause; empty rather than invented",
  "  topic        a short topic; reuse one the domain's rules or pages have, or one of its listed topics:",
  ...topicLines(),
  '  basis        and what to cite for it, written into the note as given:',
  "    stated       the user's words state the rule. quote: their words, as they typed them in this session",
  "                 page: instead of a session, the vault path of a page of the user's own, one with author: user,",
  '                 like wiki/<domain>/<folder>/<slug>.md. quote: their words on that page; propose.mjs refuses one it',
  "                 doesn't hold. The page's frontmatter and its ## Agent notes aren't the user's words.",
  '    inferred     taste only: you generalized a correction. quote: the words you generalized, as the user typed them',
  '                 A quote may leave words out with …; propose.mjs refuses one the user never typed in this session.',
  "    pick         taste only: the user's recorded answer from an earlier session backs the rule.",
  '                 pick: the id of a row in raw/picks/ (q-).',
  "                 The row's own words are cited; a row backs one rule. A provisional, replaced or confirmed pick backs none.",
  "    reading      taste only: your own reading of what you saw, labelled as yours. reading: what you saw, in one line",
  '    failure      knowledge only: something worked only after a failure.',
  '                 error: one line of the error as it was printed',
  '                 fix: what fixed it, in one line',
  '                 file: the file you fixed, from the project root',
  '    source       knowledge only: a dated source shows it.',
  '                 source: its URL, or a file under raw/refs/',
  '                 source_date: when the source was published or last updated, as YYYY-MM-DD',
  "                 quote: the source's words; propose.mjs refuses one a text file under raw/refs/ doesn't hold",
  '  keywords     words a request about it would use',
  '  applies_to   globs from the project root; give them to a rule about code or files',
  '  triggers     regexes tested against the new text of an edit; when given, the rule applies only if one matches',
  '               A rule needs keywords or applies_to.',
  "               always: true is the user's to set in Obsidian, so propose.mjs refuses it.",
  '  repeats      optional, the key of the rule in the vault this one repeats, like example-ui/flat-buttons:',
  "               propose.mjs adds this rule's Evidence line to that note and writes no new one",
  '',
  'If the rule may repeat ones in the vault, propose.mjs lists them and refuses once. If it repeats one, propose',
  'it again with repeats set to that rule; if not, propose it again as it is.',
  '',
  "A knowledge rule's as_of is set for you: the source_date for a source, today otherwise. With repeats, it moves up when that day is later.",
].join('\n');

// Every field the code below reads, so a field it doesn't read is refused rather than dropped.
const FIELDS = new Set([
  'domain', 'slug', 'kind', 'do', 'not', 'because', 'topic', 'basis', 'quote', 'page', 'pick', 'reading', 'error', 'fix', 'file',
  'source', 'source_date', 'keywords', 'applies_to', 'triggers', 'always', 'repeats',
]);

const topicLines = () => [...domainTopics()].flatMap(([d, topics]) => (topics.length ? [`                 ${d}: ${topics.join(', ')}`] : []));

function list(p, name) {
  const v = p[name] ?? [];
  if (!Array.isArray(v) || v.some(x => typeof x !== 'string' || !x.trim() || /[\r\n]/.test(x))) refuse(`${name} must be a list of one-line strings.`);
  return v.map(x => x.trim());
}

function sessionOf(sid) {
  const { entry, notOwn } = ownEntry(sid);
  if (notOwn) refuse(notOwn);
  const domains = proposeDomains(entry);
  if (!domains.length) refuse(`the taste vault has no session ${sid} from a domain's project folder or the vault folder. Pass the session id from the taste vault's note at session start, or $CLAUDE_CODE_SESSION_ID in the vault folder.`);
  return { ...entry, domains };
}

const REFS = /^raw\/refs\/./i;

const WIKI_PAGE = /^wiki\/.+\.md$/i;

function pageEvidence(page, quote) {
  if (!WIKI_PAGE.test(page)) refuse('page must be a page under wiki/, like wiki/<domain>/<folder>/<slug>.md.');
  const cited = vaultFile(page);
  if (cited === null) refuse(`there's no file at ${page} in the vault.`);
  if (!WIKI_PAGE.test(cited)) refuse('page must be a page under wiki/, like wiki/<domain>/<folder>/<slug>.md.');
  return { kind: 'stated', said: quote, page: cited, cite: `"${quote}"` };
}

function evidence(f, p) {
  const page = line(p, 'page', false);
  if (page && f.basis !== 'stated') refuse('page is only for basis stated.');
  if (page) return pageEvidence(page, line(p, 'quote'));
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
  return { kind: 'source', said: quote, date, source: cited, cite: `${cited} · dated ${date} · "${quote}"` };
}

function checkQuote(session, e) {
  if (e.page) {
    const texts = userPageTexts(e.page);
    if (!texts) refuse(`${e.page} isn't an author: user page. Only a page the user marked author: user holds their words.`);
    if (!saidIn(e.said, texts)) refuse(`the quote isn't in ${e.page}. Quote the user's own words there, not its frontmatter or its ## Agent notes.`);
    return;
  }
  if (e.kind === 'source') {
    const texts = REFS.test(e.source) ? sourceTexts(e.source) : null;
    if (texts && !saidIn(e.said, texts)) refuse(`the quote isn't in ${e.source}. Quote the file's own words.`);
    return;
  }
  if (e.pick || !['stated', 'correction'].includes(e.kind)) return;
  const typed = session.transcript ? typedMessages(session.transcript) : null;
  if (!typed) {
    refuse("the taste vault has no transcript for this session, so it can't check the quote is the user's words. Give your own reading with basis reading instead.");
  }
  if (!saidIn(e.said, typed)) {
    refuse("the quote isn't in anything the user typed in this session. Quote their words exactly, leaving words out with … if you need to, or give your own reading with basis reading.");
  }
}

// A pick's label is the user's answer verbatim, and a comment row holds their words; either backs a rule on its own,
// so the row's text is cited and nothing has to be typed again.
function pickEvidence(id, domain) {
  const row = pickRows().find(r => r.id === id);
  if (!row) refuse(`there's no row ${id} in raw/picks/.`);
  if (row.domain && row.domain !== domain && domain !== 'global') refuse(`${id} was recorded in ${row.domain}, not ${domain}.`);
  // A reversed or confirmed pick no longer stands on its own, and a provisional one is the agent's choice, not the user's.
  const by = laterRows(subjectRows()).get(id);
  if (by?.how === 'replaces') refuse(`${id} was replaced by ${by.id}, so it no longer stands.`);
  if (by) refuse(`${id} was ${endedBy(by)}. Propose from that row.`);
  if (row.status === 'provisional') refuse(`${id} is provisional: an agent picked it, not the user. Propose from the row that confirms it.`);
  const from = { pick: id, day: localDay(row.at) || today(), session: String(row.session ?? '').slice(0, 8) || 'unknown' };
  if (typeof row.pick === 'string' && row.pick) {
    const said = row.notes ? `${row.pick} — ${row.notes}` : row.pick;
    const others = otherLabels(row);
    const cite = `"${said}"${others.length ? `, picked over ${joinList(others.map(l => `"${l}"`), 'and')}` : ''}${row.question ? ` for "${row.question}"` : ''}`;
    return { ...from, kind: 'choice', said, cite };
  }
  if (typeof row.text === 'string' && row.text.trim()) return { ...from, kind: 'stated', said: row.text.trim(), cite: `"${row.text.trim()}"` };
  refuse(`${id} holds no answer or message to quote.`);
}

const OVERLAP = 0.2;
const STOPWORDS = new Set(('a all an and any are as at be because but by can cant didnt do doesnt dont for from in is isnt it its must never not of on or '
  + 'should that the their theirs them these they this those to use was we were with wont you your yours').split(' '));
const words = s => new Set((normText(s).replace(/'/g, '').match(/[\p{L}\p{N}]+/gu) ?? [])
  .filter(w => w.length > 2 && !STOPWORDS.has(w) && !/^\p{N}+$/u.test(w))
  .map(w => (w.length > 3 ? w.replace(/s$/, '') : w)));

function overlap(x, y) {
  const shared = [...x].filter(w => y.has(w)).length;
  return shared / (x.size + y.size - shared || 1);
}

const SHORTLIST = 5;
const TOPIC_LIST = 20;

// While a topic holds few rules the agent judges them all, words shared or not. Topics are free text, so case doesn't count.
function onTopic(f, rules) {
  const mine = Object.entries(rules).filter(([, r]) => r.domain === f.domain && r.topic === normTopic(f.topic));
  return mine.length <= TOPIC_LIST ? mine.sort(byKey) : [];
}

// Paraphrases share few words, so a shared glob or keyword lists a rule too; the agent judges which it repeats.
function lookalikes(f, text, scope, rules) {
  const globs = new Set(f.applies_to.map(entryKey));
  const mine = words(text);
  const close = [];
  for (const [k, r] of Object.entries(rules)) {
    if (!scope.includes(r.domain)) continue;
    const glob = (r.applies_to ?? []).some(g => globs.has(entryKey(g)));
    const theirs = [r.text, ...(r.keywords ?? [])].join('\n');
    const keyword = f.keywords.some(w => mentions(w, theirs));
    const share = overlap(mine, words(r.text));
    if (glob || keyword || share >= OVERLAP) close.push({ entry: [k, r], score: glob + keyword + share });
  }
  return close.sort((a, b) => b.score - a.score || byKey(a.entry, b.entry)).map(c => c.entry);
}

// The retry goes through once every rule on the list, and the note its words back, was shown for this proposal.
function checkRepeats(f, text, scope, rules, same, notes) {
  const topic = onTopic(f, rules);
  const all = lookalikes(f, text, scope, rules);
  const inTopic = new Set(topic.map(([k]) => k));
  const others = all.filter(([k]) => !inTopic.has(k));
  const alike = others.slice(0, SHORTLIST).sort(byKey);
  const listedRules = [...topic, ...alike];
  const ids = [...listedRules.map(([k, r]) => `${f.slug}|${k}|${r.hash}`), ...(same ? [`${f.slug}|words|${same.id}`] : [])];
  if (ids.every(id => marked('repeats', f.sid, id))) return [...all.filter(([k]) => inTopic.has(k)), ...alike].sort(byKey).map(([k]) => k);
  markMany('repeats', f.sid, ids);
  const more = others.length - alike.length;
  const item = ([k, r]) => `- ${k}: ${r.text} [${wasShown(f.sid, k) ? 'shown' : 'not shown'} in this session]`;
  const it = same ? 'It' : 'it';
  const listed = topic.length ? [
    `${it} may repeat rules already in the vault.`,
    `Every ${f.domain} rule on ${f.topic}:`,
    ...topic.map(item),
    ...(alike.length ? ['Others that share words, globs or keywords:', ...alike.map(item)] : []),
  ] : alike.length ? [`${it} may repeat these rules:`, ...alike.map(item)] : [];
  refuse([
    ...(same ? [`these words already back ${same.note}${gone(same.note, notes)}.`] : []),
    ...listed,
    ...(more ? [`${more} more match less closely and aren't listed.`] : []),
    ...(listed.length ? [
      `If it repeats one, propose it again with "repeats": "<that rule's key>", and propose.mjs adds its evidence to that note.`,
      "If that rule was shown in this session and you still needed correcting, suggest to the user how its wording or triggers could change. If it wasn't shown, add the keywords or applies_to that would have brought it up.",
      'If it says something new, propose it again as it is.',
    ] : ["If this rule says something that one doesn't, propose it again."]),
  ].join('\n'));
}

// Named once the rule is written, since a global rule or another domain's can gate the same files without being on
// the repeat list.
function sameFiles(f, n, notes, rules) {
  const mine = { domain: f.domain, topic: normTopic(f.topic), applies_to: f.applies_to };
  const near = Object.entries(rules).sort(byKey).filter(([, r]) => sharedFiles(r, mine)).map(([k]) => k);
  if (!near.length) return '';
  const one = near.length === 1;
  const ranked = near.flatMap(k => {
    const rank = rankPair(n, readNote(k, notes));
    if (!rank) return [];
    return [rank.first ? `${rank.first.key} ranks before ${rank.last.key} (${rank.why})` : `${n.key} and ${k} tie (${rank.why})`];
  });
  const order = ranked.length ? `If ${one ? 'it does' : 'one does'}, show the user both with the higher-ranked first: ${ranked.join('; ')}. ` : '';
  return `On ${f.topic}, ${joinList(near, 'and')} cover${one ? 's' : ''} files this rule covers too. Check the new rule doesn't contradict ${one ? 'it' : 'them'}. ${order}`;
}

function gone(key, notes) {
  const n = readNote(key, notes);
  return !n ? ', which has since been deleted' : n.superseded_by ? ', which has since been retired' : '';
}

const sameList = (a, b) => Array.isArray(a) && a.length === b.length && a.every((x, i) => x === b[i]);

function checkReadBack(n, f) {
  const fields = [
    ['domain', n.data.domain === f.domain], ['kind', n.kind === f.kind], ['basis', n.data.basis === f.basis],
    ['as_of', n.as_of === (f.as_of ?? null)], ['topic', n.data.topic === f.topic],
    ['applies_to', sameList(n.applies_to, f.applies_to)], ['triggers', sameList(n.triggers, f.triggers)], ['keywords', sameList(n.keywords, f.keywords)],
    ['do', n.do === f.do], ['not', n.not === f.not], ['because', n.because === f.because],
  ];
  const bad = fields.find(([, ok]) => !ok);
  if (bad) refuse(`${bad[0]} doesn't survive as YAML. Rephrase it.`);
}

const yaml = s => (plainSafe(s) ? s : yamlQuote(s));
const yamlList = (name, xs) => (xs.length ? [`${name}:`, ...xs.map(x => `  - ${yamlQuote(x)}`)] : [`${name}: []`]);

// A pick is cited from the day and session it was recorded in, and a page of the user's by its path.
const citation = (f, e) => `- ${e.day ?? f.day} · ${e.label ?? e.kind} · ${e.page ?? `session ${e.session ?? f.sid.slice(0, 8)}`} · ${e.cite}`;
const evidenceLine = (f, e) => `${citation(f, e)} (${e.pick ? `${e.pick}; proposed as ` : ''}${f.id})`;

const noteText = (f, e) => [
  '---', 'type: rule', `domain: ${f.domain}`, `kind: ${f.kind}`, `basis: ${f.basis}`, ...(f.as_of ? [`as_of: ${f.as_of}`] : []),
  `topic: ${yaml(f.topic)}`, 'always: false',
  ...yamlList('applies_to', f.applies_to), ...yamlList('triggers', f.triggers), ...yamlList('keywords', f.keywords),
  `created: ${f.day}`, `updated: ${f.day}`, '---', '',
  `**Do:** ${f.do}`, `**Not:** ${f.not}`, `**Because:**${f.because ? ` ${f.because}` : ''}`, '',
  '## Examples', '', '## Evidence', evidenceLine(f, e), '',
].join('\n');

// Below the section's last line, in the note's own line endings, so its Evidence stays in the order it came in.
function withEvidence(text, entry) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(l => /^## evidence\s*$/i.test(l));
  if (start < 0) return `${text.trimEnd()}${eol}${eol}## Evidence${eol}${entry}${eol}`;
  const next = lines.findIndex((l, i) => i > start && l.startsWith('## '));
  let last = (next < 0 ? lines.length : next) - 1;
  while (last > start && !lines[last].trim()) last--;
  lines.splice(last + 1, 0, entry);
  return lines.join(eol);
}

// Saved settled, so the rule keeps reaching sessions just when the user has corrected the agent on it.
function addEvidence(f, e, scope, rules, same, row, notes) {
  const target = f.repeats;
  if (!rules[target] || !scope.includes(rules[target].domain)) refuse(`repeats names ${target}, which isn't a delivered rule in ${joinList(scope, 'or')}. Give the key of a rule the refusal listed.`);
  if (same?.note === target) refuse(`these words already back ${target}.`);
  const { rel } = readNote(target, notes);
  const file = vaultPath(...rel.split('/'));
  const before = fs.readFileSync(file, 'utf8');
  const n = parseNote(before, rel);
  let after = withEvidence(before, evidenceLine(f, e));
  // as_of is the day the fact was last checked, so newer evidence of any kind moves it up: a source's date, or the day
  // the Evidence line gives.
  const checked = e.date ?? e.day ?? f.day;
  if (n.kind === 'knowledge' && validDay(n.as_of) && checked > n.as_of) after = setField(after, 'as_of', checked);
  const now = parseNote(after, rel);
  writeSettled(file, after);
  appendJsonl(inboxFile(f.sid), [row(target)]);
  appendLog([`added evidence to ${target} · session ${f.sid.slice(0, 8)}`]);
  const [was, is] = [n, now].map(x => shortHash(ruleText(x)));
  if (was !== is) carryMarkers(f.sid, target, was, is);
  const moved = now.as_of !== n.as_of;
  return [
    `Added the Evidence line to ${rel}. End your reply with these two lines as they are:`,
    '',
    `**Rule backed again** ${target}: ${ruleText(now)}`,
    `Its note has a new Evidence line${moved ? `, and as_of ${now.as_of}` : ''}. To change or remove it, edit ${toPosix(file)}.`,
  ].join('\n');
}

function propose(sid, p) {
  const session = sessionOf(sid);
  const unknown = Object.keys(p).find(k => !FIELDS.has(k));
  if (unknown) refuse(`${unknown} isn't a field propose.mjs takes. Fields like requires and tools are added to the note by hand. node tools/propose.mjs --help lists the fields.`);
  const domains = [...session.domains, 'global'];
  // Slugs compare in NFC, so a slug typed with combining accents names the same note as its composed spelling.
  const f = { sid, domain: line(p, 'domain').normalize('NFC'), slug: line(p, 'slug').normalize('NFC') };
  // A vault-only domain isn't offered, and the note's own check says why it takes no rule.
  if (!domains.includes(f.domain) && !isVaultOnly(f.domain)) refuse(`domain must be ${joinList(domains, 'or')}.`);
  const key = `${f.domain}/${f.slug}`;
  if (!KEY_RE.test(key)) refuse('slug must be lowercase-kebab-case.');
  f.kind = line(p, 'kind', false) || 'taste';
  if (!BASES[f.kind]) refuse('kind must be taste or knowledge.');
  f.topic = line(p, 'topic');
  f.basis = line(p, 'basis');
  if (!BASES[f.kind].includes(f.basis)) refuse(`${wrongBasis(f.kind, f.basis)}.`);
  Object.assign(f, { do: line(p, 'do'), not: line(p, 'not'), because: line(p, 'because', false) });
  Object.assign(f, { applies_to: list(p, 'applies_to'), triggers: list(p, 'triggers'), keywords: list(p, 'keywords') });
  const always = p.always ?? false;
  if (typeof always !== 'boolean') refuse('always must be true or false.');
  // The user chose to set always: true by hand; the note carries always: false for them to flip.
  if (always) refuse("always is the user's to set in Obsidian. Give the rule keywords or applies_to instead.");
  if (!f.applies_to.length && !f.keywords.length) refuse('give it keywords or applies_to, or nothing will deliver it.');
  const scope = f.domain === 'global' ? domains : [f.domain, 'global'];
  f.repeats = line(p, 'repeats', false).normalize('NFC');
  if (f.repeats && !KEY_RE.test(f.repeats)) refuse('repeats must be a rule key like example-ui/flat-buttons.');
  const e = evidence(f, p);
  checkQuote(session, e);
  if (f.kind === 'knowledge') f.as_of = e.date ?? today();

  const at = new Date().toISOString();
  Object.assign(f, { day: today(), id: `a-${crypto.randomBytes(4).toString('hex')}` });
  const text = noteText(f, e);
  const rel = `wiki/${f.domain}/rules/${f.slug}.md`;
  const n = parseNote(text, rel);
  checkReadBack(n, f);
  const [err] = noteErrors(n);
  if (err) refuse(`${err}.`);
  const cap = maxChars(n.kind);
  if (ruleText(n).length > cap) refuse(`${ruleTextParts(n)} come to ${ruleText(n).length} characters; keep them under ${cap} together.`);

  const out = withLock(statePath('propose.lock'), () => {
    const rows = proposalRows();
    // Any later session can re-propose a recorded answer, so each one backs a single rule.
    const earlier = e.pick && rows.find(r => r.pick === e.pick);
    if (earlier) refuse(`${e.pick} was already proposed as ${earlier.note}.`);
    // One correction can back two rules, so the same words refuse once and the retry goes through.
    // One error can show several facts, so a failure matches an earlier one only with the same fix.
    const same = rows.find(r => normText(r.text ?? '') === normText(e.said) && (!e.fix || normText(r.fix ?? '') === normText(e.fix)));
    // Read under the lock, so a proposal written meanwhile is on the list.
    const notes = loadNotes();
    const rules = liveRules(notes);
    const row = note => ({
      id: f.id, at, source: 'agent', kind: e.kind, text: e.said, ...(e.fix ? { fix: e.fix } : {}),
      note, session: sid, transcript: session.transcript ?? null, cwd: session.cwd ?? null, domain: rules[note]?.domain ?? f.domain, ...(e.pick ? { pick: e.pick } : {}), ...(e.page ? { page: e.page } : {}),
    });
    if (f.repeats) return addEvidence(f, e, scope, rules, same, row, notes);
    const taken = readNote(key, notes);
    if (taken) refuse(`${taken.rel} already exists. Pick another slug, or leave that note to the user.`);
    const overlaps = checkRepeats(f, ruleText(n), scope, rules, same, notes);
    const file = vaultPath(...rel.split('/'));
    writeSettled(file, text);
    appendJsonl(inboxFile(sid), [row(key)]);
    appendLog([`wrote ${key} · session ${sid.slice(0, 8)}`]);
    const reply = [
      `**New ${f.kind === 'knowledge' ? 'knowledge rule' : 'rule'}** ${key}: ${ruleText(n)}`,
      ...(overlaps.length ? [`It may overlap ${joinList(overlaps, 'and')}.`] : []),
      `It applies from now on. To change or remove it, edit or delete ${toPosix(file)}.`,
    ];
    return [`Wrote ${rel}. ${sameFiles(f, n, notes, rules)}End your reply with these ${['two', 'three'][reply.length - 2]} lines as they are:`, '', ...reply].join('\n');
  });
  // The rebuild takes seconds at thousands of notes, so it runs after the lock is released rather than hold up the other
  // proposes. The note is written by now, so a failed build costs the generated files, not the reply that names the rule.
  guarded('build', build);
  return out;
}

const [sid, ...rest] = process.argv.slice(2);
try {
  if (sid === '--help' && !rest.length) console.log(help());
  else if (!sid || rest.length) throw new UsageError();
  else console.log(propose(sid, readInput()));
} catch (e) {
  const f = failure(e, 'propose', USAGE, 'Not proposed');
  console.error(f.message);
  process.exitCode = f.code;
}
