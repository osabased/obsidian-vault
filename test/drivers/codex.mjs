import { codexInput, codexPatch, codexRollout } from '../codex.mjs';

// What the adapter contract test needs of one agent: its hook payloads, and what it reads back from the hooks' output.
// Codex is opt-in, so its vault lists it.
export const name = 'codex';
export const config = { agents: ['claude-code', 'codex'] };

const own = (sid, cwd, agent) => ({ session_id: sid, cwd, ...(agent ? { agent_id: agent, agent_type: 'default' } : {}) });

export const payload = {
  start: (v, sid, { source = 'startup', transcript = null, cwd = v.project } = {}) => codexInput('SessionStart', { session_id: sid, transcript_path: transcript, cwd, source }),
  prompt: (v, sid, text, { cwd = v.project } = {}) => codexInput('UserPromptSubmit', { session_id: sid, cwd, prompt: text }),
  editFile: (v, sid, rel, { text = 'set x to 1', agent } = {}) => codexInput('PreToolUse', {
    ...own(sid, v.project, agent), tool_name: 'apply_patch', tool_input: { command: codexPatch([{ update: rel, chunks: [{ context: '', lines: ['-a', `+${text}`] }] }]) },
  }),
  toolCall: (v, sid, tool, args, { agent } = {}) => codexInput('PreToolUse', { ...own(sid, v.project, agent), tool_name: tool, tool_input: args }),
  subagent: (v, sid, agent) => codexInput('SubagentStart', { session_id: sid, cwd: v.project, agent_id: agent }),
  stop: (v, sid) => codexInput('Stop', { session_id: sid, cwd: v.project }),
};

const hook = (v, name, input) => v.hook(name, input, { agent: 'codex' });
export const start = (v, sid, opts) => hook(v, 'session-start', payload.start(v, sid, opts));
export const prompt = (v, sid, text, opts) => hook(v, 'prompt', payload.prompt(v, sid, text, opts));
export const editFile = (v, sid, rel, opts) => hook(v, 'edit', payload.editFile(v, sid, rel, opts));
export const toolCall = (v, sid, tool, args, opts) => hook(v, 'edit', payload.toolCall(v, sid, tool, args, opts));
export const subagent = (v, sid, agent) => hook(v, 'subagent-start', payload.subagent(v, sid, agent));
export const stop = (v, sid) => hook(v, 'stop', payload.stop(v, sid));

export const context = out => out?.hookSpecificOutput?.additionalContext ?? null;
export const deny = out => (out?.hookSpecificOutput?.permissionDecision === 'deny' ? out.hookSpecificOutput.permissionDecisionReason : null);
export const continued = out => (out?.decision === 'block' ? out.reason : null);

// A rollout holding one typed message among text the user didn't type.
export function transcript(v, sid, typed) {
  return codexRollout(v, sid, [
    { kinds: ['agents_md.instructions'], text: `# The vault's AGENTS.md\n${typed}` },
    { kinds: ['environments.context'], text: `<environment_context>${typed}</environment_context>` },
    typed,
    { role: 'assistant', kinds: null, text: `You said: ${typed}` },
  ]);
}
