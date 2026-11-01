import fs from 'node:fs';
import { config, shortHash } from '../../lib/vault.mjs';
import { fitContext, joinList } from '../../lib/rules.mjs';

const FILE = 'AGENTS.md';
const BEGIN = /^<!-- taste-vault: begin ([0-9a-f]{16}) [^\r\n]*-->$/;
const END = '<!-- taste-vault: end -->';
const beginLine = hash => `<!-- taste-vault: begin ${hash} · written by node tools/compile.mjs, which refuses to rewrite it once it is edited by hand -->`;
const RULE = /^- (\S+?): /;

const editing = globs => {
  const [skipped, kept] = [globs.filter(g => g.startsWith('!')), globs.filter(g => !g.startsWith('!'))];
  return `${kept.join(', ')}${skipped.length ? `, except ${skipped.map(g => g.slice(1)).join(', ')}` : ''}`;
};

// Cut by bytes, which the cap counts, where fitContext counts characters: a rule in a language with wide characters
// would otherwise push the section past it. The overflow line names no file, since other machines and repos read the
// section without the vault.
function bodyOf({ always, files, keywords }, maxBytes) {
  const leftOut = list => `(Left out to stay within ${maxBytes} bytes: ${list}.)`;
  const groups = [
    ...files.map(g => ({ noun: 'rule', head: `### When editing ${editing(g.globs)}\n`, items: g.lines })),
    ...keywords.map(g => ({ noun: 'rule', head: `### When the request mentions ${joinList(g.keywords, 'or')}\n`, items: g.lines })),
  ];
  const none = !always.length && !groups.length;
  const parts = [
    "## Taste rules\n\nFrom the user's taste vault. Follow them in this project.",
    none ? 'None yet.' : '',
    { noun: 'rule', items: always },
    ...groups,
  ];
  let max = maxBytes;
  for (;;) {
    const { text } = fitContext(parts, { max, leftOut });
    const over = Buffer.byteLength(text) - maxBytes;
    if (over <= 0 || max <= over) return text;
    max -= over;
  }
}

const rulesIn = body => new Map(body.split('\n').flatMap(l => { const key = RULE.exec(l)?.[1]; return key ? [[key, l]] : []; }));

function readFile(file) {
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (e) {
    return e.code === 'ENOENT' ? { text: null } : { refused: `the file can't be read (${e.code ?? e.message}), so the section can't be written.` };
  }
  const utf16 = buf.length > 1 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff));
  try {
    if (utf16) throw new Error('utf-16');
    return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf) };
  } catch {
    return { refused: "the file isn't UTF-8 text, so the section can't be written without changing its other bytes. Convert it to UTF-8, then compile again." };
  }
}

// The marker lines, with where each starts, where its text ends and where the next line begins.
function markers(text) {
  const begins = [];
  const ends = [];
  for (let at = 0; at <= text.length;) {
    const nl = text.indexOf('\n', at);
    const stop = nl < 0 ? text.length : nl;
    const next = nl < 0 ? text.length : nl + 1;
    const line = text.slice(at, stop).replace(/\r$/, '').replace(/^﻿/, '').trimEnd();
    // A BOM belongs to the file, so a marker on the first line starts after it.
    const start = text.charCodeAt(at) === 0xfeff ? at + 1 : at;
    const hash = BEGIN.exec(line)?.[1];
    if (hash) begins.push({ at: start, next, hash });
    else if (line === END) ends.push({ at: start, stop: start + END.length, next });
    if (nl < 0) break;
    at = next;
  }
  return { begins, ends };
}

export function compile(sections, root) {
  const path = `${root}/${FILE}`;
  const out = extra => [{ path, text: null, rules: 0, state: 'refused', changed: 0, ...extra }];
  const found = readFile(path);
  if (found.refused) return out({ refused: found.refused });
  const text = found.text ?? '';

  const body = bodyOf(sections, config().compile.maxBytes);
  const mine = rulesIn(body);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const block = terminator => `${[beginLine(shortHash(body)), ...body.split('\n'), END].join(eol)}${terminator}`;
  const done = (state, next, changed = 0) => [{ path, text: next, rules: mine.size, state, changed }];

  const { begins, ends } = markers(text);
  if (!begins.length && !ends.length) {
    const gap = text === '' ? '' : `${text.endsWith('\n') ? '' : eol}${eol}`;
    return done('missing', `${text}${gap}${block(eol)}`);
  }
  if (begins.length !== 1 || ends.length !== 1 || begins[0].at > ends[0].at) {
    return out({ refused: "the taste-vault markers don't pair: there must be one begin line and one end line after it. Fix or delete them, then compile again." });
  }
  const [begin] = begins;
  const [end] = ends;
  const was = text.slice(begin.next, end.at).replace(/\r?\n$/, '').replace(/\r\n/g, '\n');
  if (shortHash(was) !== begin.hash) return out({ refused: 'the taste-vault section was edited by hand since it was compiled. Move those edits out of the section, or delete it, then compile again.', state: 'edited' });

  const next = `${text.slice(0, begin.at)}${block(text.slice(end.stop, end.next))}${text.slice(end.next)}`;
  if (next === text) return done('current', next);
  const before = rulesIn(was);
  const changed = [...new Set([...before.keys(), ...mine.keys()])].filter(k => before.get(k) !== mine.get(k)).length;
  return done('stale', next, changed);
}
