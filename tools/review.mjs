import fs from 'node:fs';
import { vaultPath, appendJsonl, inboxRows, proposalRows, pickRows, pendingRows, decisionsFile, plural, today, clock, appendLog, toPosix } from './lib/vault.mjs';
import { KEY_RE, readNote, readLedger, noteHash, ruleText, loadNotes, clip, byKey } from './lib/rules.mjs';
import { lint, tally } from './lib/lint.mjs';
import { lastPass } from './lib/sessions.mjs';

const USAGE = [
  'usage: node tools/review.mjs pending [--domain <domain>]',
  '       node tools/review.mjs picks [--domain <domain>]',
  '       node tools/review.mjs resolve <ids> (--note <domain>/<slug> | --dismiss "<reason>")',
  '       node tools/review.mjs status',
].join('\n');

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

class UsageError extends Error {}
class Refused extends Error {}

const day = iso => {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? 'no date' : today(at);
};
const oneLine = s => String(s ?? '').replace(/\s+/g, ' ').trim();
const short = id => String(id ?? '').slice(0, 8);

function block(r) {
  const kinds = Array.isArray(r.kinds) ? r.kinds.join(', ') : r.kind;
  const lines = [
    `${r.id} · ${day(r.at)} · ${r.domain || 'no domain'} · ${r.source}: ${kinds} · session ${short(r.session)}`,
    `  "${r.text}"`,
  ];
  if (r.source === 'pass') {
    for (const f of ['do', 'not', 'because', 'topic', 'existing']) if (r[f]) lines.push(`  ${f}: ${r[f]}`);
  }
  return lines.join('\n');
}

function pickBlock(p) {
  const labels = (Array.isArray(p.options) ? p.options : []).map(o => o?.label).filter(Boolean);
  const pick = typeof p.pick === 'string' ? `"${clip(oneLine(p.pick), 200)}"` : 'no pick';
  const lines = [
    `${p.id} · ${day(p.at)} · ${p.domain || 'no domain'} · session ${short(p.session)}`,
    `  ${clip(oneLine(p.question), 200)} → ${pick}${labels.length ? ` · of ${clip(labels.join(' | '), 200)}` : ''}`,
  ];
  if (p.notes) lines.push(`  notes: "${clip(oneLine(p.notes), 300)}"`);
  return lines.join('\n');
}

function domainArg(args) {
  if (!args.length) return null;
  if (args.length !== 2 || args[0] !== '--domain' || !args[1]) throw new UsageError();
  return args[1];
}

function showPending(args) {
  const domain = domainArg(args);
  const rows = pendingRows().filter(r => domain === null || r.domain === domain);
  if (!rows.length) return 'Nothing pending.';
  return [...rows.map(block), `${rows.length} pending`].join('\n\n');
}

function showPicks(args) {
  const domain = domainArg(args);
  const rows = pendingRows(pickRows()).filter(p => domain === null || p.domain === domain);
  if (!rows.length) return 'No picks pending.';
  const sessions = new Set(rows.map(p => p.session)).size;
  return [...rows.map(pickBlock), `${plural(rows.length, 'pending pick')} from ${plural(sessions, 'session')}`].join('\n\n');
}

function parseResolve(args) {
  const ids = [];
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--note' || a === '--dismiss') {
      const name = a.slice(2);
      if (name in opts || args[i + 1] === undefined) throw new UsageError();
      opts[name] = args[++i];
    } else if (a.startsWith('--')) {
      throw new UsageError();
    } else {
      ids.push(...a.split(/[\s,]+/).filter(Boolean));
    }
  }
  if (!ids.length || ('note' in opts) === ('dismiss' in opts)) throw new UsageError();
  if ('dismiss' in opts && !opts.dismiss.trim()) throw new UsageError();
  return { ids: [...new Set(ids)], ...opts };
}

function resolve(args) {
  const { ids, note, dismiss } = parseResolve(args);
  const rows = [...inboxRows(), ...pickRows()];
  const known = new Set(rows.map(r => r.id));
  const open = new Set(pendingRows(rows).map(r => r.id));
  const problems = [];
  for (const id of ids) {
    if (!known.has(id)) problems.push(`${id}: no capture or pick has this id.`);
    else if (!open.has(id)) problems.push(`${id}: already resolved.`);
  }
  if (note !== undefined) {
    if (!KEY_RE.test(note)) problems.push(`${note}: use <domain>/<slug>, like roblox-ui/strict-mode.`);
    else if (!readNote(note)) problems.push(`${note}: no note at wiki/${note}.md.`);
  }
  if (problems.length) throw new Refused(`${problems.join('\n')}\nNothing recorded.`);

  const at = new Date().toISOString();
  const list = ids.join(', ');
  let line;
  if (note !== undefined) {
    appendJsonl(decisionsFile(), [{ at, ids, action: 'note', note }]);
    line = `linked ${list} to ${note}`;
  } else {
    const reason = dismiss.trim();
    appendJsonl(decisionsFile(), [{ at, ids, action: 'dismiss', reason }]);
    line = `dismissed ${list} (${reason.replace(/\s+/g, ' ')})`;
  }
  appendLog([`review: ${line}`]);
  return `Recorded: ${line}.`;
}

function readLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

function changed() {
  const out = [];
  for (const [key, r] of Object.entries(readLedger().rules).sort(byKey)) {
    const n = readNote(key);
    if (!n) out.push(`- ${key}: confirmed, but wiki/${key}.md is missing`, `  confirmed: ${r.text}`);
    else if (noteHash(n) !== r.hash) out.push(`- ${key}`, `  confirmed: ${r.text}`, `  current: ${ruleText(n)}`);
  }
  return out.length ? out : ['none'];
}

function provisional() {
  const out = loadNotes()
    .filter(n => n.type === 'rule' && n.status === 'provisional')
    .map(n => `- ${n.key}: Do: ${clip(n.do || '(missing)', 100)}`);
  return out.length ? out : ['none'];
}

function fate(key, { rules, retired }) {
  if (rules[key]) return ', confirmed';
  if (retired[key]) return ', confirmed, then retired';
  return readNote(key)?.status === 'outdated' ? ', dropped' : '';
}

function repeats() {
  const ledger = readLedger();
  const out = proposalRows().filter(r => Array.isArray(r.repeats)).flatMap(r => {
    const then = fate(r.note, ledger);
    return r.repeats.map(k => {
      const how = Array.isArray(r.delivered) && r.delivered.includes(k) ? 'reached the agent' : 'never reached the agent';
      return `- ${k}: repeated by ${r.note} on ${day(r.at)} (${how}${then})`;
    });
  });
  return out.length ? out : ['none'];
}

function lintLine() {
  try {
    return `Lint: ${tally(lint())}`;
  } catch (e) {
    return `Lint: failed: ${e.message}`;
  }
}

function hookHealth() {
  const out = [];
  const errorsFile = vaultPath('.state', 'errors.log');
  const errors = (readLines(errorsFile) ?? []).filter(l => ISO.test(l));
  if (errors.length) out.push(`${plural(errors.length, 'hook error')} in ${toPosix(errorsFile)}`, `  newest: ${clip(errors.at(-1), 300)}`);
  else out.push('No hook errors.');
  const pass = lastPass();
  if (!pass) out.push('No passes yet.');
  else if (pass.failed === undefined) out.push(`Last pass: succeeded at ${clock(new Date(pass.at))} · ${pass.kept} · session ${short(pass.id)}`);
  else out.push(
    `Last pass: failed at ${clock(new Date(pass.at))} · session ${short(pass.id)}`,
    `  reason: ${clip(pass.failed, 300)}`,
    `  rerun: node tools/session-pass.mjs ${pass.id}`,
  );
  return out;
}

function status() {
  return [
    'Changed since confirmed', ...changed(),
    '', 'Provisional rules', ...provisional(),
    '', 'Repeats of confirmed rules', ...repeats(),
    '', `Pending captures: ${pendingRows().length}`,
    `Pending picks: ${pendingRows(pickRows()).length}`,
    lintLine(),
    '', 'Hook health', ...hookHealth(),
  ].join('\n');
}

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (cmd === 'pending') console.log(showPending(rest));
  else if (cmd === 'picks') console.log(showPicks(rest));
  else if (cmd === 'resolve') console.log(resolve(rest));
  else if (cmd === 'status' && !rest.length) console.log(status());
  else throw new UsageError();
} catch (e) {
  if (e instanceof UsageError) {
    console.error(USAGE);
    process.exitCode = 2;
  } else if (e instanceof Refused) {
    console.error(e.message);
    process.exitCode = 1;
  } else {
    console.error(`review failed: ${e.message}`);
    process.exitCode = 1;
  }
}
