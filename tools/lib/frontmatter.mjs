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

function flowList(inner) {
  const parts = [];
  let cur = '';
  let q = null;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (q) {
      cur += ch;
      if (q === '"' && ch === '\\') cur += inner[++i] ?? '';
      else if (ch === q && q === "'" && inner[i + 1] === "'") cur += inner[++i];
      else if (ch === q) q = null;
    } else if (ch === ',') {
      parts.push(cur);
      cur = '';
    } else {
      if (ch === "'" || ch === '"') q = ch;
      cur += ch;
    }
  }
  parts.push(cur);
  return parts.map(scalar).filter(v => v !== null);
}

function value(raw) {
  const v = raw.trim();
  return v.startsWith('[') && v.endsWith(']') ? flowList(v.slice(1, -1)) : scalar(v);
}

const closing = lines => (lines[0].trim() === '---' ? lines.findIndex((l, i) => i > 0 && /^---\s*$/.test(l)) : -1);
const KV = /^([^\s#'"-][^:]*?)\s*:(?:\s+(.*))?$/;

// The subset of YAML that Obsidian writes for properties: scalars, quoted strings, inline and block lists.
export function parse(text) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/);
  const end = closing(lines);
  if (end < 0) return { data: {}, body: lines.join('\n'), ok: false };
  const data = {};
  let list = null;
  for (const line of lines.slice(1, end)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const item = line.match(/^\s*-(?:\s+(.*))?$/);
    if (item && list) {
      const v = scalar(item[1] ?? '');
      if (v !== null) data[list] = [...(data[list] ?? []), v];
      continue;
    }
    list = null;
    const kv = line.match(KV);
    if (!kv) continue;
    data[kv[1]] = kv[2] === undefined ? null : value(kv[2]);
    if (data[kv[1]] === null) list = kv[1];
  }
  return { data, body: lines.slice(end + 1).join('\n'), ok: true };
}

// Sets a scalar on the line parse reads it from, the last one with its key, keeping the line's quotes, comment and
// ending. Text without frontmatter or without the key comes back as it was.
export function setField(text, key, val) {
  const lines = text.split('\n');
  const end = closing(lines);
  const at = lines.findLastIndex((l, i) => i > 0 && i < end && l.replace(/\r$/, '').match(KV)?.[1] === key);
  if (at < 0) return text;
  const [, head, old, comment, eol] = lines[at].match(/^([^:]*:[ \t]*)(.*?)((?:[ \t]+#.*)?)(\r?)$/);
  const q = /^['"]/.test(old) ? old[0] : '';
  lines[at] = `${/\s$/.test(head) ? head : `${head} `}${q}${val}${q}${comment}${eol}`;
  return lines.join('\n');
}
