import fs from 'node:fs';
import { shortHash, plainText, toPosix } from '../../lib/vault.mjs';
import { mark } from '../../lib/sessions.mjs';
import { parsePatch, applyChunks, addedText } from './patch.mjs';
import { continuedMark } from './transcript.mjs';

export { typedMessages, transcriptCheck, newestTranscript } from './transcript.mjs';

export const name = 'codex';

export const capabilities = { start: true, prompt: true, deny: true, stopContext: true, subagentStart: true, typedText: true };

export const sessionVar = 'CODEX_THREAD_ID';

// Codex has no safe-mode variable: the user turns hooks off in /hooks or with features.hooks = false.
export const disabled = () => false;

export const fileTools = ['apply_patch'];
// PreToolUse sees apply_patch, Bash and MCP tools. Bash is left out: a shell write is the Stop hook's to check.
export const matcher = 'apply_patch|mcp__.*';
const SENT = new RegExp(`^(?:${matcher})$`);
export const sends = tool => SENT.test(tool);

export const proposeShell = 'from a POSIX shell with a quoted heredoc, since PowerShell turns curly quotes and dashes into ?';

export const identifiers = ['CODEX_', 'apply_patch', '*** Begin Patch', 'content_item_kinds', 'send_user_message', 'Codex'];

const fileKey = (file, cwd) => (process.platform === 'win32' ? toPosix(file, cwd).toLowerCase() : toPosix(file, cwd));
const readText = file => { try { return plainText(fs.readFileSync(file, 'utf8')); } catch { return null; } };

// One event per file the patch touches, two for a move, so each file is gated and guarded as an edit of its own. Codex
// applies the hunks in order, so a file's text is built from the hunks before: an add ignores what was there, a delete
// leaves '', an update applies its chunks, and a move deletes its source and writes the source's new text to its
// destination. Each event's after() runs the patch up to its own hunk, from the before it is given for its own file and
// from disk for any other.
function patchEvents(input, base) {
  const tool = input.tool_name;
  const texts = new Map();
  const textOf = key => texts.get(key) ?? (read => read(key));
  const out = [];
  for (const op of parsePatch(input.tool_input?.command ?? '')) {
    const from = fileKey(op.path, base.cwd);
    const to = op.moveTo === undefined ? from : fileKey(op.moveTo, base.cwd);
    if (op.op === 'add') {
      const text = op.lines.map(l => `${l}\n`).join('');
      texts.set(from, () => text);
    } else if (op.op === 'delete') texts.set(from, () => '');
    else {
      const was = textOf(from);
      texts.set(from, () => '');
      texts.set(to, read => { const text = was(read); return text === null ? null : applyChunks(text, op.chunks); });
    }
    const upTo = new Map(texts);
    const event = (file, key, added) => ({
      ...base, tool, args: input.tool_input, target: { namespace: 'file', path: file }, added,
      after: before => upTo.get(key)(k => (k === key ? before : readText(k))),
    });
    if (to !== from) out.push(event(op.path, from, ''));
    out.push(event(op.moveTo ?? op.path, to, addedText(op)));
  }
  return out;
}

// output() gets only the handlers' results, so the session the Stop continuation is marked under is kept from events().
let session;

export function events(hook, input) {
  session = input.session_id;
  const base = { session, agent: input.agent_id, cwd: input.cwd };
  switch (hook) {
    case 'session-start': {
      const reason = input.source === 'startup' || !['resume', 'clear', 'compact'].includes(input.source) ? 'new' : input.source;
      return [{ session, cwd: base.cwd, transcript: input.transcript_path, reason }];
    }
    case 'prompt': return continuedMark(session, input.prompt) ? [] : [{ ...base, transcript: input.transcript_path, text: input.prompt }];
    case 'edit':
      if (input.tool_name === 'apply_patch') return patchEvents(input, base);
      return sends(input.tool_name) ? [{ ...base, tool: input.tool_name, args: input.tool_input }] : [];
    case 'subagent-start': return [base];
    case 'stop': return [{ session, cwd: base.cwd }];
    default: throw new Error(`no hook ${hook}`);
  }
}

const EVENT_NAMES = { 'session-start': 'SessionStart', prompt: 'UserPromptSubmit', edit: 'PreToolUse', stop: 'Stop', 'subagent-start': 'SubagentStart' };

// Stop's decision block continues the turn with the reason as the next prompt. Its hash is marked, so the prompt hook and
// the transcript provider can tell the vault's text from the user's. No objection gives no output, never an allow.
export function output(hook, results) {
  const denies = results.flatMap(r => (r?.deny ? [r.deny] : []));
  if (denies.length) return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: denies.join('\n\n') } };
  const context = results.flatMap(r => (r?.context ? [r.context] : [])).join('\n\n');
  if (!context) return null;
  if (hook === 'stop') {
    mark('turns', session, `continued|${shortHash(context.trim())}`);
    return { decision: 'block', reason: context };
  }
  return { hookSpecificOutput: { hookEventName: EVENT_NAMES[hook], additionalContext: context } };
}

const HOOKS = [
  ['SessionStart', 'session-start', true],
  ['UserPromptSubmit', 'prompt', true],
  ['PreToolUse', 'edit', false],
  ['SubagentStart', 'subagent-start', true],
  ['Stop', 'stop', false],
];

// The command names .live, whose content changes with each commit while the definition stays the same, so the trust the
// user gives in /hooks holds across vault commits. The path is quoted, so cmd.exe keeps one with spaces whole.
export function registration(root) {
  const line = ([event, hook, context]) => {
    const command = JSON.stringify(`node "${root}/.live/tools/adapters/codex/launch.mjs" ${hook} 10`);
    const limit = context ? ', "additionalContextLimit": 4000' : '';
    const match = event === 'PreToolUse' ? `"matcher": ${JSON.stringify(matcher)}, ` : '';
    return `    "${event}": [{ ${match}"hooks": [{ "type": "command", "command": ${command}, "timeout": 10${limit} }] }]`;
  };
  return {
    where: 'Merge this into ~/.codex/hooks.json, then open /hooks in Codex and trust the five vault hooks. Codex skips them until you do.',
    text: `{\n  "hooks": {\n${HOOKS.map(line).join(',\n')}\n  }\n}`,
  };
}
