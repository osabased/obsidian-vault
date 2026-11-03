import fs from 'node:fs';
import path from 'node:path';
import { isBuiltin } from 'node:module';
import {
  config, vaultPath, plural, today, daysBetween, datedFiles, filesIn, pickRows, proposalRows, rewriteText, writeText, lf, readJson, readJsonSafe, toPosix, memo, statePath, isVaultOnly, isMarkerName, clock, inVaultFolder,
  PROPOSAL_MODES,
} from './vault.mjs';
import { editsFile, sentToHook, hookMatchers, listedAgents, typedFor, hasAgent, AGENT_NAME } from './agents.mjs';
import {
  vaultFile, loadNotes, noteErrors, ruleText, ruleTextParts, liveRules, knownDomain, alwaysSize, isUrl, validDay, normTopic, topicNotes, rawFile, toKey, resolver, linksUnder, noteLinks, byTopic, isTopicPage, isSourcePage, PAGE_KINDS, joinList,
  hasSection, footnotes, youSaid, linkedKeys, clip, citedSources, evidenceQuotes, keyOf, kindFolder, kindLabel, linkTo, parseNote, noteLinkSpans, maxChars, bundleOf, locate,
  filled, isMap, sourceItem, authoredByUser, isUserPage, parsedFile, notTextError, manifestNames,
} from './rules.mjs';
import { hasFormat, reachOf, compileFor } from './compile.mjs';
import { setField } from './frontmatter.mjs';
import { routesOf } from './reach.mjs';
import { NAMESPACE_NAME, validGlob } from './glob.mjs';
import { EXTENSION_NAME, hasExtension, extensionRel, extension } from './ext.mjs';
import { SCHEMES } from './versions.mjs';
import { build } from './build.mjs';
import { transcriptFor, sessionsByName, sessionName } from './sessions.mjs';
import { saidIn, quoteTexts, userPageTexts } from './quotes.mjs';
import { loadExtractor } from './extractors.mjs';
import {
  KINDS, LOCATORS, hashFile, lineCount, clockTime, parseLocator, anchorsIn, derivedAnchors, manifestLine, sourceProblems, refSources,
  sourceChains, noteCitations, knowledgeDays, newerCopies, copyStem,
} from './sources.mjs';

export const tally = found => {
  const errors = found.filter(f => f.level === 'error').length;
  return `${plural(errors, 'error')}, ${plural(found.length - errors, 'warning')}`;
};

// chains is sourceChains(), which a caller that also builds or lints again passes so raw/refs/ is read once.
export function lint(notes = loadNotes(), chains = sourceChains()) {
  const found = [];
  const add = (level, file, msg, fix) => found.push({ level, file, msg, fix });
  const { domains, delivery } = config();
  const citesOf = noteCitations(notes, chains);
  const checks = readJsonSafe(statePath('derived.json'))?.sources ?? {};
  // A source re-checked unchanged keeps its notes fresh, so the age counts from the day every source the note cites was
  // last checked, when that is later than as_of. A check that saved a copy newer than the one the note read found the
  // source changed, which freshens nothing; with no copy to go by, the check's own result says so.
  const lastChecked = n => {
    const { ids, latest } = citesOf(n);
    const days = [...ids].map(id => {
      const behind = latest.has(id) ? newerCopies(chains, id, latest.get(id)).length > 0 : checks[id]?.result === 'changed';
      return behind ? null : checks[id]?.checked;
    });
    return days.length && days.every(validDay) ? days.sort()[0] : null;
  };
  const keys = new Set(notes.map(n => n.key));
  const named = new Map();
  for (const n of notes) named.set(n.slug, [...(named.get(n.slug) ?? []), n]);
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
  let byName;
  const typedIn = memo(name => {
    const entry = transcriptFor(name, byName ??= sessionsByName());
    return entry ? typedFor(entry) : null;
  });
  // A file that can't be hashed for now is skipped, not reported as changed.
  const hashOf = memo(rel => { try { return hashFile(rel); } catch { return null; } });
  // A file another program holds open can't be read for now, so its lines pass. One too large to hold is a binary, which
  // quoteTexts tells apart, so only a read that may succeed later reaches the catch. A skipped hash is tried again there
  // to throw.
  const textsOf = memo(rel => {
    try { return quoteTexts(rel, r => hashOf(r) ?? hashFile(r)); } catch { return { texts: null }; }
  });
  const pageTextsOf = memo(userPageTexts);
  const lines = memo(lineCount);
  const anchors = memo(rel => { const hash = hashOf(rel); return hash && derivedAnchors(hash); });
  let rows;
  const rowOf = id => (rows ??= new Map(pickRows().map(r => [r.id, r]))).get(id);
  let inbox;
  const inboxRow = id => (inbox ??= new Map(proposalRows().map(r => [r.id, r]))).get(id);
  const unchecked = [];

  for (const n of notes) {
    if (n.depth === 1) add('error', n.rel, 'notes go in wiki/<domain>/');
    else if (!knownDomain(n.domain)) add('error', n.rel, `${n.domain} isn't a domain in vault.config.json`);
    const folder = kindFolder(n);
    if (n.depth > 1 && folder && n.folder !== folder) {
      const what = n.type === 'rule' ? 'rule' : kindLabel(n.kind);
      add('warn', n.rel, `${/^[aeiou]/.test(what) ? 'an' : 'a'} ${what} goes in wiki/${n.domain}/${folder}/`);
    }
    for (const e of noteErrors(n)) add('error', n.rel, e);
    for (const e of toolErrors(n)) add('error', n.rel, e);
    // Settling can't go by a save time that hasn't come yet, so such a note waits until its text has held unchanged.
    if (n.saved > Date.now()) add('warn', n.rel, `its file is dated ${clock(new Date(n.saved))}, in the future, so the hooks wait until its text has gone ${plural(delivery.settleSeconds, 'second')} unchanged. Save it again, or fix the clock that dated it`);
    lintLinks(n, noteAt, named, md, add);
    if (n.type === 'page') {
      lintPage(n, () => watched(n), add);
      lintFootnotes(n, { lines, anchors }, add);
      lintSaid(n, { typedIn, inboxRow, unchecked }, add);
    }
    if (n.type !== 'rule') continue;

    lintEvidence(n, { typedIn, textsOf, pageTextsOf, rowOf, inboxRow, unchecked }, add);
    if (n.superseded_by === n.key) add('error', n.rel, 'superseded_by names the note itself');
    else if (n.superseded_by && !keys.has(n.superseded_by)) add('error', n.rel, `superseded_by names ${n.superseded_by}, which has no note`);
    if (n.data.status !== undefined) add('warn', n.rel, 'status does nothing. To stop a rule, delete its note or set superseded_by');
    if (n.data.replaces !== undefined) add('warn', n.rel, 'replaces does nothing. Set superseded_by on the note it replaces instead');
    if (!n.because) add('warn', n.rel, 'empty **Because:**');
    if (!n.superseded_by && !n.topic) add('warn', n.rel, 'no topic. Give it a short one, so the repeat check lists it with the rules on its topic');
    if (n.do && n.not && ruleText(n).length > maxChars(n.kind)) {
      add('warn', n.rel, `${ruleTextParts(n)} come to ${ruleText(n).length} characters; the hooks cut them at ${maxChars(n.kind)}`);
    }
    // Every session start pays for an always rule, so one keeps to the taste cap whatever its kind.
    if (n.do && n.not && n.always && n.kind === 'knowledge' && ruleText(n).length > delivery.maxRuleChars) {
      add('warn', n.rel, `always: true loads this rule at every session start, and its ${ruleTextParts(n)} come to ${ruleText(n).length} characters, over the ${delivery.maxRuleChars} a taste rule may have. Shorten it, or give it keywords instead`);
    }
    if (n.kind === 'knowledge' && !n.superseded_by && validDay(n.as_of)) {
      const checked = lastChecked(n);
      const from = checked && checked > n.as_of ? checked : n.as_of;
      const days = daysBetween(from);
      if (days > knowledgeDays(n.domain).staleAfterDays) {
        add('warn', n.rel, from === n.as_of
          ? `as_of is ${days} days old. If it still holds, set as_of to the day you checked; if not, delete the note`
          : `the sources it cites were last checked ${days} days ago, on ${checked}. Run /lint to refresh them, or set as_of to the day you checked the fact; if it no longer holds, delete the note`);
      }
    }
  }

  if (unchecked.length) found.push({ level: 'warn', file: 'wiki', msg: uncheckedTally(unchecked), unchecked });
  lintConfig(add);
  lintReaders(notes, add);
  lintTopics(notes, domains, add);
  lintTopicPages(notes, add);
  lintOrphans(notes, resolve, add);
  lintPicks(add);
  lintSources(add, chains);
  lintManifestCase(add);
  lintBundles(add, hashOf);
  lintDerived(add, hashOf, lintExtractors(add));
  lintPrivacy(add);
  lintReach(add);
  lintCompiled(notes, add);
  const rules = liveRules(notes);
  for (const d of Object.keys(domains)) {
    const size = alwaysSize(rules, routesOf([d], false).always);
    if (size.lines > delivery.activeMaxLines || size.bytes > delivery.activeMaxBytes) {
      add('error', 'active.md', `always-on rules for ${d} come to ${size.lines} lines and ${size.bytes} bytes, over the ${delivery.activeMaxLines} lines or ${delivery.activeMaxBytes} bytes a session start loads`);
    }
  }
  for (const f of build({ check: true, notes })) add('error', f, 'stale; run node tools/build.mjs');
  lintCode(add);
  lintSkillCopies(found);
  return found.sort((a, b) => (a.level === b.level ? 0 : a.level === 'error' ? -1 : 1));
}

// Applies the fixes lint gives whole, then rebuilds the generated files, which a fixed note can change too. The fixes
// read a note with \n line ends, as parseNote does, and a file saved with \r\n gets them back.
export function fix(found, chains, refs) {
  // A skill's copy is written byte for byte from the skill, so it skips the text fixes below.
  const copied = found.filter(f => f.copyFrom);
  for (const f of copied) writeText(vaultPath(f.file), fs.readFileSync(vaultPath(f.copyFrom)));
  const written = [];
  const fixable = found.filter(f => f.fix);
  for (const rel of new Set(fixable.map(f => f.file))) {
    const file = vaultPath(rel);
    const text = fs.readFileSync(file, 'utf8');
    // The user wrote this page and keeps it as they wrote it; lint still reports what it finds.
    if (authoredByUser(text)) continue;
    const before = lf(text);
    const out = fixable.filter(f => f.file === rel).reduce((t, f) => f.fix(t), before);
    if (out === before) continue;
    rewriteText(file, text.includes('\r\n') ? out.replace(/\n/g, '\r\n') : out);
    written.push(rel);
  }
  return { fixed: [...copied, ...fixable.filter(f => written.includes(f.file))], written, rebuilt: build({ chains, refs }) };
}

// Each fix parses the text it's given afresh, so the fixes to one file apply one after another, and a fix for a link
// another fix already rewrote finds nothing left to change.
function editBody(text, rel, edits) {
  const n = parseNote(text, rel);
  const at = text.length - n.body.length;
  return edits(n).sort((a, b) => b.at - a.at)
    .reduce((t, e) => `${t.slice(0, at + e.at)}${e.text}${t.slice(at + e.at + e.length)}`, text);
}

// A link keeps its heading and alias. One with no alias gets the note's name, escaped in a table row as Obsidian
// escapes it.
function relink(rel, target, note) {
  const to = note.rel.replace(/\.md$/i, '');
  return text => editBody(text, rel, n => noteLinkSpans(n).filter(s => s.target === target).map(s => {
    if (!s.wiki) return { at: s.at, length: s.raw.length, text: note.rel };
    const row = /^\s*\|/.test(n.body.slice(n.body.lastIndexOf('\n', s.at) + 1, s.at));
    const alias = /\\?\|/.test(s.rest) ? '' : `${row ? '\\|' : '|'}${note.slug}`;
    return { at: s.at, length: s.raw.length + s.rest.length, text: `${to}${s.rest}${alias}` };
  }));
}

function refootnote(rel, id, target, from, to) {
  return text => editBody(text, rel, n => footnotes(n).defs.filter(d => d.id === id && d.target === target)
    .map(d => ({ at: d.at, length: d.raw.length, text: d.raw.replace(from, () => to) })));
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

// Reads the file rather than config(), which fills in defaults and would hide a value of the wrong shape.
export function lintConfig(add) {
  const c = readJson(vaultPath('vault.config.json'), {}) ?? {};
  const bad = msg => add('error', 'vault.config.json', msg);
  if (c.agents !== undefined && !Array.isArray(c.agents)) bad('agents must be a list of adapter names');
  for (const name of Array.isArray(c.agents) ? c.agents : []) {
    if (typeof name !== 'string' || !AGENT_NAME.test(name)) bad(`agents names ${name}, which isn't an adapter name: lowercase letters, digits, - or _`);
    else if (!hasAgent(name)) bad(`agents names ${name}, and tools/adapters/${name}/adapter.mjs doesn't exist`);
  }
  const namespaces = c.namespaces ?? {};
  if (!isMap(namespaces)) bad('namespaces must be an object of { separator, escape } by namespace name');
  else {
    for (const [name, ns] of Object.entries(namespaces)) {
      const at = `namespaces.${name}`;
      if (!NAMESPACE_NAME.test(name)) bad(`${at}: a namespace name is two or more lowercase letters, digits, - or _, starting with a letter`);
      else if (name === 'file') bad(`${at}: file is the namespace of bare globs; pick another name`);
      if (!isMap(ns)) {
        bad(`${at} must be an object with separator and escape`);
        continue;
      }
      if (typeof ns.separator !== 'string' || !ns.separator) bad(`${at}.separator must be a non-empty string`);
      if (typeof ns.escape !== 'string' || [...ns.escape].length !== 1) bad(`${at}.escape must be one character`);
      else if ('*?[]{},!'.includes(ns.escape)) bad(`${at}.escape ${ns.escape} is a glob character. Pick one that isn't * ? [ ] { } , or !`);
      else if (typeof ns.separator === 'string' && ns.separator.includes(ns.escape)) bad(`${at}.escape ${ns.escape} is in the separator. Pick another character`);
    }
  }
  const declared = ns => isMap(namespaces) && typeof ns === 'string' && ns !== 'file' && Object.hasOwn(namespaces, ns);
  for (const [d, x] of Object.entries(isMap(c.domains) ? c.domains : {})) {
    if (x?.aliases === undefined) continue;
    const at = `${d}.aliases`;
    if (!isMap(x.aliases)) {
      bad(`${at} must be an object of alias extension names by namespace`);
      continue;
    }
    for (const [ns, name] of Object.entries(x.aliases)) {
      if (!declared(ns)) bad(`${at}.${ns}: ${ns} isn't a namespace that vault.config.json declares under namespaces`);
      if (typeof name !== 'string' || !EXTENSION_NAME.test(name)) bad(`${at}.${ns} must name an extension in lowercase letters, digits, - or _`);
      else if (!hasExtension('aliases', name)) bad(`${at}.${ns} names ${name}, and ${extensionRel('aliases', name)} doesn't exist`);
    }
  }
  for (const [d, x] of Object.entries(isMap(c.domains) ? c.domains : {})) {
    if (x?.compile === undefined) continue;
    if (!Array.isArray(x.compile) || x.compile.some(name => typeof name !== 'string')) bad(`${d}.compile must be a list of adapter names`);
    else for (const name of x.compile) if (!hasFormat(name)) bad(`${d}.compile names ${name}, and tools/adapters/${name}/compile.mjs doesn't exist`);
  }
  if (c.compile !== undefined && (!isMap(c.compile) || (c.compile.maxBytes !== undefined && !(Number.isInteger(c.compile.maxBytes) && c.compile.maxBytes > 0)))) {
    bad('compile.maxBytes must be a whole number of bytes above 0');
  }
  for (const [d, x] of Object.entries(isMap(c.domains) ? c.domains : {})) {
    if (x?.feeds !== undefined) add('warn', 'vault.config.json', `${d}.feeds does nothing yet: no feed parser ships, so refresh reads no feeds`);
  }
  const editTools = c.editTools ?? {};
  if (!isMap(editTools)) return bad('editTools must be an object of { namespace, path, after } by tool name');
  const FIELD = /^tool_input\.\S+$/;
  for (const [tool, t] of Object.entries(editTools)) {
    const at = `editTools.${tool}`;
    if (!/^\S+$/.test(tool)) bad(`${at}: a tool name has no spaces`);
    else if (editsFile(tool)) bad(`${at}: ${tool} edits a file, which the edit hook reads from the call itself; take it out of editTools`);
    else if (!listedAgents().length) bad(`${at}: agents in vault.config.json lists no agent, so lint can't tell whether an edit hook is sent ${tool}`);
    else if (!sentToHook(tool)) bad(`${at}: the edit hook's matcher, ${hookMatchers()}, never sends ${tool} to the hook, so it would never be gated`);
    if (!isMap(t)) {
      bad(`${at} must be an object with namespace, path and after`);
      continue;
    }
    if (!isMap(namespaces) || typeof t.namespace !== 'string' || !Object.hasOwn(namespaces, t.namespace)) {
      bad(`${at}.namespace names ${t.namespace ?? 'nothing'}, which namespaces doesn't declare`);
    }
    if (typeof t.path !== 'string' || !FIELD.test(t.path)) bad(`${at}.path must be tool_input.<field>`);
    if (t.after !== undefined && (typeof t.after !== 'string' || !FIELD.test(t.after))) bad(`${at}.after must be tool_input.<field>`);
  }
}

// A compiled section is written once and read by sessions for as long as it stays in the project, so it is checked
// against the rules the way a generated file in the vault is. Only the folders a domain lists under paths are found: a
// project reached by a marker has no root to look in.
function lintCompiled(notes, add) {
  const listed = Object.values(config().domains).filter(x => Array.isArray(x.compile) && x.compile.length).flatMap(x => (Array.isArray(x.paths) ? x.paths : []));
  for (const root of [...new Set(listed.map(p => toPosix(p)))].sort()) {
    if (inVaultFolder(root) || !fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) continue;
    const reach = reachOf(root);
    if (!reach) continue;
    const run = `node tools/compile.mjs ${/\s/.test(root) ? `"${root}"` : root}`;
    for (const r of compileFor(root, reach, notes)) {
      const msg = {
        missing: `not compiled; run ${run}`,
        stale: r.changed ? `stale: ${plural(r.changed, 'rule')} changed since it was compiled; run ${run}` : `stale: its wording changed since it was compiled; run ${run}`,
        edited: `edited by hand since it was compiled; move those edits out of the section, or delete it, then run ${run}`,
        refused: r.refused,
      }[r.state];
      if (msg) add('warn', r.path, msg);
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

// A locator is checked against the source only when the source can say: lines in a text file, pages and times in derived text.
function lintFootnotes(n, { lines, anchors }, add) {
  const { defs, cited } = footnotes(n);
  for (const d of defs) {
    const { id, target } = d;
    const { base, fragment } = locate(d);
    const locator = fragment === null ? null : parseLocator(fragment);
    if (!cited.has(id)) add('warn', n.rel, `footnote [^${id}] is never cited`);
    if (isUrl(target)) {
      if (locator?.problem) add('warn', n.rel, `footnote [^${id}] has #${fragment}. ${locator.problem}`);
      continue;
    }
    const rel = rawFile(base) ?? bundleOf(base);
    if (!rel) {
      add('warn', n.rel, `footnote [^${id}] names ${target || 'nothing'}. Cite a URL or a file under raw/ that exists`);
      continue;
    }
    if (rel !== base) add('warn', n.rel, `footnote [^${id}] names ${target}. Write it as ${rel}${fragment === null ? '' : `#${fragment}`}, the path from the vault root`, refootnote(n.rel, id, target, base, rel));
    if (fragment === null) continue;
    if (!locator) add('warn', n.rel, `footnote [^${id}] ends with #${fragment}, which isn't a locator. ${LOCATORS}`);
    else if (locator.problem) add('warn', n.rel, `footnote [^${id}] has #${fragment}. ${locator.problem}`);
    else if (locator.kind === 'lines') {
      const count = lines(rel);
      const span = locator.from === locator.to ? `line ${locator.from}` : `lines ${locator.from}-${locator.to}`;
      if (count !== null && locator.to > count) add('warn', n.rel, `footnote [^${id}] cites ${span} of ${rel}, which has ${plural(count, 'line')}`);
    } else if (locator.kind === 'page') {
      const found = anchors(rel);
      if (found && !found.pages.has(locator.page)) add('warn', n.rel, `footnote [^${id}] cites page ${locator.page} of ${rel}, and its derived text has no [p. ${locator.page}]`);
    } else if (locator.kind === 'time' && locator.start !== null) {
      const found = anchors(rel);
      if (found && !found.times.has(locator.start)) add('warn', n.rel, `footnote [^${id}] cites ${clockTime(locator.start)} of ${rel}, and its derived text has no [t=${clockTime(locator.start)}]`);
    }
  }
  const written = new Set(defs.map(d => d.id));
  for (const id of cited) if (!written.has(id)) add('warn', n.rel, `cites [^${id}], which has no footnote`);
}

// Raw files are append-only, so a saved source's fields are warnings: a fix is a new file, not an edit. A parse
// error, such as a quote that never closes, is a warning too: as an error it would block every commit.
// A doc set's pages and manifest copies are checked as loose files are, though the set is listed as one source.
function lintSources(add, chains) {
  const inSets = [...chains.files].filter(([, e]) => e.set).map(([rel]) => rel);
  for (const f of [...new Set([...refSources().loose.filter(x => x.endsWith('.md')), ...inSets])].sort()) {
    const parsed = parsedFile(f);
    if (!parsed?.ok) continue;
    for (const msg of parsed.errors) add('warn', f, msg);
    if (parsed.data.url == null && parsed.data.repo == null) continue;
    for (const msg of sourceProblems(parsed.data, { body: parsed.body, rel: f, chains })) add('warn', f, msg);
  }
}

// A doc set's manifest goes by its name exactly, though stat ignores case on Windows and macOS, so a set reads the same
// on every machine; a file named like one in another case makes no set.
function lintManifestCase(add) {
  const names = manifestNames();
  for (const f of filesIn(vaultPath('raw', 'refs'), '', 'raw/refs')) {
    const name = `${copyStem(f)}${path.posix.extname(f)}`;
    const m = names.find(x => x.toLowerCase() === name.toLowerCase());
    if (m && m !== name) add('warn', f, `is named like the manifest ${m} in another case, so its folder is not a doc set. docSets.manifests names it exactly`);
  }
}

function lintBundles(add, hashOf) {
  for (const dir of refSources().bundles) {
    const rel = `${dir}/source.md`;
    const parsed = parsedFile(rel);
    if (!parsed) continue;
    const { data, ok } = parsed;
    if (!ok) {
      add('warn', rel, "no frontmatter. A bundle's source.md starts with url and commit, or sha256");
      continue;
    }
    for (const msg of parsed.errors) add('warn', rel, msg);
    for (const msg of sourceProblems(data, { bundle: true })) add('warn', rel, msg);
    if (data.commit == null && data.sha256 == null) add('warn', rel, "no commit or sha256. A bundle's source.md pins the folder with a commit, or a sha256 line for each file");
    else if (data.commit != null && data.url == null && data.repo == null) add('warn', rel, 'a commit needs a url or repo. Say where the folder came from');
    if (data.sha256 != null && !Array.isArray(data.sha256)) add('warn', rel, "sha256 must be a list of '<64 hex>  <path>' lines, as sha256sum writes them");
    for (const line of Array.isArray(data.sha256) ? data.sha256 : []) {
      if (typeof line !== 'string') {
        add('warn', rel, notTextError('sha256', line));
        continue;
      }
      const entry = manifestLine(line);
      if (!entry) add('warn', rel, `sha256 line "${clip(line, 100)}" isn't '<64 hex>  <path in the folder>', as sha256sum writes it`);
      else if (!rawFile(`${dir}/${entry.file}`)) add('warn', rel, `sha256 lists ${entry.file}, which isn't a file in the folder`);
      else if (![null, entry.hash].includes(hashOf(`${dir}/${entry.file}`))) add('warn', rel, `${entry.file} doesn't match its sha256 line in source.md`);
    }
  }
}

// Extraction writes derived text, so the file a name or source points at is what shows it is still current.
function lintDerived(add, hashOf, versions) {
  for (const f of filesIn(vaultPath('derived'), '', 'derived').sort()) {
    const name = f.slice('derived/'.length);
    const hash = /^[0-9a-f]{64}\.md$/.test(name) ? name.slice(0, 64) : null;
    if (!hash) add('warn', f, `named ${name}. Derived text is derived/<sha256>.md, the SHA-256 of the file it was taken from`);
    if (!f.endsWith('.md')) continue;
    const parsed = parsedFile(f);
    if (!parsed) continue;
    const { data, body, ok } = parsed;
    if (!ok) {
      add('warn', f, 'no frontmatter. Derived text starts with kind, extractor, extractor_version and source');
      continue;
    }
    for (const msg of parsed.errors) add('warn', f, msg);
    if (!KINDS.includes(data.kind)) add('warn', f, `kind must be ${joinList(KINDS, 'or')}`);
    if (!filled(data.extractor)) add('warn', f, 'no extractor. Name the program that made the text');
    if (!filled(data.extractor_version)) add('warn', f, 'no extractor_version. Give the version of the program that made the text');
    const { source } = data;
    if (!filled(source)) add('warn', f, 'no source. Give the path under raw/ of the file the text was taken from');
    else if (!source.startsWith('raw/')) add('warn', f, 'source must be a file under raw/');
    else if (!rawFile(source)) add('warn', f, `source ${source} is gone, so the text can't be checked against it`);
    else if (hash && ![null, hash].includes(hashOf(rawFile(source)))) add('warn', f, `source ${rawFile(source)} has changed: its SHA-256 isn't ${hash}. Extract the text again for the new file`);
    for (const anchor of anchorsIn(body).bad) add('warn', f, `anchor ${anchor} isn't [p. N] or [t=hh:mm:ss]`);
    const now = versions.get(data.extractor);
    if (now !== undefined && String(data.extractor_version ?? '') !== now) {
      add('warn', f, `made by ${data.extractor} ${data.extractor_version}, and ${data.extractor} is ${now} now. Run node tools/extract.mjs ${rawFile(source) ?? source}`);
    }
  }
}

// Each listed extractor, loaded as extract.mjs loads it, so one that would fail extraction fails lint first. Returns the
// version of each that loads, which the derived text it made is checked against.
function lintExtractors(add) {
  const { extractors } = readJson(vaultPath('vault.config.json'), {}) ?? {};
  const versions = new Map();
  if (extractors === undefined) return versions;
  if (!Array.isArray(extractors)) {
    add('error', 'vault.config.json', 'extractors must be a list of extractor extension names');
    return versions;
  }
  for (const name of extractors) {
    const { mod, problems } = loadExtractor(name);
    for (const msg of problems ?? []) add('error', 'vault.config.json', msg);
    if (mod) versions.set(name, mod.version);
  }
  return versions;
}

function lintPrivacy(add) {
  const { privacy } = readJson(vaultPath('vault.config.json'), {}) ?? {};
  const bad = msg => add('error', 'vault.config.json', msg);
  if (privacy === undefined) return;
  if (!isMap(privacy)) return bad('privacy must be an object, such as { "allow": [] }');
  if (privacy.allow === undefined) return;
  if (!Array.isArray(privacy.allow)) return bad('privacy.allow must be a list of the allow ids scan.mjs prints');
  for (const id of privacy.allow) {
    if (typeof id !== 'string' || !/^[0-9a-f]{16}$/.test(id)) bad(`privacy.allow: ${JSON.stringify(id)} isn't an allow id, which is 16 lowercase hex digits as scan.mjs prints it`);
  }
}

// A session the registry has dropped, or whose transcript is gone, is checked against the inbox row the line names,
// whose text propose.mjs checked as it wrote it, if the row is from that session. It isn't compared with the row's note:
// a rule renamed since keeps its evidence, and raw/ can't change. A line with no such row can't be checked, and goes in
// the tally.
function checkTyped(n, { session, quote, id }, { typedIn, inboxRow, unchecked }, add) {
  const typed = typedIn(session);
  if (typed) {
    if (!saidIn(quote, typed)) add('warn', n.rel, `"${quote}" isn't in what the user typed in session ${session}. Quote their exact words, with … where you leave some out`);
    return;
  }
  const row = id && inboxRow(id);
  if (!row) unchecked.push({ note: n.rel, cites: `session ${session}`, quote, gone: true });
  else if (!row.session || ![sessionName(String(row.session), row.agent), String(row.session)].includes(session)) {
    add('warn', n.rel, `"${quote}" isn't in what row ${id} recorded for session ${session}: it was recorded in session ${row.session ? sessionName(String(row.session), row.agent) : 'unknown'}`);
  }
  else if (!saidIn(quote, [String(row.text ?? '')])) add('warn', n.rel, `"${quote}" isn't in what row ${id} recorded`);
}

// The user can't fix a URL or a pruned transcript, so these are one warning, and review.mjs status lists them.
function uncheckedTally(unchecked) {
  const gone = unchecked.filter(u => u.gone).length;
  const parts = [[unchecked.length - gone, 'a URL'], [gone, 'a session whose transcript is gone']].filter(([count]) => count);
  const said = parts.map(([count, what], i) => (i ? `${count} ${what}` : `${count} ${count === 1 ? 'cites' : 'cite'} ${what}`));
  return `${plural(unchecked.length, 'quote')} can't be checked: ${said.join(', ')}. node tools/review.mjs status lists them.`;
}

function lintSaid(n, ctx, add) {
  for (const { line, session, quote } of youSaid(n)) {
    if (session) checkTyped(n, { session, quote }, ctx, add);
    else add('warn', n.rel, `a line under ## You said isn't in the form - <date> · session <id> · "<their exact words>", so lint can't check it: ${clip(line, 100)}`);
  }
}

// propose.mjs checks a quote as it writes it, but a rule written or edited by hand never passes through it.
// A binary is checked through its derived text. A URL, and a session whose transcript is gone with no row to fall
// back on, can't be checked, so they go in the tally.
function lintEvidence(n, ctx, add) {
  const { textsOf, pageTextsOf, rowOf, unchecked } = ctx;
  for (const { line, session, note, source, pick, quote, id } of evidenceQuotes(n)) {
    if (line) {
      add('warn', n.rel, `an Evidence line isn't in the form propose.mjs writes, so lint can't check it: ${clip(line, 100)}`);
    } else if (note) {
      const texts = pageTextsOf(note);
      if (!vaultFile(note)) add('warn', n.rel, `an Evidence line cites ${note}, which isn't a file in the vault`);
      else if (!texts) add('warn', n.rel, `an Evidence line cites ${note}, which isn't an author: user page`);
      else if (!saidIn(quote, texts)) add('warn', n.rel, `"${quote}" isn't in ${note}. Quote the page's own words, with … where you leave some out`);
    } else if (pick) {
      const row = rowOf(pick);
      if (!row) add('warn', n.rel, `an Evidence line cites ${pick}, which no row in raw/picks/ has`);
      else if (!saidIn(quote, [String(row.text ?? '')])) add('warn', n.rel, `"${quote}" isn't in what row ${pick} recorded. Quote the row's own words, with … where you leave some out`);
    } else if (source === undefined) {
      checkTyped(n, { session, quote, id }, ctx, add);
    } else if (!isUrl(source)) {
      const rel = rawFile(source);
      const { texts, why } = rel ? textsOf(rel) : {};
      if (!rel) add('warn', n.rel, `an Evidence line cites ${source}. Cite a URL or a file under raw/ that exists`);
      else if (why === 'image') add('warn', n.rel, `an Evidence line quotes ${rel}, an image, as a source. What an image shows is a reading: give it basis reading`);
      else if (why) add('warn', n.rel, `"${quote}" can't be checked: ${rel} has no derived text. Run node tools/extract.mjs ${rel}, or save it as UTF-8`);
      else if (texts && !saidIn(quote, texts)) add('warn', n.rel, `"${quote}" isn't in ${rel}. Quote the file's own words, with … where you leave some out`);
    } else {
      unchecked.push({ note: n.rel, cites: source, quote });
    }
  }
}

// Obsidian links an attachment such as ![[shop.png]] by its file name from anywhere in the vault, so only links to notes are checked.
// A link to a note not written yet is a warning, like a missing topic, so a page being written in Obsidian doesn't block a commit.
// Obsidian also resolves a link to any other markdown file in the vault, such as [[index]] or [[decisions]],
// by its path or its bare name. A bare [[slug]] two notes share resolves to neither in index.md, so it has to give its path.
// A link by a note's key, or through a folder it isn't in, names the note for the tools, but Obsidian may resolve it to
// another file or none, so lint gives the note's path.
// Checked here and not in noteErrors, since a rule's delivery mustn't depend on which agents vault.config.json lists.
const toolErrors = n => (n.tools ?? []).filter(x => /^\S+$/.test(x)).flatMap(x => (editsFile(x) ? [`tools names ${x}, which edits a file; give the rule applies_to instead`]
  : sentToHook(x) ? []
  : !listedAgents().length ? [`tools names ${x}, but agents in vault.config.json lists no agent, so lint can't tell whether an edit hook is sent it`]
  : [`tools names ${x}, which the edit hook's matcher, ${hookMatchers()}, never sends to the hook, so it would never bring the rule up`]));

function lintLinks(n, noteAt, named, md, add) {
  for (const target of noteLinks(n)) {
    if (!target || /\.(?!md$)[^./]+$/i.test(target)) continue;
    const rel = target.replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\.md$/i, '').toLowerCase();
    if (md.paths.has(rel)) continue;
    const key = toKey(target);
    const same = named.get(key) ?? [];
    if (!key.includes('/') && (same.length === 1 || (!same.length && md.names.has(key)))) continue;
    const note = key.includes('/') && noteAt.get(keyOf(key));
    if (note) add('warn', n.rel, `links [[${target}]], a note at ${note.rel}. Link it by that path, as ${linkTo(note.key, note.rel)}`, note.clash ? null : relink(n.rel, target, note));
    else if (same.length > 1) add('warn', n.rel, `links [[${target}]], which names more than one note. Write its path from the vault root: ${joinList(same.map(x => `[[${x.rel.slice(0, -3)}]]`), 'or')}`);
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
      const { file, bundle, rel } = sourceItem(source);
      if (!rel) add('error', n.rel, 'source must be a URL, a file under raw/ that exists, or a folder under raw/refs/ with a source.md');
      else if (bundle && file) add('error', n.rel, `write source as ${bundle}, the bundle it is in`, text => setField(text, 'source', bundle));
      else if (rel !== source) add('error', n.rel, `write source as ${rel}, the path from the vault root`, text => setField(text, 'source', rel));
    }
    if (dated != null && !validDay(dated)) add('error', n.rel, 'source_date must be a date as YYYY-MM-DD');
    else if (dated > today()) add('error', n.rel, `source_date ${dated} is in the future`);
  }
  if (!n.topic && !isUserPage(n)) add('warn', n.rel, 'no topic. Give it one, so the index lists it with the rules on its topic');
  if (!n.summary && !isUserPage(n)) add('warn', n.rel, 'no summary. Give it one line, so the index says what the page holds');
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
  if (n.applies_to?.length && isVaultOnly(n.domain)) {
    add('warn', n.rel, `${n.domain} is vault-only, so no edit brings this page up. Give it keywords instead`);
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

// Each domain's readers, loaded as a hook loads them, so a reader that would fail a hook fails lint first. A note's
// requires names an ecosystem one of its domain's readers answers to, or no project can say whether it fits.
function lintReaders(notes, add) {
  const c = readJson(vaultPath('vault.config.json'), {}) ?? {};
  const bad = msg => add('error', 'vault.config.json', msg);
  const answers = new Map();
  for (const [d, x] of Object.entries(isMap(c.domains) ? c.domains : {})) {
    if (x?.readers === undefined) continue;
    const at = `${d}.readers`;
    if (!Array.isArray(x.readers)) {
      bad(`${at} must be a list of reader extension names`);
      continue;
    }
    const ecosystems = new Map();
    for (const name of x.readers) {
      if (typeof name !== 'string' || !EXTENSION_NAME.test(name)) {
        bad(`${at}: ${JSON.stringify(name)} must name an extension in lowercase letters, digits, - or _`);
        continue;
      }
      if (!hasExtension('readers', name)) {
        bad(`${at} names ${name}, and ${extensionRel('readers', name)} doesn't exist`);
        continue;
      }
      let r;
      try {
        r = extension('readers', name, ['read']);
      } catch (e) {
        bad(`${at}: ${name}: ${e.message}`);
        continue;
      }
      const rel = extensionRel('readers', name);
      if (typeof r.ecosystem !== 'string' || !r.ecosystem) bad(`${at}: ${rel} must export ecosystem, a non-empty string`);
      if (!Array.isArray(r.lockfiles) || !r.lockfiles.length || !r.lockfiles.every(f => typeof f === 'string' && f && !/[\\/]/.test(f))) {
        bad(`${at}: ${rel} must export lockfiles, a list of file names`);
      }
      if (!SCHEMES.includes(r.scheme)) bad(`${at}: ${rel} exports scheme ${JSON.stringify(r.scheme)}; it must be ${joinList(SCHEMES.map(x => `'${x}'`), 'or')}`);
      else if (r.scheme === 'ECOSYSTEM' && typeof r.compare !== 'function') bad(`${at}: ${rel} has scheme 'ECOSYSTEM' and exports no compare function`);
      if (typeof r.ecosystem !== 'string' || !r.ecosystem) continue;
      if (ecosystems.has(r.ecosystem)) bad(`${at}: ${ecosystems.get(r.ecosystem)} and ${name} both read ecosystem ${r.ecosystem}`);
      else ecosystems.set(r.ecosystem, name);
    }
    answers.set(d, ecosystems);
  }
  for (const n of notes) {
    if (!Array.isArray(n.requires)) continue;
    const named = [...new Set(n.requires.map(e => e?.package?.ecosystem).filter(e => typeof e === 'string'))];
    for (const e of named.filter(e => !answers.get(n.domain)?.has(e))) {
      add('warn', n.rel, `requires names ecosystem ${e}, and no reader in ${n.domain}.readers reads it, so the note is always delivered as version unknown`);
    }
  }
}

function codeErrors(rel, src) {
  const scanned = scan(src);
  const { code, comments, strings } = scanned;
  const errors = [];
  const inHooks = rel.startsWith('hooks/') || /^adapters\/[^/]+\/hooks\//.test(rel);
  // An installed launcher from before the adapters still runs hooks/<hook>.mjs, so each stays as one import of its entry.
  const shim = /^hooks\/[^/]+\.mjs$/.test(rel) && /^import '\.\.\/adapters\/[a-z0-9_-]+\/hooks\/[a-z0-9_-]+\.mjs';\r?\n?$/.test(src);
  // Readers and aliases in ext/ and the adapters run inside hooks, so they stay off the network as lib/ does.
  const quiet = inHooks || rel.startsWith('lib/') || rel.startsWith('ext/') || rel.startsWith('adapters/');

  const specs = [...code.matchAll(/(?<![\w$.])(?:from|import|require)\s*\(?\s*(?=['"`])/g)]
    .map(m => strings.get(m.index + m[0].length))
    .filter(s => s !== undefined);
  for (const spec of specs) {
    const relative = spec.startsWith('./') || spec.startsWith('../');
    if (!relative && !spec.startsWith('node:') && isBuiltin(spec)) errors.push(`imports '${spec}'; name built-ins with node:, as in 'node:${spec}'`);
    else if (!relative && !(spec.startsWith('node:') && isBuiltin(spec))) errors.push(`imports '${spec}'; tools/ uses only Node's built-in modules`);
    const mod = spec.replace(/^node:/, '');
    if (mod === 'child_process' && rel !== 'lib/git.mjs') errors.push('imports node:child_process; only lib/git.mjs runs another program, git, and hooks call only changedFiles from it');
    if (quiet && NETWORK.includes(mod)) errors.push(`imports node:${mod}; hooks, lib/ and ext/ stay off the network`);
  }
  // Hooks run what lib/ and ext/ export, so a module there that hands on more of lib/git.mjs reaches a hook too.
  if (quiet && rel !== 'lib/git.mjs') {
    const toGit = at => {
      const s = strings.get(at);
      return s !== undefined && /^\.\.?\//.test(s) && path.posix.join(path.posix.dirname(rel), s) === 'lib/git.mjs';
    };
    for (const m of code.matchAll(/(?<![\w$.])(import|export)\s+([^'"`;]*?)\s+from\s*(?=['"])/g)) {
      if (!toGit(m.index + m[0].length)) continue;
      const { names, named } = bindings(m[2]);
      const others = [...names, ...named.map(([orig]) => orig).filter(x => x !== 'changedFiles')];
      if (others.length) errors.push(`${m[1]}s ${others.join(', ')} from lib/git.mjs; hooks call only changedFiles from it`);
    }
    for (const m of code.matchAll(/(?<![\w$.])import\s*\(\s*(?=['"`])/g)) {
      if (toGit(m.index + m[0].length)) errors.push('imports lib/git.mjs with import(); hooks call only changedFiles from it, through a static import');
    }
  }
  if (quiet && /(?<![\w$.])fetch\s*\(/.test(code)) errors.push('calls fetch(); hooks, lib/ and ext/ stay off the network');

  if (inHooks && !shim && !/(?<![\w$.])runHook\s*\(/.test(code)) errors.push("doesn't go through runHook");
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

// Bytes compared with CRLF read as LF, through latin1, which maps each byte to one character and back.
const lfBytes = buf => buf.toString('latin1').replace(/\r\n/g, '\n');

// Some agents read skills from .agents/skills/ rather than .claude/skills/, so each skill file has a copy there. Line
// endings don't count: a checkout made before the copies existed can hold the skills with CRLF and the copies with LF.
function lintSkillCopies(found) {
  for (const rel of filesIn(vaultPath('.claude', 'skills')).sort()) {
    const [from, to] = [`.claude/skills/${rel}`, `.agents/skills/${rel}`];
    const copy = fs.existsSync(vaultPath(to)) ? fs.readFileSync(vaultPath(to)) : null;
    if (copy && lfBytes(copy) === lfBytes(fs.readFileSync(vaultPath(from)))) continue;
    const msg = copy ? `differs from ${from}; edit the skill there, then run node tools/lint.mjs --fix to copy it` : `missing; run node tools/lint.mjs --fix to copy ${from}`;
    found.push({ level: 'error', file: to, msg, copyFrom: from });
  }
  // An agent would still read a renamed or deleted skill's copy. Deleting is the user's call, so --fix leaves it.
  const copies = vaultPath('.agents', 'skills');
  const names = fs.existsSync(copies) ? fs.readdirSync(copies, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => e.name) : [];
  for (const name of names.sort()) {
    if (fs.existsSync(vaultPath('.claude', 'skills', name))) continue;
    found.push({ level: 'error', file: `.agents/skills/${name}/`, msg: `.claude/skills/${name}/ no longer exists; delete .agents/skills/${name}/` });
  }
}

const isList = (v, ok) => Array.isArray(v) && v.every(ok);
const isFolder = p => typeof p === 'string' && Boolean(p.trim()) && path.isAbsolute(p);

// Reach comes from vault.config.json, which every machine shares, and the paths in vault.local.json, which only this
// machine has, so each file is read as written rather than through config(), which keeps only what parses.
function lintReach(add) {
  const sharedFile = readJsonSafe(vaultPath('vault.config.json'));
  const shared = sharedFile?.domains ?? {};
  const localFile = vaultPath('vault.local.json');
  const modes = joinList(PROPOSAL_MODES, 'or');
  const topMode = sharedFile?.proposals;
  if (topMode !== undefined && !PROPOSAL_MODES.includes(topMode)) add('error', 'vault.config.json', `proposals is ${JSON.stringify(topMode)}; it must be ${modes}`);
  for (const [d, x] of Object.entries(shared)) {
    const mode = x?.proposals;
    if (mode !== undefined && !PROPOSAL_MODES.includes(mode)) add('error', 'vault.config.json', `${d}: proposals is ${JSON.stringify(mode)}; it must be ${modes}`);
  }
  const local = fs.existsSync(localFile) ? readJsonSafe(localFile) : {};
  const mine = local?.domains ?? {};
  if (!local || typeof mine !== 'object' || Array.isArray(mine)) {
    add('error', 'vault.local.json', 'vault.local.json must be JSON in the form { "domains": { "<domain>": { "paths": ["<folder>"] } } }');
    return;
  }
  // Windows calls /scratch absolute, but a session's folder there starts with its drive, so such a glob never matches.
  const rooted = g => process.platform !== 'win32' || /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/.test(g);
  if (local.quiet !== undefined && !isList(local.quiet, g => isFolder(g) && rooted(g) && validGlob(g))) {
    add('error', 'vault.local.json', 'quiet must be a list of globs over absolute folder paths, such as "C:/scratch/**"');
  }
  const pathsOf = d => (Array.isArray(mine[d]?.paths) ? mine[d].paths : []);
  for (const [d, x] of Object.entries(shared)) {
    const c = x ?? {};
    if (c.markers !== undefined && !isList(c.markers, isMarkerName)) add('error', 'vault.config.json', `${d}: markers must be a list of file names, with no folders in them`);
    for (const flag of ['everywhere', 'vaultOnly']) {
      if (c[flag] !== undefined && typeof c[flag] !== 'boolean') add('error', 'vault.config.json', `${d}: ${flag} must be true or false`);
    }
    const marked = Array.isArray(c.markers) && c.markers.length > 0;
    if (c.vaultOnly === true && (marked || c.everywhere === true)) add('error', 'vault.config.json', `${d} is vaultOnly, so it holds only pages and takes no markers or everywhere`);
    if (c.projects !== undefined) add('warn', 'vault.config.json', `${d}: projects does nothing. Put its folders in vault.local.json as paths, or give it markers`);
    if (c.paths !== undefined) add('warn', 'vault.config.json', `${d}: paths in vault.config.json do nothing. Put them in vault.local.json, which holds this machine's folders`);
    if (d !== 'global' && c.vaultOnly !== true && !marked && !pathsOf(d).length && c.everywhere !== true) {
      add('warn', 'vault.config.json', `${d} reaches no project on this machine. Add its folders to vault.local.json as paths, give it markers, or set vaultOnly: true if it holds only pages`);
    }
  }
  for (const [d, x] of Object.entries(mine)) {
    if (d === 'global') add('error', 'vault.local.json', 'global reaches every project, so it takes no paths');
    else if (!Object.hasOwn(shared, d)) add('error', 'vault.local.json', `${d} isn't a domain in vault.config.json`);
    else if (shared[d]?.vaultOnly === true && pathsOf(d).length) add('error', 'vault.local.json', `${d} is vaultOnly in vault.config.json, so it takes no paths`);
    else if (x?.paths !== undefined && !isList(x.paths, isFolder)) add('error', 'vault.local.json', `${d}: paths must be a list of absolute folder paths`);
    else {
      for (const p of pathsOf(d)) {
        if (!fs.statSync(toPosix(p), { throwIfNoEntry: false })?.isDirectory()) add('error', 'vault.local.json', `${d}'s path ${p} doesn't exist on this machine. Fix it or remove it`);
      }
    }
  }
}
