import path from 'node:path';
import { userTurn, assistantTurn, toolResult } from '../fixture.mjs';

// What the adapter contract test needs of one agent: its hook payloads, and what it reads back from the hooks' output.
export const name = 'claude-code';
export const config = {};

export const payload = {
  start: (v, sid, { source = 'startup', transcript = null, cwd = v.project } = {}) => ({ session_id: sid, transcript_path: transcript, cwd, hook_event_name: 'SessionStart', source }),
  prompt: (v, sid, text, { cwd = v.project } = {}) => ({ session_id: sid, cwd, prompt: text, hook_event_name: 'UserPromptSubmit' }),
  editFile: (v, sid, rel, { text = 'set x to 1', agent } = {}) => ({
    session_id: sid, cwd: v.project, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(v.project, ...rel.split('/')), old_string: 'a', new_string: text },
    ...(agent ? { agent_id: agent } : {}),
  }),
  toolCall: (v, sid, tool, args, { agent } = {}) => ({ session_id: sid, cwd: v.project, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: args, ...(agent ? { agent_id: agent } : {}) }),
  subagent: (v, sid, agent) => ({ session_id: sid, cwd: v.project, hook_event_name: 'SubagentStart', agent_id: agent, agent_type: 'general-purpose' }),
  stop: (v, sid) => ({ session_id: sid, cwd: v.project, hook_event_name: 'Stop', stop_hook_active: false }),
};

const hook = (v, name, input) => v.hook(name, input, { agent: 'claude-code' });
export const start = (v, sid, opts) => hook(v, 'session-start', payload.start(v, sid, opts));
export const prompt = (v, sid, text, opts) => hook(v, 'prompt', payload.prompt(v, sid, text, opts));
export const editFile = (v, sid, rel, opts) => hook(v, 'edit', payload.editFile(v, sid, rel, opts));
export const toolCall = (v, sid, tool, args, opts) => hook(v, 'edit', payload.toolCall(v, sid, tool, args, opts));
export const subagent = (v, sid, agent) => hook(v, 'subagent-start', payload.subagent(v, sid, agent));
export const stop = (v, sid) => hook(v, 'stop', payload.stop(v, sid));

export const context = out => out?.hookSpecificOutput?.additionalContext ?? null;
export const deny = out => (out?.hookSpecificOutput?.permissionDecision === 'deny' ? out.hookSpecificOutput.permissionDecisionReason : null);
export const continued = out => (out?.hookSpecificOutput?.hookEventName === 'Stop' ? out.hookSpecificOutput.additionalContext : null);

// A transcript holding one typed message among text the user didn't type.
export function transcript(v, sid, typed) {
  return v.transcript(sid, [
    assistantTurn(`You said: ${typed}`),
    { ...userTurn(typed), origin: { kind: 'human' } },
    { ...userTurn('injected skill text'), isMeta: true },
    toolResult('tool output'),
    { ...userTurn('a background task finished'), origin: { kind: 'task-notification' } },
  ]);
}
