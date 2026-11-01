import { createHash } from 'node:crypto';
import { config } from './vault.mjs';

// No vendor's key prefix: a name that says it holds a secret, or a run of characters only a machine would write.
const PEM = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/g;
const ASSIGN = /(?<![\p{L}\p{N}])[\p{L}\p{N}_.-]{0,40}?(?:key|token|secret|passw(?:or)?d|credential)s?["']?[ \t]*[:=][ \t]*["']?([^\s"'`<>,;]{8,})/giu;
const PLACEHOLDER = /^(?:\$\{|\{\{|%|<)|^(?:x+|\*+|\.+|your[_-].*|changeme|example.*|placeholder.*|redacted)$/i;
const RUN = /(?<![A-Za-z0-9+/_=-])[A-Za-z0-9+/_=-]{32,}(?![A-Za-z0-9+/_=-])/g;
const BLOCK = /^-----BEGIN ([A-Z0-9 ]+)-----/;

const masked = v => `${v.slice(0, 2)}…${v.slice(-2)}`;
const allowId = v => createHash('sha256').update(v).digest('hex').slice(0, 16);

function entropy(s) {
  const counts = new Map();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) bits -= (n / s.length) * Math.log2(n / s.length);
  return bits;
}

const tokenShaped = v => /\d/.test(v) && /[A-Z]/.test(v) && /[a-z]/.test(v) && entropy(v) >= 4.2;

// The key- and token-shaped values in a text, one per value per line, each with the allow id privacy.allow takes. A
// PEM block's lines are base64 by design, so only a private key's block is reported, and as one value.
export function secretsIn(text) {
  const lines = String(text).split(/\r?\n/);
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    const begin = lines[i].match(BLOCK);
    if (begin) {
      const end = lines.findIndex((l, j) => j > i && l.startsWith(`-----END ${begin[1]}-----`));
      const last = end === -1 ? lines.length - 1 : end;
      PEM.lastIndex = 0;
      if (PEM.test(lines[i])) {
        const value = lines.slice(i, last + 1).join('\n');
        found.push({ line: i + 1, kind: 'private key', value, masked: 'private key', allow: allowId(value) });
      }
      i = last;
      continue;
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
      found.push({ line: i + 1, kind: 'assignment', name, value, masked: masked(value), allow: allowId(value) });
    }
    for (const m of line.matchAll(RUN)) {
      const value = m[0];
      if (line.slice(0, m.index).endsWith('base64,') || /^sha(?:256|384|512)-/.test(value) || !tokenShaped(value)) continue;
      if (spans.some(([a, b]) => m.index < b && a < m.index + value.length)) continue;
      found.push({ line: i + 1, kind: 'token', value, masked: masked(value), allow: allowId(value) });
    }
  }
  return found.sort((a, b) => a.line - b.line);
}

// What secretsIn finds that privacy.allow in vault.config.json doesn't let through.
export function unallowedSecrets(text) {
  const allow = config().privacy?.allow;
  const allowed = new Set(Array.isArray(allow) ? allow : []);
  return secretsIn(text).filter(s => !allowed.has(s.allow));
}

// A finding as scan.mjs prints it after the file and line.
export const shownSecret = s => (s.kind === 'private key' ? s.kind : `${s.kind} ${s.name ? `${s.name}=` : ''}${s.masked}`);
