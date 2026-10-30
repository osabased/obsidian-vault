import fs from 'node:fs';
import path from 'node:path';
import { isBuiltin } from 'node:module';
import { config, vaultPath, plural, today, datedFiles, filesIn, recordedRows } from './vault.mjs';
import {
  loadNotes, noteErrors, ruleText, ruleTextParts, liveRules, knownDomain, alwaysSize, isUrl, validDay, normTopic, topicNotes, rawFile, toKey, resolver, linksUnder, noteLinks, byTopic, isTopicPage, isSourcePage, PAGE_KINDS, joinList,
  hasSection, footnotes, youSaid, linkedKeys, clip, isResearch, citedSources, evidenceQuotes,
} from './rules.mjs';
import { build } from './build.mjs';
import { transcriptFor } from './sessions.mjs';
import { typedMessages, saidIn, sourceTexts } from './quotes.mjs';

const memo = f => {
  const seen = new Map();
  return k => {
    if (!seen.has(k)) seen.set(k, f(k));
    return seen.get(k);
  };
};

export const tally = found => {
  const errors = found.filter(f => f.level === 'error').length;
  return `${plural(errors, 'error')}, ${plural(found.length - errors, 'warning')}`;
};

export function lint(notes = loadNotes()) {
  const found = [];
  const add = (level, file, msg) => found.push({ level, file, msg });
  const { domains, delivery, knowledge } = config();
  const keys = new Set(notes.map(n => n.key));
  const slugs = new Map();
  for (const n of notes) slugs.set(n.slug, (slugs.get(n.slug) ?? 0) + 1);
  const noteAt = new Map(notes.map(n => [n.key, n]));
  const resolve = resolver(notes);
  const md = markdownFiles();
  const rulesOf = page => [...new Set(linksUnder(page, 'Rules').map(resolve))].map(k => noteAt.get(k)).filter(r => r?.type === 'rule');
  const sourcePages = notes.filter(isSourcePage);
  const cites = citedSources(notes, resolve);
  const watched = page => {
    const { pages } = cites(page);
    const onTopic = isTopicPage(page);
    return [
      ...rulesOf(page),
      ...sourcePages.filter(s => pages.has(s.key) || (onTopic && s.topic && s.domain === page.domain && s.topic === page.topic)),
    ];
  };
  const typedIn = memo(prefix => {
    const file = transcriptFor(prefix);
    return file ? typedMessages(file) : null;
  });
  // A file another program holds open can't be read for now, so its lines pass like a binary source's.
  const textsOf = memo(rel => {
    try { return sourceTexts(rel); } catch { return null; }
  });
  let rows;
  const rowOf = id => (rows ??= new Map(recordedRows().map(r => [r.id, r]))).get(id);

  for (const n of notes) {
    if (n.depth === 1) add('error', n.rel, 'notes go in wiki/<domain>/');
    else if (!knownDomain(n.domain)) add('error', n.rel, `${n.domain} isn't a domain in vault.config.json`);
    if (n.depth > 2) add('warn', n.rel, 'notes go directly in wiki/<domain>/, not in subfolders, or the hooks never deliver them');
    for (const e of noteErrors(n)) add('error', n.rel, e);
    lintLinks(n, keys, slugs, md, add);
    if (n.type === 'page') {
      lintPage(n, () => watched(n), add);
      lintFootnotes(n, add);
      lintSaid(n, typedIn, add);
    }
    if (n.type !== 'rule') continue;

    lintEvidence(n, { typedIn, textsOf, rowOf }, add);
    if (n.superseded_by === n.key) add('error', n.rel, 'superseded_by names the note itself');
    else if (n.superseded_by && !keys.has(n.superseded_by)) add('error', n.rel, `superseded_by names ${n.superseded_by}, which has no note`);
    if (n.data.status !== undefined) add('warn', n.rel, 'status does nothing. To stop a rule, delete its note or set superseded_by');
    if (n.data.replaces !== undefined) add('warn', n.rel, 'replaces does nothing. Set superseded_by on the note it replaces instead');
    if (!n.because) add('warn', n.rel, 'empty **Because:**');
    if (!n.superseded_by && !n.topic) add('warn', n.rel, 'no topic. Give it a short one, so the repeat check lists it with the rules on its topic');
    if (n.do && n.not && ruleText(n).length > delivery.maxRuleChars) {
      add('warn', n.rel, `${ruleTextParts(n)} come to ${ruleText(n).length} characters; the hooks cut them at ${delivery.maxRuleChars}`);
    }
    if (n.kind === 'knowledge' && !n.superseded_by && validDay(n.as_of)) {
      const days = Math.round((Date.parse(today()) - Date.parse(n.as_of)) / 864e5);
      if (days > knowledge.staleAfterDays) add('warn', n.rel, `as_of is ${days} days old. If it still holds, set as_of to the day you checked; if not, delete the note`);
    }
  }

  lintTopics(notes, domains, add);
  lintTopicPages(notes, add);
  lintOrphans(notes, resolve, add);
  lintPicks(add);
  const rules = liveRules(notes);
  for (const d of Object.keys(domains)) {
    const size = alwaysSize(rules, ['global', d]);
    if (size.lines > delivery.activeMaxLines || size.bytes > delivery.activeMaxBytes) {
      add('error', 'active.md', `always-on rules for ${d} come to ${size.lines} lines and ${size.bytes} bytes, over the ${delivery.activeMaxLines} lines or ${delivery.activeMaxBytes} bytes a session start loads`);
    }
  }
  for (const f of build({ check: true, notes })) add('error', f, 'stale; run node tools/build.mjs');
  lintCode(add);
  return found.sort((a, b) => (a.level === b.level ? 0 : a.level === 'error' ? -1 : 1));
}

// The model picks topics freely, so a topic only one rule has, and that its domain doesn't list, is likely a typo
// or a near-duplicate. Global has no list to check a one-off against. A listed topic no rule has is taste not
// captured yet rather than a fault, so /lint reports it from review.mjs status.
function lintTopics(notes, domains, add) {
  const used = topicNotes(notes);
  for (const [d, c] of Object.entries(domains)) {
    const mine = used.get(d) ?? new Map();
    const listed = (c.topics ?? []).map(normTopic);
    for (const [t, [n, ...more]] of mine) {
      if (more.length || listed.includes(t)) continue;
      const others = [...new Set([...listed, ...[...mine.keys()].filter(k => k !== t)])];
      const fix = others.length ? ` Use one of ${others.join(', ')}, or add it to the list` : '';
      add('warn', n.rel, `no other ${d} rule has topic ${n.data.topic.trim()}, and vault.config.json doesn't list it.${fix}`);
    }
  }
}

// Warnings, since raw/ is append-only: a row is fixed by recording a new one, not by editing it.
function lintPicks(add) {
  const files = datedFiles('picks');
  const ids = new Set(files.flatMap(f => f.rows.map(r => r.id)));
  for (const { file, rows } of files) {
    for (const r of rows) {
      for (const how of ['replaces', 'confirms']) {
        if (typeof r[how] === 'string' && !ids.has(r[how])) add('warn', file, `${r.id} ${how} ${r[how]}, which has no row`);
      }
      if (typeof r.sheet === 'string' && r.sheet && !fs.existsSync(vaultPath(r.sheet))) add('warn', file, `${r.id} names sheet ${r.sheet}, which doesn't exist`);
    }
  }
}

// A topic's updates would split between two topic pages.
function lintTopicPages(notes, add) {
  for (const topics of byTopic(notes.filter(isTopicPage)).values()) {
    for (const [t, pages] of topics) {
      if (pages.length < 2) continue;
      for (const p of pages) add('warn', p.rel, `another topic page is on ${t}: ${pages.filter(x => x !== p).map(x => x.key).join(', ')}. Merge them into one`);
    }
  }
}

// A session finds a topic's page in index.md and the other pages through it, so a page no note links is found only by
// reading the whole index. A link under the user's quoted words doesn't count, as noteLinks leaves those out.
function lintOrphans(notes, resolve, add) {
  const linked = new Set(notes.flatMap(n => linkedKeys(n, resolve).filter(k => k !== n.key)));
  for (const n of notes) {
    if (n.type !== 'page' || isTopicPage(n) || noteErrors(n).length || linked.has(n.key)) continue;
    add('warn', n.rel, "no other note links this page. Link it from its topic's page");
  }
}

function lintFootnotes(n, add) {
  const { defs, cited } = footnotes(n);
  for (const { id, target } of defs) {
    if (!cited.has(id)) add('warn', n.rel, `footnote [^${id}] is never cited`);
    if (isUrl(target)) continue;
    const rel = rawFile(target);
    if (!rel) add('warn', n.rel, `footnote [^${id}] names ${target || 'nothing'}. Cite a URL or a file under raw/ that exists`);
    else if (rel !== target) add('warn', n.rel, `footnote [^${id}] names ${target}. Write it as ${rel}, the path from the vault root`);
  }
  const written = new Set(defs.map(d => d.id));
  for (const id of cited) if (!written.has(id)) add('warn', n.rel, `cites [^${id}], which has no footnote`);
}

// A session the registry has dropped, or whose transcript is gone, can't be checked, so its lines pass.
function checkTyped(n, session, quote, typedIn, add) {
  const typed = typedIn(session);
  if (typed && !saidIn(quote, typed)) add('warn', n.rel, `"${quote}" isn't in what the user typed in session ${session}. Quote their exact words, with … where you leave some out`);
}

function lintSaid(n, typedIn, add) {
  for (const { line, session, quote } of youSaid(n)) {
    if (session) checkTyped(n, session, quote, typedIn, add);
    else add('warn', n.rel, `a line under ## You said isn't in the form - <date> · session <id> · "<their exact words>", so lint can't check it: ${clip(line, 100)}`);
  }
}

// propose.mjs checks a quote as it writes it, but a rule written or edited by hand never passes through it.
// A URL, or a source with no words such as a screenshot, can't be checked, so its lines pass.
function lintEvidence(n, { typedIn, textsOf, rowOf }, add) {
  for (const { line, session, source, pick, quote } of evidenceQuotes(n)) {
    if (line) {
      add('warn', n.rel, `an Evidence line isn't in the form propose.mjs writes, so lint can't check it: ${clip(line, 100)}`);
    } else if (pick) {
      const row = rowOf(pick);
      if (!row) add('warn', n.rel, `an Evidence line cites ${pick}, which no row in raw/picks/ or raw/inbox/ has`);
      else if (!saidIn(quote, [String(row.text ?? '')])) add('warn', n.rel, `"${quote}" isn't in what row ${pick} recorded. Quote the row's own words, with … where you leave some out`);
    } else if (source === undefined) {
      checkTyped(n, session, quote, typedIn, add);
    } else if (!isUrl(source)) {
      const rel = rawFile(source);
      const texts = rel ? textsOf(rel) : null;
      if (!rel) add('warn', n.rel, `an Evidence line cites ${source}. Cite a URL or a file under raw/ that exists`);
      else if (texts && !saidIn(quote, texts)) add('warn', n.rel, `"${quote}" isn't in ${rel}. Quote the file's own words, with … where you leave some out`);
    }
  }
}

// Obsidian links an attachment such as ![[shop.png]] by its file name from anywhere in the vault, so only links to notes are checked.
// A link to a note not written yet is a warning, like a missing topic, so a page being written in Obsidian doesn't block a commit.
// Obsidian also resolves a link to any other markdown file in the vault, such as [[index]] or [[decisions]],
// by its path or its bare name. A bare [[slug]] two notes share resolves to neither in index.md, so it has to name its folder.
function lintLinks(n, keys, slugs, md, add) {
  for (const target of noteLinks(n)) {
    if (!target || /\.(?!md$)[^./]+$/i.test(target)) continue;
    const key = toKey(target);
    if (key.includes('/') ? keys.has(key) || md.paths.has(key) : slugs.get(key) === 1 || (!slugs.has(key) && md.names.has(key))) continue;
    if (slugs.get(key) > 1) add('warn', n.rel, `links [[${target}]], which names more than one note. Write its folder too, as [[wiki/<domain>/${key}]]`);
    else add('warn', n.rel, `links [[${target}]], which has no note`);
  }
}

function markdownFiles() {
  const paths = new Set(filesIn(vaultPath(), '.md').map(f => f.slice(0, -3).toLowerCase()));
  return { paths, names: new Set([...paths].map(f => f.split('/').at(-1))) };
}

// Obsidian doesn't change updated when the user edits a note, so the day its file was last saved counts too.
// A checkout gives every file the same day, which flags nothing. A date in the future is a typo, not a change.
const changed = n => [n.data.updated, today(new Date(n.saved))].filter(d => validDay(d) && d <= today()).sort().at(-1);

const SECTIONS = { source: ['You said', "Agent's reading", 'Rules'], topic: ['Rules'] };

// /ingest finds a source's page by the path its source gives, so each file has one spelling.
// A source page records what its source said. The other pages sum up the rules they link and the source pages they
// cite, and a topic page every source page on its topic too, so they go stale when one changes after them.
function lintPage(n, watched, add) {
  const { source, source_date: dated } = n.data;
  // Another page gets only the warning below that these fields are for source pages, not errors on their values.
  if (isSourcePage(n)) {
    if (source != null && !isUrl(source)) {
      const rel = rawFile(source);
      if (!rel) add('error', n.rel, 'source must be a URL or a file under raw/ that exists');
      else if (rel !== source) add('error', n.rel, `write source as ${rel}, the path from the vault root`);
    }
    if (dated != null && !validDay(dated)) add('error', n.rel, 'source_date must be a date as YYYY-MM-DD');
    else if (dated > today()) add('error', n.rel, `source_date ${dated} is in the future`);
  }
  if (!n.topic) add('warn', n.rel, 'no topic. Give it one, so the index lists it with the rules on its topic');
  if (!n.summary) add('warn', n.rel, 'no summary. Give it one line, so the index says what the page holds');
  if (!PAGE_KINDS.includes(n.kind)) add('warn', n.rel, `a page needs kind: ${joinList(PAGE_KINDS, 'or')}`);
  if (isSourcePage(n) && source == null) add('warn', n.rel, 'no source. A source page names the file under raw/ or the URL it is about');
  const needs = SECTIONS[n.kind] ?? [];
  const missing = needs.filter(s => !hasSection(n, s)).map(s => `## ${s}`);
  if (missing.length) {
    add('warn', n.rel, `no ${joinList(missing, 'or')} section. A ${n.kind} page has ${joinList(needs.map(s => `## ${s}`), 'and')}, even when ${needs.length > 1 ? 'one is' : 'it is'} empty`);
  }
  const misplaced = (fields, owner, instead) => {
    const set = fields.filter(f => n.data[f] != null);
    if (set.length) add('warn', n.rel, `${joinList(set, 'and')} ${set.length > 1 ? 'are' : 'is'} for ${owner}. ${instead}`);
  };
  if (!isSourcePage(n)) misplaced(['source', 'source_date'], 'source pages', 'Cite a source with a footnote instead');
  misplaced(['always', 'triggers'], 'rules', 'A page comes up through keywords and applies_to');
  if (n.applies_to?.length && isResearch(n.domain)) {
    add('warn', n.rel, `${n.domain} is a research domain, with no project folders, so no edit brings this page up. Give it keywords instead`);
  }
  if (isSourcePage(n)) return;
  const mine = changed(n);
  for (const r of watched()) {
    const theirs = changed(r);
    if (theirs > mine) add('warn', n.rel, `${r.key} changed on ${theirs}, after this page (${mine}). Check the page still matches it, then set updated`);
  }
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

function lintCode(add) {
  const root = vaultPath('tools');
  for (const rel of filesIn(root, '.mjs').sort()) {
    for (const msg of codeErrors(rel, fs.readFileSync(path.join(root, rel), 'utf8'))) add('error', `tools/${rel}`, msg);
  }
}
