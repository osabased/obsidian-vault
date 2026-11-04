import fs from 'node:fs';
import {
  vaultPath, writeSettled, appendJsonl, appendLog, inboxFile, proposalRows, pickRows, statePath, withLock, today, localDay, toPosix, guarded,
  shortHash, isVaultOnly, sessionReach, cwdOf, proposalMode, inVaultFolder, newId,
} from './vault.mjs';
import {
  KEY_RE, BASES, wrongBasis, parseNote, noteErrors, ruleText, ruleTextParts, loadNotes, readNote, liveRules, mentions, isUrl, validDay, byKey, normTopic, domainTopics, vaultFile, joinList,
  sharedFiles, rankPair, maxChars, fitIn,
} from './rules.mjs';
import { build } from './build.mjs';
import { entryKey } from './glob.mjs';
import { saidIn, normText, quoteTexts, userPageTexts, inLatest } from './quotes.mjs';
import { ownEntry, marked, markMany, wasShown, carryMarkers, proposeDomains, sessionName } from './sessions.mjs';
import { setField, yamlQuote, yamlScalar } from './frontmatter.mjs';
import { subjectRows, laterRows, endedBy, otherLabels } from './picks.mjs';
import { refuse, line, lines, Refused } from './input.mjs';
import { typedFor, shortName } from './agents.mjs';
import { makeOffer, offerText, offerReply, consentOf, declined, releaseOffers, claimOffer, keptOffer } from './offers.mjs';
import { entryOf, queueEntry, appendEntry, closeEntry, queueLocked } from './queue.mjs';

// Every field the code below reads, so a field it doesn't read is refused rather than dropped.
const FIELDS = new Set([
  'domain', 'slug', 'kind', 'do', 'not', 'because', 'topic', 'basis', 'quote', 'page', 'pick', 'reading', 'error', 'fix', 'file',
  'source', 'source_date', 'keywords', 'applies_to', 'triggers', 'always', 'repeats', 'asked', 'hold', 'release', 'queued',
]);

const PASS = "The vault's tools pass the session id themselves. From a shell, pass it as the first argument, or run this from the agent's own shell, which sets its session variable.";

function sessionOf(sid) {
  if (!sid) refuse(`there's no session id to propose for. ${PASS}`);
  const { entry, notOwn } = ownEntry(sid);
  if (notOwn) refuse(notOwn);
  if (!entry) refuse(`the taste vault has no session ${sid}. ${PASS}`);
  return { ...entry, domains: proposeDomains(entry) };
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

function checkQuote(session, e, queued) {
  if (e.page) {
    const texts = userPageTexts(e.page);
    if (!texts) refuse(`${e.page} isn't an author: user page. Only a page the user marked author: user holds their words.`);
    if (!saidIn(e.said, texts)) refuse(`the quote isn't in ${e.page}. Quote the user's own words there, not its frontmatter or its ## Agent notes.`);
    return;
  }
  if (e.kind === 'source') {
    if (!REFS.test(e.source)) return;
    const { texts, why } = quoteTexts(e.source);
    if (why === 'image') refuse(`${e.source} is an image, and what it shows is your reading. Give it as basis reading instead.`);
    if (why) {
      refuse(`${e.source} has no text propose.mjs can read: it isn't UTF-8 and has no derived text. Run node tools/extract.mjs ${e.source}, or save it as UTF-8, then propose again.`);
    }
    if (!saidIn(e.said, texts)) refuse(`the quote isn't in ${e.source}. Quote the file's own words.`);
    return;
  }
  if (e.pick || !['stated', 'correction'].includes(e.kind)) return;
  const typed = typedFor(session);
  // The entry kept the words that passed the check when it was made, as an inbox row does once its transcript is gone.
  if (!typed && queued && saidIn(e.said, [queued.quote ?? ''])) return;
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
  const from = { pick: id, day: localDay(row.at) || today(), session: row.session ? sessionName(String(row.session), row.agent) : 'unknown' };
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
  const fit = fitIn(sessionReach(cwdOf({})));
  const ranked = near.flatMap(k => {
    const rank = rankPair(n, readNote(k, notes), { fit });
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

const yamlList = (name, xs) => (xs.length ? [`${name}:`, ...xs.map(x => `  - ${yamlQuote(x)}`)] : [`${name}: []`]);

// A pick is cited from the day and session it was recorded in, and a page of the user's by its path.
const citation = (f, e) => `- ${e.day ?? f.day} · ${e.label ?? e.kind} · ${e.page ?? `session ${e.session ?? f.name}`} · ${e.cite}`;
const evidenceLine = (f, e) => `${citation(f, e)} (${e.pick ? `${e.pick}; proposed as ` : ''}${f.id})`;

const noteText = (f, e) => [
  '---', 'type: rule', `domain: ${f.domain}`, `kind: ${f.kind}`, `basis: ${f.basis}`, ...(f.as_of ? [`as_of: ${f.as_of}`] : []),
  `topic: ${yamlScalar(f.topic)}`, 'always: false',
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

// Outside the vault folder, where /ingest goes through each rule with the user, ask and off only offer the rule once
// every other check has passed, and keep writes it once the user agrees, so what the user agrees to is what gets written.
// Kept, the offer's text must still be what these fields give: the rule a repeat backs may have changed since. A held
// rule waits for release whatever the mode. An entry from the review queue is offered again in every mode, since it went
// there for the user's review, and a subagent's rule waits there for it.
function consent(f, domain, kind, key, offer) {
  if (f.kept) {
    if (offerText(offer, f.kept.code) !== f.kept.text) refuse("the vault changed since the offer, so it isn't what the user agreed to. Propose it again.");
    return null;
  }
  const mode = proposalMode(domain);
  const vault = inVaultFolder(f.folder);
  const writes = mode === 'corrections' || vault;
  if (writes && !f.hold && !f.queueAs && !f.queued) return null;
  // Checked before the offer, which no answer could approve without a transcript.
  if ((!writes || f.queued) && !f.queueAs && (mode === 'off' || consentOf(f.session) === 'code') && !typedFor(f.session)) {
    refuse("the taste vault has no transcript for this session, so it can't check the user agreed. Ask the user to write the rule in Obsidian.");
  }
  // A filter with no power to write: an offer the user didn't ask for raises no prompt.
  if (!vault && mode === 'off') {
    if (!f.asked) refuse(`proposals is off for ${domain}: propose a rule only when the user asks you to keep one, with their words asking as asked.`);
    if (!inLatest(f.session, f.asked)) refuse("asked isn't in the user's latest message. Wait for the user to ask for the rule, and pass their words as asked once they do.");
  }
  return { kind, key, lines: offer };
}

// Saved settled, so the rule keeps reaching sessions just when the user has corrected the agent on it.
function addEvidence(f, e, scope, rules, same, row, notes) {
  const target = f.repeats;
  if (!rules[target] || !scope.includes(rules[target].domain)) refuse(`repeats names ${target}, which isn't a delivered rule in ${joinList(scope, 'or')}. Give the key of a rule the refusal listed.`);
  if (same?.note === target) refuse(`these words already back ${target}.`);
  const offer = consent(f, rules[target].domain, 'evidence', target, [
    `**Back this rule again?** ${target}: ${rules[target].text}`,
    `Its note would get this Evidence: ${e.cite}.`,
  ]);
  if (offer) return { offer };
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
  appendJsonl(inboxFile(f.name), [row(target)]);
  appendLog([`added evidence to ${target} · session ${f.name}`]);
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

const where = f => {
  const parts = [...(f.applies_to.length ? [`Applies to ${f.applies_to.join(', ')}`] : []), ...(f.keywords.length ? [`keywords: ${f.keywords.join(', ')}`] : [])].join(' · ');
  return `${parts[0].toUpperCase()}${parts.slice(1)}`;
};

const RELEASE_HEAD = 'Call `keep` for each offer below, then say in your final reply what was kept.';

// Held offers are released together once the task is done. Where the mode writes at once they are written now; the rest
// go to the user as offers. The mode is read now, since the user may have changed it since the rule was held.
function releaseHeld(sid, session, p) {
  if (p.release !== true) refuse('release must be true.');
  if (Object.keys(p).length > 1) refuse('release takes no other field. Hold each rule on its own, then release them together.');
  const held = releaseOffers(sid, typedFor(session)?.length ?? null);
  if (!held.length) return 'Nothing is held in this session.';
  const written = [];
  const offered = [];
  for (const o of held) {
    if (proposalMode(o.key.split('/')[0]) !== 'corrections' && !inVaultFolder(session.cwd)) offered.push(o);
    else if (claimOffer(o.id)) {
      try {
        written.push(proposeRule(sid, o.fields, { kept: { text: o.text, code: o.code, offer: o.id } }));
        keptOffer(o.id);
      } catch (e) {
        if (!(e instanceof Refused)) throw e;
        written.push(`Not written \`${o.id}\`: ${e.message}`);
      }
    }
  }
  const blocks = offered.map(offerReply);
  return [...written, ...(blocks.length && consentOf(session) === 'prompt' ? [RELEASE_HEAD] : []), ...blocks].join('\n\n');
}

// An entry is proposed again from its own fields, and its quote checked against the session it was typed in.
function fromQueue(p) {
  if (Object.keys(p).some(k => !['queued', 'asked'].includes(k))) refuse("queued takes no other field than asked: the entry's own fields are proposed again.");
  const id = line(p, 'queued');
  const { entry, decided } = entryOf(id);
  if (!entry) refuse(`there's no entry \`${id}\` in raw/queue/.`);
  if (decided) refuse(`\`${id}\` was already ${decided}.`);
  if (!['rule', 'evidence'].includes(entry.kind)) refuse(`\`${id}\` is a ${entry.kind} entry, which propose doesn't take.`);
  return entry;
}

// The input is read after the session is checked, so a script run from the wrong place says that first: p is the input,
// or a function that reads it. kept is how the user agreed to the offer keep writes: { consent: 'prompt' }, or
// { consent: 'code', approved } with their typed reply, and the offer's id, text and code to check it against. queueAs
// sends the rule to the review queue instead of offering it: { why, unattended, reply } gives the entry's reasons and
// what to say once it is queued.
export function proposeRule(sid, p, { kept = null, queueAs = null } = {}) {
  const session = sessionOf(sid);
  if (typeof p === 'function') p = p();
  // A subagent's rules wait in the queue, so the session's held offers and the queue's entries are left to the main agent.
  for (const k of ['release', 'queued']) if (queueAs && p && Object.hasOwn(p, k)) refuse(`a subagent's rules wait in the review queue for the user, so ${k} is for the main session.`);
  if (p && Object.hasOwn(p, 'release')) return releaseHeld(sid, session, p);
  const queued = p && Object.hasOwn(p, 'queued') ? fromQueue(p) : null;
  if (queued) p = { ...queued.fields, ...(Object.hasOwn(p, 'asked') ? { asked: p.asked } : {}) };
  const unknown = Object.keys(p).find(k => !FIELDS.has(k));
  if (unknown) refuse(`${unknown} isn't a field propose.mjs takes. Fields like requires and tools are added to the note by hand. The \`propose\` tool's schema lists the fields.`);
  const domains = [...session.domains, 'global'];
  // Slugs compare in NFC, so a slug typed with combining accents names the same note as its composed spelling.
  const f = { sid, name: shortName(sid, session.agent), domain: line(p, 'domain').normalize('NFC'), slug: line(p, 'slug').normalize('NFC') };
  Object.assign(f, { session, folder: session.cwd, asked: line(p, 'asked', false), kept, queueAs, queued: queued?.id ?? null });
  f.hold = p.hold ?? false;
  if (typeof f.hold !== 'boolean') refuse('hold must be true or false.');
  // A vault-only domain isn't offered, and the note's own check says why it takes no rule.
  if (!domains.includes(f.domain) && !isVaultOnly(f.domain)) {
    refuse(`domain must be ${joinList(domains, 'or')}. For a rule that holds only in projects of a kind no domain covers, suggest a new domain to the user, and once they agree start it with the vault's \`domain\` tool.`);
  }
  const key = `${f.domain}/${f.slug}`;
  if (!KEY_RE.test(key)) refuse('slug must be lowercase-kebab-case.');
  f.kind = line(p, 'kind', false) || 'taste';
  if (!BASES[f.kind]) refuse('kind must be taste or knowledge.');
  f.topic = line(p, 'topic');
  f.basis = line(p, 'basis');
  if (!BASES[f.kind].includes(f.basis)) refuse(`${wrongBasis(f.kind, f.basis)}.`);
  Object.assign(f, { do: line(p, 'do'), not: line(p, 'not'), because: line(p, 'because', false) });
  Object.assign(f, { applies_to: lines(p, 'applies_to'), triggers: lines(p, 'triggers'), keywords: lines(p, 'keywords') });
  const always = p.always ?? false;
  if (typeof always !== 'boolean') refuse('always must be true or false.');
  // The user chose to set always: true by hand; the note carries always: false for them to flip.
  if (always) refuse("always is the user's to set in Obsidian. Give the rule keywords or applies_to instead.");
  if (!f.applies_to.length && !f.keywords.length) refuse('give it keywords or applies_to, or nothing will deliver it.');
  const scope = f.domain === 'global' ? domains : [f.domain, 'global'];
  f.repeats = line(p, 'repeats', false).normalize('NFC');
  if (f.repeats && !KEY_RE.test(f.repeats)) refuse('repeats must be a rule key like example-ui/flat-buttons.');
  const e = evidence(f, p);
  if (queued && !e.pick) Object.assign(e, { day: queued.checked, session: sessionName(queued.session, queued.agent) });
  checkQuote(queued ? { agent: queued.agent, transcript: queued.transcript } : session, e, queued);
  if (f.kind === 'knowledge') f.as_of = e.date ?? today();

  const at = new Date().toISOString();
  Object.assign(f, { day: today(), id: newId('a') });
  const text = noteText(f, e);
  const rel = `wiki/${f.domain}/rules/${f.slug}.md`;
  const n = parseNote(text, rel);
  checkReadBack(n, f);
  const [err] = noteErrors(n);
  if (err) refuse(`${err}.`);
  const cap = maxChars(n.kind);
  if (ruleText(n).length > cap) refuse(`${ruleTextParts(n)} come to ${ruleText(n).length} characters; keep them under ${cap} together.`);

  // Under queue.lock too for a queued entry, so a drop can't land between the check and the kept row.
  const out = withLock(statePath('propose.lock'), () => (queued ? queueLocked : fn => fn())(() => {
    const decided = queued && entryOf(queued.id).decided;
    if (decided) refuse(`\`${queued.id}\` was already ${decided}.`);
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
    // A queued entry's row names the session the words were typed in, so lint finds them there or in this row.
    const from = queued ?? { ...session, session: sid };
    const row = note => ({
      id: f.id, at, source: 'agent', kind: e.kind, text: e.said, ...(e.fix ? { fix: e.fix } : {}),
      note, session: from.session, agent: from.agent ?? null, transcript: from.transcript ?? null, cwd: from.cwd ?? null, domain: rules[note]?.domain ?? f.domain, ...(e.pick ? { pick: e.pick } : {}), ...(e.page ? { page: e.page } : {}),
      ...(kept?.consent ? { consent: kept.consent, ...(kept.approved ? { approved: kept.approved } : {}) } : {}),
      ...(queued ? { queued: queued.id } : {}),
    });
    const done = reply => {
      if (queued && typeof reply === 'string') closeEntry({ id: queued.id, decision: 'kept', offer: kept?.offer ?? null, sid, agentName: session.agent });
      return reply;
    };
    if (f.repeats) return done(addEvidence(f, e, scope, rules, same, row, notes));
    const taken = readNote(key, notes);
    if (taken) refuse(`${taken.rel} already exists. Pick another slug, or leave that note to the user.`);
    const overlaps = checkRepeats(f, ruleText(n), scope, rules, same, notes);
    const offer = consent(f, f.domain, 'rule', key, [`**Keep this rule?** ${key}: ${ruleText(n)}`, where(f)]);
    if (offer) return { offer };
    const file = vaultPath(...rel.split('/'));
    writeSettled(file, text);
    appendJsonl(inboxFile(f.name), [row(key)]);
    appendLog([`wrote ${key} · session ${f.name}`]);
    const reply = [
      `**New ${f.kind === 'knowledge' ? 'knowledge rule' : 'rule'}** ${key}: ${ruleText(n)}`,
      ...(overlaps.length ? [`It may overlap ${joinList(overlaps, 'and')}.`] : []),
      `It applies from now on. To change or remove it, edit or delete ${toPosix(file)}.`,
    ];
    return done([`Wrote ${rel}. ${sameFiles(f, n, notes, rules)}End your reply with these ${['two', 'three'][reply.length - 2]} lines as they are:`, '', ...reply].join('\n'));
  }));
  if (out.offer) {
    const { asked, hold, ...given } = p;
    const fields = queued ? { queued: queued.id } : given;
    // The words a quote check passed against the transcript, kept for when it is gone.
    const quote = !e.page && !e.pick && ['stated', 'correction'].includes(e.kind) ? e.said : null;
    if (queueAs) {
      const id = newId('u');
      appendEntry(queueEntry({
        id, kind: out.offer.kind, why: queueAs.why, unattended: queueAs.unattended, from: null, session: sid, entry: session,
        domain: out.offer.key.split('/')[0], key: out.offer.key, fields, text: offerText(out.offer.lines, null), quote, checked: today(),
      }), f.name);
      return queueAs.reply(id);
    }
    // Made once the propose lock is released, so no propose holds two locks at once.
    if (consentOf(session) === 'prompt' && declined(sid, offerText(out.offer.lines, null))) refuse("the user denied keeping this rule at the prompt in this session. Don't offer it again unless they ask.");
    const extra = { quote, checked: queued?.checked ?? today() };
    return makeOffer({ ...out.offer, sid, entry: session, fields, hold: f.hold, extra }).reply;
  }
  // The rebuild takes seconds at thousands of notes, so it runs after the lock is released rather than hold up the other
  // proposes. The note is written by now, so a failed build costs the generated files, not the reply that names the rule.
  guarded('build', build);
  return out;
}
