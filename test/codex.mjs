import fs from 'node:fs';
import path from 'node:path';

// Hook input as Codex CLI 0.153.4 sends it: each event's required fields from its schema in fixtures/codex/schema/,
// then the test's own.
export function codexInput(event, fields = {}) {
  const base = { session_id: 'codex-session', transcript_path: null, cwd: process.cwd(), hook_event_name: event, model: 'fixture-model', permission_mode: 'default' };
  const turn = { turn_id: 'turn-1' };
  const own = {
    SessionStart: { source: 'startup' },
    UserPromptSubmit: { ...turn, prompt: '' },
    PreToolUse: { ...turn, tool_name: 'apply_patch', tool_use_id: 'call-1', tool_input: { command: '' } },
    SubagentStart: { ...turn, agent_id: 'agent-1', agent_type: 'default' },
    Stop: { ...turn, stop_hook_active: false, last_assistant_message: null },
  }[event];
  if (!own) throw new Error(`no Codex event ${event}`);
  return { ...base, ...own, ...fields };
}

// Patch text from { add, lines } (the file's lines), { update, moveTo, chunks: [{ context, lines }] } (each line with its
// ' ', '-' or '+'), and { delete }.
export function codexPatch(ops) {
  const out = ['*** Begin Patch'];
  for (const op of ops) {
    if (op.add !== undefined) out.push(`*** Add File: ${op.add}`, ...op.lines.map(l => `+${l}`));
    else if (op.delete !== undefined) out.push(`*** Delete File: ${op.delete}`);
    else {
      out.push(`*** Update File: ${op.update}`, ...(op.moveTo ? [`*** Move to: ${op.moveTo}`] : []));
      for (const c of op.chunks) out.push(...(c.context === undefined ? [] : [c.context ? `@@ ${c.context}` : '@@']), ...c.lines, ...(c.eof ? ['*** End of File'] : []));
    }
  }
  out.push('*** End Patch');
  return `${out.join('\n')}\n`;
}

const xmlEscape = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

// A Stop continuation as Codex records it: a user message with no content_item_kinds, one input_text per fragment.
export const hookPrompt = (...reasons) => ({ kinds: null, content: reasons.map(r => ({ type: 'input_text', text: `<hook_prompt hook_run_id="run-1">${xmlEscape(r.trim())}</hook_prompt>` })) });

// A rollout as Codex writes it under ~/.codex/sessions/: a session_meta line, then one response_item per message. A
// message is the user's typed text, or { kinds, text } for one Codex injects, or { role, text }, or { kinds, content } with
// the content items given. The shape was read from local rollouts, field names only.
export function codexRollout(v, sid, messages) {
  const file = v.at('.transcripts', `rollout-2026-11-01T00-00-00-${sid}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const at = i => new Date(Date.UTC(2026, 10, 1, 0, 0, i)).toISOString();
  const lines = [{ timestamp: at(0), type: 'session_meta', payload: { id: sid, cwd: v.project, cli_version: '0.153.4' } }];
  messages.forEach((m, i) => {
    const { role = 'user', kinds = ['user.text'], text, content } = typeof m === 'string' ? { text: m } : m;
    const meta = kinds === null ? {} : { internal_chat_message_metadata_passthrough: { content_item_kinds: kinds } };
    const type = role === 'user' ? 'input_text' : 'output_text';
    lines.push({ timestamp: at(i + 1), type: 'response_item', payload: { type: 'message', role, content: content ?? [{ type, text }], ...meta } });
  });
  fs.writeFileSync(file, lines.map(l => `${JSON.stringify(l)}\n`).join(''));
  return file;
}
