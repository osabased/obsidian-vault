import { config, shortHash } from './vault.mjs';

// No vendor's key prefix: a name that says it holds a secret, or a run of characters only a machine would write.
const PEM = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/;
const ASSIGN = /(?<![\p{L}\p{N}])[\p{L}\p{N}_.-]{0,40}?(?:key|token|secret|passw(?:or)?d|credential)s?["']?[ \t]*[:=][ \t]*["']?([^\s"'`<>,;]{8,})/giu;
const PLACEHOLDER = /^(?:\$\{|\{\{|%|<)|^(?:x+|\*+|\.+|your[_-].*|changeme|example.*|placeholder.*|redacted)$/i;
const RUN = /(?<![A-Za-z0-9+/_=-])[A-Za-z0-9+/_=-]{32,}(?![A-Za-z0-9+/_=-])/g;
// A block may sit indented in YAML, after a list marker, or as one quoted string per line in JSON.
const BLOCK = /^\s*(?:- |")?-----BEGIN ([A-Z0-9 ]+)-----/;
const BASE64 = /^[A-Za-z0-9+/=]*$/;
// The headers PGP and PEM armor define, so another `name: value` line inside a block is still a line to scan.
const HEADER = /^(?:Version|Comment|MessageID|Hash|Charset|Proc-Type|DEK-Info): /;
const PIECE = /[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|\d+/g;

const masked = v => `${v.slice(0, 2)}…${v.slice(-2)}`;
const bare = line => line.trim().replace(/^(?:- |")/, '').replace(/",?$/, '');
const armored = line => BASE64.test(bare(line)) || HEADER.test(bare(line));

function entropy(s) {
  const counts = new Map();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) bits -= (n / s.length) * Math.log2(n / s.length);
  return bits;
}

// Names, paths and URLs join words and numbers with separators and case changes. A machine-made run split the same
// way leaves pieces of one or two letters, or longer ones no word is spelt like, so a run of words is no token.
function wordy(v) {
  const pieces = [];
  for (const part of v.split(/[/_.-]+/)) {
    if (/[^A-Za-z0-9]/.test(part)) return false;
    pieces.push(...(part.match(PIECE) ?? []));
  }
  const word = p => /^\d+$/.test(p) || p.length <= 2 || /^[A-Z]{3,6}$/.test(p) || (p.length <= 20 && /[aeiouy]/i.test(p));
  return pieces.every(word) && pieces.filter(p => /^[A-Za-z]{1,2}$/.test(p)).length * 4 <= pieces.length;
}

const tokenShaped = v => /\d/.test(v) && /[A-Z]/.test(v) && /[a-z]/.test(v) && entropy(v) >= 4.2 && !wordy(v);

// The key- and token-shaped values in a text, one per value per line, each with the allow id privacy.allow takes. A
// PEM block's lines are base64 by design, so a block its END closes holding only base64 and armor headers is passed,
// and a private key's block is reported as one value, which runs to the end of the text when no END closes it.
export function secretsIn(text) {
  const lines = String(text).split(/\r?\n/);
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    const begin = lines[i].match(BLOCK);
    if (begin) {
      const end = `-----END ${begin[1]}-----`;
      if (PEM.test(`-----BEGIN ${begin[1]}-----`)) {
        let last = i + 1;
        while (last < lines.length && !bare(lines[last]).startsWith(end)) last++;
        last = Math.min(last, lines.length - 1);
        const value = lines.slice(i, last + 1).join('\n');
        found.push({ line: i + 1, kind: 'private key', value, masked: 'private key', allow: shortHash(value) });
        i = last;
        continue;
      }
      let j = i + 1;
      while (j < lines.length && armored(lines[j])) j++;
      if (j < lines.length && bare(lines[j]).startsWith(end)) {
        i = j;
        continue;
      }
    }
    const line = lines[i];
    const spans = [];
    for (const m of line.matchAll(ASSIGN)) {
      const value = m[1];
      if (!/\p{L}/u.test(value) || !/\d/.test(value) || PLACEHOLDER.test(value)) continue;
      const head = m[0].slice(0, m[0].length - value.length);
      const name = head.slice(0, head.search(/[:=]/)).replace(/["'\s]+$/, '');
      const start = m.index + head.length;
      spans.push([start, start + value.length]);
      found.push({ line: i + 1, kind: 'assignment', name, value, masked: masked(value), allow: shortHash(value) });
    }
    // Both lists rise along the line, so one pointer walks the spans.
    let k = 0;
    for (const m of line.matchAll(RUN)) {
      const value = m[0];
      while (k < spans.length && spans[k][1] <= m.index) k++;
      if (line.slice(0, m.index).endsWith('base64,') || /^sha(?:256|384|512)-/.test(value) || !tokenShaped(value)) continue;
      if (k < spans.length && spans[k][0] < m.index + value.length) continue;
      found.push({ line: i + 1, kind: 'token', value, masked: masked(value), allow: shortHash(value) });
    }
  }
  return found.sort((a, b) => a.line - b.line);
}

// Derived text's frontmatter is the core's, written from the binary's path and the extractor's name, not the source's.
function headLines(text) {
  const lines = String(text).split(/\r?\n/, 64);
  if (lines[0] !== '---') return 0;
  const end = lines.indexOf('---', 1);
  return end === -1 ? 0 : end + 1;
}

// What secretsIn finds that privacy.allow in vault.config.json doesn't let through, past derived text's frontmatter.
export function unallowedSecrets(text, { derived = false } = {}) {
  const allow = config().privacy?.allow;
  const allowed = new Set(Array.isArray(allow) ? allow : []);
  const head = derived ? headLines(text) : 0;
  return secretsIn(text).filter(s => s.line > head && !allowed.has(s.allow));
}

// A finding as scan.mjs prints it, and extract.mjs when it refuses a text.
const shownSecret = s => (s.kind === 'private key' ? s.kind : `${s.kind} ${s.name ? `${s.name}=` : ''}${s.masked}`);
export const secretLine = (rel, s) => `${rel}:${s.line} ${shownSecret(s)} · allow ${s.allow}`;
