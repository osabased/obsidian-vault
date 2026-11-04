// YAML's escapes in double quotes. \x, \u and \U take 2, 4 and 8 hex digits, a code point.
const ESCAPES = {
  0: '\0', a: '\x07', b: '\b', t: '\t', '\t': '\t', n: '\n', v: '\v', f: '\f', r: '\r', e: '\x1b', ' ': ' ', '"': '"', '/': '/', '\\': '\\',
  N: '\x85', _: '\xa0', L: String.fromCharCode(0x2028), P: String.fromCharCode(0x2029),
};
const HEX_DIGITS = { x: 2, u: 4, U: 8 };

function quoted(s) {
  const q = s[0];
  let out = '';
  for (let i = 1; i < s.length; i++) {
    const ch = s[i];
    if (ch === q && q === "'" && s[i + 1] === "'") {
      out += "'";
      i++;
    } else if (ch === q) {
      return out;
    } else if (q === '"' && ch === '\\' && i + 1 < s.length) {
      const n = HEX_DIGITS[s[++i]];
      const hex = n && s.slice(i + 1, i + 1 + n);
      const cp = hex && /^[\da-f]+$/i.test(hex) && hex.length === n ? parseInt(hex, 16) : NaN;
      if (cp <= 0x10ffff) {
        out += String.fromCodePoint(cp);
        i += n;
      } else {
        out += ESCAPES[s[i]] ?? `\\${s[i]}`;
      }
    } else {
      out += ch;
    }
  }
  return s;
}

function scalar(raw) {
  const s = raw.trim();
  if (s[0] === "'" || s[0] === '"') return quoted(s);
  // The lookbehind starts a match only at the first space of a run, so a long run is read once.
  const v = s.includes('#') ? s.replace(/(?<!\s)\s+#.*$/, '') : s;
  if (v === 'true' || v === 'false') return v === 'true';
  return v === '' || v === '~' || v === 'null' ? null : v;
}

// Splits flow text at the commas outside quotes and outside the brackets in nest. A flow list nests only braces, so an
// unquoted [[link]] in one still reads as the string [link], as it always has. As in YAML, a quote opens only where an
// item, key or value starts, so an apostrophe inside a word, as in don't, is text.
function splitFlow(inner, nest, at = ',') {
  const parts = [];
  let cur = '';
  let q = null;
  let depth = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (q) {
      cur += ch;
      if (q === '"' && ch === '\\') cur += inner[++i] ?? '';
      else if (ch === q && q === "'" && inner[i + 1] === "'") cur += inner[++i];
      else if (ch === q) q = null;
    } else if (ch === at && !depth && (at === ',' || /\s/.test(inner[i + 1] ?? ' '))) {
      parts.push(cur);
      if (at !== ',') return [...parts, inner.slice(i + 1)];
      cur = '';
    } else {
      if ((ch === "'" || ch === '"') && /^$|[[{,:]$/.test(cur.trimEnd())) q = ch;
      else if (nest.includes(ch)) depth = Math.max(0, depth + ('{['.includes(ch) ? 1 : -1));
      cur += ch;
    }
  }
  return [...parts, cur];
}

// Braces with no key: value inside, like a glob's {ts,tsx}, stay a string.
const isFlowMap = s => s.startsWith('{') && s.endsWith('}') && splitFlow(s.slice(1, -1), '{}[]', ':').length > 1;

function flowMap(s) {
  const out = {};
  for (const part of splitFlow(s.slice(1, -1), '{}[]')) {
    if (!part.trim()) continue;
    const [k, v] = splitFlow(part, '{}[]', ':');
    out[scalar(k)] = v === undefined ? null : value(v);
  }
  return out;
}

const flowList = inner => splitFlow(inner, '{}').map(p => (isFlowMap(p.trim()) ? flowMap(p.trim()) : scalar(p))).filter(v => v !== null);

function value(raw) {
  const v = raw.trim();
  if (v.startsWith('[') && v.endsWith(']')) return flowList(v.slice(1, -1));
  return isFlowMap(v) ? flowMap(v) : scalar(v);
}

const closing = lines => (lines[0].trim() === '---' ? lines.findIndex((l, i) => i > 0 && /^---\s*$/.test(l)) : -1);
// The white space before the colon starts only after a character that isn't white space, so a long run of spaces is
// read once.
const KV = /^([^\s#'"-][^:]*?)(?<!\s)\s*:(?:\s+([^]*))?$/;
const ITEM = /^-(?:[ \t]+([^]*))?$/;

// Reads s on from from, keeping a value's state in st: the quote open in it, how deep it is in [ and {, and its last
// character outside quotes. Returns the index just past where the value closes, or -1 when s ends first. As in
// splitFlow, a quote opens only where an item, key or value starts, so the apostrophe in don't is text.
function advance(s, st, from = 0) {
  for (let i = from; i < s.length; i++) {
    const ch = s[i];
    if (st.q) {
      if (st.q === '"' && ch === '\\') i++;
      else if (st.q === "'" && ch === "'" && s[i + 1] === "'") i++;
      else if (ch === st.q) {
        st.q = null;
        st.prev = ch;
        if (!st.depth) return i + 1;
      }
    } else if (ch !== ' ' && ch !== '\t') {
      if ((ch === "'" || ch === '"') && '[{,:'.includes(st.prev)) st.q = ch;
      else if (ch === '[' || ch === '{') st.depth++;
      else if ((ch === ']' || ch === '}') && st.depth && !--st.depth) return i + 1;
      st.prev = ch;
    }
  }
  return -1;
}

// Where a quote opened at the start of a value closes: the index just past it, or -1 when the text ends first.
const closeAt = (s, q, from) => advance(s, { q, depth: 0, prev: '' }, from);

// A line's indent, the dashes of the list items it starts and its key, each part matching characters no other part
// can, so a long run of spaces is read once. col is the key's column, or the last dash's when there is no key.
const HEAD = /^([ \t]*)((?:-(?:[ \t]+|$))*)(?:([^\s#'"[{-][^:]*):(?:[ \t]+|$))?/;
function head(s) {
  const [all, sp, dashes, key] = s.match(HEAD);
  const dash = dashes ? sp.length + dashes.trimEnd().lastIndexOf('-') : -1;
  return { indent: sp.length, dash, key: key?.trimEnd(), col: key === undefined ? dash : sp.length + dashes.length, rest: s.slice(all.length) };
}
function indentOf(s) {
  let i = 0;
  while (s[i] === ' ' || s[i] === '\t') i++;
  return i;
}
const isComment = s => /^\s*#/.test(s);

// A line of a quoted value without the white space before its break. Inside double quotes, a backslash before the
// break drops the break too.
function lineEnd(s, q) {
  const t = s.trimEnd();
  return q === '"' && (/\\+$/.exec(t)?.[0].length ?? 0) % 2 === 1 ? { text: t.slice(0, -1), esc: true } : { text: t, esc: false };
}

// A quoted or flow value that runs on from line i, folded as YAML does: each break is a space, and inside quotes an
// empty line is a newline and the white space around a break goes. Outside quotes a comment line is skipped. Returns
// the one line that holds the folded text, how many lines it took, and its last line with where the value closes in
// it, or null when a quote or bracket is still open at the first line not indented past parent.
function fold(line, i, to, parent, st) {
  let { text, esc } = lineEnd(line(i), st.q);
  let blanks = 0;
  for (let j = i + 1; j < to; j++) {
    const s = line(j);
    const t = s.trim();
    if (!t) blanks++;
    else if (!st.q && t[0] === '#') continue;
    else if (indentOf(s) <= parent) return null;
    else {
      const sep = st.q && blanks ? '\n'.repeat(blanks) : esc ? '' : ' ';
      const end = advance(t, st);
      if (end >= 0) return { text: text + sep + t, n: j - i + 1, last: t, end };
      const piece = lineEnd(t, st.q);
      text += sep + piece.text;
      esc = piece.esc;
      blanks = 0;
    }
  }
  return null;
}

// A plain value takes the lines below it indented past parent that are not keys, list items or comments, each break a
// space and each empty line a newline, as YAML does. A comment ends it.
function plainFold(line, i, to, parent, first, value) {
  let text = first.trimEnd();
  let last = value;
  let n = 1;
  let blanks = 0;
  for (let j = i + 1; j < to; j++) {
    const s = line(j);
    const indent = indentOf(s);
    // Most values are one line under a key at the margin, so the line below ends them here, before any other test.
    if (indent <= parent && indent < s.length && s.trim()) break;
    const t = s.trim();
    if (!t) {
      blanks++;
      continue;
    }
    if (indent <= parent || t[0] === '#' || /\s#/.test(last)) break;
    const h = head(s);
    if (h.key !== undefined || h.dash >= 0) break;
    text += (blanks ? '\n'.repeat(blanks) : ' ') + t;
    last = t;
    n = j - i + 1;
    blanks = 0;
  }
  return { i, text, n };
}

// The key a message about the value on line i names: its own, or for a list item or a value on its own line, the key
// above that it is under.
function owner(line, from, i, h) {
  for (let j = i; h.key === undefined && j-- > from;) {
    const k = head(line(j));
    if (k.key !== undefined && (h.col < 0 ? k.col < h.indent : k.col <= h.dash)) return k.key;
  }
  return h.key ?? (h.col < 0 ? 'a value' : 'a list item');
}

// The logical lines from..to: blank and comment lines skipped, and a value that runs onto the lines below as one line.
// As in YAML, a value runs on only onto lines indented past its parent's column: its key's, its last dash's when it has
// no key, or for a value on its own line, the key's above it. A quote, [ or { open in it runs it on; a plain value runs
// on onto lines that are not keys or list items. A quote or bracket still open at the first line that isn't leaves the
// value's first line as it is and adds a message to errors, as does text after a closing quote. The body of a | or >
// block is passed through line by line, never read for quotes.
function scan(lines, from, to, errors = []) {
  const line = j => (lines[j].endsWith('\r') ? lines[j].slice(0, -1) : lines[j]);
  const out = [];
  let under = -1;
  for (let i = from; i < to; i++) {
    const s = line(i);
    if (!s.trim() || isComment(s)) continue;
    const h = head(s);
    const v = h.rest;
    const own = h.col < 0;
    const parent = !own ? h.col : under >= 0 && h.indent > under ? under : h.indent;
    if (!own && (!v.trim() || v[0] === '#')) {
      under = h.col;
      out.push({ i, text: s, n: 1 });
      continue;
    }
    under = -1;
    if (!own && BLOCK_SCALAR.test(v)) {
      out.push({ i, text: s, n: 1 });
      let j = i + 1;
      for (; j < to; j++) {
        const b = line(j);
        if (!b.trim() || isComment(b)) continue;
        if (indentOf(b) <= h.col) break;
        out.push({ i: j, text: b, n: 1 });
      }
      i = j - 1;
      continue;
    }
    let row = { i, text: s, n: 1 };
    if (/^['"[{]/.test(v)) {
      const st = { q: null, depth: 0, prev: '' };
      let end = advance(s, st, s.length - v.length);
      let last = { at: i, text: s };
      if (end < 0) {
        const f = fold(line, i, to, parent, st);
        if (f) {
          row = { i, text: f.text, n: f.n };
          last = { at: i + f.n - 1, text: f.last };
          end = f.end;
        } else if (v[0] === "'" || v[0] === '"') {
          errors.push(`${owner(line, from, i, h)}: the ${v[0]} quote opened on line ${i + 1} never closes. Close it with a matching ${v[0]}`);
        } else {
          errors.push(`${owner(line, from, i, h)}: the ${v[0]} opened on line ${i + 1} never closes. Close it with a matching ${v[0] === '[' ? ']' : '}'}`);
        }
      }
      if (end >= 0 && (v[0] === "'" || v[0] === '"') && !/^(?:\s*$|\s+#)/.test(last.text.slice(end))) {
        errors.push(`${owner(line, from, i, h)}: text follows the closing quote on line ${last.at + 1}. Put it inside the quotes, or after a #`);
      }
    } else {
      row = plainFold(line, i, to, parent, s, v);
    }
    out.push(row);
    i += row.n - 1;
  }
  return out;
}

// A key with no value takes the lines below it that are indented further, or are list items at its own indent.
const childrenEnd = (rows, i, level) => {
  let j = i + 1;
  while (j < rows.length && (rows[j].indent > level || (rows[j].indent === level && ITEM.test(rows[j].text)))) j++;
  return j;
};

// A lone line below a key that is no key or list item is the key's value, as in YAML.
const block = rows => (ITEM.test(rows[0].text) ? sequence(rows)
  : rows.length === 1 && (/^['"[{]/.test(rows[0].text) || !KV.test(rows[0].text)) ? value(rows[0].text) : mapping(rows, rows[0].indent));

// A | or > after the key. The lines below are its text, folded with spaces or kept with newlines. Blank lines are
// already gone, so a paragraph break folds to a space. Lines starting with # are gone too, where YAML would keep them.
// A literal block keeps each line's indent beyond the first line's.
const BLOCK_SCALAR = /^[|>][-+]?\d*\s*(?:#.*)?$/;
const blockScalar = (head, rows) => (head[0] === '>'
  ? rows.map(r => r.text).join(' ')
  : rows.map(r => ' '.repeat(Math.max(0, r.indent - rows[0].indent)) + r.text).join('\n'));

// Lines that read as nothing are skipped. An empty mapping or list reads as null, as an empty key always has.
function mapping(rows, level) {
  const out = {};
  let any = false;
  for (let i = 0; i < rows.length; i++) {
    const kv = rows[i].indent <= level && rows[i].text.match(KV);
    if (!kv) continue;
    const j = childrenEnd(rows, i, level);
    let v = kv[2] === undefined ? null : BLOCK_SCALAR.test(kv[2]) ? blockScalar(kv[2], rows.slice(i + 1, j)) : value(kv[2]);
    if (v === null && j > i + 1) v = block(rows.slice(i + 1, j));
    out[kv[1]] = v;
    any = true;
    i = j - 1;
  }
  return any ? out : null;
}

// A scalar item takes no lines below it, so a list whose items wander in indent still reads as one list.
function sequence(rows) {
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const { indent, text } = rows[i];
    const m = text.match(ITEM);
    if (!m) continue;
    const c = m[1] ?? '';
    if (c && (isFlowMap(c) || !KV.test(c))) {
      const v = isFlowMap(c) ? flowMap(c) : scalar(c);
      if (v !== null) out.push(v);
      continue;
    }
    let j = i + 1;
    while (j < rows.length && rows[j].indent > indent) j++;
    const kids = rows.slice(i + 1, j);
    const v = c ? mapping([{ indent: indent + text.length - c.length, text: c }, ...kids], indent + text.length - c.length) : kids.length ? block(kids) : null;
    if (v !== null) out.push(v);
    i = j - 1;
  }
  return out.length ? out : null;
}

// The subset of YAML that Obsidian writes for properties, plus nested mappings: scalars, quoted strings, flow and block
// lists, and flow and block mappings.
export function parse(text) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/);
  const end = closing(lines);
  if (end < 0) return { data: {}, body: lines.join('\n'), ok: false, errors: [] };
  const errors = [];
  const rows = scan(lines, 1, end, errors).map(e => ({ indent: e.text.match(/^\s*/)[0].length, text: e.text.trim() }));
  return { data: mapping(rows, 0) ?? {}, body: lines.slice(end + 1).join('\n'), ok: true, errors };
}

// YAML reads these plain as something other than the text: a number, a boolean or null in the YAML other tools use,
// or an indicator character at the start.
const PLAIN_NOT_TEXT = /^(?:[-+]?(?:\d[\d_]*(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?|[-+]?\.(?:inf|nan)|0x[\da-f]+|0o[0-7]+|y|n|yes|no|on|off|true|false|null|~)$/i;
export const plainSafe = s => s !== '' && s === s.trim() && !/[\r\n\t]/.test(s) && !/^[-?:,[\]{}#&*!|>'"%@`]/.test(s)
  && !/: | #|:$/.test(s) && !PLAIN_NOT_TEXT.test(s) && value(s) === s;

// Single quotes fold a line break to a space, so a value with one is double-quoted.
export const yamlQuote = s => (/[\r\n]/.test(s)
  ? `"${String(s).replace(/[\\"]/g, '\\$&').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`
  : `'${String(s).replace(/'/g, "''")}'`);

export const yamlScalar = s => (plainSafe(s) ? s : yamlQuote(s));

export const yamlList = (name, xs) => (xs.length ? [`${name}:`, ...xs.map(x => `  - ${yamlQuote(x)}`)] : [`${name}: []`]);

// Where a value written after `key: ` ends: after its closing quote, or where a comment starts in a plain one.
function valueEnd(rest) {
  const q = rest[0];
  if (q !== "'" && q !== '"') return rest.search(/(?<![ \t])[ \t]+#|$/);
  const end = closeAt(rest, q, 1);
  return end < 0 ? rest.length : end;
}

// A top-level list's lines are the key's line and the indented or `-` lines below it. A key that isn't there is added
// before the closing line.
export function setList(text, key, items) {
  const lines = text.split('\n');
  const end = closing(lines);
  if (end < 1) return text;
  const eol = lines[0].endsWith('\r') ? '\r' : '';
  const bare = l => l.replace(/\r$/, '');
  const written = yamlList(key, items).map(l => `${l}${eol}`);
  const at = lines.findIndex((l, i) => i > 0 && i < end && bare(l).match(KV)?.[1] === key);
  if (at < 0) {
    lines.splice(end, 0, ...written);
    return lines.join('\n');
  }
  let stop = at + 1;
  while (stop < end && /^(?:[ \t]|-)/.test(bare(lines[stop]))) stop++;
  lines.splice(at, stop - at, ...written);
  return lines.join('\n');
}

// Sets a scalar on the line parse reads it from, the last one with its key, keeping the line's ending and a trailing
// comment, which is the user's note. The old value goes whole, quotes too. The new one is written plain when it reads
// back as itself and was plain before, single-quoted otherwise. Text without frontmatter, without the key, or whose
// key holds a nested block comes back as it was.
export function setField(text, key, val) {
  const lines = text.split('\n');
  const end = closing(lines);
  const at = scan(lines, 1, Math.max(end, 1)).findLast(e => e.text.match(KV)?.[1] === key);
  if (!at) return text;
  const [, head, old] = at.text.match(/^([^:]*:[ \t]*)([^]*)$/);
  const eol = lines[at.i + at.n - 1].endsWith('\r') ? '\r' : '';
  const next = lines.slice(at.i + at.n, end).find(l => l.trim() && !/^\s*#/.test(l));
  if (BLOCK_SCALAR.test(old)) return text;
  if ((!old.trim() || old.startsWith('#')) && next && /^(?:\s|-)/.test(next)) return text;
  const tail = old.slice(valueEnd(old));
  const comment = /^[ \t]+#/.test(tail) ? tail : '';
  const s = String(val);
  const written = plainSafe(s) && !/^['"]/.test(old) ? s : yamlQuote(s);
  lines.splice(at.i, at.n, `${/\s$/.test(head) ? head : `${head} `}${written}${comment}${eol}`);
  return lines.join('\n');
}
