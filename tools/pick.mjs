import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  config, domainsFor, vaultPath, appendJsonl, picksFile, pickRows, copyNew, today, toPosix, withLock, statePath, guarded,
} from './lib/vault.mjs';
import { KEBAB, settledRules, ruleLine, normTopic, joinList, byKey, byFit, cmp, domainOrder, deliverable, deliveryFor } from './lib/rules.mjs';
import { build } from './lib/build.mjs';
import { IMAGE, hashPath, derivedText } from './lib/sources.mjs';
import { subjectRows, laterRows, liveRows, endedBy, newestFirst, entry, projectName, sameProject } from './lib/picks.mjs';
import { UsageError, readInput, refuse, failure, line, renderHelp, schemaOf, schemaArg } from './lib/input.mjs';
import { callerEntry, markShown, sessionRoots, PASS } from './lib/sessions.mjs';
import { saidIn } from './lib/quotes.mjs';
import { currentSession, typedFor, shortName } from './lib/agents.mjs';

const RUN = 'usage: node tools/pick.mjs [session-id] < pick.json';
const SHOW = '       node tools/pick.mjs show <session-id> <subject> [domain [project]]';
const USAGE = `${RUN}\n${SHOW}\n       node tools/pick.mjs --help lists the fields of pick.json`;

const row = (label, help) => ({ label, help });

// One list drives --help and --schema. A pick, a confirmation and a comment are one flat list with text blocks between.
const FIELDS = [
  { name: 'domain', type: 'string', help: ['optional when the session is in one domain, which the row then takes; otherwise the domain this is for,', "one the session is in. A session at a monorepo root is in each package's domain."] },
  { name: 'project', type: 'string', help: ['optional when the domain has one project folder in this session, which the row then takes; otherwise the', 'project this is for, as the full path or the folder name of one of the projects the refusal lists. A', 'monorepo root has a project for each package.'] },
  { text: ['', 'A pick, when the user chose between options you showed them, or you chose alone while they were away:'] },
  { name: 'subject', type: 'string', help: ['the piece of work, lowercase-kebab-case, like shop or style-tile; reuse the one its earlier picks have'] },
  { name: 'question', type: 'string', help: ['the question the options answered, one line'] },
  { name: 'header', type: 'string', help: ['optional, a short label for the question'] },
  { name: 'options', type: 'object[]', help: ['at least two objects: label (one line) and an optional description'] },
  { name: 'pick', type: 'string', help: ['the label of the option picked'] },
  { name: 'status', type: 'string', enum: ['user', 'provisional'], help: ['"user" when the user picked it, "provisional" when you picked alone'] },
  { name: 'notes', type: 'string', help: ["optional, the user's own words about the pick, verbatim; a provisional pick has none"] },
  { name: 'reason', type: 'string', help: ['optional, your own reasons, in one line'] },
  { name: 'sheet', type: 'string', help: ['optional, the file the options were picked from, as a full path or one from the folder you run pick.mjs in:', 'an image (.png, .jpg, .jpeg or .webp), or a file whose text node tools/extract.mjs has extracted, which', 'needs a copy in raw/refs/. It is copied into raw/picks/'] },
  { name: 'replaces', type: 'string', help: ['optional, the id of the live pick on the same subject this one reverses'] },
  { text: ['', 'A confirmation, when the user agrees with a provisional pick:'] },
  { name: 'confirms', type: 'string', help: ['the id of the provisional pick'] },
  row('notes, reason', ['as above']),
  { text: ['The row copies the question, options, pick and sheet from the pick it confirms, and its reason when you give none.', '', "A comment, when the user says something about a piece of work that isn't a rule for every piece:"] },
  row('subject', ['as above']),
  { name: 'comment', type: 'string', help: ["the user's words, verbatim, one line"] },
  // No help, so --help stays as the argv form's; the schema is where the JSON form of show is described.
  { name: 'show', type: 'string', describe: 'Instead of recording: the subject (lowercase-kebab-case) to show the picks of, newest first, then the taste and knowledge rules of the project. Run it before building or reviewing the piece and keep to what it returns. Takes only domain and project, with the same meaning.' },
];

const SUMMARY = "Records the user's pick between options you showed them, your provisional pick, a confirmation of one, or their comment on one piece of work. With show and a subject it returns that subject's picks and the rules instead. domain and project are needed only when the session has several.";

const help = () => renderHelp([
  RUN,
  SHOW,
  '',
  'pick.json is one of three objects. Each records a row in raw/picks/ for a project this session is in, and takes:',
], FIELDS, [
  '',
  "show prints the subject's live picks, newest first, then the taste and knowledge rules of the domain and of the other",
  "domains whose projects hold its project. Run it before building or reviewing the piece, and paste what it prints into the",
  "reviewer's prompt. Give the domain when the session is in more than one, and the project when the domain has more than one.",
], 13);

function sessionOf(sid) {
  const entryRow = callerEntry(sid, { noId: `there's no session id to record for. ${PASS}`, optional: true });
  const hits = [...sessionRoots(entryRow)].sort((a, b) => cmp(a.domain, b.domain) || cmp(a.root, b.root));
  if (!hits.length) refuse(`the vault has no session ${sid} from a domain's project folder. The vault's tools pass the session id themselves; from a shell, pass this session's own id.`);
  return { ...entryRow, hits };
}

// A project is named by its path, or by its folder name when that names one of the roots alone.
function rootNamed(roots, project) {
  const same = roots.filter(r => sameProject(r, project));
  const named = same.length ? same : roots.filter(r => projectName(r).toLowerCase() === project.toLowerCase());
  return named.length === 1 ? named[0] : null;
}

// A confirmation names no domain or project of its own, so it takes those of the pick it confirms.
function inDomain(s, { domain, project, from } = {}) {
  const names = [...new Set(s.hits.map(h => h.domain))];
  const want = domain ?? (names.includes(from?.domain) ? from.domain : names.length === 1 ? names[0] : null);
  if (!want) refuse(`this session is in more than one domain: ${joinList(names, 'and')}. Add domain with the one this is for.`);
  if (!names.includes(want)) refuse(`${want} isn't a domain of this session. It has: ${joinList(names, 'and')}.`);
  const roots = s.hits.filter(h => h.domain === want).map(h => h.root);
  const all = joinList(roots, 'and');
  let root;
  if (project) {
    root = rootNamed(roots, project);
    if (!root) refuse(`${project} isn't a project of this session in ${want}. It has: ${all}.`);
  } else {
    root = roots.length === 1 ? roots[0] : from?.domain === want ? roots.find(r => sameProject(r, from.project)) : undefined;
    if (!root) refuse(`${want} has more than one project in this session: ${all}. Add project with the one this is for.`);
  }
  return { ...s, domain: want, project: root };
}

const optional = (p, name) => line(p, name, false) || null;

// propose.mjs cites a row's notes and a comment's text as the user's words, so they are checked as its quotes are.
const NOT_TYPED = {
  notes: "notes aren't in anything the user typed in this session. Put their exact words in notes, with … where you leave some out, or your own in reason.",
  comment: "the comment isn't in anything the user typed in this session. Record their exact words, with … where you leave some out.",
};
function checkSaid(s, text, what) {
  const typed = typedFor(s);
  if (!typed) refuse("the vault has no transcript for this session, so it can't check these are the user's words.");
  if (!saidIn(text, typed)) refuse(NOT_TYPED[what]);
}

function subjectOf(p) {
  const subject = line(p, 'subject');
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

const mb = n => (n / 1e6).toFixed(1);

function sheetOf(p) {
  const given = line(p, 'sheet', false);
  if (!given) return null;
  const file = toPosix(given);
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile()) refuse(`there's no file at ${given}.`);
  const { maxSheetBytes } = config().picks;
  const { size } = stat;
  if (size > maxSheetBytes) refuse(`sheet is ${mb(size)} MB; keep it under ${mb(maxSheetBytes)} MB (the contact sheet's --max-size, or JPEG).`);
  if (!IMAGE.test(file)) {
    let derived;
    try { derived = derivedText(hashPath(file)); } catch (e) { refuse(`sheet can't be read just now (${e.code ?? e.message}). Close whatever holds it open and try again.`); }
    if (!derived) refuse('sheet must be a .png, .jpg, .jpeg or .webp image, or a file with derived text. Save the file in raw/refs/ and run node tools/extract.mjs on it.');
  }
  return file;
}

function target(rows, later, id, s, subject) {
  const row = subjectRows(rows).find(r => r.id === id);
  if (!row) refuse(`there's no pick row ${id} in raw/picks/.`);
  if (row.domain !== s.domain) refuse(`${id} is for ${row.subject} in ${row.domain}, not ${s.domain}.`);
  if ((subject && row.subject !== subject) || !sameProject(row.project, s.project)) {
    refuse(`${id} is for ${row.subject} in ${projectName(row.project)}, not ${subject ?? row.subject} in ${projectName(s.project)}.`);
  }
  const by = later.get(id);
  if (by) refuse(`${id} was ${endedBy(by)}.`);
  return row;
}

// A field that belongs to another kind is refused rather than dropped without a word. Each kind checks its input
// before the lock, and builds its row from the rows read under it.
const KINDS = {
  options: {
    name: 'pick',
    fields: ['subject', 'domain', 'project', 'question', 'header', 'options', 'pick', 'status', 'notes', 'reason', 'sheet', 'replaces'],
    read: (p, s) => {
      const subject = subjectOf(p);
      const question = line(p, 'question');
      const header = optional(p, 'header');
      const options = optionsOf(p.options);
      const pick = line(p, 'pick');
      if (!options.some(o => o.label === pick)) refuse('pick must be the label of one of the options.');
      const status = line(p, 'status');
      if (!['user', 'provisional'].includes(status)) refuse('status must be user or provisional.');
      const notes = optional(p, 'notes');
      if (notes && status === 'provisional') refuse("notes are the user's words, and a provisional pick has none. Put your own reasons in reason.");
      if (notes) checkSaid(s, notes, 'notes');
      const reason = optional(p, 'reason');
      return {
        sheet: sheetOf(p), replaces: line(p, 'replaces', false),
        make: () => ({ subject, question, header, options, multiSelect: false, pick, notes, reason, status, sheet: null }),
      };
    },
  },
  confirms: {
    name: 'confirmation',
    fields: ['confirms', 'subject', 'domain', 'project', 'notes', 'reason'],
    read: (p, s) => {
      const subject = p.subject === undefined ? null : subjectOf(p);
      const confirms = line(p, 'confirms');
      const notes = optional(p, 'notes');
      if (notes) checkSaid(s, notes, 'notes');
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
  },
  comment: {
    name: 'comment',
    fields: ['subject', 'domain', 'project', 'comment'],
    read: (p, s) => {
      const subject = subjectOf(p);
      const text = line(p, 'comment');
      checkSaid(s, text, 'comment');
      return { make: () => ({ subject, text, status: 'user' }) };
    },
  },
};
const ALL_FIELDS = new Set(Object.values(KINDS).flatMap(k => k.fields));

// The input is read after the session is checked, so a script run from the wrong place says that first.
function record(sid, input) {
  const session = sessionOf(sid);
  const p = input();
  if (p.show !== undefined) {
    refused = 'Not shown';
    const stray = Object.keys(p).find(k => p[k] !== undefined && !['show', 'domain', 'project'].includes(k));
    if (stray) refuse(`${stray} doesn't go with show, which takes only domain and project.`);
    return show(sid, line(p, 'show'), optional(p, 'domain'), optional(p, 'project'));
  }
  const kinds = Object.keys(KINDS).filter(k => p[k] !== undefined);
  if (kinds.length !== 1) refuse('give one of: a pick with question and options, confirms, or comment.');
  const kind = KINDS[kinds[0]];
  const stray = Object.keys(p).find(k => p[k] !== undefined && ALL_FIELDS.has(k) && !kind.fields.includes(k));
  if (stray) refuse(`${stray} doesn't go with a ${kind.name}. The \`pick\` tool's schema lists each one's fields.`);
  const from = kind.name === 'confirmation' ? pickRows().find(r => r.id === p.confirms) : undefined;
  const s = inDomain(session, { domain: optional(p, 'domain'), project: optional(p, 'project'), from });
  const { make, sheet = null, replaces = '' } = kind.read(p, s);
  const base = {
    at: new Date().toISOString(), source: 'pick',
    session: sid, agent: s.agent ?? null, transcript: s.transcript ?? null, cwd: s.cwd ?? null, domain: s.domain, project: s.project,
  };

  // Read under the lock, so two picks recorded at once can't both replace or confirm the same row.
  const out = withLock(statePath('pick.lock'), () => {
    const day = today();
    const file = picksFile(shortName(sid, session.agent), day);
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
    const out = [`Recorded ${row.id} in raw/picks/${path.basename(file)}.`];
    if (sheet) {
      const copied = copyNew(sheet, vaultPath('raw', 'picks'), `${day}-${row.subject}`, path.extname(sheet).toLowerCase());
      row.sheet = `raw/picks/${path.basename(copied)}`;
      out.push(`Copied the sheet to ${row.sheet}.`);
    }
    appendJsonl(file, [row]);
    return out.join('\n');
  });
  guarded('build', build);
  return out;
}

function show(sid, subject, domain, project) {
  const s = inDomain(sessionOf(sid), { domain, project });
  if (!KEBAB.test(subject)) refuse('subject must be lowercase-kebab-case.');
  const rows = subjectRows().filter(r => r.domain === s.domain && sameProject(r.project, s.project));
  const live = newestFirst(liveRows(rows).filter(r => r.subject === subject));
  const name = projectName(s.project);
  const sheet = r => `Sheet: ${toPosix(vaultPath(r.sheet))}`;
  const others = [...new Set(rows.map(r => r.subject))].filter(x => x !== subject).sort();
  const out = live.length
    ? [`Picks for ${subject} in ${name}, newest first:`, ...live.flatMap(r => entry(r, { sheet, indent: '  ' }))]
    : [`No picks for ${subject} in ${name} yet.`, ...(others.length ? [`Subjects with picks: ${others.join(', ')}.`] : [])];
  // An edit in the project takes the rules of every domain whose project holds it, so the reviewer hears them all.
  const reach = domainsFor(s.project);
  const near = domainOrder(reach.map(d => d.domain)).filter(d => d !== s.domain);
  const all = deliverable(settledRules(), deliveryFor([{ domain: s.domain, root: s.project }, ...reach]));
  for (const d of [s.domain, ...near]) {
    const skipped = [config().domains[d]?.showSkipTopics ?? []].flat().filter(t => typeof t === 'string');
    const skip = skipped.map(normTopic);
    const rules = Object.entries(all).filter(([, r]) => r.domain === d && !skip.includes(r.topic)).sort((a, b) => byFit(a[1], b[1]) || byKey(a, b));
    if (d !== s.domain && !rules.length) continue;
    out.push('', skipped.length ? `${d} rules, leaving out ${joinList(skipped, 'and')}:` : `${d} rules:`);
    out.push(...(rules.length ? rules.map(([k, r]) => ruleLine(k, r)) : ['None.']));
    markShown(sid, rules.map(([k]) => k));
  }
  return out.join('\n');
}

const args = process.argv.slice(2);
let refused = 'Not recorded';
try {
  const variant = schemaArg(args);
  if (variant) console.log(JSON.stringify(schemaOf(SUMMARY, FIELDS)));
  else if (args[0] === '--help' && args.length === 1) console.log(help());
  else if (args[0] === 'show' && args.length >= 3 && args.length <= 5) {
    refused = 'Not shown';
    console.log(show(args[1], args[2], args[3], args[4]));
  } else if (args.length <= 1 && !['show', '--help'].includes(args[0])) console.log(record(args[0] ?? currentSession()?.id, readInput));
  else throw new UsageError();
} catch (e) {
  const f = failure(e, 'pick', USAGE, refused);
  console.error(f.message);
  process.exitCode = f.code;
}
