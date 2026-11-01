import fs from 'node:fs';
import { vaultPath } from './vault.mjs';
import { escapeRegExp, isUserPage, parseNote, userWords } from './rules.mjs';
import { fileText, derivedText, hashFile, isAnchor } from './sources.mjs';

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
  const text = fileText(vaultPath(...rel.split('/')));
  if (text === null) return null;
  if (/\.html?$/i.test(rel)) return [htmlText(text)];
  return /\.(?:md|markdown)$/i.test(rel) ? [text, markdownText(text)] : [text];
}

// The image types a quote may meet, wider than the sheets pick.mjs takes, so a .gif quote is told it is an image rather
// than to run extract, which no extractor answers.
const IMAGES = /\.(?:png|jpe?g|webp|gif|bmp|tiff?)$/i;

// What a quote from a file under raw/ is checked against: { texts }, or { why } when there is nothing to check it
// against. A binary is read through its derived text without the anchor lines, so a quote may run across a page break.
// What an image shows is a reading, whatever text was taken from it. hashOf is how the caller hashes a binary, so lint
// can hand over a hash it has already taken.
export function quoteTexts(rel, hashOf = hashFile) {
  const texts = sourceTexts(rel);
  if (texts) return { texts };
  const derived = derivedText(hashOf(rel));
  if (derived ? derived.data.kind === 'image' : IMAGES.test(rel)) return { why: 'image' };
  if (!derived) return { why: 'no derived text' };
  return { texts: [derived.body.split('\n').filter(l => !isAnchor(l)).join('\n')] };
}

// A page of the user's is quoted by paragraph, as a message is, in the words it holds or as they read. Null when the
// file can't be read or isn't an author: user page.
export function userPageTexts(rel) {
  let text;
  try { text = fs.readFileSync(vaultPath(...rel.split('/')), 'utf8'); } catch { return null; }
  if (!isUserPage(parseNote(text, rel))) return null;
  const words = userWords(text);
  return [words, markdownText(words)].flatMap(t => t.split(/\n[ \t]*\n/));
}
