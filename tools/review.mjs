import fs from 'node:fs';
import { vaultPath, proposalRows, plural, today, toPosix } from './lib/vault.mjs';
import { readNote, readLedger, noteHash, ruleText, loadNotes, clip, byKey } from './lib/rules.mjs';
import { lint, tally } from './lib/lint.mjs';

const USAGE = 'usage: node tools/review.mjs status';

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

class UsageError extends Error {}

const day = iso => {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? 'no date' : today(at);
};

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
  const file = vaultPath('.state', 'errors.log');
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const errors = text.split(/\r?\n/).filter(l => ISO.test(l));
  return errors.length ? [`${plural(errors.length, 'hook error')} in ${toPosix(file)}`, `  newest: ${clip(errors.at(-1), 300)}`] : ['No hook errors.'];
}

function status() {
  return [
    'Changed since confirmed', ...changed(),
    '', 'Provisional rules', ...provisional(),
    '', 'Repeats of confirmed rules', ...repeats(),
    '', lintLine(),
    '', 'Hook health', ...hookHealth(),
  ].join('\n');
}

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (cmd === 'status' && !rest.length) console.log(status());
  else throw new UsageError();
} catch (e) {
  if (e instanceof UsageError) {
    console.error(USAGE);
    process.exitCode = 2;
  } else {
    console.error(`review failed: ${e.message}`);
    process.exitCode = 1;
  }
}
