import fs from 'node:fs';
import { setKey } from './frontmatter.mjs';
import { stripInjected } from './capture.mjs';
import { KEY_RE, toKey, parseNote, noteErrors, noteHash, ruleText, readLedger, writeLedger, build } from './rules.mjs';
import { config, vaultPath, writeText, appendLog, statePath, withLock } from './vault.mjs';

export function parseCommands(prompt) {
  const lines = stripInjected(prompt).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const cmds = [];
  for (const line of lines) {
    const m = line.match(/^(confirm|retire):\s*(.+)$/i);
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
  if (n && n.status !== 'outdated') {
    ctx.ws.set(key, 'status', 'outdated');
    ctx.log.push(`marked ${key} outdated`);
    return `Marked ${key} outdated. It wasn't confirmed, so nothing changes in sessions.`;
  }
  return n ? `Not retired: ${key} is already outdated.` : `Not retired: ${key} has no note and isn't confirmed.`;
}

export function runCommands(cmds, input) {
  return withLock(statePath('ledger.lock'), () => {
    const session = String(input.session_id ?? '');
    const ctx = { ledger: readLedger(), ws: workspace(), changed: false, log: [], now: new Date().toISOString(), session };
    const replies = cmds.map(c => (c.op === 'confirm' ? confirm : retire)(c.key, ctx));
    // The ledger is what the hooks enforce, so it goes first; a note that fails to save only shows up as a lint warning.
    if (ctx.changed) writeLedger(ctx.ledger);
    const saved = ctx.ws.save();
    if (ctx.changed || saved) build();
    if (ctx.log.length) appendLog(ctx.log.map(l => (session ? `${l} · session ${session.slice(0, 8)}` : l)));
    return replies.join('\n');
  });
}
