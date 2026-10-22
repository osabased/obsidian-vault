import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  config, vaultPath, domainsFor, readJsonSafe, writeText, appendJsonl, inboxFile, decisionsFile, proposalRows, statePath, withLock, safeId, today,
  inside, FILE_TOOLS, WRITEISH, toolCommand, toolFile,
} from './lib/vault.mjs';
import {
  KEY_RE, BASES, wrongBasis, toKey, parseNote, noteErrors, ruleText, ruleTextParts, readNote, readLedger, build, escapeRegExp, mentions, validDay, byKey,
} from './lib/rules.mjs';
import { normGlob } from './lib/glob.mjs';
import { registry, markRepeat, marked, wasShown } from './lib/sessions.mjs';
import { typedMessages, toolActivity } from './lib/transcript.mjs';

const RUN = 'usage: node tools/propose.mjs <session-id> < rule.json';
const USAGE = `${RUN}\n       node tools/propose.mjs --help lists the fields of rule.json`;
const MAX_PER_SESSION = 3;

const help = () => [
  RUN,
  '',
  'rule.json is an object with these fields:',
  "  domain       this session's domain, or global for every project",
  '  slug         lowercase-kebab-case',
  '  kind         "taste" (the default), or "knowledge" for a fact about an API, version or tool',
  "               that your training gets wrong or doesn't know",
  '  do, not      one line each',
  "  because      the user's reason, or for knowledge the cause; empty rather than invented",
  "  topic        one of the domain's topics:",
  ...Object.entries(config().domains).map(([d, c]) => `                 ${d}: ${(c.topics ?? []).join(', ')}`),
  '  basis        with the evidence it needs:',
  "    stated       the user's words state the rule.",
  "                 quote: their exact words, at least 3 in one unbroken stretch",
  '    inferred     taste only: you generalized a correction. quote: as for stated',
  '    failure      knowledge only: something worked only after a failure.',
  "                 error: one line of the error as a command or a failed tool call printed it in this session, yours or a subagent's.",
  "                 An error in a file a command only showed (cat, Get-Content), on a page, or in the call's own input doesn't count.",
  '                 fix: what fixed it, in one line',
  '                 file: the file you fixed, from the project root',
  '    source       knowledge only: a dated source shows it.',
  "                 source: a URL you or a subagent fetched in this session, or a raw/refs/ file this session didn't write",
  '                 source_date: when the source was published or last updated, as YYYY-MM-DD',
  "                 quote: its exact words, at least 3 in one unbroken stretch, not ones you gave the tool. A quote found only in a WebFetch",
  "                 result is marked as coming from a summary, not the page's own words.",
  '  keywords     words a request about it would use',
  '  applies_to   globs from the project root',
  '  triggers     regexes tested against the new text of an edit; when given, the rule applies only if one matches',
  '  always       true for short rules that matter in nearly every session',
  '               A taste rule needs keywords, applies_to or always: true. A knowledge rule needs applies_to',
  '               and takes no keywords or always.',
  '  replaces     leave it out at first. If the rule may repeat ones the user confirmed, propose.mjs lists them',
  '               and refuses once. Then propose it again with the keys of the ones it repeats, or [] if none.',
  '               Confirming it retires the rules it replaces.',
  '',
  "A knowledge rule's as_of is set for you: the source_date for a source, today otherwise.",
].join('\n');

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
  const domains = domainsFor(entry?.cwd).map(d => d.domain);
  if (!domains.length) refuse(`the taste vault has no domain session ${sid}. Pass the session id from the taste vault's note at session start.`);
  return { ...entry, domains };
}

const REFS = /^raw\/refs\/./;

function evidence(f, p) {
  if (f.basis === 'failure') return { error: line(p, 'error'), fix: line(p, 'fix'), file: line(p, 'file') };
  if (f.basis !== 'source') return { quote: line(p, 'quote') };
  const e = { source: line(p, 'source'), source_date: line(p, 'source_date'), quote: line(p, 'quote') };
  if (!/^https?:\/\/\S+$/i.test(e.source) && !REFS.test(e.source)) refuse('source must be a URL or a file under raw/refs/.');
  if (!validDay(e.source_date)) refuse('source_date must be a date as YYYY-MM-DD.');
  if (e.source_date > today()) refuse("source_date can't be in the future.");
  return e;
}

const normText = s => String(s)
  .toLowerCase()
  .replace(/[‘’ʼ]/g, "'")
  .replace(/[“”]/g, '"')
  .replace(/\s+/g, ' ')
  .trim();
const wordCount = s => normText(s).split(' ').filter(w => /[\p{L}\p{N}]/u.test(w)).length;
const finder = s => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(normText(s))}(?![\\p{L}\\p{N}])`, 'u');

const URLS = /https?:\/\/[^\s"'`<>()\\]+/g;
const sameUrl = (a, b) => a.replace(/[.,;:!?]+$/, '').replace(/\/$/, '') === b.replace(/\/$/, '');
const HEREDOC = /<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?^\s*\2\s*$|@(['"])\s*\n[\s\S]*?^\3@/gm;
const FETCHERS = /^(?:curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)$/i;
const SHOWS = /^(?:cat|type|head|tail|less|more|sed|awk|grep|egrep|fgrep|rg|findstr|jq|cd|echo|printf|Get-Content|gc|Select-String|sls|Select-Object|Write-Output|Write-Host)$/i;
// Downloads and unpacked archives write files without a redirect.
const SAVES = /\s(?:-[a-z]*o|--output|-OutFile)\b|\b(?:wget|tar|unzip|7z|Expand-Archive|git\s+clone)\b/i;
// The browser tools take the URL in one call and return the page's text from another, headed by its URL.
const PAGE_URL = /^Title: [^\n]*\nURL: (\S+)\n/;

// A heredoc's lines are text the command was given, not commands it ran.
const segments = cmd => cmd.replace(HEREDOC, '').split(/&&|\|\||[|;\n]/).map(s => s.trim()).filter(Boolean);
const program = s => s.replace(/^(?:\$\w+\s*=\s*)?[(&]?\s*/, '').split(/[\s)]/)[0].replace(/\.exe$/i, '');
const urlFields = x => (x && typeof x === 'object' ? Object.entries(x).flatMap(([k, v]) => (k === 'url' && typeof v === 'string' ? [v] : urlFields(v))) : []);
const strings = x => (typeof x === 'string' ? [x] : x && typeof x === 'object' ? Object.values(x).flatMap(strings) : []);
// An echo, a failed Edit or a WebFetch prompt hands back words the agent wrote.
const echoes = (a, re) => strings(a.input).some(s => re.test(normText(s)));
const pageUrl = a => (a.name?.startsWith('mcp__') ? a.preview.match(PAGE_URL)?.[1] ?? null : null);

// A search, a brief or a mention in another command can name a URL without reading it.
function fetched(a) {
  const cmd = toolCommand(a.name, a.input);
  if (cmd === null) return urlFields(a.input);
  return segments(cmd).filter(s => FETCHERS.test(program(s))).flatMap(s => s.match(URLS) ?? []);
}

// A file the agent showed, a page, or a subagent's report can quote an error that never happened here.
function ran(a) {
  const cmd = toolCommand(a.name, a.input);
  if (cmd !== null) return !segments(cmd).every(s => SHOWS.test(program(s)));
  return a.error || (a.name?.startsWith('mcp__') && pageUrl(a) === null);
}

function printed(re, session) {
  for (const a of toolActivity(session.transcript)) if (a.type === 'result' && ran(a) && !echoes(a, re) && re.test(normText(a.text))) return true;
  return false;
}

function wrote(file, session) {
  const at = s => `(?<![\\w.-])${escapeRegExp(s)}`;
  const folders = (inside(vaultPath('raw'), file) ?? '').split('/').slice(0, -1);
  // A command that writes the file names it, or ends a path with a folder the file is in.
  const named = new RegExp([`${at(path.basename(file))}(?![\\w.-])`, ...folders.map(d => `${at(d)}[\\\\/]*(?=$|[\\s"'\`;|&)])`)].join('|'), 'im');
  for (const a of toolActivity(session.transcript)) {
    if (a.type !== 'call') continue;
    const p = toolFile(a.name, a.input);
    if (FILE_TOOLS.includes(a.name) && typeof p === 'string' && inside(file, p, session.cwd) === '') return true;
    const cmd = toolCommand(a.name, a.input);
    if (cmd !== null && named.test(cmd) && (WRITEISH.test(cmd) || SAVES.test(cmd))) return true;
  }
  return false;
}

function refsHas(source, re, session) {
  const file = vaultPath(source);
  if (!inside(vaultPath('raw', 'refs'), file)) refuse('source must be a file under raw/refs/.');
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { refuse(`there's no file at ${source} in the vault.`); }
  if (wrote(file, session)) refuse(`${source} was written in this session, so it can't back a rule. Cite the URL it came from instead.`);
  return re.test(normText(text));
}

// WebFetch answers with a model's summary of the page, so a quote found only there is marked as one.
function sourceHas(source, re, session) {
  if (REFS.test(source)) return refsHas(source, re, session);
  const ids = new Set();
  let read = false;
  let summary = false;
  for (const a of toolActivity(session.transcript)) {
    if (a.type === 'call') {
      if (fetched(a).some(u => sameUrl(u, source))) ids.add(a.id);
    } else if (ids.has(a.id) || sameUrl(pageUrl(a) ?? '', source)) {
      read = true;
      if (echoes(a, re) || !re.test(normText(a.text))) continue;
      if (a.name !== 'WebFetch') return 'page';
      summary = true;
    }
  }
  if (!read) refuse(`no tool read ${source} in this session. Fetch it first, then quote what it shows.`);
  return summary && 'summary';
}

function checkEvidence(f, session) {
  if (f.basis === 'failure') {
    if (wordCount(f.error) < 3) refuse('the error needs at least 3 words of what the tool printed.');
    if (!printed(finder(f.error), session)) {
      refuse("the error isn't in anything a command or a failed tool call printed in this session. Copy one line of it as it was printed; an error quoted in a file, a page, a report or the call's own input doesn't count.");
    }
    return false;
  }
  const whose = f.basis === 'source' ? "the source's" : "the user's";
  if (wordCount(f.quote) < 3) refuse(`the quote needs at least 3 of ${whose} words.`);
  const re = finder(f.quote);
  if (f.basis === 'source') {
    const found = sourceHas(f.source, re, session);
    if (!found) refuse(`the quote isn't in what this session read from ${f.source}. Quote one unbroken stretch of it; words you gave the tool don't count.`);
    return found === 'summary';
  }
  if (!typedMessages(session.transcript).some(m => re.test(normText(m.text)))) {
    refuse("the quote isn't in anything the user typed in this session. Quote one unbroken stretch of their own words; briefs, skills and task text don't count.");
  }
  return false;
}

const andList = xs => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
const those = xs => (xs.length === 1 ? 'that one' : 'them');

function checkReplaces(f, scope, rules) {
  const bad = f.replaces.filter(k => !scope.includes(rules[k]?.domain));
  if (bad.length) refuse(`replaces names rules the user confirmed in ${scope.join(' or ')}, by key. ${bad.join(', ')} ${bad.length === 1 ? "isn't one" : "aren't"}.`);
  const wide = f.domain === 'global' ? [] : f.replaces.filter(k => rules[k].domain === 'global');
  if (!wide.length) return;
  const it = wide.length === 1 ? 'it' : 'them';
  refuse(`${andList(wide)} ${wide.length === 1 ? 'applies' : 'apply'} in every project, so a ${f.domain} rule can't replace ${it}. Propose this one in global instead, or leave ${it} out of replaces.`);
}

const OVERLAP = 0.2;
const STOPWORDS = new Set(('a all an and any are as at be because but by can cant didnt do doesnt dont for from in is isnt it its must never not of on or '
  + 'should that the their theirs them these they this those to use was we were with wont you your yours').split(' '));
// Apostrophes go first so "don't" reads as the stopword dont rather than as don, which every Not line shares.
const words = s => new Set((normText(s).replace(/'/g, '').match(/[\p{L}\p{N}]+/gu) ?? [])
  .filter(w => w.length > 2 && !STOPWORDS.has(w) && !/^\p{N}+$/u.test(w))
  .map(w => (w.length > 3 ? w.replace(/s$/, '') : w)));

function overlap(x, y) {
  const shared = [...x].filter(w => y.has(w)).length;
  return shared / (x.size + y.size - shared || 1);
}

const globKey = g => normGlob(g).toLowerCase();

const SHORTLIST = 5;

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

function checkRepeats(f, text, scope, given, rules) {
  const all = lookalikes(f, text, scope, rules);
  const alike = all.slice(0, SHORTLIST).sort(byKey);
  const id = ([k, r]) => `${f.slug}|${k}|${r.hash}`;
  const seen = e => f.replaces.includes(e[0]) || marked('repeats', f.sid, id(e));
  if (!alike.length || (given && alike.every(seen))) return alike.map(([k]) => k);
  for (const e of alike) markRepeat(f.sid, id(e));
  const more = all.length - alike.length;
  refuse([
    'it may repeat rules the user confirmed:',
    ...alike.map(([k, r]) => `- ${k}: ${r.text}`),
    ...(more ? [`${more} more match less closely and aren't listed.`] : []),
    "If it repeats one, propose it again with that rule's key in replaces; confirming yours retires it. If it says something new, propose it again with replaces: [].",
  ].join('\n'));
}

const sameList = (a, b) => Array.isArray(a) && a.length === b.length && a.every((x, i) => x === b[i]);

function checkReadBack(n, f) {
  const fields = [
    ['domain', n.data.domain === f.domain], ['status', n.status === 'provisional'], ['kind', n.kind === f.kind], ['basis', n.data.basis === f.basis],
    ['as_of', n.as_of === (f.as_of ?? null)], ['topic', n.data.topic === f.topic], ['always', n.data.always === f.always],
    ['applies_to', sameList(n.applies_to, f.applies_to)], ['triggers', sameList(n.triggers, f.triggers)], ['keywords', sameList(n.keywords, f.keywords)],
    ['replaces', sameList(n.replaces, f.replaces.map(toKey))], ['do', n.do === f.do], ['not', n.not === f.not], ['because', n.because === f.because],
  ];
  const bad = fields.find(([, ok]) => !ok);
  if (bad) refuse(`${bad[0]} doesn't survive as YAML. Rephrase it.`);
}

const yaml = s => (/^[a-z0-9-]+$/i.test(s) ? s : `'${s.replace(/'/g, "''")}'`);
const yamlList = (name, xs) => (xs.length ? [`${name}:`, ...xs.map(x => `  - '${x.replace(/'/g, "''")}'`)] : [`${name}: []`]);

function evidenceLine(f) {
  const head = `- ${f.day} · ${f.evidence} · session ${f.sid.slice(0, 8)}`;
  if (f.basis === 'failure') return `${head} · ${f.file} · "${f.error}" · fixed by: ${f.fix} (${f.id})`;
  if (f.basis === 'source') return `${head} · ${f.source} · dated ${f.source_date}${f.summary ? ' · summary' : ''} · "${f.quote}" (${f.id})`;
  return `${head} · "${f.quote}" (${f.id})`;
}

const noteText = f => [
  '---', 'type: rule', `domain: ${f.domain}`, 'status: provisional', `kind: ${f.kind}`, `basis: ${f.basis}`, ...(f.as_of ? [`as_of: ${f.as_of}`] : []),
  `topic: ${yaml(f.topic)}`, `always: ${f.always}`,
  ...yamlList('applies_to', f.applies_to), ...yamlList('triggers', f.triggers), ...yamlList('keywords', f.keywords), ...yamlList('replaces', f.replaces),
  `created: ${f.day}`, `updated: ${f.day}`, '---', '',
  `**Do:** ${f.do}`, `**Not:** ${f.not}`, `**Because:**${f.because ? ` ${f.because}` : ''}`, '',
  '## Examples', '', '## Evidence', evidenceLine(f), '',
].join('\n');

function propose(sid, p) {
  const session = sessionOf(sid);
  const domains = [...session.domains, 'global'];
  const f = { sid, domain: line(p, 'domain'), slug: line(p, 'slug') };
  if (!domains.includes(f.domain)) refuse(`domain must be ${domains.join(' or ')}.`);
  const key = `${f.domain}/${f.slug}`;
  if (!KEY_RE.test(key)) refuse('slug must be lowercase-kebab-case.');
  f.kind = line(p, 'kind', false) || 'taste';
  if (!BASES[f.kind]) refuse('kind must be taste or knowledge.');
  f.topic = line(p, 'topic');
  const topics = config().domains[f.domain]?.topics;
  if (topics && !topics.includes(f.topic)) refuse(`topic must be one of ${topics.join(', ')}.`);
  f.basis = line(p, 'basis');
  if (!BASES[f.kind].includes(f.basis)) refuse(`${wrongBasis(f.kind, f.basis)}.`);
  Object.assign(f, { do: line(p, 'do'), not: line(p, 'not'), because: line(p, 'because', false) });
  Object.assign(f, { applies_to: list(p, 'applies_to'), triggers: list(p, 'triggers'), keywords: list(p, 'keywords'), always: p.always ?? false });
  if (typeof f.always !== 'boolean') refuse('always must be true or false.');
  if (f.kind === 'taste' && !f.always && !f.applies_to.length && !f.keywords.length) refuse('give it keywords, applies_to or always: true, or nothing will deliver it.');
  const scope = f.domain === 'global' ? domains : [f.domain, 'global'];
  f.replaces = [...new Set(list(p, 'replaces'))];
  Object.assign(f, evidence(f, p));
  if (f.kind === 'knowledge') f.as_of = f.source_date ?? today();
  f.summary = checkEvidence(f, session);

  const at = new Date().toISOString();
  Object.assign(f, { day: today(), evidence: f.basis === 'inferred' ? 'correction' : f.basis, id: `a-${crypto.randomBytes(4).toString('hex')}` });
  const text = noteText(f);
  const n = parseNote(text, `wiki/${key}.md`);
  checkReadBack(n, f);
  const [err] = noteErrors(n);
  if (err) refuse(`${err}.`);
  const { maxRuleChars } = config().delivery;
  if (ruleText(n).length > maxRuleChars) refuse(`${ruleTextParts(n)} come to ${ruleText(n).length} characters; keep them under ${maxRuleChars} together.`);

  const said = f.basis === 'failure' ? f.error : f.quote;
  // One error can show several facts, so a failure repeats an earlier one only if its fix does too.
  const same = r => normText(r.text) === normText(said) && (f.basis !== 'failure' || normText(r.fix ?? '') === normText(f.fix));
  return withLock(statePath('ledger.lock'), () => {
    const rows = proposalRows();
    if (rows.filter(r => r.session === sid).length >= MAX_PER_SESSION) refuse(`this session already proposed ${MAX_PER_SESSION} rules.`);
    const earlier = rows.find(same);
    if (earlier) refuse(`these words were already proposed as ${earlier.note}.`);
    if (readNote(key)) refuse(`wiki/${key}.md already exists. Pick another slug, or leave that note to the user.`);
    // Read under the lock, so a rule in replaces the user retired meanwhile is refused here.
    const { rules } = readLedger();
    checkReplaces(f, scope, rules);
    const overlaps = checkRepeats(f, ruleText(n), scope, p.replaces !== undefined, rules).filter(k => !f.replaces.includes(k));
    writeText(`${vaultPath('wiki', f.domain, f.slug)}.md`, text);
    appendJsonl(inboxFile(), [{
      id: f.id, at, source: 'agent', kind: f.evidence, text: said, ...(f.basis === 'failure' ? { fix: f.fix } : {}),
      note: key, session: sid, transcript: session.transcript ?? null, cwd: session.cwd ?? null, domain: f.domain,
      ...(f.replaces.length ? { repeats: f.replaces, delivered: f.replaces.filter(k => wasShown(sid, k, rules[k].hash)) } : {}),
    }]);
    appendJsonl(decisionsFile(), [{ at, ids: [f.id], action: 'note', note: key }]);
    build();
    const reply = [
      `**Proposed ${f.kind === 'knowledge' ? 'knowledge rule' : 'rule'}** ${key}: ${ruleText(n)}`,
      ...(f.summary ? [`The quote comes from a WebFetch summary of ${f.source}, not the page's own words.`] : []),
      ...(f.replaces.length
        ? [`It repeats ${andList(f.replaces)}, which you confirmed. Confirming this one retires ${those(f.replaces)}.`] : []),
      ...(overlaps.length
        ? [`It may overlap ${andList(overlaps)}, which you confirmed. Confirming this one keeps ${those(overlaps)} too.`] : []),
      `Type \`confirm\` to keep it or \`drop\` to let it go. After another message, use \`confirm: ${key}\` or \`drop: ${key}\`.`,
    ];
    return [`Wrote wiki/${key}.md. End your reply with these ${['two', 'three', 'four', 'five'][reply.length - 2]} lines as they are:`, '', ...reply].join('\n');
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
