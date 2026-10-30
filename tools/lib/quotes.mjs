import fs from 'node:fs';
import { readJsonl, vaultPath } from './vault.mjs';
import { escapeRegExp } from './rules.mjs';

// Claude Code logs tool output, skill text, compaction summaries, injected context and prompts the app or a script
// sent as user entries too, so only the text the user typed counts as their words: their prompts, queued or not, and
// what they wrote into an AskUserQuestion answer. The options' labels are the agent's.
const INJECTED = /<(system-reminder|task-notification|local-command-stdout|local-command-stderr|local-command-caveat)>[\s\S]*?<\/\1>/g;

const blockTexts = c => (typeof c === 'string' ? [c] : Array.isArray(c) ? c.filter(b => b?.type === 'text').map(b => String(b.text ?? '')) : []);
const byHuman = r => (r.origin ? r.origin.kind === 'human' : r.turnOrigin === undefined);

function answerTexts(u) {
  const labels = (u.questions ?? []).flatMap(q => (q.options ?? []).map(o => String(o.label ?? ''))).filter(Boolean).sort((a, b) => b.length - a.length);
  const answers = Object.values(u.answers ?? {}).map(a => labels.reduce((s, l) => s.split(l).join('\n'), String(a ?? '')));
  return [...answers, ...Object.values(u.annotations ?? {}).map(a => String(a?.notes ?? ''))];
}

// Null when the transcript can't be read.
export function typedMessages(transcript) {
  return readJsonl(transcript, null)?.flatMap(r => {
    const q = r?.attachment;
    if (r?.type === 'attachment' && q?.type === 'queued_command' && q.commandMode === 'prompt' && byHuman(q)) return blockTexts(q.prompt);
    if (r?.type !== 'user' || r.isMeta || r.isCompactSummary) return [];
    if (r.toolUseResult !== undefined) return r.toolUseResult?.answers ? answerTexts(r.toolUseResult) : [];
    return byHuman(r) ? blockTexts(r.message?.content) : [];
  }).map(t => t.replace(INJECTED, ' ')) ?? null;
}

// Curly quotes read as straight ones, and dashes of any length as one hyphen. Apostrophes go first so "don't" reads as
// the stopword dont rather than as don, which every Not line shares.
export const normText = s => String(s)
  .normalize('NFKC')
  .toLowerCase()
  .replace(/[‐‑‒–—―]+|-{2,}/g, '-')
  .replace(/[‘’ʼ]/g, "'")
  .replace(/[“”]/g, '"')
  .replace(/\s+/g, ' ')
  .trim();

// An ellipsis marks words left out, so each piece has to appear, in order, within one message, as whole words.
export function saidIn(quote, messages) {
  const pieces = normText(quote).split(/\s*(?:…|\.{3})\s*/).filter(Boolean).map(p => new RegExp(
    `${/^[\p{L}\p{N}]/u.test(p) ? '(?<![\\p{L}\\p{N}])' : ''}${escapeRegExp(p)}${/[\p{L}\p{N}]$/u.test(p) ? '(?![\\p{L}\\p{N}])' : ''}`, 'gu'));
  return pieces.length > 0 && messages.some(m => {
    const text = normText(m);
    let from = 0;
    return pieces.every(re => {
      re.lastIndex = from;
      const hit = re.exec(text);
      from = hit ? re.lastIndex : 0;
      return hit !== null;
    });
  });
}

// Latin-1's named entities, in code point order from 160, then the typographic ones pages use most.
const LATIN1 = ('nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro '
  + 'para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute '
  + 'Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN '
  + 'szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute '
  + 'ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml').split(' ');
const ENTITIES = new Map(Object.entries({
  ...Object.fromEntries(LATIN1.map((name, i) => [name, String.fromCharCode(160 + i)])),
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ', zwnj: '', zwj: '', lrm: '', rlm: '',
  lsquo: '‘', rsquo: '’', sbquo: '‚', ldquo: '“', rdquo: '”', bdquo: '„', lsaquo: '‹', rsaquo: '›', ndash: '–', mdash: '—', minus: '−',
  hellip: '…', bull: '•', dagger: '†', Dagger: '‡', permil: '‰', euro: '€', trade: '™', larr: '←', rarr: '→', circ: 'ˆ', tilde: '˜',
  OElig: 'Œ', oelig: 'œ', Scaron: 'Š', scaron: 'š', Yuml: 'Ÿ',
}));
const INLINE_TAGS = /<\/?(?:a|abbr|b|bdi|bdo|cite|code|data|dfn|em|i|kbd|mark|q|s|samp|small|span|strong|sub|sup|time|u|var)\b[^>]*>/gi;

// Names are case-sensitive, as &Eacute; and &eacute; differ, but a page that shouts &AMP; still means &amp;.
function decodeEntity(m, name) {
  if (name[0] !== '#') return ENTITIES.get(name) ?? ENTITIES.get(name.toLowerCase()) ?? m;
  const code = /^#x/i.test(name) ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
}

const htmlText = html => html.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ').replace(INLINE_TAGS, '').replace(/<[^>]*>/g, ' ')
  .replace(/&(#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/gi, decodeEntity);

// Link text without its target, and words without their emphasis or code marks. An underscore inside a word is kept.
const markdownText = md => md
  .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/\[\[(?:[^\]|]*\|)?([^\]|]*)\]\]/g, '$1')
  .replace(/[*`]+|~~|(?<![\p{L}\p{N}])_+|_+(?![\p{L}\p{N}])/gu, '');

// The readings a quote may match. A binary source such as a screenshot or PDF has none, so it comes back null. A saved
// web page is quoted as it reads, not as its markup: inline tags sit inside words and other tags between them. Markdown
// is quoted either as written or as it reads.
export function sourceTexts(rel) {
  const buf = fs.readFileSync(vaultPath(...rel.split('/')));
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return null; }
  if (text.includes('\0')) return null;
  if (/\.html?$/i.test(rel)) return [htmlText(text)];
  return /\.(?:md|markdown)$/i.test(rel) ? [text, markdownText(text)] : [text];
}
