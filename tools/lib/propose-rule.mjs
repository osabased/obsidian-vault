import {
  vaultPath, writeSettled, appendJsonl, appendLog, inboxFile, proposalRows, pickRows, statePath, withLock, today, localDay, toPosix, guarded,
  shortHash, isVaultOnly, sessionReach, cwdOf, proposalMode, inVaultFolder, newId, readPlain, restore, queueRows, config, rewriteText, moveFile,
} from './vault.mjs';
import {
  KEY_RE, BASES, RULE_KINDS, PAGE_WHERE, wrongBasis, parseNote, noteErrors, ruleText, ruleTextParts, sentence, loadNotes, readNote, liveRules, isLive, mentions, isUrl, validDay, byKey, normTopic, vaultFile, joinList,
  sharedFiles, rankPair, maxChars, fitIn, hasChannel, rulePath, leadPattern, isRetired, packageId, knownDomain, resolver, relink, toKey, authoredByUser, noteLinks,
} from './rules.mjs';
import { projectVersions, versionIn, compareFor } from './versions.mjs';
import { build } from './build.mjs';
import { entryKey } from './glob.mjs';
import { saidIn, normText, quoteTexts, userPageTexts, inLatest } from './quotes.mjs';
import { callerEntry, PASS, marked, markMany, wasShown, carryMarkers, carryMove, proposeDomains, sessionName } from './sessions.mjs';
import { setField, putField, setList, yamlList, yamlScalar, yamlQuote } from './frontmatter.mjs';
import { pageChange, writePage } from './propose-page.mjs';
import { subjectRows, laterRows, endedBy, otherLabels } from './picks.mjs';
import { refuse, line, lines } from './input.mjs';
import { typedFor, shortName } from './agents.mjs';
import { makeOffer, offerText, offerReply, consentOf, declined, releaseOffers, claimOffer, keptOffer, keptKeys, allOffers } from './offers.mjs';
import { entryOf, queueEntry, appendEntry, closeEntry, queueLocked, openEntries, kindIs, kindsThat } from './queue.mjs';
import { addDomain } from './add-domain.mjs';

const EVIDENCE_FIELDS = ['basis', 'quote', 'page', 'pick', 'reading', 'error', 'fix', 'file', 'source', 'source_date'];
// Every field the code below reads, so a field it doesn't read is refused rather than dropped.
const FIELDS = new Set([
  'domain', 'slug', 'kind', 'do', 'not', 'because', 'topic', ...EVIDENCE_FIELDS,
  'keywords', 'applies_to', 'triggers', 'always', 'repeats', 'asked', 'hold', 'release', 'queued', 'package',
]);
const REWORD_FIELDS = new Set(['change', 'key', 'kind', 'topic', 'do', 'not', 'because', 'applies_to', 'keywords', 'checked_with', ...EVIDENCE_FIELDS, 'hold', 'asked']);

function sessionOf(sid) {
  const entry = callerEntry(sid, { noId: `there's no session id to propose for. ${PASS}` });
  return { ...entry, domains: proposeDomains(entry) };
}

const REFS = /^raw\/refs\/./i;

const WIKI_PAGE = /^wiki\/.+\.md$/i;

function pageEvidence(page, quote) {
  if (!WIKI_PAGE.test(page)) refuse(PAGE_WHERE);
  const cited = vaultFile(page);
  if (cited === null) refuse(`there's no file at ${page} in the vault.`);
  if (!WIKI_PAGE.test(cited)) refuse(PAGE_WHERE);
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
    refuse("the vault has no transcript for this session, so it can't check the quote is the user's words. Give your own reading with basis reading instead.");
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
  const fit = fitIn(sessionReach(cwdOf({})), cwdOf({}));
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
  return !n ? ', which has since been deleted' : isRetired(n) ? ', which has since been retired' : '';
}

const sameList = (a, b) => Array.isArray(a) && a.length === b.length && a.every((x, i) => x === b[i]);

// The fields a reword may change: the rule's text, and the lists that bring it up.
const TEXT_FIELDS = ['do', 'not', 'because'];
const SCOPE_FIELDS = ['applies_to', 'keywords'];
const differs = (a, b) => TEXT_FIELDS.find(k => a[k] !== b[k]) ?? SCOPE_FIELDS.find(k => !sameList(a[k], b[k]));

function checkReadBack(n, f) {
  const fields = [
    ['domain', n.data.domain === f.domain], ['kind', n.kind === f.kind], ['basis', n.data.basis === f.basis],
    ['as_of', n.as_of === (f.as_of ?? null)], ['topic', n.data.topic === f.topic],
    ['package', packageId(n.package) === packageId(f.package)], ['checked_with', n.checked_with === ((f.package && f.checked_with) || null)],
    ['applies_to', sameList(n.applies_to, f.applies_to)], ['triggers', sameList(n.triggers, f.triggers)], ['keywords', sameList(n.keywords, f.keywords)],
    ['do', n.do === f.do], ['not', n.not === f.not], ['because', n.because === f.because],
  ];
  const bad = fields.find(([, ok]) => !ok);
  if (bad) refuse(`${bad[0]} doesn't survive as YAML. Rephrase it.`);
}

const checkChannel = f => {
  if (!hasChannel(f)) refuse('give it keywords or applies_to, or nothing will deliver it.');
};

function checkNote(n) {
  const [err] = noteErrors(n);
  if (err) refuse(`${err}.`);
  const cap = maxChars(n.kind);
  if (ruleText(n).length > cap) refuse(`${ruleTextParts(n)} come to ${ruleText(n).length} characters; keep them under ${cap} together.`);
}

// Any later session can re-propose a recorded answer, so each one backs a single rule.
function checkPick(e, rows) {
  const earlier = e.pick && rows.find(r => r.pick === e.pick);
  if (earlier) refuse(`${e.pick} was already proposed as ${earlier.note}.`);
}

// A pick is cited from the day and session it was recorded in, and a page of the user's by its path.
const citation = (f, e) => `- ${e.day ?? f.day} · ${e.label ?? e.kind} · ${e.page ?? `session ${e.session ?? f.name}`} · ${e.cite}`;
const evidenceLine = (f, e) => `${citation(f, e)} (${e.pick ? `${e.pick}; proposed as ` : ''}${f.id})`;

// A flow mapping ends a plain value at a comma or bracket.
const flowScalar = s => (/[,[\]{}]/.test(s) ? yamlQuote(s) : yamlScalar(s));

// package is given as ecosystem/name and split at the first slash, since an npm scope has one of its own.
function packageOf(p, kind) {
  const given = line(p, 'package', false);
  if (!given) return null;
  if (kind !== 'knowledge') refuse('package is for knowledge rules.');
  const at = given.indexOf('/');
  if (at < 1 || at === given.length - 1) refuse('package must be ecosystem/name, as in npm/react.');
  return { ecosystem: given.slice(0, at), name: given.slice(at + 1) };
}

// The version is read once, as the rule is first proposed, in the folder the session is in now, so its offer, keep and
// queue entry all show that one. Kept or queued, it comes back in the stored fields, and f.stored says so.
const sessionVersion = (pkg, domain, cwd) => versionIn(pkg, domain, projectVersions(sessionReach(cwd), cwd));
const storedVersion = p => line(p, 'checked_with', false) || null;
const versionLine = f => (f.checked_with ? `Checked with ${packageId(f.package)} ${f.checked_with}.` : `Package ${packageId(f.package)}: version unknown.`);

const noteText = (f, e) => [
  '---', 'type: rule', `domain: ${f.domain}`, `kind: ${f.kind}`, `basis: ${f.basis}`, ...(f.as_of ? [`as_of: ${f.as_of}`] : []),
  ...(f.package ? [`package: { ecosystem: ${flowScalar(f.package.ecosystem)}, name: ${flowScalar(f.package.name)} }`] : []),
  ...(f.package && f.checked_with ? [`checked_with: ${yamlQuote(f.checked_with)}`] : []),
  `topic: ${yamlScalar(f.topic)}`, 'always: false',
  ...yamlList('applies_to', f.applies_to), ...yamlList('triggers', f.triggers), ...yamlList('keywords', f.keywords),
  `created: ${f.day}`, `updated: ${f.day}`, '---', '',
  `**Do:** ${f.do}`, `**Not:** ${f.not}`, `**Because:**${f.because ? ` ${f.because}` : ''}`, '',
  '## Examples', '', '## Evidence', evidenceLine(f, e), '',
].join('\n');

// Below the section's last line, so its Evidence stays in the order it came in. text is plain, as readPlain gives it.
function withEvidence(text, entry) {
  const lines = text.split('\n');
  const start = lines.findIndex(l => /^## evidence\s*$/i.test(l));
  if (start < 0) return `${text.trimEnd()}\n\n## Evidence\n${entry}\n`;
  const next = lines.findIndex((l, i) => i > start && l.startsWith('## '));
  let last = (next < 0 ? lines.length : next) - 1;
  while (last > start && !lines[last].trim()) last--;
  lines.splice(last + 1, 0, entry);
  return lines.join('\n');
}

// Edits the plain text of the note at from, given with the note as it reads, and reads the result back as the note at
// rel, its new path for a move. check returns the refusal for an edit that didn't come out as meant, or null. text is
// what to write, in the note's own layout.
function editNote(from, edit, check, rel = from) {
  const file = vaultPath(...from.split('/'));
  const { text: before, ...layout } = readPlain(file);
  const was = parseNote(before, from);
  const after = edit(before, was);
  const now = parseNote(after, rel);
  const bad = check(now);
  if (bad) refuse(bad);
  return { file, was, now, text: restore(after, layout) };
}

// The key a note has now, for one that may name it from before a move.
const keyNow = (key, notes) => (typeof key === 'string' && readNote(key, notes)?.key) || key;
const sameRule = (a, b) => a === b || (notes => keyNow(a, notes) === keyNow(b, notes))(loadNotes());

// Only corrections writes at once, and only a rule from a project session: ask and off offer the change once every other
// check has passed, and keep writes it once the user agrees, so what the user agrees to is what gets written. The vault
// folder offers as ask does whatever the mode, and without off's gate, since /ingest and /lint go through each item with
// the user. A page change is always an offer. Kept, the offer's text must still be what these fields give: the rule a
// repeat backs may have changed since. A held change waits for release whatever the mode. An entry from the review
// queue is offered again in every mode, since it went there for the user's review, and a subagent's waits there for it.
// A retirement or a move is always an offer too: corrections writes what the user corrected, and neither is that.
const writesAtOnce = (kind, domain, folder) => !kindIs(kind, 'offerOnly') && !inVaultFolder(folder) && proposalMode(domain) === 'corrections';
const offNote = domain => `proposals is off for ${domain}: propose a rule only when the user asks you to keep one, with their words asking as asked.`;
// Evidence moves a knowledge rule's as_of up, so held evidence for one rule is still what the user agreed to once other
// evidence for it is written: the rule's Do, Not and Because are what its offer showed them.
const undated = (kind, text) => (kind === 'evidence' ? text.replace(/^(.*?) As of \d{4}-\d{2}-\d{2}\./, '$1') : text);
// offerOnly makes a change of a kind corrections writes at once an offer, as evidence that moves checked_with is.
function consent(f, domain, kind, key, offer, { offerOnly = false } = {}) {
  if (f.kept) {
    if (undated(kind, offerText(offer, f.kept.code)) !== undated(kind, f.kept.text)) refuse("the vault changed since the offer, so it isn't what the user agreed to. Propose it again.");
    return null;
  }
  const mode = proposalMode(domain);
  const vault = inVaultFolder(f.folder);
  const writes = !offerOnly && writesAtOnce(kind, domain, f.folder);
  if (writes && !f.hold && !f.queueAs && !f.queued) return null;
  // Checked before the offer, which no answer could approve without a transcript.
  if ((!writes || f.queued) && !f.queueAs && ((mode === 'off' && !vault) || consentOf(f.session) === 'code') && !typedFor(f.session)) {
    refuse("the vault has no transcript for this session, so it can't check the user agreed. Ask the user to write the rule in Obsidian.");
  }
  // A filter with no power to write: an offer the user didn't ask for raises no prompt.
  if (!vault && mode === 'off') {
    if (!f.asked) refuse(offNote(domain));
    if (!inLatest(f.session, f.asked)) refuse("asked isn't in the user's latest message. Wait for the user to ask for the rule, and pass their words as asked once they do.");
  }
  return { kind, key, lines: offer, offerOnly };
}

// A session that agrees by code can't agree to an offer without a transcript, so where its evidence would be written at
// once, it is written without the version move that would make it an offer.
const cantOffer = (f, domain) => !f.kept && !f.queued && !f.queueAs && writesAtOnce('evidence', domain, f.folder) && consentOf(f.session) === 'code' && !typedFor(f.session);

// Saved settled, so the rule keeps reaching sessions just when the user has corrected the agent on it. repeats may name
// a rule by a key from before a move, which names the note it moved to.
function addEvidence(f, e, scope, rules, same, row, notes) {
  const target = keyNow(f.repeats, notes);
  const rule = rules[target];
  if (!rule || !scope.includes(rule.domain)) refuse(`repeats names ${f.repeats}, which isn't a delivered rule in ${joinList(scope, 'or')}. Give the key of a rule the refusal listed.`);
  if (same?.note === target) refuse(`these words already back ${target}.`);
  let bump = versionBump(f, rule);
  if (bump && cantOffer(f, rule.domain)) bump = f.checked_with = null;
  const offer = consent(f, rule.domain, 'evidence', target, [
    `**Back this rule again?** ${target}: ${rule.text}`,
    `Its note would get this Evidence: ${sentence(e.cite)}`,
    ...(bump ? [`Its checked_with would move from ${rule.checked_with} to ${bump}, the version of ${packageId(rule.package)} here.`] : []),
  ], { offerOnly: Boolean(bump) });
  if (offer) return { offer };
  const { rel } = rule;
  const { file, was: n, now, text } = editNote(rel, (before, was) => {
    let after = withEvidence(before, evidenceLine(f, e));
    // as_of is the day the fact was last checked, so newer evidence of any kind moves it up: a source's date, or the day
    // the Evidence line gives.
    const checked = e.date ?? e.day ?? f.day;
    if (was.kind === 'knowledge' && validDay(was.as_of) && checked > was.as_of) after = setField(after, 'as_of', checked);
    return bump ? setField(after, 'checked_with', bump) : after;
  }, now => (bump && now.checked_with !== bump ? `checked_with in ${rel} isn't a line propose.mjs can change. Leave the version to the user.` : null));
  writeSettled(file, text);
  appendJsonl(inboxFile(f.name), [row(target)]);
  appendLog([`added evidence to ${target} · session ${f.name}`]);
  const [was, is] = [n, now].map(x => shortHash(ruleText(x)));
  if (was !== is) carryMarkers(f.sid, target, was, is);
  const moved = [...(now.as_of !== n.as_of ? [`as_of ${now.as_of}`] : []), ...(bump ? [`checked_with ${bump}`] : [])];
  return [
    `Added the Evidence line to ${rel}. End your reply with these two lines as they are:`,
    '',
    `**Rule backed again** ${target}: ${ruleText(now)}`,
    `Its note has a new Evidence line${moved.length ? `, and ${moved.join(' and ')}` : ''}. To change or remove it, edit ${toPosix(file)}.`,
  ].join('\n');
}

// Evidence from a project on a newer version of the rule's library moves checked_with up to it, as it moves as_of. Read
// as the evidence is first proposed, and kept in the offer's fields as f.checked_with. A stored version is compared
// again, since the rule may have moved past it since.
function versionBump(f, r) {
  f.checked_with = null;
  if (!packageId(r.package) || typeof r.checked_with !== 'string') return null;
  const got = f.stored ? { version: f.stored.version, compare: compareFor(r.domain, r.package.ecosystem) } : sessionVersion(r.package, r.domain, f.here);
  try {
    if (got?.version && got.compare && got.compare(got.version, r.checked_with) > 0) f.checked_with = got.version;
  } catch { /* a version its ecosystem can't compare moves nothing */ }
  return f.checked_with;
}

// A rule only always or tools bring up has neither.
const where = f => {
  const parts = [...(f.applies_to.length ? [`Applies to ${f.applies_to.join(', ')}`] : []), ...(f.keywords.length ? [`keywords: ${f.keywords.join(', ')}`] : [])].join(' · ');
  return parts ? `${parts.slice(0, 1).toUpperCase()}${parts.slice(1)}` : 'no keywords or applies_to';
};

const RELEASE_HEAD = 'Call `keep` for each offer below, then say in your final reply what was kept.';

// The sweep queues what a session held and never released, so a release after it names the entries to propose again.
function nothingHeld(sid) {
  const rows = queueRows();
  const swept = allOffers().filter(o => o.session === String(sid) && o.state === 'queued').map(o => o.queued_as ?? `u-${o.id.slice(2)}`)
    .filter(u => { const { entry, decided } = entryOf(u, rows); return entry?.why === 'unreleased' && !decided; });
  if (!swept.length) return 'Nothing is held in this session.';
  const one = swept.length === 1;
  return `Nothing is held in this session: what it held went to the review queue as ${joinList(swept.sort().map(u => `\`${u}\``), 'and')}. Propose ${one ? 'it' : 'each'} again with \`queued\` set to its id.`;
}

// Held offers are released together once the task is done. Rules a project session holds where the mode writes at once
// are written now; the rest go to the user as offers. The mode is read now, since the user may have changed it since the
// rule was held, and off offers only what the user asked to keep. Each offer is written or refused on its own, so one
// that fails can't take the replies of those already written with it.
function releaseHeld(sid, session, p) {
  if (p.release !== true) refuse('release must be true.');
  if (Object.keys(p).length > 1) refuse('release takes no other field. Hold each rule on its own, then release them together.');
  const held = releaseOffers(sid, typedFor(session)?.length ?? null);
  if (!held.length) return nothingHeld(sid);
  const written = [];
  const offered = [];
  for (const o of held) {
    const domain = o.key.split('/')[0];
    if (o.offerOnly || !writesAtOnce(o.kind, domain, session.cwd)) {
      if (inVaultFolder(session.cwd) || proposalMode(domain) !== 'off' || o.asked) offered.push(o);
      else if (claimOffer(o.id)) written.push(`Not offered \`${o.id}\`: ${offNote(domain)}`);
      continue;
    }
    if (!claimOffer(o.id)) continue;
    try {
      written.push(proposeRule(sid, o.fields, { kept: { text: o.text, code: o.code, offer: o.id, day: o.checked ?? localDay(o.at) } }));
    } catch (e) {
      written.push(`Not written \`${o.id}\`: ${e.message}`);
      continue;
    }
    // The note is written by now, so a failure to mark the offer costs only its state.
    guarded('release', () => keptOffer(o.id));
  }
  const blocks = offered.map(offerReply);
  return [...written, ...(blocks.length && consentOf(session) === 'prompt' ? [RELEASE_HEAD] : []), ...blocks].join('\n\n');
}

// An entry is proposed again from its own fields, and its quote checked against the session it was typed in. A rule
// entry also takes the fields its refusals ask for, repeats and slug, which replace its own.
const REDO = ['repeats', 'slug'];
function fromQueue(p) {
  if (Object.keys(p).some(k => !['queued', 'asked', ...REDO].includes(k))) refuse("queued takes no other field than asked, and repeats or slug for a rule entry: the entry's own fields are proposed again.");
  const id = line(p, 'queued');
  const { entry, decided } = entryOf(id);
  if (!entry) refuse(`there's no entry \`${id}\` in raw/queue/.`);
  if (decided) refuse(`\`${id}\` was already ${decided}.`);
  if (!kindIs(entry.kind, 'queued')) refuse(`\`${id}\` is a ${entry.kind} entry, which propose doesn't take.`);
  if (entry.kind !== 'rule' && REDO.some(k => Object.hasOwn(p, k))) refuse(`repeats and slug are for a rule entry, and \`${id}\` is a ${entry.kind} entry.`);
  return entry;
}

// One inbox row per rule written or changed. A queued entry's row names the session the words were typed in, so lint
// finds them there or in this row.
const inboxRow = ({ f, e, at, session, sid, kept, queued, rules, change }) => note => {
  const from = queued ?? { ...session, session: sid };
  return {
    id: f.id, at, source: 'agent', kind: e.kind, text: e.said, ...(e.fix ? { fix: e.fix } : {}),
    note, ...(change ? { change } : {}), session: from.session, agent: from.agent ?? null, transcript: from.transcript ?? null, cwd: from.cwd ?? null,
    domain: rules[note]?.domain ?? f.domain, ...(e.pick ? { pick: e.pick } : {}), ...(e.page ? { page: e.page } : {}),
    ...(kept?.consent ? { consent: kept.consent, ...(kept.approved ? { approved: kept.approved } : {}) } : {}),
    ...(queued ? { queued: queued.id } : {}),
  };
};

// Under queue.lock too for a queued entry, so a drop can't land between the check and the kept row. done closes the
// entry once a reply says what was written.
function locked(f, queued, session, fn) {
  return withLock(statePath('propose.lock'), () => (queued ? queueLocked : g => g())(() => {
    const decided = queued && entryOf(queued.id).decided;
    if (decided) refuse(`\`${queued.id}\` was already ${decided}.`);
    const done = reply => {
      if (queued && typeof reply === 'string') closeEntry({ id: queued.id, decision: 'kept', offer: f.kept?.offer ?? null, sid: f.sid, agentName: session.agent });
      return reply;
    };
    return fn(done);
  }));
}

// What follows an offer: a subagent's goes to the review queue, the rest are stored for keep. Made once the propose lock
// is released, so no propose holds two locks at once.
function offered(f, session, offer, { fields, quote, queued, noun }) {
  if (f.queueAs) {
    const id = newId('u');
    appendEntry(queueEntry({
      id, kind: offer.kind, why: f.queueAs.why, unattended: f.queueAs.unattended, from: null, session: f.sid, entry: session,
      domain: offer.key.split('/')[0], key: offer.key, fields, text: offerText(offer.lines, null), quote, checked: today(),
    }), f.name);
    return f.queueAs.reply(id);
  }
  if (consentOf(session) === 'prompt' && declined(f.sid, offerText(offer.lines, null))) refuse(`the user denied keeping this ${noun} at the prompt in this session. Don't offer it again unless they ask.`);
  const { offerOnly, ...made } = offer;
  const extra = { quote, checked: queued?.checked ?? today(), ...(f.asked ? { asked: true } : {}), ...(offerOnly ? { offerOnly } : {}) };
  return makeOffer({ ...made, sid: f.sid, entry: session, fields, hold: f.hold, extra }).reply;
}

const baseOf = (sid, session, p, { kept, queueAs, queued }) => {
  const asked = line(p, 'asked', false);
  const hold = p.hold ?? false;
  if (typeof hold !== 'boolean') refuse('hold must be true or false.');
  // folder is where the session started, which decides how it proposes; here is where it is now, as /vault status reads it.
  const here = session.last_cwd ?? session.reach?.cwd ?? session.cwd;
  return { sid, name: shortName(sid, session.agent), session, folder: session.cwd, here, asked, kept, queueAs, queued: queued?.id ?? null, hold };
};

// The rebuild takes seconds at thousands of notes, so it runs after the lock is released rather than hold up the other
// proposes. The note is written by now, so a failed build costs the generated files, not the reply that names the rule.
function settle(f, session, out, args) {
  if (out.offer) return offered(f, session, out.offer, args);
  guarded('build', build);
  return out;
}

// The words a quote check passed against the transcript, kept for when it is gone.
const offerQuote = e => (!e.page && !e.pick && ['stated', 'correction'].includes(e.kind) ? e.said : null);

// base, the hash the change was offered against, is the stored offer's or the queue entry's, and only theirs.
function proposePage(sid, session, p, opts) {
  const { kept, queued } = opts;
  const { base: given, ...rest } = p;
  const base = queued ? queued.fields.base : kept ? given : undefined;
  if (kept || queued) p = rest;
  const f = baseOf(sid, session, p, opts);
  let change;
  const out = locked(f, queued, session, done => {
    change = pageChange(p, { sid, domains: [...session.domains, 'global'], vault: inVaultFolder(session.cwd), kept, queued, base });
    const offer = consent(f, change.domain, 'page', change.key, change.lines);
    return offer ? { offer } : done(writePage(change, f.name));
  });
  const fields = queued ? { queued: queued.id } : { page: change.rel, text: change.text, base: change.base };
  return settle(f, session, out, { fields, quote: null, queued, noun: 'page change' });
}

// The lead line of name in the note's body, before its first ## section, or added below the others. text is plain, as
// readPlain gives it.
function setLead(text, name, value) {
  const lines = text.split('\n');
  const start = /^---\s*$/.test(lines[0]) ? lines.findIndex((l, i) => i > 0 && /^---\s*$/.test(l)) + 1 : 0;
  const next = lines.findIndex((l, i) => i >= start && l.startsWith('## '));
  const end = next < 0 ? lines.length : next;
  const lead = new RegExp(leadPattern(name));
  const at = lines.findIndex((l, i) => i >= start && i < end && lead.test(l));
  const written = `**${name}:**${value ? ` ${value}` : ''}`;
  if (at >= 0) lines[at] = written;
  else {
    let last = end - 1;
    while (last >= start && !lines[last].trim()) last--;
    lines.splice(last + 1, 0, written);
  }
  return lines.join('\n');
}

// The live rule a change names, in a domain the session proposes to. A key from before a move names the note it moved to.
function changedRule(p, session, fields, takes) {
  const unknown = Object.keys(p).find(k => !fields.has(k));
  if (unknown) refuse(`${unknown} isn't a field of a ${p.change}, which takes ${takes}.`);
  const named = line(p, 'key').normalize('NFC');
  if (!KEY_RE.test(named)) refuse('key must be a rule key like example-ui/flat-buttons.');
  const domains = [...session.domains, 'global'];
  const rule = liveNote(named);
  if (!rule || !domains.includes(rule.domain)) refuse(`key names ${named}, which isn't a delivered rule in ${joinList(domains, 'or')}.`);
  return { key: rule.key, rule };
}

const liveNote = (key, notes = loadNotes()) => {
  const n = readNote(key, notes);
  return n && isLive(n) ? n : null;
};

// Read again under the lock, so a change made since the check is seen.
function stillLive(key, notes) {
  const rule = liveNote(key, notes);
  if (!rule) refuse(`${key} changed since it was checked: it isn't a delivered rule any more.`);
  return rule;
}

// What an offer stores to be proposed again from: the queue entry's id, or the fields given less asked and hold, which
// the offer records on its own.
function offerFields(p, queued) {
  if (queued) return { queued: queued.id };
  const { asked, hold, ...rest } = p;
  return rest;
}

// What follows a retirement or a move: it is written, or returned as an offer. Neither takes evidence, so neither is
// recorded in raw/inbox/; keep records the user's agreement on the offer, and log.md the change. The notes are read once
// under the lock, for the check and the write.
function changeNote(sid, session, p, opts, { kind, check, lines, write }) {
  const f = { ...baseOf(sid, session, p, opts), day: opts.kept?.day || today() };
  const out = locked(f, opts.queued, session, done => {
    const notes = loadNotes();
    const rule = check(notes);
    const offer = consent(f, rule.domain, kind, rule.key, lines(rule));
    return offer ? { offer } : done(write(rule, f, notes));
  });
  return settle(f, session, out, { fields: offerFields(p, opts.queued), quote: null, queued: opts.queued, noun: `rule ${kind === 'move' ? 'move' : 'retirement'}` });
}

const RETIRE_FIELDS = new Set(['change', 'key', 'because', 'superseded_by', 'hold', 'asked']);
const MOVE_FIELDS = new Set(['change', 'key', 'domain', 'hold', 'asked']);

// A retired rule keeps its note and its links; the hooks skip it as they skip a superseded one.
function retire(sid, session, p, opts) {
  const { key } = changedRule(p, session, RETIRE_FIELDS, 'because, why the rule is retired, and superseded_by, the rule that replaces it if one does');
  const because = line(p, 'because');
  const by = line(p, 'superseded_by', false).normalize('NFC');
  const check = notes => {
    const rule = stillLive(key, notes);
    // A key from before a move names the note it moved to, which may be this rule.
    const other = by && KEY_RE.test(by) ? liveNote(by, notes) : null;
    if (by && (!other || other.key === rule.key)) refuse(`superseded_by names ${by}, which isn't another delivered rule.`);
    return rule;
  };
  return changeNote(sid, session, p, opts, {
    kind: 'retire', check,
    lines: rule => [`**Retire this rule?** ${key}: ${ruleText(rule)}`, `Because: ${sentence(because)}${by ? ` Superseded by ${by}.` : ''}`],
    write(rule, f) {
      const { file, now: n, text } = editNote(rule.rel, before => {
        const after = putField(putField(before, 'retired', f.day), 'retired_because', because);
        return setField(by ? putField(after, 'superseded_by', by) : after, 'updated', f.day);
      }, n => (n.retired !== f.day || n.data.retired_because !== because || (by && n.superseded_by !== by) ? "because doesn't survive as YAML. Rephrase it." : null));
      writeSettled(file, text);
      appendLog([`retired ${key} · session ${f.name}`]);
      return [
        `Retired ${rule.rel}. End your reply with these two lines as they are:`,
        '',
        `**Rule retired** ${key}: ${ruleText(n)}`,
        `It no longer reaches sessions. To bring it back, delete its retired lines${by ? ' and its superseded_by line' : ''} in ${toPosix(file)}.`,
      ].join('\n');
    },
  });
}

// Only a note whose body holds the slug can link the rule, so the rest aren't read for links. A slug outside ASCII may
// be percent-encoded in a Markdown link, so for one every note is read.
const mayLink = (n, slug) => !/^[\x20-\x7e]*$/.test(slug) || n.body.toLowerCase().includes(slug);

// A move changes the rule's key, so the links that name it are rewritten as lint --fix rewrites them, except on the
// user's own pages, and moved_from keeps the old key resolving for the Evidence, inbox rows and links that still name it.
function move(sid, session, p, opts) {
  const { key, rule: was } = changedRule(p, session, MOVE_FIELDS, 'domain, the domain it moves to');
  const to = line(p, 'domain').normalize('NFC');
  // /lint drafts a domain and the moves into it together, so a draft may name a domain the queue holds.
  const drafted = opts.queueAs ? openEntries().find(r => r.kind === 'domain' && r.key === to) : null;
  if (!knownDomain(to) && !drafted) refuse(`there's no domain ${to}. Start it with the vault's \`domain\` tool first, then move the rule.`);
  if (isVaultOnly(to) || drafted?.fields?.vaultOnly === true) refuse(`${to} is vaultOnly: it holds pages, not rules.`);
  if (to === was.domain) refuse(`${key} is in ${to} already.`);
  const next = `${to}/${was.slug}`;
  const rel = rulePath(next);
  const check = notes => {
    const rule = stillLive(key, notes);
    // A rule moving back to its old key has that key as its own moved_from, which doesn't take the key.
    const taken = readNote(next, notes.filter(n => n.rel !== rule.rel)) ?? (vaultFile(rel) ? { rel } : null);
    if (taken) refuse(`${taken.rel} already exists, so ${key} can't move there. Leave that note to the user.`);
    return rule;
  };
  return changeNote(sid, session, p, opts, {
    kind: 'move', check,
    lines: rule => [`**Move this rule?** ${key} to ${next}: ${ruleText(rule)}`],
    write(rule, f, notes) {
      const resolve = resolver(notes);
      const names = t => resolve(toKey(t)) === key;
      const moved = { rel, slug: rule.slug };
      const { file, now: n, text } = editNote(rule.rel, before => relink(rel, names, moved)(putField(setField(before, 'domain', to), 'moved_from', key)),
        n => (n.key !== next || n.moved_from !== key || ruleText(n) !== ruleText(rule) ? `${rule.rel} isn't in a form propose.mjs can move. Leave the move to the user.` : null), rel);
      const target = vaultPath(...rel.split('/'));
      // The rename goes first, so a note another program holds open stops the move before anything is written, and the
      // note is never in two places.
      try {
        moveFile(file, target);
      } catch (e) {
        refuse(`${rule.rel} couldn't be moved to ${rel} (${e.code ?? e.message}), so nothing changed. Propose the move again once no other program has the note open.`);
      }
      // A move leaves what the rule says as it was, so the note keeps its day and the pages that link it don't go stale.
      try {
        rewriteText(target, text);
      } catch (e) {
        guarded('move back', () => moveFile(target, file));
        throw e;
      }
      const relinked = [];
      // A rule whose links name the moved one changes its wording hash with them, though not what it says.
      const rehashed = [];
      for (const other of notes) {
        if (other.rel === rule.rel || !mayLink(other, rule.slug) || !noteLinks(other).some(names)) continue;
        const at = vaultPath(...other.rel.split('/'));
        const { text: before, ...layout } = readPlain(at);
        if (authoredByUser(before)) continue;
        const after = relink(other.rel, names, moved)(before);
        if (after === before) continue;
        rewriteText(at, restore(after, layout));
        relinked.push(other.rel);
        if (other.type !== 'rule') continue;
        const [from, now] = [other, parseNote(after, other.rel)].map(x => shortHash(ruleText(x)));
        if (from !== now) rehashed.push({ key: other.key, from, to: now });
      }
      carryMove(key, next, rehashed);
      appendLog([`moved ${key} to ${next} · session ${f.name}`]);
      return [
        `Moved ${rule.rel} to ${rel}${relinked.length ? `, and rewrote the links to it in ${joinList(relinked, 'and')}` : ''}. End your reply with these two lines as they are:`,
        '',
        `**Rule moved** ${key} to ${next}: ${ruleText(n)}`,
        `To change or remove it, edit ${toPosix(target)}.`,
      ].join('\n');
    },
  });
}

// A reword replaces what it gives of the rule's Do, Not, Because, applies_to, keywords, kind and topic, and backs the
// change with evidence as a new rule is backed. The note keeps its other lines, its Evidence among them.
function reword(sid, session, p, opts) {
  const { key, rule: old } = changedRule(p, session, REWORD_FIELDS, 'the new do, not, because, applies_to, keywords, kind, topic or checked_with and the evidence for the change');
  const base = baseOf(sid, session, p, opts);
  const { kept, queued } = opts;
  const versionOnly = isVersionOnly(p);
  const basis = versionOnly ? null : line(p, 'basis');
  const kind = Object.hasOwn(p, 'kind') ? line(p, 'kind') : old.kind;
  if (!BASES[kind]) refuse(`kind must be ${joinList(RULE_KINDS, 'or')}.`);
  // Leaving knowledge would drop as_of, requires, package and checked_with, which a retirement records and a reword doesn't.
  if (old.kind === 'knowledge' && kind !== 'knowledge') refuse(`${key} is a knowledge rule. To make it a ${kind} rule, retire it and propose it again.`);
  if (!versionOnly && !BASES[kind].includes(basis)) refuse(`${wrongBasis(kind, basis)}.`);
  const given = (name, read = line) => (Object.hasOwn(p, name) ? read(p, name) : old[name]);
  const f = {
    ...base, domain: old.domain, slug: old.slug, kind, topic: Object.hasOwn(p, 'topic') ? line(p, 'topic') : old.data.topic, basis,
    do: given('do'), not: given('not'), because: given('because', (q, k) => line(q, k, false)),
    applies_to: given('applies_to', lines), keywords: given('keywords', lines), checked_with: given('checked_with'),
    tools: old.tools, always: old.always, day: kept?.day || today(), id: newId('a'),
  };
  // Topics are free text, so a topic that differs only in case or spacing is the same one.
  const topicMoved = normTopic(f.topic) !== old.topic;
  if (!differs(old, f) && f.kind === old.kind && !topicMoved && f.checked_with === old.checked_with) refuse(`the reword leaves ${key} as it is. Give the new do, not, because, applies_to, keywords, kind, topic or checked_with.`);
  checkChannel(f);
  const e = versionOnly ? null : evidence(f, p);
  if (e && queued && !e.pick) Object.assign(e, { day: queued.checked, session: sessionName(queued.session, queued.agent) });
  if (e) checkQuote(queued ? { agent: queued.agent, transcript: queued.transcript } : session, e, queued);
  const at = new Date().toISOString();

  const out = locked(f, queued, session, done => {
    const { file, was, now: n, text } = editNote(old.rel, (before, was) => {
      let after = before;
      for (const k of TEXT_FIELDS) if (f[k] !== was[k]) after = setLead(after, `${k[0].toUpperCase()}${k.slice(1)}`, f[k]);
      for (const k of SCOPE_FIELDS) if (!sameList(was[k], f[k])) after = setList(after, k, f[k]);
      if (f.checked_with !== was.checked_with) after = putField(after, 'checked_with', f.checked_with);
      if (topicMoved) after = putField(after, 'topic', f.topic);
      after = setField(after, 'updated', f.day);
      if (!e) return after;
      // As for new evidence, as_of moves up to the day the change was checked. Moving the rule to another topic alone
      // checks nothing about the fact.
      const checked = e.date ?? e.day ?? f.day;
      const refiled = topicMoved && !differs(was, f) && f.kind === was.kind;
      if (was.kind === 'knowledge' && !refiled && validDay(was.as_of) && checked > was.as_of) after = setField(after, 'as_of', checked);
      if (f.kind !== was.kind) after = setField(after, 'kind', f.kind);
      if (f.kind === 'knowledge' && was.kind !== 'knowledge') after = putField(after, 'as_of', checked);
      return withEvidence(after, evidenceLine(f, e));
    }, n => {
      const bad = differs(n, f) ?? (n.kind === f.kind ? null : 'kind') ?? (n.topic === normTopic(f.topic) ? null : 'topic') ?? (n.checked_with === f.checked_with ? null : 'checked_with');
      return bad ? `${bad} doesn't survive as the note's text. Rephrase it.` : null;
    });
    checkNote(n);
    if (e) checkPick(e, e.pick ? proposalRows() : []);
    const kinds = was.kind === f.kind ? [] : [`Was: a ${was.kind} rule`, `Now: a ${f.kind} rule`];
    const topics = topicMoved ? [`Was: topic ${was.data.topic}`, `Now: topic ${f.topic}`] : [];
    const scope = where(was) === where(f) ? [] : [`Was: ${where(was)}`, `Now: ${where(f)}`];
    const version = f.checked_with === was.checked_with ? [] : [`Was: ${versionLine(was)}`, `Now: ${versionLine(n)}`];
    const head = versionOnly || ruleText(was) === ruleText(n) ? [`**Change this rule?** ${key}: ${ruleText(n)}`] : [`**Change this rule?** ${key}`, `Was: ${ruleText(was)}`, `Now: ${ruleText(n)}`];
    const offer = consent(f, f.domain, 'reword', key, versionOnly ? [...head, ...version] : [...head, ...kinds, ...topics, ...scope, ...version, `Its note would get this Evidence: ${sentence(e.cite)}`],
    // checked_with decides which projects the rule reaches, and the user confirms the version, as for evidence that moves it.
    { offerOnly: version.length > 0 });
    if (offer) return { offer };
    writeSettled(file, text);
    if (e) appendJsonl(inboxFile(f.name), [inboxRow({ f, e, at, session, sid, kept, queued, rules: {}, change: 'reword' })(key)]);
    appendLog([`reworded ${key} · session ${f.name}`]);
    return done([
      `Changed ${old.rel}. End your reply with these two lines as they are:`,
      '',
      `**Rule changed** ${key}: ${ruleText(n)}`,
      `To change or remove it, edit ${toPosix(file)}.`,
    ].join('\n'));
  });
  return settle(f, session, out, { fields: offerFields(p, queued), quote: e && offerQuote(e), queued, noun: 'rule change' });
}

// The version a rule was checked with comes from a lockfile, not from anyone's words, so a reword that only fills it
// cites no one, as a page change, a retirement and a move don't.
const isVersionOnly = p => Object.hasOwn(p, 'checked_with') && !Object.hasOwn(p, 'basis') && ![...TEXT_FIELDS, ...SCOPE_FIELDS, 'kind', 'topic'].some(k => Object.hasOwn(p, k));
export const citesNoOne = p => kindIs(changeKind(p), 'citesNoOne') || (changeKind(p) === 'reword' && isVersionOnly(p));

const CHANGES = { reword, retire, move };
// A change of no kind it knows is taken for a reword, and changeRule refuses it.
export const changeKind = p => (Object.hasOwn(p, 'text') ? 'page'
  : Object.hasOwn(p, 'change') ? (kindIs(p.change, 'change') ? p.change : 'reword') : 'rule');

function changeRule(sid, session, p, opts) {
  if (!Object.hasOwn(p, 'key')) refuse('change needs key, the rule it changes, like example-ui/flat-buttons.');
  const change = line(p, 'change');
  if (!kindIs(change, 'change')) refuse(`change must be ${joinList(kindsThat('change'), 'or')}.`);
  return CHANGES[change](sid, session, p, opts);
}

// The input is read after the session is checked, so a script run from the wrong place says that first: p is the input,
// or a function that reads it. kept is how the user agreed to the offer keep writes: { consent: 'prompt' }, or
// { consent: 'code', approved } with their typed reply, and the offer's id, text and code to check it against. queueAs
// sends the rule to the review queue instead of offering it: { why, unattended, reply } gives the entry's reasons and
// what to say once it is queued. kept.day is the day the offer was made, so a keep after midnight writes what was offered.
// mainWorktree is lib/git.mjs's, passed in by the script for a domain entry from the queue, as addDomain takes it.
export function proposeRule(sid, p, { kept = null, queueAs = null, mainWorktree = null } = {}) {
  const session = sessionOf(sid);
  if (typeof p === 'function') p = p();
  // A subagent's rules wait in the queue, so the session's held offers and the queue's entries are left to the main agent.
  for (const k of ['release', 'queued']) if (queueAs && p && Object.hasOwn(p, k)) refuse(`a subagent's rules wait in the review queue for the user, so ${k} is for the main session.`);
  if (p && Object.hasOwn(p, 'release')) return releaseHeld(sid, session, p);
  const queued = p && Object.hasOwn(p, 'queued') ? fromQueue(p) : null;
  if (queued?.kind === 'domain') return addDomain(sid, queued.fields, { queued, mainWorktree });
  const redo = queued ? Object.fromEntries(REDO.filter(k => Object.hasOwn(p, k)).map(k => [k, p[k]])) : {};
  if (queued) {
    // The stored checked_with is the version read for what the entry offered, so evidence for another rule moves none.
    const { checked_with: _, ...stored } = queued.fields;
    const fields = Object.hasOwn(redo, 'repeats') && !sameRule(redo.repeats, queued.fields.repeats) ? stored : queued.fields;
    p = { ...fields, ...redo, ...(Object.hasOwn(p, 'asked') ? { asked: p.asked } : {}) };
  }
  const opts = { kept, queueAs, queued };
  const kind = changeKind(p);
  // Offers and queue entries made before propose asked for a kind were taste rules.
  if ((kept || queued) && kind === 'rule' && !Object.hasOwn(p, 'kind')) p = { ...p, kind: 'taste' };
  if (kind === 'page') return proposePage(sid, session, p, opts);
  if (kind !== 'rule') return changeRule(sid, session, p, opts);
  // checked_with comes from the lockfile, so only a stored offer or queue entry gives it.
  const unknown = Object.keys(p).find(k => !FIELDS.has(k) && !(k === 'checked_with' && (kept || queued)));
  if (unknown) refuse(`${unknown} isn't a field propose.mjs takes. Fields like requires and tools are added to the note by hand. The \`propose\` tool's schema lists the fields.`);
  const domains = [...session.domains, 'global'];
  // Slugs compare in NFC, so a slug typed with combining accents names the same note as its composed spelling.
  const f = { ...baseOf(sid, session, p, opts), domain: line(p, 'domain').normalize('NFC'), slug: line(p, 'slug').normalize('NFC') };
  // A vault-only domain isn't offered, and the note's own check says why it takes no rule.
  if (!domains.includes(f.domain) && !isVaultOnly(f.domain)) {
    refuse(`domain must be ${joinList(domains, 'or')}. For a rule that holds only in projects of a kind no domain covers, suggest a new domain to the user, and once they agree start it with the vault's \`domain\` tool.`);
  }
  const key = `${f.domain}/${f.slug}`;
  if (!KEY_RE.test(key)) refuse('slug must be lowercase-kebab-case.');
  f.kind = line(p, 'kind', false);
  if (!BASES[f.kind]) refuse(`kind must be ${joinList(RULE_KINDS, 'or')}.`);
  f.topic = line(p, 'topic');
  f.basis = line(p, 'basis');
  if (!BASES[f.kind].includes(f.basis)) refuse(`${wrongBasis(f.kind, f.basis)}.`);
  Object.assign(f, { do: line(p, 'do'), not: line(p, 'not'), because: line(p, 'because', false) });
  Object.assign(f, { applies_to: lines(p, 'applies_to'), triggers: lines(p, 'triggers'), keywords: lines(p, 'keywords') });
  const always = p.always ?? false;
  if (typeof always !== 'boolean') refuse('always must be true or false.');
  // The user chose to set always: true by hand; the note carries always: false for them to flip.
  if (always) refuse("always is the user's to set in Obsidian. Give the rule keywords or applies_to instead.");
  checkChannel(f);
  const scope = f.domain === 'global' ? domains : [f.domain, 'global'];
  f.repeats = line(p, 'repeats', false).normalize('NFC');
  if (f.repeats && !KEY_RE.test(f.repeats)) refuse('repeats must be a rule key like example-ui/flat-buttons.');
  f.package = packageOf(p, f.kind);
  f.stored = kept || queued ? { version: storedVersion(p) } : null;
  // For a repeat, addEvidence sets the version its evidence moves checked_with to once it has the rule.
  f.checked_with = !f.package || f.repeats ? null : f.stored ? f.stored.version : sessionVersion(f.package, f.domain, f.here)?.version ?? null;
  const e = evidence(f, p);
  if (queued && !e.pick) Object.assign(e, { day: queued.checked, session: sessionName(queued.session, queued.agent) });
  checkQuote(queued ? { agent: queued.agent, transcript: queued.transcript } : session, e, queued);

  const at = new Date().toISOString();
  Object.assign(f, { day: kept?.day || today(), id: newId('a') });
  if (f.kind === 'knowledge') f.as_of = e.date ?? e.day ?? f.day;
  const text = noteText(f, e);
  const rel = rulePath(key);
  const n = parseNote(text, rel);
  checkReadBack(n, f);
  checkNote(n);

  const out = locked(f, queued, session, done => {
    const rows = proposalRows();
    checkPick(e, rows);
    // Read under the lock, so a proposal written meanwhile is on the list.
    const notes = loadNotes();
    const rules = liveRules(notes);
    // One correction can back two rules, so the same words refuse once and the retry goes through.
    // One error can show several facts, so a failure matches an earlier one only with the same fix.
    // A row names its note by the key it had then, so a note moved since is named by its key now.
    const found = rows.find(r => normText(r.text ?? '') === normText(e.said) && (!e.fix || normText(r.fix ?? '') === normText(e.fix)));
    const same = found && { ...found, note: keyNow(found.note, notes) };
    const row = inboxRow({ f, e, at, session, sid, kept, queued, rules });
    if (f.repeats) return done(addEvidence(f, e, scope, rules, same, row, notes));
    const taken = readNote(key, notes);
    if (taken) refuse(`${taken.rel} already exists. Pick another slug, or leave that note to the user.`);
    // The rules this session wrote from its own offers, earlier in a release or by an earlier keep, were offered beside
    // this one, so only a rule written elsewhere since the offer makes its keep refuse.
    const own = new Set(kept ? [...keptKeys(sid)].map(k => keyNow(k, notes)) : []);
    const listed = own.size ? Object.fromEntries(Object.entries(rules).filter(([k]) => !own.has(k))) : rules;
    const overlaps = checkRepeats(f, ruleText(n), scope, listed, own.has(same?.note) ? null : same, notes);
    const version = f.package ? [versionLine(f)] : [];
    const offer = consent(f, f.domain, 'rule', key, [`**Keep this rule?** ${key}: ${ruleText(n)}`, where(f), ...version]);
    if (offer) return { offer };
    const file = vaultPath(...rel.split('/'));
    writeSettled(file, text);
    appendJsonl(inboxFile(f.name), [row(key)]);
    appendLog([`wrote ${key} · session ${f.name}`]);
    const reply = [
      `**New ${f.kind === 'knowledge' ? 'knowledge rule' : 'rule'}** ${key}: ${ruleText(n)}`,
      ...version,
      ...(overlaps.length ? [`It may overlap ${joinList(overlaps, 'and')}.`] : []),
      `It applies from now on. To change or remove it, edit or delete ${toPosix(file)}.`,
    ];
    const head = `Wrote ${rel}. ${sameFiles(f, n, notes, rules)}${entityHint(f, rules, notes)}`;
    return done([`${head}End your reply with these ${['two', 'three', 'four'][reply.length - 2]} lines as they are:`, '', ...reply].join('\n'));
  });
  const { asked, hold, ...given } = p;
  const fields = queued ? { queued: queued.id, ...redo } : { ...given, ...(f.checked_with ? { checked_with: f.checked_with } : {}) };
  return settle(f, session, out, { fields, quote: offerQuote(e), queued, noun: 'rule' });
}

// Once a library has enough rules, an entity page collects them, which the agent offers with its other held changes.
function entityHint(f, rules, notes) {
  const id = packageId(f.package);
  if (!id) return '';
  const count = Object.values(rules).filter(r => packageId(r.package) === id).length + 1;
  if (count < config().pages.entityAfterRules) return '';
  if (notes.some(n => n.type === 'page' && n.kind === 'entity' && packageId(n.package) === id)) return '';
  return `${count} live rules now name ${id}, and no entity page does. Hold a page change that adds wiki/${f.domain}/entities/<library>.md with kind: entity and this package, and release it before your final reply. `;
}
