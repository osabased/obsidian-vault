import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  config, vaultPath, appendJsonl, picksFile, pickRows, copyNew, domainsFor, today, toPosix, withLock, statePath, guarded,
} from './lib/vault.mjs';
import { KEBAB, settledRules, ruleLine, normTopic, joinList, byKey } from './lib/rules.mjs';
import { build } from './lib/build.mjs';
import { subjectRows, laterRows, endedBy, newestFirst, entry, projectName, sameProject } from './lib/picks.mjs';
import { UsageError, readInput, refuser, failure, line } from './lib/input.mjs';
import { ownEntry, markShown } from './lib/sessions.mjs';

const RUN = 'usage: node tools/pick.mjs <session-id> < pick.json';
const SHOW = '       node tools/pick.mjs show <session-id> <subject>';
const USAGE = `${RUN}\n${SHOW}\n       node tools/pick.mjs --help lists the fields of pick.json`;

const help = () => [
  RUN,
  SHOW,
  '',
  'pick.json is one of three objects. Each records a row in raw/picks/ for the project this session is in.',
  '',
  'A pick, when the user chose between options you showed them, or you chose alone while they were away:',
  '  subject      the piece of work, lowercase-kebab-case, like shop or style-tile; reuse the one its earlier picks have',
  '  question     the question the options answered, one line',
  '  header       optional, a short label for the question',
  '  options      at least two objects: label (one line) and an optional description',
  '  pick         the label of the option picked',
  '  status       "user" when the user picked it, "provisional" when you picked alone',
  "  notes        optional, the user's own words about the pick, verbatim; a provisional pick has none",
  '  reason       optional, your own reasons, in one line',
  '  sheet        optional, the image the options were picked from (.png, .jpg, .jpeg or .webp), as a full path or one from',
  '               the folder you run pick.mjs in;',
  '               it is copied into raw/picks/',
  '  replaces     optional, the id of the live pick on the same subject this one reverses',
  '',
  'A confirmation, when the user agrees with a provisional pick:',
  '  confirms     the id of the provisional pick',
  '  notes, reason  as above',
  'The row copies the question, options, pick and sheet from the pick it confirms, and its reason when you give none.',
  '',
  "A comment, when the user says something about a piece of work that isn't a rule for every piece:",
  '  subject      as above',
  "  comment      the user's words, verbatim, one line",
  '',
  'show prints the subject\'s live picks, newest first, then the domain\'s taste rules. Run it before building or',
  "reviewing the piece, and paste what it prints into the reviewer's prompt.",
].join('\n');

const refuse = refuser('Not recorded');
const showRefuse = refuser('Not shown');

function sessionOf(sid, refuse) {
  const entryRow = ownEntry(sid, refuse);
  const [hit] = domainsFor(entryRow?.cwd);
  if (!hit) refuse(`the taste vault has no session ${sid} from a domain's project folder. Pass the session id from the taste vault's note at session start.`);
  return { ...entryRow, domain: hit.domain, project: hit.root };
}

const field = (p, name, required) => line(refuse, p, name, required);
const optional = (p, name) => field(p, name, false) || null;

function subjectOf(p) {
  const subject = field(p, 'subject');
  if (!KEBAB.test(subject)) refuse('subject must be lowercase-kebab-case.');
  return subject;
}

function optionsOf(v) {
  const bad = () => refuse('options must be a list of at least two objects, each with a one-line label.');
  if (!Array.isArray(v) || v.length < 2) bad();
  const options = v.map(o => {
    const label = typeof o?.label === 'string' ? o.label.trim() : '';
    if (!label || /[\r\n]/.test(label)) bad();
    return { label, description: typeof o.description === 'string' ? o.description.trim() : '' };
  });
  if (new Set(options.map(o => o.label)).size < options.length) refuse('option labels must differ.');
  return options;
}

const SHEET = /\.(?:png|jpe?g|webp)$/i;
const mb = n => (n / 1e6).toFixed(1);

function sheetOf(p) {
  const given = field(p, 'sheet', false);
  if (!given) return null;
  const file = toPosix(given);
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile()) refuse(`there's no file at ${given}.`);
  if (!SHEET.test(file)) refuse('sheet must be a .png, .jpg, .jpeg or .webp image.');
  const { maxSheetBytes } = config().picks;
  const { size } = stat;
  if (size > maxSheetBytes) refuse(`sheet is ${mb(size)} MB; keep it under ${mb(maxSheetBytes)} MB (the contact sheet's --max-size, or JPEG).`);
  return file;
}

function target(rows, later, id, s, subject) {
  const row = subjectRows(rows).find(r => r.id === id);
  if (!row) refuse(`there's no pick row ${id} in raw/picks/.`);
  if ((subject && row.subject !== subject) || !sameProject(row.project, s.project)) {
    refuse(`${id} is for ${row.subject} in ${projectName(row.project)}, not ${subject ?? row.subject} in ${projectName(s.project)}.`);
  }
  const by = later.get(id);
  if (by) refuse(`${id} was ${endedBy(by)}.`);
  return row;
}

// Each kind's name and fields. A field that belongs to another kind is refused rather than dropped without a word.
const FIELDS = {
  options: ['pick', ['subject', 'question', 'header', 'options', 'pick', 'status', 'notes', 'reason', 'sheet', 'replaces']],
  confirms: ['confirmation', ['confirms', 'subject', 'notes', 'reason']],
  comment: ['comment', ['subject', 'comment']],
};
const ALL_FIELDS = new Set(Object.values(FIELDS).flatMap(([, fields]) => fields));

// Each kind checks its input before the lock, and builds its row from the rows read under it.
const KINDS = {
  options(p) {
    const subject = subjectOf(p);
    const question = field(p, 'question');
    const header = optional(p, 'header');
    const options = optionsOf(p.options);
    const pick = field(p, 'pick');
    if (!options.some(o => o.label === pick)) refuse('pick must be the label of one of the options.');
    const status = field(p, 'status');
    if (!['user', 'provisional'].includes(status)) refuse('status must be user or provisional.');
    const notes = optional(p, 'notes');
    if (notes && status === 'provisional') refuse("notes are the user's words, and a provisional pick has none. Put your own reasons in reason.");
    const reason = optional(p, 'reason');
    return {
      sheet: sheetOf(p), replaces: field(p, 'replaces', false),
      make: () => ({ subject, question, header, options, multiSelect: false, pick, notes, reason, status, sheet: null }),
    };
  },
  confirms(p, s) {
    const subject = p.subject === undefined ? null : subjectOf(p);
    const confirms = field(p, 'confirms');
    const notes = optional(p, 'notes');
    const reason = optional(p, 'reason');
    return {
      make: (rows, later) => {
        const was = target(rows, later, confirms, s, subject);
        if (was.status !== 'provisional') refuse(`${confirms} isn't provisional, so there's nothing to confirm.`);
        return {
          subject: was.subject, question: was.question, header: was.header ?? null, options: was.options, multiSelect: false,
          pick: was.pick, notes, reason: reason ?? was.reason ?? null, status: 'user', sheet: was.sheet ?? null, confirms,
        };
      },
    };
  },
  comment(p) {
    const subject = subjectOf(p);
    const text = field(p, 'comment');
    return { make: () => ({ subject, text, status: 'user' }) };
  },
};

function record(sid, p) {
  const s = sessionOf(sid, refuse);
  const kinds = Object.keys(KINDS).filter(k => p[k] !== undefined);
  if (kinds.length !== 1) refuse('give one of: a pick with question and options, confirms, or comment.');
  const [name, own] = FIELDS[kinds[0]];
  const stray = Object.keys(p).find(k => p[k] !== undefined && ALL_FIELDS.has(k) && !own.includes(k));
  if (stray) refuse(`${stray} doesn't go with a ${name}. node tools/pick.mjs --help lists each one's fields.`);
  const { make, sheet = null, replaces = '' } = KINDS[kinds[0]](p, s);
  const base = {
    at: new Date().toISOString(), source: 'pick',
    session: sid, transcript: s.transcript ?? null, cwd: s.cwd ?? null, domain: s.domain, project: s.project,
  };

  // Read under the lock, so two picks recorded at once can't both replace or confirm the same row.
  const out = withLock(statePath('pick.lock'), () => {
    const rows = pickRows();
    const later = laterRows(rows);
    const ids = new Set(rows.map(r => r.id));
    let id;
    do id = `q-${crypto.randomBytes(4).toString('hex')}`; while (ids.has(id));
    const row = { id, ...base, ...make(rows, later) };
    if (replaces) {
      const was = target(rows, later, replaces, s, row.subject);
      if (row.status === 'provisional' && was.status !== 'provisional') {
        refuse(`${replaces} is the user's own pick, and a provisional pick can't replace it. Ask the user, and record their answer with status user.`);
      }
      row.replaces = replaces;
    }
    const out = [`Recorded ${row.id} in raw/picks/${path.basename(picksFile())}.`];
    if (sheet) {
      const copied = copyNew(sheet, vaultPath('raw', 'picks'), `${today()}-${row.subject}`, path.extname(sheet).toLowerCase());
      row.sheet = `raw/picks/${path.basename(copied)}`;
      out.push(`Copied the sheet to ${row.sheet}.`);
    }
    appendJsonl(picksFile(), [row]);
    return out.join('\n');
  });
  guarded('build', build);
  return out;
}

function show(sid, subject) {
  const s = sessionOf(sid, showRefuse);
  if (!KEBAB.test(subject)) showRefuse('subject must be lowercase-kebab-case.');
  const rows = subjectRows().filter(r => sameProject(r.project, s.project));
  const later = laterRows(rows);
  const live = newestFirst(rows.filter(r => r.subject === subject && !later.has(r.id)));
  const name = projectName(s.project);
  const sheet = r => `Sheet: ${toPosix(vaultPath(r.sheet))}`;
  const others = [...new Set(rows.map(r => r.subject))].filter(x => x !== subject).sort();
  const out = live.length
    ? [`Picks for ${subject} in ${name}, newest first:`, ...live.flatMap(r => entry(r, { sheet, indent: '  ' }))]
    : [`No picks for ${subject} in ${name} yet.`, ...(others.length ? [`Subjects with picks: ${others.join(', ')}.`] : [])];
  const skipped = [config().domains[s.domain]?.showSkipTopics ?? []].flat().filter(t => typeof t === 'string');
  const skip = skipped.map(normTopic);
  const rules = Object.entries(settledRules()).filter(([, r]) => r.domain === s.domain && r.kind !== 'knowledge' && !skip.includes(r.topic)).sort(byKey);
  out.push('', skipped.length ? `${s.domain} taste rules, leaving out ${joinList(skipped, 'and')}:` : `${s.domain} taste rules:`);
  out.push(...(rules.length ? rules.map(([k, r]) => ruleLine(k, r)) : ['None.']));
  for (const [k] of rules) markShown(sid, k);
  return out.join('\n');
}

const args = process.argv.slice(2);
try {
  if (args[0] === '--help' && args.length === 1) console.log(help());
  else if (args[0] === 'show' && args.length === 3) console.log(show(args[1], args[2]));
  else if (args.length === 1 && !['show', '--help'].includes(args[0])) console.log(record(args[0], readInput()));
  else throw new UsageError();
} catch (e) {
  const f = failure(e, 'pick', USAGE);
  console.error(f.message);
  process.exitCode = f.code;
}
