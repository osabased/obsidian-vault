import fs from 'node:fs';
import crypto from 'node:crypto';
import { config, vaultPath, domainsFor, readJsonSafe, writeText, appendJsonl, inboxFile, decisionsFile, proposalRows, statePath, withLock, safeId, today } from './lib/vault.mjs';
import { KEY_RE, parseNote, noteErrors, ruleText, readNote, build, escapeRegExp } from './lib/rules.mjs';
import { registry } from './lib/sessions.mjs';
import { typedMessages } from './lib/transcript.mjs';
import { normText } from './lib/capture.mjs';

const USAGE = [
  'usage: node tools/propose.mjs <session-id> < rule.json',
  '  rule.json: {"domain", "slug", "do", "not", "because", "topic", "basis": "stated" or "inferred", "quote",',
  '              "keywords": [], "applies_to": [], "triggers": [], "always": false}',
].join('\n');
const MAX_PER_SESSION = 3;

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

function checkQuote(quote, session) {
  const said = normText(quote);
  if (said.split(' ').filter(w => /[\p{L}\p{N}]/u.test(w)).length < 3) refuse("the quote needs at least 3 of the user's words.");
  const words = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(said)}(?![\\p{L}\\p{N}])`, 'u');
  if (!typedMessages(session.transcript).some(m => words.test(normText(m.text)))) {
    refuse("the quote isn't in anything the user typed in this session. Quote one unbroken stretch of their own words; briefs, skills and task text don't count.");
  }
}

const sameList = (a, b) => Array.isArray(a) && a.length === b.length && a.every((x, i) => x === b[i]);

function checkReadBack(n, f) {
  const fields = [
    ['domain', n.data.domain === f.domain], ['status', n.status === 'provisional'], ['basis', n.data.basis === f.basis],
    ['topic', n.data.topic === f.topic], ['always', n.data.always === f.always], ['applies_to', sameList(n.applies_to, f.applies_to)],
    ['triggers', sameList(n.triggers, f.triggers)], ['keywords', sameList(n.keywords, f.keywords)], ['replaces', sameList(n.replaces, [])],
    ['do', n.do === f.do], ['not', n.not === f.not], ['because', n.because === f.because],
  ];
  const bad = fields.find(([, ok]) => !ok);
  if (bad) refuse(`${bad[0]} doesn't survive as YAML. Rephrase it.`);
}

const yaml = s => (/^[a-z0-9-]+$/i.test(s) ? s : `'${s.replace(/'/g, "''")}'`);
const yamlList = (name, xs) => (xs.length ? [`${name}:`, ...xs.map(x => `  - '${x.replace(/'/g, "''")}'`)] : [`${name}: []`]);

const noteText = f => [
  '---', 'type: rule', `domain: ${f.domain}`, 'status: provisional', `basis: ${f.basis}`, `topic: ${yaml(f.topic)}`, `always: ${f.always}`,
  ...yamlList('applies_to', f.applies_to), ...yamlList('triggers', f.triggers), ...yamlList('keywords', f.keywords), 'replaces: []',
  `created: ${f.day}`, `updated: ${f.day}`, '---', '',
  `**Do:** ${f.do}`, `**Not:** ${f.not}`, `**Because:**${f.because ? ` ${f.because}` : ''}`, '',
  '## Examples', '', '## Evidence',
  `- ${f.day} · ${f.kind} · session ${f.sid.slice(0, 8)} · "${f.quote}" (${f.id})`, '',
].join('\n');

function propose(sid, p) {
  const session = sessionOf(sid);
  const domains = [...session.domains, 'global'];
  const f = { sid, domain: line(p, 'domain'), slug: line(p, 'slug') };
  if (!domains.includes(f.domain)) refuse(`domain must be ${domains.join(' or ')}.`);
  const key = `${f.domain}/${f.slug}`;
  if (!KEY_RE.test(key)) refuse('slug must be lowercase-kebab-case.');
  f.topic = line(p, 'topic');
  const topics = config().domains[f.domain]?.topics;
  if (topics && !topics.includes(f.topic)) refuse(`topic must be one of ${topics.join(', ')}.`);
  f.basis = line(p, 'basis');
  if (!['stated', 'inferred'].includes(f.basis)) refuse('basis must be stated or inferred.');
  Object.assign(f, { do: line(p, 'do'), not: line(p, 'not'), because: line(p, 'because', false), quote: line(p, 'quote') });
  Object.assign(f, { applies_to: list(p, 'applies_to'), triggers: list(p, 'triggers'), keywords: list(p, 'keywords'), always: p.always ?? false });
  if (typeof f.always !== 'boolean') refuse('always must be true or false.');
  if (!f.always && !f.applies_to.length && !f.keywords.length) refuse('give it keywords, applies_to or always: true, or nothing will deliver it.');
  checkQuote(f.quote, session);

  const at = new Date().toISOString();
  Object.assign(f, { day: today(), kind: f.basis === 'stated' ? 'stated' : 'correction', id: `a-${crypto.randomBytes(4).toString('hex')}` });
  const text = noteText(f);
  const n = parseNote(text, `wiki/${key}.md`);
  checkReadBack(n, f);
  const [err] = noteErrors(n);
  if (err) refuse(`${err}.`);
  const { maxRuleChars } = config().delivery;
  if (ruleText(n).length > maxRuleChars) refuse(`Do, Not and Because come to ${ruleText(n).length} characters; keep them under ${maxRuleChars} together.`);

  return withLock(statePath('ledger.lock'), () => {
    const rows = proposalRows();
    if (rows.filter(r => r.session === sid).length >= MAX_PER_SESSION) refuse(`this session already proposed ${MAX_PER_SESSION} rules.`);
    const earlier = rows.find(r => normText(r.text) === normText(f.quote));
    if (earlier) refuse(`these words were already proposed as ${earlier.note}.`);
    if (readNote(key)) refuse(`wiki/${key}.md already exists. Pick another slug, or leave that note to the user.`);
    writeText(`${vaultPath('wiki', f.domain, f.slug)}.md`, text);
    appendJsonl(inboxFile(), [{ id: f.id, at, source: 'agent', kind: f.kind, text: f.quote, note: key, session: sid, transcript: session.transcript ?? null, cwd: session.cwd ?? null, domain: f.domain }]);
    appendJsonl(decisionsFile(), [{ at, ids: [f.id], action: 'note', note: key }]);
    build();
    return [
      `Wrote wiki/${key}.md. End your reply with these two lines as they are:`,
      '',
      `**Proposed rule** ${key}: ${ruleText(n)}`,
      `Type \`confirm\` to keep it or \`drop\` to let it go. After another message, use \`confirm: ${key}\` or \`drop: ${key}\`.`,
    ].join('\n');
  });
}

const [sid, ...rest] = process.argv.slice(2);
try {
  if (!sid || rest.length) throw new UsageError();
  console.log(propose(sid, readInput()));
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
