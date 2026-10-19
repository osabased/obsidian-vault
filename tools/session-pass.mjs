import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { config, statePath, readJsonSafe, writeJson, appendJsonl, appendLine, inboxRows, inboxFile, pickRows, picksFile, plural, tryLock, unlock } from './lib/vault.mjs';
import { registry, passFiles, lockStaleMs } from './lib/sessions.mjs';
import { loadNotes, clip, domainTitle } from './lib/rules.mjs';
import { stripInjected, normText } from './lib/capture.mjs';
import { parseCommands } from './lib/commands.mjs';

const MAX_CHUNKS = 4;
const SKIPPED_ENTRY = ['isMeta', 'isSidechain', 'isCompactSummary', 'isVisibleInTranscriptOnly'];
const NOT_TYPED = ['<', '[Request interrupted by user', 'This session is being continued', 'Caveat:'];

const SCHEMA = {
  type: 'object',
  required: ['candidates'],
  additionalProperties: false,
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        required: ['quote', 'kind', 'do', 'not', 'because', 'topic', 'existing'],
        additionalProperties: false,
        properties: {
          quote: { type: 'string' },
          kind: { type: 'string', enum: ['preference', 'correction', 'choice'] },
          do: { type: 'string' },
          not: { type: 'string' },
          because: { type: 'string' },
          topic: { type: 'string' },
          existing: { type: 'string' },
        },
      },
    },
  },
};

const oneLine = s => String(s ?? '').replace(/\s+/g, ' ').trim();

function agentText(text) {
  const t = oneLine(text);
  return t.length > 600 ? `…${t.slice(-600)}` : t;
}

function typed(text) {
  const t = stripInjected(text);
  if (!t || NOT_TYPED.some(p => t.startsWith(p)) || parseCommands(t)) return null;
  const plain = t.replace(/```[\s\S]*?(?:```|$)/g, '[code]');
  const lines = plain.split(/\r?\n/).map(l => l.trim()).filter(l => l && l !== '[code]').map(l => `[USER] ${clip(l, 2000)}`);
  return lines.length ? { lines, said: [plain] } : null;
}

const isUnmarkedOrHuman = v => v == null || v === 'human';

// Briefs from other sessions, task notifications and peer messages are user entries too, told apart only
// by turnOrigin and origin. An entry with neither still counts, so a transcript written without them
// doesn't silence the pass.
const userWords = e => isUnmarkedOrHuman(e.turnOrigin) && isUnmarkedOrHuman(e.origin?.kind);

// A message the user sends mid-turn is a queued_command attachment, not a user entry. One without an
// origin can be another session's report, so only an explicit human origin counts.
const queuedPrompt = e => {
  const a = e.type === 'attachment' ? e.attachment : null;
  return a?.type === 'queued_command' && a.origin?.kind === 'human' && typeof a.prompt === 'string' ? a.prompt : null;
};

// Answers to questions come back in tool results and are the user's whoever started the turn.
const userBlocks = (e, blocks) => {
  const prompt = queuedPrompt(e);
  if (prompt !== null) return [{ type: 'text', text: prompt }];
  if (e.type !== 'user') return [];
  return userWords(e) ? blocks : blocks.filter(b => b?.type === 'tool_result');
};

const firstFilled = (...lists) => lists.find(l => Array.isArray(l) && l.length) ?? [];

const filled = s => (typeof s === 'string' && s.trim() ? s : null);

function answersIn(block, result, asks) {
  const { answers } = result;
  const specs = firstFilled(asks.get(block.tool_use_id), result.questions, Object.keys(answers).map(question => ({ question })));
  return specs.flatMap(spec => {
    const question = spec?.question;
    if (typeof question !== 'string' || !(question in answers)) return [];
    const raw = answers[question];
    const answer = filled(Array.isArray(raw) ? raw.join(', ') : raw == null ? '' : String(raw));
    const pick = answer && !answer.trim().startsWith('[User did not answer') ? answer : null;
    const notes = filled(result.annotations?.[question]?.notes);
    return pick || notes ? [{ spec, question, pick, notes }] : [];
  });
}

function answered(block, result, asks) {
  const lines = [];
  const said = [];
  for (const { spec, question, pick, notes } of answersIn(block, result, asks)) {
    const labels = (spec.options ?? []).map(o => o?.label).filter(Boolean);
    lines.push(`[QUESTION] ${oneLine(question)}${labels.length ? ` Options: ${labels.join(' | ')}` : ''}`);
    for (const [tag, text] of [['ANSWER', pick], ['NOTES', notes]]) {
      if (!text) continue;
      lines.push(`[${tag}] ${oneLine(text)}`);
      said.push(oneLine(text));
    }
  }
  return { lines, said };
}

function* entries(buf) {
  let pos = 0;
  while (pos < buf.length) {
    const nl = buf.indexOf(10, pos);
    const stop = nl < 0 ? buf.length : nl;
    const text = buf.toString('utf8', pos, stop);
    pos = stop + 1;
    let e;
    try { e = JSON.parse(text); } catch { continue; }
    if (!e || typeof e !== 'object' || SKIPPED_ENTRY.some(f => e[f])) continue;
    const content = e.message?.content;
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
    yield { e, blocks, pos };
  }
}

const askedIn = (blocks, asks) => {
  for (const b of blocks) if (b?.type === 'tool_use' && b.name === 'AskUserQuestion') asks.set(b.id, b.input?.questions);
};

function picksIn(buf, entry) {
  const rows = [];
  const asks = new Map();
  for (const { e, blocks } of entries(buf)) {
    if (e.type === 'assistant') askedIn(blocks, asks);
    if (e.type !== 'user' || !e.toolUseResult?.answers) continue;
    const stamp = new Date(e.timestamp ?? NaN);
    const at = Number.isNaN(stamp.getTime()) ? new Date().toISOString() : stamp.toISOString();
    for (const b of blocks) {
      if (b?.type !== 'tool_result') continue;
      for (const { spec, question, pick, notes } of answersIn(b, e.toolUseResult, asks)) {
        rows.push({
          id: `q-${crypto.randomBytes(4).toString('hex')}`, at, source: 'pass',
          session: entry.session, transcript: entry.transcript, cwd: entry.cwd, domain: entry.domain,
          tool_use_id: b.tool_use_id ?? null, question, header: spec.header ?? null,
          options: Array.isArray(spec.options) ? spec.options : [], multiSelect: spec.multiSelect === true, pick, notes,
        });
      }
    }
  }
  return rows;
}

const pickKey = p => JSON.stringify([p.session, p.tool_use_id, p.question]);

// Picks come from the whole transcript each time, so a failed model call, the chunk limit, or a
// session passed before picks were logged never loses one.
function logPicks(entry) {
  const buf = readNew(entry.transcript, 0)?.buf;
  if (!buf?.length) return 0;
  const logged = new Set(pickRows().filter(p => p.session === entry.session).map(pickKey));
  const rows = picksIn(buf, entry).filter(p => !logged.has(pickKey(p)) && logged.add(pickKey(p)));
  appendJsonl(picksFile(), rows);
  return rows.length;
}

function render(buf, start, agent) {
  const items = [];
  const asks = new Map();
  let lastAgent = agent;
  for (const { e, blocks, pos } of entries(buf)) {
    if (e.type === 'assistant') {
      for (const b of blocks) if (b?.type === 'text' && oneLine(b.text)) lastAgent = agentText(b.text);
      askedIn(blocks, asks);
      continue;
    }
    const lines = [];
    const said = [];
    for (const b of userBlocks(e, blocks)) {
      let got = null;
      if (b?.type === 'text') got = typed(b.text);
      else if (b?.type === 'tool_result' && e.toolUseResult?.answers) got = answered(b, e.toolUseResult, asks);
      if (!got) continue;
      lines.push(...got.lines);
      said.push(...got.said);
    }
    if (!lines.length) continue;
    if (lastAgent) {
      lines.unshift(`[AGENT] ${lastAgent}`);
      lastAgent = '';
    }
    items.push({ lines, said, end: start + pos });
  }
  return { items, end: start + buf.length, agent: lastAgent };
}

function pack(items, max) {
  const chunks = [];
  let cur = null;
  for (const item of items) {
    const size = item.lines.join('\n').length;
    if (size > max) {
      chunks.push({ lines: clip(item.lines.join('\n'), max).split('\n'), said: [...item.said], end: item.end });
      cur = null;
    } else if (cur && cur.size + 1 + size <= max) {
      cur.lines.push(...item.lines);
      cur.said.push(...item.said);
      cur.end = item.end;
      cur.size += 1 + size;
    } else {
      cur = { lines: [...item.lines], said: [...item.said], end: item.end, size };
      chunks.push(cur);
    }
  }
  return chunks;
}

// The pass outlives the session that started it, so its claude runs on its own login. It drops the variables
// a session hands its children, such as host-managed auth and the desktop app's messaging socket.
const childEnv = () => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|AI_AGENT$|BAGGAGE$)/i.test(k))),
  AGENT_TASTE_PASS: '1',
});

function ask(text) {
  const { command, model, effort, timeoutSeconds } = config().pass;
  const [exe, ...prefix] = Array.isArray(command) ? command : [command];
  const name = path.basename(exe);
  const args = [
    ...prefix, '-p', '--safe-mode', '--model', model, '--effort', effort, '--tools', '',
    '--no-session-persistence', '--output-format', 'json', '--json-schema', JSON.stringify(SCHEMA),
  ];
  const r = spawnSync(exe, args, {
    input: text, encoding: 'utf8', cwd: os.tmpdir(), windowsHide: true, timeout: timeoutSeconds * 1000,
    maxBuffer: 16 << 20, env: childEnv(),
  });
  if (r.error) throw r.error;
  let out = null;
  try { out = JSON.parse(r.stdout); } catch {}
  // A failed run still prints its result JSON. Its `result` says why, and its `subtype` can read "success".
  if (r.status !== 0 || out?.is_error) {
    const why = filled(out?.result) ?? (r.stderr || r.stdout);
    throw new Error(`${name} ${r.status !== 0 ? `exited with ${r.status ?? r.signal}` : 'reported an error'}: ${clip(oneLine(why), 300) || 'no output'}`);
  }
  if (!out) throw new Error(`${name} printed no JSON: ${clip(oneLine(r.stdout), 300)}`);
  const candidates = out.structured_output?.candidates;
  if (!Array.isArray(candidates)) throw new Error(`${name} returned no structured_output.candidates`);
  return { candidates, cost: Number(out.total_cost_usd) || 0 };
}

function promptFor(chunk, entry) {
  const domain = config().domains[entry.domain];
  const subject = domain ? domainTitle(entry.domain) : "the user's projects";
  const topics = domain?.topics ?? [];
  const rules = loadNotes()
    .filter(n => n.type === 'rule' && n.do && n.status !== 'outdated' && (n.domain === 'global' || n.domain === entry.domain))
    .map(n => `- ${n.key}: Do: ${clip(n.do, 200)}`);
  return [
    `Read the conversation below between a user and a coding agent and pick out the user's lasting preferences about ${subject}: how they want things built, how things should look and feel, and what to avoid, stated so that they would still hold in a later session.`,
    ...(topics.length ? [`The topics for this domain are ${topics.join(', ')}.`] : []),
    '',
    'Each line of the conversation starts with a tag. USER lines are what the user typed. AGENT lines are the end of the agent\'s message just before, for context only. QUESTION lines are questions the agent asked, with their options; ANSWER lines are what the user picked or wrote; NOTES lines are notes the user added to an answer. Tool output is left out.',
    '',
    'Leave out instructions for the task at hand that say nothing about later work, questions, bare agreement such as "yes" or "go ahead", and anything the agent proposed that the user didn\'t take up.',
    '',
    'For each lasting preference, fill in:',
    '- quote: the user\'s exact words, copied character for character from one USER, ANSWER or NOTES line. Never paraphrase or join pieces of different lines.',
    '- kind: preference for a stated liking, correction when the user pushes back on what the agent did, choice when the user picks between options.',
    '- do: what to do, phrased as a rule.',
    '- not: what to avoid, phrased as a rule.',
    '- because: the reason, only when the user gave one. Never invent a reason; leave it empty otherwise.',
    topics.length ? `- topic: one of ${topics.join(', ')}.` : '- topic: leave it empty.',
    '- existing: the key of a rule below that this restates or contradicts, otherwise empty.',
    '',
    'Rules already in the vault:',
    ...(rules.length ? rules : ['(none yet)']),
    '',
    'Most conversations hold no lasting preferences, so an empty candidates list is the usual answer.',
    '',
    '<conversation>',
    ...chunk.lines,
    '</conversation>',
  ].join('\n');
}

const unquote = s => String(s ?? '').trim().replace(/^["“”]+/, '').replace(/["“”]+$/, '').trim();

function keep(candidates, chunk, seen, entry) {
  const said = normText(chunk.said.join('\n'));
  const at = new Date().toISOString();
  const rows = [];
  for (const c of candidates) {
    const quote = unquote(c?.quote);
    const n = normText(quote);
    if (!n || !said.includes(n) || seen.some(s => s.includes(n) || n.includes(s))) continue;
    seen.push(n);
    rows.push({
      id: `p-${crypto.randomBytes(4).toString('hex')}`, at, source: 'pass', kind: c.kind, text: quote,
      do: c.do, not: c.not, because: c.because, topic: c.topic, existing: c.existing,
      session: entry.session, transcript: entry.transcript, cwd: entry.cwd, domain: entry.domain,
    });
  }
  return rows;
}

function readNew(file, offset) {
  try {
    const size = fs.statSync(file).size;
    const start = size < offset ? 0 : offset;
    const buf = Buffer.alloc(size - start);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, buf.length, start); } finally { fs.closeSync(fd); }
    return { buf: buf.subarray(0, buf.lastIndexOf(10) + 1), start, restarted: start !== offset };
  } catch {
    return null;
  }
}

const passLog = line => appendLine(statePath('passes.log'), `${new Date().toISOString()} ${line}`);

function run(id, entry) {
  const { state } = passFiles(id);
  const prev = readJsonSafe(state) ?? { offset: 0, agent: '' };
  const got = readNew(entry.transcript, prev.offset ?? 0);
  // Without new lines there is nothing to pick up, so the sweep doesn't reread idle transcripts;
  // `picks` marks state written since picks were logged, so older sessions get one full read.
  if (!got || (!got.buf.length && prev.picks)) return 0;
  try {
    const picked = logPicks(entry);
    if (picked) passLog(`${id} logged ${plural(picked, 'pick')}`);
    const save = s => writeJson(state, { ...s, picks: true });
    const { items, end, agent } = render(got.buf, got.start, got.restarted ? '' : prev.agent ?? '');
    if (!items.length) {
      save({ offset: end, agent });
      return 0;
    }
    const chunks = pack(items, config().pass.maxInputChars);
    const seen = inboxRows().filter(r => r.session === entry.session).map(r => normText(r.text ?? '')).filter(Boolean);
    for (const [i, chunk] of chunks.slice(0, MAX_CHUNKS).entries()) {
      const { candidates, cost } = ask(promptFor(chunk, entry));
      const rows = keep(candidates, chunk, seen, entry);
      appendJsonl(inboxFile(), rows);
      const last = i === chunks.length - 1;
      save({ offset: last ? end : chunk.end, agent: last ? agent : '' });
      passLog(`${id} kept ${rows.length} of ${candidates.length} candidates, $${cost.toFixed(4)}`);
    }
    return 0;
  } catch (e) {
    passLog(`${id} failed: ${e.message}`);
    return 1;
  }
}

const id = process.argv[2];
if (process.argv.length !== 3 || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) {
  console.error('usage: node tools/session-pass.mjs <session-id>');
  process.exit(2);
}
const entry = readJsonSafe(registry(id));
if (!entry) {
  console.error(`No session ${id} in .state/sessions/.`);
  process.exit(1);
}
const { lock } = passFiles(id);
if (!tryLock(lock, lockStaleMs())) process.exit(0);
let code = 1;
try {
  code = run(id, entry);
} finally {
  unlock(lock);
}
process.exit(code);
