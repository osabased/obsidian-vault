import fs from 'node:fs';
import path from 'node:path';
import { readJsonl, shortHash } from '../../lib/vault.mjs';
import { marked } from '../../lib/sessions.mjs';

// A Codex rollout logs AGENTS.md, environment context, hook context and the replies to its question tool as user messages
// too. Each message's content_item_kinds says where its text came from, and only ['user.text'] is what the user typed.
const QUESTION_REPLY = '<send_user_message_question_reply';

// A Stop continuation comes back as a user message; the adapter marks its hash when it sends it.
export const continuedMark = (sid, text) => Boolean(sid) && marked('turns', sid, `continued|${shortHash(String(text ?? '').trim())}`);

const userMessage = r => r?.type === 'response_item' && r.payload?.type === 'message' && r.payload.role === 'user';
const kindsOf = r => r.payload.internal_chat_message_metadata_passthrough?.content_item_kinds;

// Null when the file can't be read, has no session_meta, or holds a user message with no content_item_kinds, so a format
// change refuses quotes rather than letting injected text count as the user's.
export function typedMessages(file) {
  const rows = readJsonl(file, null);
  const sid = rows?.find(r => r?.type === 'session_meta')?.payload?.id;
  if (!sid) return null;
  const out = [];
  for (const r of rows.filter(userMessage)) {
    const kinds = kindsOf(r);
    if (!Array.isArray(kinds)) return null;
    if (kinds.length !== 1 || kinds[0] !== 'user.text') continue;
    for (const item of Array.isArray(r.payload.content) ? r.payload.content : []) {
      if (item?.type !== 'input_text') continue;
      const text = String(item.text ?? '');
      if (!text.startsWith(QUESTION_REPLY) && !continuedMark(sid, text)) out.push(text);
    }
  }
  return out;
}

// For the live provider test: the fields typedMessages reads, and the ones the file lacks.
export function transcriptCheck(file) {
  const rows = readJsonl(file, []);
  const users = rows.filter(userMessage);
  const missing = [
    !rows.some(r => r?.type === 'session_meta' && r.payload?.id) && 'session_meta.payload.id',
    !users.length && 'response_item user message',
    users.length > 0 && !users.every(r => Array.isArray(kindsOf(r))) && 'internal_chat_message_metadata_passthrough.content_item_kinds',
    !users.some(r => (r.payload.content ?? []).some(c => c?.type === 'input_text')) && 'input_text content',
  ].filter(Boolean);
  return { ok: !missing.length, missing, records: rows.length };
}

// The newest rollout under ~/.codex/sessions/<year>/<month>/<day>/, or null.
export function newestTranscript(home) {
  const dir = path.join(home, '.codex', 'sessions');
  let files;
  try { files = fs.readdirSync(dir, { recursive: true }).filter(f => /(^|[\\/])rollout-[^\\/]*\.jsonl$/.test(f)); } catch { return null; }
  const newest = files.map(f => path.join(dir, f)).map(f => ({ f, at: fs.statSync(f).mtimeMs })).sort((a, b) => b.at - a.at)[0];
  return newest?.f ?? null;
}
