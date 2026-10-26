import fs from 'node:fs';
import { runHook, config, domainsFor, inside, vaultRel, toPosix, cwdOf, FILE_TOOLS, toolFile } from '../lib/vault.mjs';
import { settledRules, ruleLine, tryRegex, cmp } from '../lib/rules.mjs';
import { bestMatch, specificity, bySpecificity } from '../lib/glob.mjs';
import { marked, mark, markShown } from '../lib/sessions.mjs';

function vaultGuard(file, cwd) {
  const rel = vaultRel(file, cwd);
  if (rel === null) return null;
  const low = rel.toLowerCase();
  if (low === 'active.md' || low === 'index.md') return `${rel} is generated from the notes. Edit the notes instead, then run \`node tools/build.mjs\`.`;
  if (low === 'decisions.md') return `${rel} is generated from the picks in raw/picks/. Record picks with tools/pick.mjs instead.`;
  if (low === '.state' || low.startsWith('.state/')) return ".state/ is the hooks' own bookkeeping. Leave it to them.";
  if (low.startsWith('raw/')) {
    if (fs.existsSync(toPosix(file, cwd))) return `raw/ is append-only: ${rel} already exists and can't be changed. Put new material in a new file under raw/refs/.`;
    if (!/^raw\/refs\/./.test(low)) return 'raw/ is append-only. New files go under raw/refs/; tools/propose.mjs and tools/pick.mjs write the rest.';
  }
  return null;
}

function newText(tool, ti) {
  if (tool === 'Write') return String(ti.content ?? '');
  if (tool === 'MultiEdit') return (ti.edits ?? []).map(e => e.new_string ?? '').join('\n');
  if (tool === 'NotebookEdit') return String(ti.new_source ?? '');
  return String(ti.new_string ?? '');
}

function gate(input, file, cwd) {
  // The vault's notes and sources are the user's taste, not project work, so no rule gates them.
  if (/^(?:wiki|raw)\//i.test(vaultRel(file, cwd) ?? '')) return null;
  const { maxRulesPerEdit, maxBlockChars } = config().delivery;
  const sid = input.session_id;
  const doms = domainsFor(file, cwd);
  const fallback = doms[0]?.rel ?? inside(cwd, file, cwd);
  const text = newText(input.tool_name, input.tool_input ?? {});
  const hits = [];
  for (const [key, r] of Object.entries(settledRules())) {
    if (!r.applies_to?.length) continue;
    const rel = r.domain === 'global' ? fallback : doms.find(d => d.domain === r.domain)?.rel;
    if (typeof rel !== 'string') continue;
    const glob = bestMatch(r.applies_to, rel);
    if (!glob) continue;
    const triggered = r.triggers?.length > 0;
    if (triggered && !r.triggers.some(t => tryRegex(t)?.test(text))) continue;
    // The hash is in the id, so a reworded rule is refused once more on files it already gated.
    const id = `${key}|${r.hash}|${rel.toLowerCase()}`;
    if (!marked('gate', sid, id)) hits.push({ key, r, rel, id, triggered, spec: specificity(glob) });
  }
  if (!hits.length) return null;
  hits.sort((a, b) => Number(b.triggered) - Number(a.triggered) || bySpecificity(a.spec, b.spec) || cmp(a.key, b.key));
  const head = `Taste rules apply to ${hits[0].rel}:`;
  const foot = 'Revise this edit to follow them, then retry. The retry is allowed.';
  const shown = [];
  for (const hit of hits.slice(0, maxRulesPerEdit)) {
    const line = ruleLine(hit.key, hit.r);
    if (shown.length && [head, ...shown.map(s => s.line), line, foot].join('\n').length > maxBlockChars) break;
    shown.push({ ...hit, line });
  }
  for (const s of shown) {
    mark('gate', sid, s.id);
    markShown(sid, s.key);
  }
  return [head, ...shown.map(s => s.line), foot].join('\n');
}

runHook('edit', input => {
  if (!FILE_TOOLS.includes(input.tool_name)) return null;
  const file = toolFile(input.tool_name, input.tool_input ?? {});
  if (!file) return null;
  const cwd = cwdOf(input);
  const why = vaultGuard(file, cwd) ?? gate(input, file, cwd);
  return why ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: why } } : null;
});
