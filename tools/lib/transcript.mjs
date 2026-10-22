import fs from 'node:fs';
import path from 'node:path';
import { stripInjected } from './capture.mjs';
import { inside } from './vault.mjs';

const SKIPPED_ENTRY = ['isMeta', 'isSidechain', 'isCompactSummary', 'isVisibleInTranscriptOnly'];
export const NOT_TYPED = ['<', '[Request interrupted by user', 'This session is being continued', 'Caveat:'];

export function* entries(buf, skipped = SKIPPED_ENTRY) {
  let pos = 0;
  while (pos < buf.length) {
    const nl = buf.indexOf(10, pos);
    const stop = nl < 0 ? buf.length : nl;
    const text = buf.toString('utf8', pos, stop);
    pos = stop + 1;
    let e;
    try { e = JSON.parse(text); } catch { continue; }
    if (!e || typeof e !== 'object' || skipped.some(f => e[f])) continue;
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

const resultText = c => (typeof c === 'string' ? c : Array.isArray(c) ? c.filter(b => b?.type === 'text').map(b => b.text).join('\n') : '');
const SAVED = /^<persisted-output>[\s\S]*?Full output saved to: (.+)$/m;
const PREVIEW = /^<persisted-output>[\s\S]*?\nPreview[^\n]*\n/;

// The transcript keeps only a preview of a long output. Claude Code saves the whole of it in the session's folder.
function outputText(e, b, folder) {
  const text = resultText(b.content);
  const file = text.match(SAVED)?.[1].trim() ?? e.toolUseResult?.persistedOutputPath;
  if (typeof file !== 'string' || inside(folder, file) === null) return text;
  try { return fs.readFileSync(file, 'utf8'); } catch { return [text, e.toolUseResult?.stdout, e.toolUseResult?.stderr].filter(s => typeof s === 'string').join('\n'); }
}

// Subagents keep their own transcripts in the session's folder, marked as side chains, and save their long
// outputs with the session's. A saved output can be large, so a result's text is read only when asked for;
// its preview is what the transcript itself holds.
export function* toolActivity(file) {
  if (typeof file !== 'string') return;
  const folder = file.replace(/\.jsonl$/i, '');
  const sub = path.join(folder, 'subagents');
  let subagents = [];
  try { subagents = fs.readdirSync(sub).filter(f => f.endsWith('.jsonl')).map(f => path.join(sub, f)); } catch {}
  for (const t of [file, ...subagents]) {
    let buf;
    try { buf = fs.readFileSync(t); } catch { continue; }
    const calls = new Map();
    for (const { e, blocks } of entries(buf, [])) {
      for (const b of blocks) {
        if (e.type === 'assistant' && b?.type === 'tool_use') {
          const call = { type: 'call', id: b.id, name: b.name, input: b.input ?? {} };
          calls.set(b.id, call);
          yield call;
        } else if (e.type === 'user' && b?.type === 'tool_result') {
          const call = calls.get(b.tool_use_id);
          yield {
            type: 'result', id: b.tool_use_id, name: call?.name, input: call?.input ?? {}, error: b.is_error === true,
            get text() { return outputText(e, b, folder); },
            get preview() { return resultText(b.content).replace(PREVIEW, ''); },
          };
        }
      }
    }
  }
}

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
