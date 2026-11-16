import fs from 'node:fs';
import { config, shortHash, DEFAULTS } from '../../lib/vault.mjs';
import { fitContext, joinList } from '../../lib/rules.mjs';

const FILE = 'AGENTS.md';
// Sections compiled before the vault's rename carry `taste-vault:` markers; they are still read, and rewritten with the new ones.
const BEGIN = /^<!-- (?:taste-)?vault: begin ([0-9a-f]{16}) [^\r\n]*-->$/;
const END = '<!-- vault: end -->';
const ENDS = new Set([END, '<!-- taste-vault: end -->']);
const beginLine = hash => `<!-- vault: begin ${hash} · written by node tools/compile.mjs, which refuses to rewrite it once it is edited by hand -->`;
const RULE = /^- (\S+?): /;
const INTRO = "## Taste rules\n\nFrom the user's vault. Follow them in this project.";
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

const editing = globs => {
  const [skipped, kept] = [globs.filter(g => g.startsWith('!')), globs.filter(g => !g.startsWith('!'))];
  return `${kept.join(', ')}${skipped.length ? `, except ${skipped.map(g => g.slice(1)).join(', ')}` : ''}`;
};

// A cap of the wrong shape is a lint error; compile still writes the section, within the default cap.
const capOf = n => (Number.isInteger(n) && n > 0 ? n : DEFAULTS.compile.maxBytes);

// Cut by bytes, which the cap counts, where fitContext counts characters: a rule in a language with wide characters
// would otherwise push the section past it. size measures the section as written, its markers and line endings
// included. The intro is always written, so a cap below it and the overflow line leaves just those two. The overflow
// line names no file, since other machines and repos read the section without the vault.
function bodyOf({ always, files, keywords }, maxBytes, size) {
  const leftOut = list => `(Left out to stay within ${maxBytes} bytes: ${list}.)`;
  const groups = [
    ...files.map(g => ({ noun: 'rule', head: `### When editing ${editing(g.globs)}\n`, items: g.lines })),
    ...keywords.map(g => ({ noun: 'rule', head: `### When the request mentions ${joinList(g.keywords, 'or')}\n`, items: g.lines })),
  ];
  if (!always.length && !groups.length) return `${INTRO}\n\nNone yet.`;
  const parts = [{ noun: 'rule', items: always }, ...groups];
  for (let max = maxBytes; ;) {
    const body = `${INTRO}\n\n${fitContext(parts, { max, leftOut }).text}`;
    const over = size(body) - maxBytes;
    if (!(over > 0) || !(max > 0)) return body;
    max = Math.max(0, max - over);
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
  const lines = [];
  for (let at = 0; at <= text.length;) {
    const nl = text.indexOf('\n', at);
    const next = nl < 0 ? text.length : nl + 1;
    // A BOM belongs to the file, so a marker on the first line starts after it.
    const start = text.charCodeAt(at) === 0xfeff ? at + 1 : at;
    lines.push({ at: start, line: text.slice(start, nl < 0 ? text.length : nl).replace(/\r$/, '').trimEnd(), next });
    if (nl < 0) break;
    at = next;
  }
  // Lines in a fence are the file's own text, such as an example of the markers. A fence that never closes hides
  // nothing, or the section compile appends after it would be missed on every later run, and appended again.
  const fenced = new Set();
  for (let i = 0, open = -1, fence = ''; i < lines.length; i++) {
    const m = FENCE.exec(lines[i].line);
    if (!m) continue;
    if (open < 0) {
      if (!(m[1][0] === '`' && m[2].includes('`'))) [open, fence] = [i, m[1]];
    } else if (m[1][0] === fence[0] && m[1].length >= fence.length && !m[2].trim()) {
      for (let j = open; j <= i; j++) fenced.add(j);
      open = -1;
    }
  }
  const begins = [];
  const ends = [];
  lines.forEach(({ at, line, next }, i) => {
    if (fenced.has(i)) return;
    const hash = BEGIN.exec(line)?.[1];
    if (hash) begins.push({ at, stop: at + line.length, next, hash });
    else if (ENDS.has(line)) ends.push({ at, stop: at + line.length, next });
  });
  return { begins, ends };
}

export function compile(sections, root) {
  const path = `${root}/${FILE}`;
  const out = extra => [{ path, text: null, rules: 0, state: 'refused', changed: 0, ...extra }];
  const found = readFile(path);
  if (found.refused) return out({ refused: found.refused });
  const text = found.text ?? '';

  const { begins, ends } = markers(text);
  const [begin] = begins;
  const [end] = ends;
  const paired = begins.length === 1 && ends.length === 1 && begin.at < end.at;
  if ((begins.length || ends.length) && !paired) {
    return out({ refused: "the vault markers don't pair: there must be one begin line and one end line after it. Fix or delete them, then compile again." });
  }
  // A section keeps its marker lines' own line endings and trailing spaces, so a change elsewhere in the file leaves
  // it current. A new section takes the file's line endings.
  const fileEol = text.includes('\r\n') ? '\r\n' : '\n';
  const [beginTail, endTail] = paired ? [text.slice(begin.stop, begin.next), text.slice(end.stop, end.next)] : [fileEol, fileEol];
  const eol = beginTail.endsWith('\r\n') ? '\r\n' : '\n';
  const block = body => `${beginLine(shortHash(body))}${beginTail}${body.split('\n').join(eol)}${eol}${END}${endTail}`;
  const body = bodyOf(sections, capOf(config().compile.maxBytes), b => Buffer.byteLength(block(b)));
  const mine = rulesIn(body);
  const done = (state, next, changed = 0) => [{ path, text: next, rules: mine.size, state, changed }];

  if (!paired) {
    const gap = text === '' ? '' : `${text.endsWith('\n') ? '' : fileEol}${fileEol}`;
    return done('missing', `${text}${gap}${block(body)}`);
  }
  const was = text.slice(begin.next, end.at).replace(/\r?\n$/, '').replace(/\r\n/g, '\n');
  if (shortHash(was) !== begin.hash) return out({ refused: 'the vault section was edited by hand since it was compiled. Move those edits out of the section, or delete it, then compile again.', state: 'edited' });

  const next = `${text.slice(0, begin.at)}${block(body)}${text.slice(end.next)}`;
  if (next === text) return done('current', next);
  const before = rulesIn(was);
  const changed = [...new Set([...before.keys(), ...mine.keys()])].filter(k => before.get(k) !== mine.get(k)).length;
  return done('stale', next, changed);
}
