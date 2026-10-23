import fs from 'node:fs';
import path from 'node:path';
import { isBuiltin } from 'node:module';
import { config, vaultPath, plural, today } from './vault.mjs';
import { loadNotes, readLedger, noteErrors, replaceProblem, noteHash, ruleText, ruleTextParts, alwaysSize, build, isUrl, validDay } from './rules.mjs';

export const tally = found => {
  const errors = found.filter(f => f.level === 'error').length;
  return `${plural(errors, 'error')}, ${plural(found.length - errors, 'warning')}`;
};

export function lint() {
  const found = [];
  const add = (level, file, msg) => found.push({ level, file, msg });
  const { domains, delivery, knowledge } = config();
  let ledger = null;
  try { ledger = readLedger(); } catch (e) { add('error', 'confirmed.json', `not valid JSON: ${e.message}`); }
  const rules = ledger?.rules ?? {};
  const retired = ledger?.retired ?? {};
  const notes = loadNotes();
  const keys = new Set(notes.map(n => n.key));

  for (const n of notes) {
    if (n.depth === 1) add('error', n.rel, 'notes go in wiki/<domain>/');
    else if (n.domain !== 'global' && !domains[n.domain]) add('error', n.rel, `${n.domain} isn't a domain in taste.config.json`);
    if (n.depth > 2) add('warn', n.rel, 'notes go directly in wiki/<domain>/, not in subfolders, or they can\'t be confirmed');
    for (const e of noteErrors(n)) add('error', n.rel, e);
    if (n.type === 'page') lintPage(n, add);
    if (n.type !== 'rule') continue;

    const entry = rules[n.key];
    if (n.status === 'confirmed' && !entry) add('error', n.rel, "status is confirmed but the user hasn't confirmed it; only the user's confirm in chat sets it");
    for (const t of n.replaces ?? []) {
      if (t === n.key) add('error', n.rel, 'replaces itself');
      else if (!keys.has(t) && !rules[t] && !retired[t]) add('error', n.rel, `replaces ${t}, which has no note`);
      else {
        const wrong = replaceProblem(n, t);
        if (wrong) add('error', n.rel, wrong);
      }
    }
    if (entry && n.status !== 'confirmed') add('warn', n.rel, `confirmed in confirmed.json but its status is ${n.status}`);
    if (entry && entry.hash !== noteHash(n)) add('warn', n.rel, 'changed since confirmed; the hooks still enforce the confirmed wording until you confirm it again');
    if (!n.because) add('warn', n.rel, 'empty **Because:**');
    const topics = domains[n.domain]?.topics;
    if (topics && !topics.includes(n.data.topic)) add('warn', n.rel, `topic should be one of ${topics.join(', ')}`);
    if (n.do && n.not && ruleText(n).length > delivery.maxRuleChars) {
      add('warn', n.rel, `${ruleTextParts(n)} come to ${ruleText(n).length} characters; the hooks cut them at ${delivery.maxRuleChars}`);
    }
    const confirmed = n.status === 'confirmed';
    // The hooks deliver the date recorded at confirmation, so that is the one that goes stale.
    const asOf = (confirmed && entry?.as_of) || n.as_of;
    if (n.kind === 'knowledge' && n.status !== 'outdated' && validDay(asOf)) {
      const days = Math.round((Date.parse(today()) - Date.parse(asOf)) / 864e5);
      if (days > knowledge.staleAfterDays) {
        add('warn', n.rel, asOf !== n.as_of && validDay(n.as_of)
          ? `the confirmed as_of is ${days} days old; confirm it again to deliver as_of ${n.as_of}`
          : `as_of is ${days} days old. If it still holds, set as_of to the day you checked and confirm it${confirmed ? ' again' : ''}; if not, ${confirmed ? 'retire' : 'drop'} it`);
      }
    }
  }

  if (ledger) {
    for (const k of Object.keys(rules)) if (!keys.has(k)) add('warn', 'confirmed.json', `${k} is confirmed but has no note`);
    for (const d of Object.keys(domains)) {
      const size = alwaysSize(ledger, ['global', d]);
      if (size.lines > delivery.activeMaxLines || size.bytes > delivery.activeMaxBytes) {
        add('error', 'active.md', `always-on rules for ${d} come to ${size.lines} lines and ${size.bytes} bytes, over the ${delivery.activeMaxLines} lines or ${delivery.activeMaxBytes} bytes a session start loads`);
      }
    }
    for (const f of build({ check: true })) add('error', f, 'stale; run node tools/build.mjs');
  }
  lintCode(add);
  return found.sort((a, b) => (a.level === b.level ? 0 : a.level === 'error' ? -1 : 1));
}

const realFile = file => {
  try { return fs.statSync(file).isFile() ? fs.realpathSync.native(file) : null; } catch { return null; }
};

// /ingest finds the sources no page names yet by comparing paths, so each file has one spelling.
function lintPage(n, add) {
  const { source, source_date: dated } = n.data;
  if (!isUrl(source)) {
    const real = typeof source === 'string' ? realFile(vaultPath(source)) : null;
    const rel = real ? path.relative(fs.realpathSync.native(vaultPath()), real).split(path.sep).join('/') : '';
    if (!rel.startsWith('raw/')) add('error', n.rel, 'source must be a URL or a file under raw/ that exists');
    else if (rel !== source) add('error', n.rel, `write source as ${rel}, the path from the vault root`);
  }
  if (dated != null && !validDay(dated)) add('error', n.rel, 'source_date must be a date as YYYY-MM-DD');
  else if (dated > today()) add('error', n.rel, `source_date ${dated} is in the future`);
}

const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);

// Blanks comments, string and template text and regex bodies but keeps every offset,
// so the code checks never match inside them and string values can be looked up by position.
function scan(src) {
  const code = src.split('');
  const comments = [];
  const strings = new Map();
  const depths = [];
  const blank = (a, b) => { for (let k = a; k < b; k++) if (code[k] !== '\n') code[k] = ' '; };
  const template = j => {
    for (let k = j; k < src.length; k++) {
      if (src[k] === '\\') k++;
      else if (src[k] === '`') { blank(j, k); return { end: k + 1, open: false }; }
      else if (src[k] === '$' && src[k + 1] === '{') { blank(j, k); depths.push(0); return { end: k + 2, open: true }; }
    }
    blank(j, src.length);
    return { end: src.length, open: false };
  };
  const regexCanStart = i => {
    let p = i - 1;
    while (p >= 0 && /\s/.test(code[p])) p--;
    if (p < 0 || !/[\w$)\]}'"`]/.test(code[p])) return true;
    let q = p;
    while (q >= 0 && /[\w$]/.test(code[q])) q--;
    return REGEX_AFTER_WORD.has(code.slice(q + 1, p + 1).join(''));
  };

  let i = src.startsWith('#!') ? src.indexOf('\n') : 0;
  if (i < 0) i = src.length;
  blank(0, i);
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && (next === '/' || next === '*')) {
      const close = next === '/' ? src.indexOf('\n', i) : src.indexOf('*/', i + 2);
      const end = close < 0 ? src.length : next === '/' ? close : close + 2;
      comments.push(src.slice(i, end));
      blank(i, end);
      i = end;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      let value = '';
      while (j < src.length && src[j] !== c && src[j] !== '\n') {
        if (src[j] === '\\') j++;
        value += src[j++] ?? '';
      }
      strings.set(i, value);
      blank(i + 1, j);
      i = j + 1;
    } else if (c === '`') {
      const t = template(i + 1);
      if (!t.open) strings.set(i, src.slice(i + 1, t.end - 1));
      i = t.end;
    } else if (c === '}' && depths.length && depths.at(-1) === 0) {
      depths.pop();
      i = template(i + 1).end;
    } else if (c === '/' && regexCanStart(i)) {
      let j = i + 1;
      let inClass = false;
      for (; j < src.length && src[j] !== '\n'; j++) {
        if (src[j] === '\\') j++;
        else if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        else if (src[j] === '/' && !inClass) break;
      }
      blank(i + 1, j);
      i = j + 1;
    } else {
      if (depths.length && c === '{') depths[depths.length - 1]++;
      if (depths.length && c === '}') depths[depths.length - 1]--;
      i++;
    }
  }
  return { code: code.join(''), comments, strings };
}

const FS_WRITES = 'write|writev|writeFile|appendFile|rename|rm|rmdir|unlink|mkdir|mkdtemp|copyFile|cp|truncate|ftruncate|symlink|link|createWriteStream|utimes|futimes|lutimes|chmod|fchmod|lchmod|chown|fchown|lchown';
const FS_WRITE_RE = new RegExp(`^(?:promises\\.)?(?:${FS_WRITES})(?:Sync)?$`);
const FS_OPEN_RE = /^(?:promises\.)?open(?:Sync)?$/;
const NETWORK = ['http', 'https', 'http2', 'net', 'tls', 'dgram'];
const esc = s => s.replace(/\$/g, '\\$');

function opensForWriting({ code, strings }, from) {
  let to = from;
  for (let depth = 1; to < code.length && depth; to++) {
    if (code[to] === '(') depth++;
    if (code[to] === ')') depth--;
  }
  if (/\bO_(?:WRONLY|RDWR|CREAT|APPEND|TRUNC)\b/.test(code.slice(from, to))) return true;
  for (const [at, value] of strings) {
    if (at >= from && at < to && /^[rwa][+sx]*$/.test(value) && /[wa+]/.test(value)) return true;
  }
  return false;
}

function bindings(clause) {
  const names = clause.replace(/\{[^}]*\}/, '').split(',').map(p => p.trim()).filter(Boolean)
    .map(p => p.match(/^\*\s*as\s+([\w$]+)$/)?.[1] ?? p);
  const named = (clause.match(/\{([^}]*)\}/)?.[1].split(',') ?? [])
    .map(p => p.trim().split(/\s+as\s+/).map(x => x.trim()))
    .filter(([orig]) => orig)
    .map(([orig, local = orig]) => [orig, local]);
  return { names, named };
}

function fsWrites(scanned) {
  const { code, strings } = scanned;
  const calls = [];
  const isWrite = (name, at) => FS_WRITE_RE.test(name) || (FS_OPEN_RE.test(name) && opensForWriting(scanned, at));
  for (const m of code.matchAll(/(?<![\w$.])import\s+([^'"`;]*?)\s+from\s*(?=['"])/g)) {
    if (!['node:fs', 'fs', 'node:fs/promises', 'fs/promises'].includes(strings.get(m.index + m[0].length))) continue;
    const { names, named } = bindings(m[1]);
    for (const [orig, local] of named) {
      if (orig === 'promises') names.push(local);
      else if (FS_WRITE_RE.test(orig) || FS_OPEN_RE.test(orig)) {
        for (const c of code.matchAll(new RegExp(`(?<![\\w$.])${esc(local)}\\s*\\(`, 'g'))) {
          if (isWrite(orig, c.index + c[0].length)) calls.push(orig);
        }
      }
    }
    for (const ns of names) {
      for (const c of code.matchAll(new RegExp(`(?<![\\w$.])${esc(ns)}\\.((?:promises\\.)?[\\w$]+)\\s*\\(`, 'g'))) {
        if (isWrite(c[1], c.index + c[0].length)) calls.push(c[1]);
      }
    }
  }
  return calls;
}

function codeErrors(rel, src) {
  const scanned = scan(src);
  const { code, comments, strings } = scanned;
  const errors = [];
  const inHooks = rel.startsWith('hooks/');
  const quiet = inHooks || rel.startsWith('lib/');

  const specs = [...code.matchAll(/(?<![\w$.])(?:from|import|require)\s*\(?\s*(?=['"`])/g)]
    .map(m => strings.get(m.index + m[0].length))
    .filter(s => s !== undefined);
  for (const spec of specs) {
    const relative = spec.startsWith('./') || spec.startsWith('../');
    if (!relative && !spec.startsWith('node:') && isBuiltin(spec)) errors.push(`imports '${spec}'; name built-ins with node:, as in 'node:${spec}'`);
    else if (!relative && !(spec.startsWith('node:') && isBuiltin(spec))) errors.push(`imports '${spec}'; tools/ uses only Node's built-in modules`);
    const mod = spec.replace(/^node:/, '');
    if (mod === 'child_process') errors.push("imports node:child_process; tools/ doesn't run other programs");
    if (quiet && NETWORK.includes(mod)) errors.push(`imports node:${mod}; hooks and lib/ stay off the network`);
  }
  if (quiet && /(?<![\w$.])fetch\s*\(/.test(code)) errors.push('calls fetch(); hooks and lib/ stay off the network');

  if (inHooks && !/(?<![\w$.])runHook\s*\(/.test(code)) errors.push("doesn't go through runHook");
  if (quiet && rel !== 'lib/vault.mjs') {
    for (const m of code.matchAll(/(?<![\w$.])(console\.[\w$]+|process\.(?:stdout|stderr)\.write)\s*\(/g)) {
      errors.push(`prints with ${m[1]}; hooks print only through runHook`);
    }
  }
  if (!['lib/vault.mjs', 'lib/sessions.mjs'].includes(rel)) {
    for (const name of fsWrites(scanned)) errors.push(`calls fs.${name}; write through the helpers in lib/vault.mjs`);
  }
  if (rel !== 'lib/vault.mjs' && /(?<![\w$.])process\.cwd\s*\(/.test(code)) errors.push('uses process.cwd(); find vault files with vaultPath()');

  for (const c of comments) {
    const tag = c.match(/\b(TODO|FIXME|XXX|HACK)\b/)?.[1];
    if (tag) errors.push(`has a ${tag} comment`);
    if (c.startsWith('/**') && c !== '/**/') errors.push('has a docstring');
    else if (/^(?:[=\-*#~_+]{3,}|step\s*\d|note\s*:)/i.test(c.replace(/^\/[/*]/, '').trim())) errors.push('has a banner comment');
  }
  return [...new Set(errors)];
}

function mjsFiles(dir, rel = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    if (e.name.startsWith('.') || e.name === 'node_modules') return [];
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) return mjsFiles(path.join(dir, e.name), r);
    return e.name.endsWith('.mjs') ? [r] : [];
  });
}

function lintCode(add) {
  const root = vaultPath('tools');
  for (const rel of mjsFiles(root).sort()) {
    for (const msg of codeErrors(rel, fs.readFileSync(path.join(root, rel), 'utf8'))) add('error', `tools/${rel}`, msg);
  }
}
