import fs from 'node:fs';
import { runHook, domainsFor, vaultRel, vaultPath, pendingRows, plural, clock } from '../lib/vault.mjs';
import { alwaysContext, clip } from '../lib/rules.mjs';
import { touchSession, clearMarkers } from '../lib/sessions.mjs';

const PASS_END = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z) ([A-Za-z0-9_-]{1,100}) (?:kept \d|failed: (.*))/;
const LOGIN = /OAuth|authenticat|\/login|not logged in/i;

// Only the newest pass counts: one that succeeds after a failure shows the cause is gone, and the sweep retries the failed session.
function passNote() {
  let log = '';
  try { log = fs.readFileSync(vaultPath('.state', 'passes.log'), 'utf8'); } catch {}
  const [, at, id, why] = log.split(/\r?\n/).map(l => PASS_END.exec(l)).findLast(Boolean) ?? [];
  if (why === undefined) return '';
  return [
    `The taste vault's last session pass failed at ${clock(new Date(at))} with "${clip(why, 200)}".`,
    ...(LOGIN.test(why) ? ["The pass's claude login has expired, and only the user can renew it, with `claude auth login` in a terminal."] : []),
    `Once the cause is fixed, \`node tools/session-pass.mjs ${id}\` from the vault root reruns the pass.`,
    'At the start of your first reply, tell the user so in a line of its own.',
  ].join(' ');
}

function reviewNote() {
  const n = pendingRows().length;
  if (!n) return '';
  const waiting = `${plural(n, 'capture')} in the taste vault ${n === 1 ? 'is' : 'are'} waiting for review.`;
  return `${waiting} At the start of your first reply, tell the user so in one line and mention that /taste-review turns captures into rules.`;
}

function vaultNotes(input) {
  if (!['startup', 'clear'].includes(input.source) || !input.cwd || vaultRel(input.cwd) === null) return [];
  return [passNote(), reviewNote()];
}

runHook('session-start', input => {
  const doms = domainsFor(input.cwd).map(d => d.domain);
  // Compaction can drop the rules the gate and excerpts already showed, so they show them again.
  if (input.session_id && (input.source === 'compact' || input.source === 'clear')) clearMarkers(input.session_id);
  if (input.session_id && doms.length) touchSession(input, { loaded: ['global', ...doms] });
  const context = [alwaysContext(['global', ...doms]), ...vaultNotes(input)].filter(Boolean).join('\n\n');
  return context ? { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } } : null;
});
