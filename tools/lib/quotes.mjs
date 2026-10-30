import { readJsonl } from './vault.mjs';
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

export function typedMessages(transcript) {
  return readJsonl(transcript).flatMap(r => {
    const q = r?.attachment;
    if (r?.type === 'attachment' && q?.type === 'queued_command' && q.commandMode === 'prompt' && byHuman(q)) return blockTexts(q.prompt);
    if (r?.type !== 'user' || r.isMeta || r.isCompactSummary) return [];
    if (r.toolUseResult !== undefined) return r.toolUseResult?.answers ? answerTexts(r.toolUseResult) : [];
    return byHuman(r) ? blockTexts(r.message?.content) : [];
  }).map(t => t.replace(INJECTED, ' '));
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
