const ESCAPES = { n: '\n', t: '\t', '"': '"', '\\': '\\' };

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
      i++;
      out += ESCAPES[s[i]] ?? `\\${s[i]}`;
    } else {
      out += ch;
    }
  }
  return s;
}

function scalar(raw) {
  const s = raw.trim();
  if (s[0] === "'" || s[0] === '"') return quoted(s);
  const v = s.replace(/\s+#.*$/, '');
  if (v === 'true' || v === 'false') return v === 'true';
  return v === '' || v === '~' || v === 'null' ? null : v;
}

// Splits flow text at the commas outside quotes and outside the brackets in nest. A flow list nests only braces, so an
// unquoted [[link]] in one still reads as the string [link], as it always has.
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
      if (ch === "'" || ch === '"') q = ch;
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
const KV = /^([^\s#'"-][^:]*?)\s*:(?:\s+(.*))?$/;
const ITEM = /^-(?:[ \t]+(.*))?$/;

// A key with no value takes the lines below it that are indented further, or are list items at its own indent.
const childrenEnd = (rows, i, level) => {
  let j = i + 1;
  while (j < rows.length && (rows[j].indent > level || (rows[j].indent === level && ITEM.test(rows[j].text)))) j++;
  return j;
};

const block = rows => (ITEM.test(rows[0].text) ? sequence(rows) : mapping(rows, rows[0].indent));

// Lines that read as nothing are skipped. An empty mapping or list reads as null, as an empty key always has.
function mapping(rows, level) {
  const out = {};
  let any = false;
  for (let i = 0; i < rows.length; i++) {
    const kv = rows[i].indent <= level && rows[i].text.match(KV);
    if (!kv) continue;
    const j = childrenEnd(rows, i, level);
    let v = kv[2] === undefined ? null : value(kv[2]);
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
  if (end < 0) return { data: {}, body: lines.join('\n'), ok: false };
  const rows = lines.slice(1, end).filter(l => l.trim() && !/^\s*#/.test(l)).map(l => ({ indent: l.match(/^\s*/)[0].length, text: l.trim() }));
  return { data: mapping(rows, 0) ?? {}, body: lines.slice(end + 1).join('\n'), ok: true };
}

// YAML reads these plain as something other than the text: a number, a boolean or null in the YAML other tools use,
// or an indicator character at the start.
const PLAIN_NOT_TEXT = /^(?:[-+]?(?:\d[\d_]*(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?|[-+]?\.(?:inf|nan)|0x[\da-f]+|0o[0-7]+|y|n|yes|no|on|off|true|false|null|~)$/i;
const plainSafe = s => s !== '' && s === s.trim() && !/[\r\n\t]/.test(s) && !/^[-?:,[\]{}#&*!|>'"%@`]/.test(s)
  && !/: | #|:$/.test(s) && !PLAIN_NOT_TEXT.test(s) && value(s) === s;

export const yamlQuote = s => `'${String(s).replace(/'/g, "''")}'`;

// Where a value written after `key: ` ends: after its closing quote, or where a comment starts in a plain one.
function valueEnd(rest) {
  const q = rest[0];
  if (q !== "'" && q !== '"') return rest.search(/[ \t]+#|$/);
  for (let i = 1; i < rest.length; i++) {
    if (q === '"' && rest[i] === '\\') i++;
    else if (q === "'" && rest[i] === "'" && rest[i + 1] === "'") i++;
    else if (rest[i] === q) return i + 1;
  }
  return rest.length;
}

// Sets a scalar on the line parse reads it from, the last one with its key, keeping the line's ending and a trailing
// comment, which is the user's note. The old value goes whole, quotes too. The new one is written plain when it reads
// back as itself and was plain before, single-quoted otherwise. Text without frontmatter, without the key, or whose
// key holds a nested block comes back as it was.
export function setField(text, key, val) {
  const lines = text.split('\n');
  const end = closing(lines);
  const at = lines.findLastIndex((l, i) => i > 0 && i < end && l.replace(/\r$/, '').match(KV)?.[1] === key);
  if (at < 0) return text;
  const [, head, old, eol] = lines[at].match(/^([^:]*:[ \t]*)(.*?)(\r?)$/);
  const next = lines.slice(at + 1, end).find(l => l.trim() && !/^\s*#/.test(l));
  if ((!old.trim() || old.startsWith('#')) && next && /^(?:\s|-)/.test(next)) return text;
  const tail = old.slice(valueEnd(old));
  const comment = /^[ \t]+#/.test(tail) ? tail : '';
  const s = String(val);
  const written = plainSafe(s) && !/^['"]/.test(old) ? s : yamlQuote(s);
  lines[at] = `${/\s$/.test(head) ? head : `${head} `}${written}${comment}${eol}`;
  return lines.join('\n');
}
