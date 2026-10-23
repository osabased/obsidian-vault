import fs from 'node:fs';
import { setKey } from './frontmatter.mjs';
import { stripInjected, typedMessages } from './transcript.mjs';
import { KEY_RE, toKey, parseNote, noteErrors, replaceProblem, noteHash, ruleText, readLedger, readNote, writeLedger, build } from './rules.mjs';
import { config, vaultPath, writeText, appendLog, statePath, withLock, proposalRows } from './vault.mjs';

const BARE = /^(?:(`?)(confirm|drop)\1[.!]?|(confirm|drop):)$/i;
const NOT_TYPED_YET = "Not recorded: the taste hooks take confirm:, retire: and drop: only in a session where you've already typed a message. Send any message, then type it again.";

export function parseCommands(prompt) {
  const lines = stripInjected(prompt).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const bare = lines.length === 1 ? lines[0].match(BARE) : null;
  if (bare) return [{ op: (bare[2] ?? bare[3]).toLowerCase(), key: null }];
  const cmds = [];
  for (const line of lines) {
    const m = line.match(/^(confirm|retire|drop):\s*(.+)$/i);
    if (!m) return null;
    for (const ref of m[2].split(',')) if (ref.trim()) cmds.push({ op: m[1].toLowerCase(), key: toKey(ref) });
  }
  return cmds.length ? cmds : null;
}

function workspace() {
  const cache = new Map();
  const file = key => `${vaultPath('wiki', ...key.split('/'))}.md`;
  const load = key => {
    if (!cache.has(key)) {
      let text = null;
      if (KEY_RE.test(key)) {
        try { text = fs.readFileSync(file(key), 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      }
      cache.set(key, { before: text, text });
    }
    return cache.get(key);
  };
  return {
    get(key) {
      const { text } = load(key);
      return text === null ? null : parseNote(text, `wiki/${key}.md`);
    },
    set(key, name, value) {
      const c = load(key);
      if (c.text !== null) c.text = setKey(c.text, name, value);
    },
    save() {
      let wrote = false;
      for (const [key, c] of cache) {
        if (c.text === c.before) continue;
        writeText(file(key), c.text);
        wrote = true;
      }
      return wrote;
    },
  };
}

function delivery(n) {
  const where = n.domain === 'global' ? 'every session' : `${n.domain} sessions`;
  const edit = n.applies_to.length > 0;
  if (edit && n.always) return `Enforced from your next edit, and loaded into ${where}.`;
  if (edit) return 'Enforced from your next edit.';
  if (n.always) return `Loaded into ${where} from their next prompt.`;
  if (n.keywords.length) return `Shown when a prompt mentions ${n.keywords.length === 1 ? 'its keyword' : 'one of its keywords'}.`;
  return 'It has no applies_to, keywords or always: true, so nothing delivers it yet.';
}

function problem(n, ctx) {
  if (!n.ok) return 'it has no frontmatter';
  if (n.type !== 'rule') return 'its type is not rule';
  if (n.status === 'outdated') return 'the note is marked outdated (set its status to provisional to confirm it again)';
  if (n.domain !== 'global' && !config().domains[n.domain]) return `${n.domain} isn't a domain in taste.config.json`;
  const [err] = noteErrors(n);
  if (err) return err;
  for (const t of n.replaces) {
    if (t === n.key) return 'it replaces itself';
    if (!ctx.ws.get(t) && !ctx.ledger.rules[t] && !ctx.ledger.retired[t]) return `it replaces ${t}, which has no note`;
    const wrong = replaceProblem(n, t);
    if (wrong) return wrong;
  }
  return null;
}

function replace(t, key, ctx) {
  const old = ctx.ws.get(t);
  if (old) {
    ctx.ws.set(t, 'status', 'outdated');
    ctx.ws.set(t, 'superseded_by', `[[wiki/${key}|${key.split('/')[1]}]]`);
  }
  if (ctx.ledger.rules[t]) {
    delete ctx.ledger.rules[t];
    ctx.ledger.retired[t] = { retired_at: ctx.now, superseded_by: key };
    ctx.changed = true;
    ctx.log.push(`retired ${t}, replaced by ${key}`);
    return `Retired ${t}. Replaced by ${key}.`;
  }
  if (old && old.status !== 'outdated') {
    ctx.log.push(`marked ${t} outdated, replaced by ${key}`);
    return `Marked ${t} outdated. Replaced by ${key}.`;
  }
  return '';
}

function confirm(key, ctx) {
  if (!KEY_RE.test(key)) return `Not confirmed: ${key} — use <domain>/<slug>, like roblox-ui/strict-mode.`;
  const n = ctx.ws.get(key);
  if (!n) return `Not confirmed: ${key} — no note at wiki/${key}.md.`;
  const why = problem(n, ctx);
  if (why) return `Not confirmed: ${key} — ${why}.`;
  const hash = noteHash(n);
  const prev = ctx.ledger.rules[key];
  if (n.status !== 'confirmed') ctx.ws.set(key, 'status', 'confirmed');
  if (prev?.hash === hash) return `Already confirmed: ${key}, with this wording. Nothing changed.`;
  ctx.ledger.rules[key] = {
    domain: n.domain, slug: n.slug, text: ruleText(n),
    applies_to: n.applies_to, triggers: n.triggers, keywords: n.keywords, always: n.always,
    ...(n.kind === 'knowledge' ? { as_of: n.as_of } : {}),
    hash, confirmed_at: ctx.now, session: ctx.session,
  };
  delete ctx.ledger.retired[key];
  ctx.changed = true;
  ctx.log.push(`${prev ? 're-confirmed' : 'confirmed'} ${key}`);
  const head = prev ? `Re-confirmed ${key} with its current wording. ${delivery(n)}` : `Confirmed ${key}. ${delivery(n)}`;
  return [head, ...n.replaces.map(t => replace(t, key, ctx)).filter(Boolean)].join('\n');
}

function retire(key, ctx) {
  if (!KEY_RE.test(key)) return `Not retired: ${key} — use <domain>/<slug>, like roblox-ui/strict-mode.`;
  const n = ctx.ws.get(key);
  if (ctx.ledger.rules[key]) {
    delete ctx.ledger.rules[key];
    ctx.ledger.retired[key] = { retired_at: ctx.now, superseded_by: null };
    ctx.changed = true;
    if (n) ctx.ws.set(key, 'status', 'outdated');
    ctx.log.push(`retired ${key}`);
    return `Retired ${key}. No longer enforced.`;
  }
  if (n && n.type !== 'rule') return `Not retired: ${key} — its type is not rule.`;
  if (n && n.status !== 'outdated') {
    ctx.ws.set(key, 'status', 'outdated');
    ctx.log.push(`marked ${key} outdated`);
    return `Marked ${key} outdated. It wasn't confirmed, so nothing changes in sessions.`;
  }
  return n ? `Not retired: ${key} is already outdated.` : `Not retired: ${key} has no note and isn't confirmed.`;
}

function drop(key, ctx) {
  if (!KEY_RE.test(key)) return `Not dropped: ${key} — use <domain>/<slug>, like roblox-ui/strict-mode.`;
  const n = ctx.ws.get(key);
  if (!n) return `Not dropped: ${key} — no note at wiki/${key}.md.`;
  if (n.type !== 'rule') return `Not dropped: ${key} — its type is not rule.`;
  if (ctx.ledger.rules[key]) return `Not dropped: ${key} is confirmed. Type retire: ${key} to stop enforcing it.`;
  if (n.status === 'outdated') return `Not dropped: ${key} is already outdated.`;
  ctx.ws.set(key, 'status', 'outdated');
  ctx.log.push(`dropped ${key}`);
  return `Dropped ${key}. Its note stays in the vault, marked outdated, so it isn't offered again.`;
}

const OPS = { confirm, retire, drop };

// A bare confirm or drop answers a proposal made since the user's last message; older ones need their key.
function fresh(session, typed) {
  const since = typed.at(-1).at;
  const keys = new Set(proposalRows().filter(r => r.session === session && r.at > since).map(r => r.note));
  return [...keys].filter(k => readNote(k)?.status === 'provisional');
}

function resolveBare(op, session, typed) {
  const keys = typed.length ? fresh(session, typed) : [];
  if (keys.length > 1) return `Not recorded: ${keys.join(', ')} were all proposed since your last message. Type ${op}: with the ones you mean.`;
  return keys.length ? [{ op, key: keys[0] }] : null;
}

export function runCommands(parsed, input) {
  const session = String(input.session_id ?? '');
  const typed = typedMessages(input.transcript_path);
  const cmds = parsed[0].key === null ? resolveBare(parsed[0].op, session, typed) : typed.length ? parsed : NOT_TYPED_YET;
  if (!Array.isArray(cmds)) return cmds;
  return withLock(statePath('ledger.lock'), () => {
    const ctx = { ledger: readLedger(), ws: workspace(), changed: false, log: [], now: new Date().toISOString(), session };
    const replies = cmds.map(c => OPS[c.op](c.key, ctx));
    // The ledger is what the hooks enforce, so it goes first; a note that fails to save only shows up as a lint warning.
    if (ctx.changed) writeLedger(ctx.ledger);
    const saved = ctx.ws.save();
    if (ctx.changed || saved) build();
    if (ctx.log.length) appendLog(ctx.log.map(l => (session ? `${l} · session ${session.slice(0, 8)}` : l)));
    return replies.join('\n');
  });
}
