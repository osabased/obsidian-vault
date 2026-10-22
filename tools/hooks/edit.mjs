import fs from 'node:fs';
import { runHook, config, domainsFor, inside, vaultRel, toPosix, cwdOf, FILE_TOOLS, SHELL_TOOLS, WRITEISH, toolCommand, toolFile } from '../lib/vault.mjs';
import { readLedger, parseNote, noteHash, clip, tryRegex, cmp } from '../lib/rules.mjs';
import { bestMatch, specificity, bySpecificity } from '../lib/glob.mjs';
import { marked, markDelivered } from '../lib/sessions.mjs';

const LEDGER = 'confirmed.json is the ledger of the rules the user confirmed. Only the hooks write it, when the user confirms or retires a rule in chat. Reading it is fine.';
const ONLY_USER = 'Only the user confirms, retires or drops rules, in their own chat. Ask them to.';

function shellGuard(command) {
  if (/confirmed\.json/i.test(command) && WRITEISH.test(command)) return LEDGER;
  if (/\bclaude(?:\.exe)?["']?\s/i.test(command) && /\b(?:confirm|retire):/i.test(command)) return ONLY_USER;
  if (/status:\s*confirmed/i.test(command) && WRITEISH.test(command)) return ONLY_USER;
  return null;
}

const lf = s => String(s ?? '').replace(/\r\n/g, '\n');

function simulate(tool, ti, prev) {
  if (tool === 'Write') return lf(ti.content);
  if (tool === 'NotebookEdit') return null;
  const edits = tool === 'MultiEdit' ? ti.edits ?? [] : [ti];
  let text = prev === null ? (edits[0]?.old_string === '' ? '' : null) : lf(prev);
  if (text === null) return null;
  for (const e of edits) {
    const from = lf(e.old_string);
    const to = lf(e.new_string);
    if (!from) {
      if (!text) text = to;
    } else if (text.includes(from)) {
      text = e.replace_all ? text.split(from).join(to) : text.replace(from, () => to);
    }
  }
  return text;
}

function noteGuard(tool, ti, file, rel) {
  let prev = null;
  try { prev = fs.readFileSync(file, 'utf8'); } catch {}
  const next = simulate(tool, ti, prev);
  if (next === null) return null;
  const after = parseNote(next, rel);
  const before = prev === null ? null : parseNote(lf(prev), rel);
  const { key } = after;
  if (after.status === 'confirmed' && before?.status !== 'confirmed') {
    return `Only the user can confirm rules, by typing \`confirm: ${key}\` in chat. Leave status as it is.`;
  }
  const entry = readLedger().rules[key];
  if (!entry || !before) return null;
  if (after.status !== before.status) return `${key} is confirmed. Only the user changes its status, by typing \`retire: ${key}\` in chat.`;
  const hash = noteHash(after);
  if (hash !== noteHash(before) && hash !== entry.hash) {
    const fields = [before, after].some(n => n.kind === 'knowledge')
      ? 'Do, Not, Because, applies_to, triggers, keywords, always, kind and as_of'
      : 'Do, Not, Because, applies_to, triggers, keywords and always';
    return `${key} is confirmed, so its ${fields} stay as the user confirmed them. Write a new note with \`replaces: ['${key}']\` instead and ask the user to confirm it.`;
  }
  return null;
}

function vaultGuard(tool, ti, file, cwd) {
  const rel = vaultRel(file, cwd);
  if (rel === null) return null;
  const low = rel.toLowerCase();
  if (low === 'confirmed.json') return LEDGER;
  if (low === 'active.md' || low === 'index.md') return `${rel} is generated from the notes and confirmed.json. Edit the notes instead, then run \`node tools/build.mjs\`.`;
  if (low === '.state' || low.startsWith('.state/')) return ".state/ is the hooks' own bookkeeping. Leave it to them.";
  if (low.startsWith('raw/')) {
    if (fs.existsSync(toPosix(file, cwd))) return `raw/ is append-only: ${rel} already exists and can't be changed. Put new material in a new file under raw/refs/ or raw/judgments/.`;
    if (!/^raw\/(?:refs|judgments)\/./.test(low)) return 'raw/ is append-only. New files go under raw/refs/ or raw/judgments/; the hooks, tools/review.mjs and tools/propose.mjs write the rest.';
    return null;
  }
  return /^wiki\/.+\.md$/.test(low) ? noteGuard(tool, ti, toPosix(file, cwd), low) : null;
}

function newText(tool, ti) {
  if (tool === 'Write') return String(ti.content ?? '');
  if (tool === 'MultiEdit') return (ti.edits ?? []).map(e => e.new_string ?? '').join('\n');
  if (tool === 'NotebookEdit') return String(ti.new_source ?? '');
  return String(ti.new_string ?? '');
}

function gate(input, file, cwd) {
  const { maxRulesPerEdit, maxRuleChars, maxBlockChars } = config().delivery;
  const sid = input.session_id;
  const doms = domainsFor(file, cwd);
  const fallback = doms[0]?.rel ?? inside(cwd, file, cwd);
  const text = newText(input.tool_name, input.tool_input ?? {});
  const hits = [];
  for (const [key, r] of Object.entries(readLedger().rules)) {
    if (!r.applies_to?.length) continue;
    const rel = r.domain === 'global' ? fallback : doms.find(d => d.domain === r.domain)?.rel;
    if (typeof rel !== 'string') continue;
    const glob = bestMatch(r.applies_to, rel);
    if (!glob) continue;
    const triggered = r.triggers?.length > 0;
    if (triggered && !r.triggers.some(t => tryRegex(t)?.test(text))) continue;
    const id = `${key}|${r.hash}|${rel.toLowerCase()}`;
    if (!marked('gate', sid, id)) hits.push({ key, r, rel, id, triggered, spec: specificity(glob) });
  }
  if (!hits.length) return null;
  hits.sort((a, b) => Number(b.triggered) - Number(a.triggered) || bySpecificity(a.spec, b.spec) || cmp(a.key, b.key));
  const head = `Taste rules the user confirmed apply to ${hits[0].rel}:`;
  const foot = 'Revise this edit to follow them, then retry. The retry is allowed.';
  const shown = [];
  for (const hit of hits.slice(0, maxRulesPerEdit)) {
    const line = `- ${hit.key}: ${clip(hit.r.text, maxRuleChars)}`;
    if (shown.length && [head, ...shown.map(s => s.line), line, foot].join('\n').length > maxBlockChars) break;
    shown.push({ ...hit, line });
  }
  for (const s of shown) markDelivered('gate', sid, s.id, s.key, s.r.hash);
  return [head, ...shown.map(s => s.line), foot].join('\n');
}

runHook('edit', input => {
  const tool = input.tool_name;
  const ti = input.tool_input ?? {};
  let why = null;
  if (SHELL_TOOLS.includes(tool)) {
    why = shellGuard(toolCommand(tool, ti));
  } else if (FILE_TOOLS.includes(tool)) {
    const file = toolFile(tool, ti);
    const cwd = cwdOf(input);
    if (file) why = vaultGuard(tool, ti, file, cwd) ?? gate(input, file, cwd);
  }
  return why ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: why } } : null;
});
