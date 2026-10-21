import fs from 'node:fs';
import { stripInjected } from './capture.mjs';

const SKIPPED_ENTRY = ['isMeta', 'isSidechain', 'isCompactSummary', 'isVisibleInTranscriptOnly'];
export const NOT_TYPED = ['<', '[Request interrupted by user', 'This session is being continued', 'Caveat:'];

export function* entries(buf) {
  let pos = 0;
  while (pos < buf.length) {
    const nl = buf.indexOf(10, pos);
    const stop = nl < 0 ? buf.length : nl;
    const text = buf.toString('utf8', pos, stop);
    pos = stop + 1;
    let e;
    try { e = JSON.parse(text); } catch { continue; }
    if (!e || typeof e !== 'object' || SKIPPED_ENTRY.some(f => e[f])) continue;
    const content = e.message?.content;
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
    yield { e, blocks, pos };
  }
}

// A message the user sends mid-turn is a queued_command attachment, not a user entry. One without an
// origin can be another session's report, so only an explicit human origin counts.
export const queuedPrompt = e => {
  const a = e.type === 'attachment' ? e.attachment : null;
  return a?.type === 'queued_command' && a.origin?.kind === 'human' && typeof a.prompt === 'string' ? a.prompt : null;
};

// Stricter than the pass, which also reads unmarked entries: slash-command echoes are unmarked, and a
// brief can produce them.
const typedEntry = e => {
  const marks = [e.turnOrigin, e.origin?.kind];
  return e.type === 'user' && marks.includes('human') && marks.every(m => m == null || m === 'human');
};

const SLASH = /^<command-(?:message|name)>/;
const commandArgs = text => text.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1].trim() ?? '';

export function typedMessages(file) {
  let buf;
  try { buf = fs.readFileSync(file); } catch { return []; }
  const out = [];
  for (const { e, blocks } of entries(buf)) {
    const queued = queuedPrompt(e);
    const texts = queued !== null ? [queued] : typedEntry(e) ? blocks.filter(b => b?.type === 'text').map(b => b.text) : [];
    for (const raw of texts) {
      const text = stripInjected(raw);
      const at = String(e.timestamp ?? '');
      if (SLASH.test(text)) out.push({ at, text: commandArgs(text) });
      else if (text && !NOT_TYPED.some(p => text.startsWith(p))) out.push({ at, text });
    }
  }
  return out;
}
