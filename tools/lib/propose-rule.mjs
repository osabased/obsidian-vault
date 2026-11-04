import {
  vaultPath, writeSettled, appendJsonl, appendLog, inboxFile, proposalRows, pickRows, statePath, withLock, today, localDay, toPosix, guarded,
  shortHash, isVaultOnly, sessionReach, cwdOf, proposalMode, inVaultFolder, newId, readPlain, restore,
} from './vault.mjs';
import {
  KEY_RE, BASES, PAGE_WHERE, wrongBasis, parseNote, noteErrors, ruleText, ruleTextParts, loadNotes, readNote, liveRules, isLive, mentions, isUrl, validDay, byKey, normTopic, domainTopics, vaultFile, joinList,
  sharedFiles, rankPair, maxChars, fitIn, hasChannel, rulePath, leadPattern,
} from './rules.mjs';
import { build } from './build.mjs';
import { entryKey } from './glob.mjs';
import { saidIn, normText, quoteTexts, userPageTexts, inLatest } from './quotes.mjs';
import { callerEntry, PASS, marked, markMany, wasShown, carryMarkers, proposeDomains, sessionName } from './sessions.mjs';
import { setField, setList, yamlList, yamlScalar } from './frontmatter.mjs';
import { pageChange, writePage } from './propose-page.mjs';
import { subjectRows, laterRows, endedBy, otherLabels } from './picks.mjs';
import { refuse, line, lines, Refused } from './input.mjs';
import { typedFor, shortName } from './agents.mjs';
import { makeOffer, offerText, offerReply, consentOf, declined, releaseOffers, claimOffer, keptOffer } from './offers.mjs';
import { entryOf, queueEntry, appendEntry, closeEntry, queueLocked } from './queue.mjs';

const EVIDENCE_FIELDS = ['basis', 'quote', 'page', 'pick', 'reading', 'error', 'fix', 'file', 'source', 'source_date'];
// Every field the code below reads, so a field it doesn't read is refused rather than dropped.
const FIELDS = new Set([
  'domain', 'slug', 'kind', 'do', 'not', 'because', 'topic', ...EVIDENCE_FIELDS,
  'keywords', 'applies_to', 'triggers', 'always', 'repeats', 'asked', 'hold', 'release', 'queued',
]);
const REWORD_FIELDS = new Set(['change', 'key', 'do', 'not', 'because', 'applies_to', 'keywords', ...EVIDENCE_FIELDS, 'hold', 'asked']);

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

// The fields a reword may change: the rule's text, and the lists that bring it up.
const TEXT_FIELDS = ['do', 'not', 'because'];
const SCOPE_FIELDS = ['applies_to', 'keywords'];
const differs = (a, b) => TEXT_FIELDS.find(k => a[k] !== b[k]) ?? SCOPE_FIELDS.find(k => !sameList(a[k], b[k]));

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

const noteText = (f, e) => [
  '---', 'type: rule', `domain: ${f.domain}`, `kind: ${f.kind}`, `basis: ${f.basis}`, ...(f.as_of ? [`as_of: ${f.as_of}`] : []),
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

// Only corrections writes at once, and only a rule from a project session: ask and off offer the change once every other
// check has passed, and keep writes it once the user agrees, so what the user agrees to is what gets written. The vault
// folder offers as ask does whatever the mode, and without off's gate, since /ingest and /lint go through each item with
// the user. A page change is always an offer. Kept, the offer's text must still be what these fields give: the rule a
// repeat backs may have changed since. A held change waits for release whatever the mode. An entry from the review
// queue is offered again in every mode, since it went there for the user's review, and a subagent's waits there for it.
const writesAtOnce = (kind, domain, folder) => kind !== 'page' && !inVaultFolder(folder) && proposalMode(domain) === 'corrections';
function consent(f, domain, kind, key, offer) {
  if (f.kept) {
    if (offerText(offer, f.kept.code) !== f.kept.text) refuse("the vault changed since the offer, so it isn't what the user agreed to. Propose it again.");
    return null;
  }
  const mode = proposalMode(domain);
  const vault = inVaultFolder(f.folder);
  const writes = writesAtOnce(kind, domain, f.folder);
  if (writes && !f.hold && !f.queueAs && !f.queued) return null;
  // Checked before the offer, which no answer could approve without a transcript.
  if ((!writes || f.queued) && !f.queueAs && ((mode === 'off' && !vault) || consentOf(f.session) === 'code') && !typedFor(f.session)) {
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
  const { text: before, ...layout } = readPlain(file);
  const n = parseNote(before, rel);
  let after = withEvidence(before, evidenceLine(f, e));
  // as_of is the day the fact was last checked, so newer evidence of any kind moves it up: a source's date, or the day
  // the Evidence line gives.
  const checked = e.date ?? e.day ?? f.day;
  if (n.kind === 'knowledge' && validDay(n.as_of) && checked > n.as_of) after = setField(after, 'as_of', checked);
  const now = parseNote(after, rel);
  writeSettled(file, restore(after, layout));
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

// A rule only always or tools bring up has neither.
const where = f => {
  const parts = [...(f.applies_to.length ? [`Applies to ${f.applies_to.join(', ')}`] : []), ...(f.keywords.length ? [`keywords: ${f.keywords.join(', ')}`] : [])].join(' · ');
  return parts ? `${parts.slice(0, 1).toUpperCase()}${parts.slice(1)}` : 'no keywords or applies_to';
};

const RELEASE_HEAD = 'Call `keep` for each offer below, then say in your final reply what was kept.';

// Held offers are released together once the task is done. Rules a project session holds where the mode writes at once
// are written now; the rest go to the user as offers. The mode is read now, since the user may have changed it since the
// rule was held.
function releaseHeld(sid, session, p) {
  if (p.release !== true) refuse('release must be true.');
  if (Object.keys(p).length > 1) refuse('release takes no other field. Hold each rule on its own, then release them together.');
  const held = releaseOffers(sid, typedFor(session)?.length ?? null);
  if (!held.length) return 'Nothing is held in this session.';
  const written = [];
  const offered = [];
  for (const o of held) {
    if (!writesAtOnce(o.kind, o.key.split('/')[0], session.cwd)) offered.push(o);
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
  if (!['rule', 'evidence', 'page', 'reword'].includes(entry.kind)) refuse(`\`${id}\` is a ${entry.kind} entry, which propose doesn't take.`);
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
  const extra = { quote, checked: queued?.checked ?? today() };
  return makeOffer({ ...offer, sid: f.sid, entry: session, fields, hold: f.hold, extra }).reply;
}

const baseOf = (sid, session, p, { kept, queueAs, queued }) => {
  const asked = line(p, 'asked', false);
  const hold = p.hold ?? false;
  if (typeof hold !== 'boolean') refuse('hold must be true or false.');
  return { sid, name: shortName(sid, session.agent), session, folder: session.cwd, asked, kept, queueAs, queued: queued?.id ?? null, hold };
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

// A reword replaces what it gives of the rule's Do, Not, Because, applies_to and keywords, and backs the change with
// evidence as a new rule is backed. The note keeps its other lines, its Evidence among them.
function reword(sid, session, p, opts) {
  if (!Object.hasOwn(p, 'key')) refuse('change needs key, the rule it changes, like example-ui/flat-buttons.');
  if (line(p, 'change') !== 'reword') refuse('change must be reword.');
  const unknown = Object.keys(p).find(k => !REWORD_FIELDS.has(k));
  if (unknown) refuse(`${unknown} isn't a field of a reword, which takes the new do, not, because, applies_to or keywords and the evidence for the change.`);
  const base = baseOf(sid, session, p, opts);
  const { kept, queued } = opts;
  const key = line(p, 'key').normalize('NFC');
  if (!KEY_RE.test(key)) refuse('key must be a rule key like example-ui/flat-buttons.');
  const domains = [...session.domains, 'global'];
  const note = readNote(key, loadNotes());
  const old = note && isLive(note) ? note : null;
  if (!old || !domains.includes(old.domain)) refuse(`key names ${key}, which isn't a delivered rule in ${joinList(domains, 'or')}.`);
  const basis = line(p, 'basis');
  if (!BASES[old.kind].includes(basis)) refuse(`${wrongBasis(old.kind, basis)}.`);
  const given = (name, read = line) => (Object.hasOwn(p, name) ? read(p, name) : old[name]);
  const f = {
    ...base, domain: old.domain, slug: old.slug, kind: old.kind, topic: old.topic, basis,
    do: given('do'), not: given('not'), because: given('because', (q, k) => line(q, k, false)),
    applies_to: given('applies_to', lines), keywords: given('keywords', lines),
    tools: old.tools, always: old.always, day: today(), id: newId('a'),
  };
  if (!differs(old, f)) refuse(`the reword leaves ${key} as it is. Give the new do, not, because, applies_to or keywords.`);
  checkChannel(f);
  const e = evidence(f, p);
  if (queued && !e.pick) Object.assign(e, { day: queued.checked, session: sessionName(queued.session, queued.agent) });
  checkQuote(queued ? { agent: queued.agent, transcript: queued.transcript } : session, e, queued);
  const at = new Date().toISOString();
  const file = vaultPath(...old.rel.split('/'));

  const out = locked(f, queued, session, done => {
    const { text: before, ...layout } = readPlain(file);
    const was = parseNote(before, old.rel);
    let after = before;
    for (const k of TEXT_FIELDS) if (f[k] !== was[k]) after = setLead(after, `${k[0].toUpperCase()}${k.slice(1)}`, f[k]);
    for (const k of SCOPE_FIELDS) if (!sameList(was[k], f[k])) after = setList(after, k, f[k]);
    after = setField(after, 'updated', f.day);
    // As for new evidence, as_of moves up to the day the change was checked.
    const checked = e.date ?? e.day ?? f.day;
    if (was.kind === 'knowledge' && validDay(was.as_of) && checked > was.as_of) after = setField(after, 'as_of', checked);
    after = withEvidence(after, evidenceLine(f, e));
    const n = parseNote(after, old.rel);
    const bad = differs(n, f);
    if (bad) refuse(`${bad} doesn't survive as the note's text. Rephrase it.`);
    checkNote(n);
    checkPick(e, e.pick ? proposalRows() : []);
    const scope = where(was) === where(f) ? [] : [`Was: ${where(was)}`, `Now: ${where(f)}`];
    const offer = consent(f, f.domain, 'reword', key, [
      `**Change this rule?** ${key}`, `Was: ${ruleText(was)}`, `Now: ${ruleText(n)}`, ...scope, `Its note would get this Evidence: ${e.cite}.`,
    ]);
    if (offer) return { offer };
    writeSettled(file, restore(after, layout));
    appendJsonl(inboxFile(f.name), [inboxRow({ f, e, at, session, sid, kept, queued, rules: {}, change: 'reword' })(key)]);
    appendLog([`reworded ${key} · session ${f.name}`]);
    return done([
      `Changed ${old.rel}. End your reply with these two lines as they are:`,
      '',
      `**Rule changed** ${key}: ${ruleText(n)}`,
      `To change or remove it, edit ${toPosix(file)}.`,
    ].join('\n'));
  });
  const { asked, hold, ...rest } = p;
  return settle(f, session, out, { fields: queued ? { queued: queued.id } : rest, quote: offerQuote(e), queued, noun: 'rule change' });
}

export const changeKind = p => (Object.hasOwn(p, 'text') ? 'page' : Object.hasOwn(p, 'change') ? 'reword' : 'rule');

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
  const opts = { kept, queueAs, queued };
  const kind = changeKind(p);
  if (kind === 'page') return proposePage(sid, session, p, opts);
  if (kind === 'reword') return reword(sid, session, p, opts);
  const unknown = Object.keys(p).find(k => !FIELDS.has(k));
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
  checkChannel(f);
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
  const rel = rulePath(key);
  const n = parseNote(text, rel);
  checkReadBack(n, f);
  checkNote(n);

  const out = locked(f, queued, session, done => {
    const rows = proposalRows();
    checkPick(e, rows);
    // One correction can back two rules, so the same words refuse once and the retry goes through.
    // One error can show several facts, so a failure matches an earlier one only with the same fix.
    const same = rows.find(r => normText(r.text ?? '') === normText(e.said) && (!e.fix || normText(r.fix ?? '') === normText(e.fix)));
    // Read under the lock, so a proposal written meanwhile is on the list.
    const notes = loadNotes();
    const rules = liveRules(notes);
    const row = inboxRow({ f, e, at, session, sid, kept, queued, rules });
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
  });
  const { asked, hold, ...given } = p;
  return settle(f, session, out, { fields: queued ? { queued: queued.id } : given, quote: offerQuote(e), queued, noun: 'rule' });
}
