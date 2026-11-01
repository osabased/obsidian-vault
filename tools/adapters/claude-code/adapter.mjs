import { lf, plainText } from '../../lib/vault.mjs';

export { typedMessages, transcriptCheck, newestTranscript } from './transcript.mjs';

export const name = 'claude-code';

export const capabilities = { start: true, prompt: true, deny: true, stopContext: true, subagentStart: true, typedText: true };

export const sessionVar = 'CLAUDE_CODE_SESSION_ID';

// Session ids are random UUIDs, so their start tells sessions apart.
export const shortName = sid => sid.slice(0, 8);

export const disabled = env => env.CLAUDE_CODE_SAFE_MODE === '1';

export const fileTools = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
// The PreToolUse matcher the edit hook ships with. It names no user's tools: a tool in editTools is an MCP tool. Claude
// Code tests a matcher with characters other than letters, digits, _ and | as an unanchored regex, so it anchors itself.
export const matcher = '^(?:Edit|Write|MultiEdit|NotebookEdit|AskUserQuestion|mcp__.*)$';
const SENT = new RegExp(matcher);
export const sends = tool => SENT.test(tool);

const toolFile = (tool, ti) => (tool === 'NotebookEdit' ? ti.notebook_path : ti.file_path);

export const proposeShell = 'from the Bash tool with a quoted heredoc, since PowerShell turns curly quotes and dashes into ?';

export const identifiers = [
  'CLAUDE_CODE_', 'CLAUDE_PLUGIN_', 'hookSpecificOutput', 'permissionDecision', 'additionalContext', 'AskUserQuestion', 'MultiEdit', 'NotebookEdit',
  'toolUseResult', 'isCompactSummary', 'isMeta', 'queued_command', 'system-reminder', 'task-notification', 'local-command-', 'stop_hook_active',
  'session_id', 'agent_id', 'tool_name', 'transcript_path', 'file_path', 'notebook_path', 'old_string', 'new_string', 'new_source', 'Claude Code',
];

const foldQuotes = s => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');

function matchIn(text, from) {
  if (text.includes(from)) return from;
  const i = foldQuotes(text).indexOf(foldQuotes(from));
  if (i >= 0) return text.slice(i, i + from.length);
  const decoded = from.replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
  return decoded !== from && text.includes(decoded) ? decoded : null;
}

// Edit matches as Claude Code does: line endings and curly quotes don't count, a character old_string spells as an
// escape such as \u00e9 matches itself, and an empty old_string writes a file that is missing or blank. An old_string
// found more than once without replace_all fails, so that edit is left for the tool to refuse.
function replaced(text, e) {
  if (!e.old_string) return text.trim() ? null : lf(e.new_string);
  const from = matchIn(text, lf(e.old_string));
  if (from === null) return null;
  const parts = text.split(from);
  return parts.length > 2 && !e.replace_all ? null : parts.join(lf(e.new_string));
}

function textAfter(tool, ti, before) {
  if (tool === 'Write') return plainText(ti.content);
  const edits = tool === 'MultiEdit' ? ti.edits ?? [] : tool === 'Edit' ? [ti] : null;
  return edits && edits.reduce((text, e) => (text === null ? null : replaced(text, e)), before);
}

function newText(tool, ti) {
  if (tool === 'Write') return String(ti.content ?? '');
  if (tool === 'MultiEdit') return (ti.edits ?? []).map(e => e.new_string ?? '').join('\n');
  if (tool === 'NotebookEdit') return String(ti.new_source ?? '');
  return String(ti.new_string ?? '');
}

// A file tool call with no path has nothing to gate, so it gives no event.
function preTool(input, base) {
  const tool = input.tool_name;
  const ti = input.tool_input ?? {};
  if (!fileTools.includes(tool)) return [{ ...base, tool, args: input.tool_input, added: newText(tool, ti) }];
  const file = toolFile(tool, ti);
  if (!file) return [];
  return [{ ...base, tool, args: input.tool_input, target: { namespace: 'file', path: file }, added: newText(tool, ti), after: before => textAfter(tool, ti, before) }];
}

export function events(hook, input) {
  const base = { session: input.session_id, agent: input.agent_id, cwd: input.cwd };
  switch (hook) {
    case 'session-start': return [{ session: base.session, cwd: base.cwd, transcript: input.transcript_path, reason: input.source === 'startup' ? 'new' : input.source }];
    case 'prompt': return [{ ...base, transcript: input.transcript_path, text: input.prompt }];
    case 'edit': return preTool(input, base);
    case 'subagent-start':
    case 'stop': return [base];
    default: throw new Error(`no hook ${hook}`);
  }
}

const EVENT_NAMES = { 'session-start': 'SessionStart', prompt: 'UserPromptSubmit', edit: 'PreToolUse', stop: 'Stop', 'subagent-start': 'SubagentStart' };

// Stop's additionalContext continues the turn. The gate markers alone keep it to one continuation per file, so
// stop_hook_active is not consulted: a file a continuation writes still gets its rules, and Claude Code ends the turn
// after 8 continuations in a row whatever the hook says. No objection gives no output, since a PreToolUse allow would
// skip the permission prompt the user's mode shows.
export function output(hook, results) {
  const denies = results.flatMap(r => (r?.deny ? [r.deny] : []));
  if (denies.length) return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: denies.join('\n\n') } };
  const context = results.flatMap(r => (r?.context ? [r.context] : []));
  return context.length ? { hookSpecificOutput: { hookEventName: EVENT_NAMES[hook], additionalContext: context.join('\n\n') } } : null;
}

export const registration = root => ({
  where: 'Run these in a shell to install the plugin with this vault.',
  text: [
    'claude plugin marketplace add osabased/obsidian-vault',
    `claude plugin install obsidian-vault@obsidian-vault --config "vault=${root}"`,
  ].join('\n'),
});
