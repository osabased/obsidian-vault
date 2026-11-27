import fs from 'node:fs';
import path from 'node:path';
import { config, vaultPath, writeText, today, plural, toPosix, shortHash, removeDir } from './lib/vault.mjs';
import { isUrl, normUrl, cmp, readDerived, parsedFile } from './lib/rules.mjs';
import { yamlQuote } from './lib/frontmatter.mjs';
import { sourceChains, copyStem, sourceProblems, sha256 } from './lib/sources.mjs';
import { clone, hasOrigin, fetchOrigin, hasCommit, remoteHead, lastChange, sizeAt, showAt } from './lib/git.mjs';
import { build } from './lib/build.mjs';
import { htmlText } from './lib/quotes.mjs';

const USAGE = 'usage: node tools/refresh.mjs';
// Set in main, so a config that can't be read fails the run as any other error does.
let timeoutSeconds, maxBytes, timeout;

// A failed check: its reason is recorded, and nothing is written under raw/.
class Failed extends Error {}

// Line ends as parse() reads a saved file's body, with no \r left before a \n, so the sha256 of the text is the one
// lint checks.
function asText(bytes) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new Failed("body isn't UTF-8 text"); }
  return text.replace(/\r+\n/g, '\n');
}

async function readCapped(body) {
  const chunks = [];
  let size = 0;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Failed(`body over ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

// Redirects aren't followed, so a moved source is saved again under its new URL.
async function fetchText(url, { etag, lastModified }) {
  try {
    const res = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeout),
      headers: { ...(etag ? { 'If-None-Match': etag } : {}), ...(lastModified ? { 'If-Modified-Since': lastModified } : {}) },
    });
    if (res.status === 304) {
      await res.body?.cancel().catch(() => {});
      return { status: 304 };
    }
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => {});
      const location = res.headers.get('location');
      throw new Failed(location
        ? `redirected to ${URL.parse(location, url)?.href ?? location}. If that is the same page, save it again from there as a new file in raw/refs/`
        : 'redirected to (no Location)');
    }
    if (res.status < 200 || res.status >= 300) {
      await res.body?.cancel().catch(() => {});
      throw new Failed(`HTTP ${res.status}`);
    }
    const bytes = res.body ? await readCapped(res.body) : Buffer.alloc(0);
    return { status: res.status, text: asText(bytes), etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified') };
  } catch (e) {
    if (e instanceof Failed) throw e;
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw new Failed(`no answer in ${timeoutSeconds} s`);
    const code = e?.cause?.code ?? e?.cause?.errors?.[0]?.code ?? e?.cause?.message ?? e?.message;
    throw new Failed(`fetch failed: ${code}`);
  }
}

// A clone per repo, named so two repos called alike don't share a folder.
const cloneDir = repo => {
  const name = String(repo).replace(/[\\/]+$/, '').split(/[\\/:]/).at(-1).replace(/\.git$/i, '').replace(/[^\w.-]/g, '-') || 'repo';
  return vaultPath('.sources', `${name}-${shortHash(repo).slice(0, 8)}`);
};

// A web page served again with new cache-busting query strings, Cloudflare ray IDs or hashed bundle names reads the
// same, and a copy of it would mark every note citing it unverified for nothing. Only HTML is read this way: stripping
// tags from Markdown or plain text would hide a real change such as Vec<String> to Vec<u8>.
const isHtml = text => /^\s*<(?:!doctype html|html)[\s>]/i.test(text);
const visibleText = html => htmlText(html).replace(/\s+/g, ' ').trim();
const sameVisibleText = (a, b) => isHtml(a) && isHtml(b) && visibleText(a) === visibleText(b);

const linksIn = (text, base) => new Set([...text.matchAll(/\]\(\s*<?([^)\s>]+)|(?<![(<\w])(https?:\/\/[^\s)>\]]+)/g)].flatMap(m => {
  try { return [normUrl(new URL(m[1] ?? m[2], base).href)]; } catch { return []; }
}));

function frontmatter(fields) {
  const line = ([k, v]) => `${k}: ${typeof v === 'string' && !/^\d{4}-\d\d-\d\d$/.test(v) ? yamlQuote(v) : v}`;
  return `---\n${Object.entries(fields).filter(([, v]) => v !== null && v !== undefined).map(line).join('\n')}\n---\n`;
}

// A copy goes next to the one it replaces, as <stem>.<8 hex><ext>, with -2, -3 when a body comes back to an earlier
// version whose name is taken.
function copyName(prev, hash, ext) {
  const dir = path.posix.dirname(prev);
  const stem = `${dir}/${copyStem(prev)}.${hash.slice(0, 8)}`;
  for (let i = 1; ; i++) {
    const rel = `${stem}${i === 1 ? '' : `-${i}`}${ext}`;
    if (!fs.existsSync(vaultPath(...rel.split('/')))) return rel;
  }
}

async function checkUrl(id, chain, chains, was, { data, body }) {
  const latest = chain.at(-1);
  // A stored etag belongs to the copy that was latest when it came, so a copy saved since then sends its own.
  const stored = was?.chain?.at(-1) === latest && (was.etag || was.lastModified);
  const sent = stored ? { etag: was.etag, lastModified: was.lastModified } : { etag: data.etag, lastModified: data.last_modified };
  const got = await fetchText(data.url, { etag: typeof sent.etag === 'string' ? sent.etag : null, lastModified: typeof sent.lastModified === 'string' ? sent.lastModified : null });
  if (got.status === 304) return { result: 'unchanged', note: ' (304)', etag: sent.etag ?? null, lastModified: sent.lastModified ?? null };
  const hash = sha256(got.text);
  const headers = { etag: got.etag, lastModified: got.lastModified };
  if (data.sha256 && hash === data.sha256) return { result: 'unchanged', ...headers };
  const manifest = chains.files.get(latest).manifest;
  if (data.sha256 && !manifest && sameVisibleText(got.text, body)) return { result: 'unchanged', note: ' (same text)', ...headers };
  const result = data.sha256 ? 'changed' : 'baseline';
  const ext = manifest ? path.posix.extname(latest) : '.md';
  const copy = {
    after: latest, hash, ext,
    text: got.text,
    fields: {
      url: data.url, fetched: today(), etag: got.etag, last_modified: got.lastModified, sha256: hash, replaces: latest, ...(result === 'baseline' ? { baseline: true } : {}),
    },
  };
  let detail = '';
  if (manifest) {
    const before = linksIn(body, data.url);
    const now = linksIn(got.text, data.url);
    const added = [...now].filter(u => !before.has(u)).length;
    const removed = [...before].filter(u => !now.has(u)).length;
    const pages = new Set([...chains.files.values()].filter(e => e.set === id && !e.manifest && isUrl(e.data.url) && !now.has(normUrl(e.data.url))).map(e => e.id));
    const gone = [...pages].map(p => chains.chains.get(p).at(-1).slice(id.length + 1)).sort(cmp);
    detail = `, ${plural(added, 'link')} added, ${removed} removed${gone.length ? `; cited pages no longer listed: ${gone.join(', ')}` : ''}`;
  }
  return { result, copy, detail, ...headers };
}

// Each clone is cloned or fetched once a run, however many of its repo's paths the sources cite: null once it is ready,
// or the error it failed with.
const synced = new Map();
function syncClone(repo) {
  const dir = cloneDir(repo);
  if (!synced.has(dir)) {
    try {
      if (hasOrigin(dir, { timeout })) fetchOrigin(dir, { timeout });
      else {
        try { removeDir(dir); } catch (e) { throw new Failed(`can't remove ${toPosix(dir)}: ${e.code ?? e.message}`); }
        clone(repo, toPosix(dir), { timeout });
      }
      if (!remoteHead(dir, { timeout })) throw new Failed('remote has no default branch');
      synced.set(dir, null);
    } catch (e) {
      synced.set(dir, e);
    }
  }
  if (synced.get(dir)) throw synced.get(dir);
  return dir;
}

function checkGit(chain, { data, body }) {
  const latest = chain.at(-1);
  const problems = sourceProblems(data, { body });
  if (problems.length) throw new Failed(`${latest}: ${problems.join('; ')}`);
  const repo = String(data.repo);
  const dir = syncClone(repo);
  if (!hasCommit(dir, data.commit, { timeout })) throw new Failed(`commit ${data.commit} isn't in ${repo}`);
  const change = lastChange(dir, data.commit, data.path, { timeout });
  if (!change) return { result: 'unchanged' };
  const newest = change.commit;
  const size = sizeAt(dir, newest, data.path, { timeout });
  if (size === null) throw new Failed(`${data.path} is gone at ${newest.slice(0, 8)}`);
  if (size > maxBytes) throw new Failed(`body over ${maxBytes} bytes`);
  const text = asText(showAt(dir, newest, data.path, { timeout }));
  // A change reverted upstream leaves the text the latest copy holds, and a copy of it would mark its notes for nothing.
  if (text === body) return { result: 'unchanged', note: ` (same text at ${newest.slice(0, 8)})` };
  return {
    result: 'changed',
    copy: { after: latest, hash: newest, ext: '.md', text, fields: { repo, path: data.path, commit: newest, fetched: today(), replaces: latest } },
  };
}

async function check(id, chain, chains, was, copy) {
  try {
    return isUrl(copy.data.url) ? await checkUrl(id, chain, chains, was, copy) : checkGit(chain, copy);
  } catch (e) {
    if (e instanceof Failed || /^(?:git |no answer in )/.test(e.message)) return { result: 'failed', why: e.message };
    throw e;
  }
}

// Fetches run a few at a time, so a vault offline doesn't wait out each timeout in turn.
async function inPool(items, n, f) {
  const out = Array.from({ length: items.length });
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await f(items[i]);
    }
  }));
  return out;
}

async function main() {
  ({ timeoutSeconds, maxBytes } = config().refresh);
  timeout = timeoutSeconds * 1000;
  const chains = sourceChains();
  const before = readDerived() ?? {};
  const ids = [...chains.chains.keys()].sort(cmp);
  // The chains hold each copy's frontmatter from a cache that doesn't open the file while its size and mtime hold, so the
  // latest copy of each source is read here, once, for the frontmatter and the text its check goes by.
  const latestOf = id => chains.chains.get(id).at(-1);
  const copies = new Map(ids.map(id => [id, parsedFile(latestOf(id))]));
  const unreadable = [...chains.unreadable, ...ids.filter(id => !copies.get(id)).map(latestOf)];
  if (unreadable.length) throw new Error(`can't read ${unreadable.join(', ')}`);
  const isGit = id => !isUrl(copies.get(id).data.url);
  const results = new Map();
  for (const id of ids.filter(isGit)) results.set(id, await check(id, chains.chains.get(id), chains, before.sources?.[id], copies.get(id)));
  const urls = ids.filter(id => !isGit(id));
  (await inPool(urls, 8, id => check(id, chains.chains.get(id), chains, before.sources?.[id], copies.get(id)))).forEach((r, i) => results.set(urls[i], r));

  const day = today();
  // The copies are written under build.lock, where their names are taken, and before build reads raw/refs/ for the chains.
  // A copy another refresh or an /ingest saved since the check read the chain would fork it, so the chain is read again
  // there, and a check whose copy no longer follows the latest one isn't saved.
  build({
    apply: derived => {
      const sources = { ...derived.sources };
      const now = [...results.values()].some(r => r.copy) ? sourceChains() : chains;
      for (let [id, r] of results) {
        const w = sources[id] ?? {};
        const latest = now.chains.get(id)?.at(-1);
        if (r.copy && latest !== r.copy.after) {
          const same = latest && [now.files.get(latest).data.sha256, now.files.get(latest).data.commit].includes(r.copy.hash);
          r = same
            ? { result: 'unchanged', ...('etag' in r ? { etag: r.etag, lastModified: r.lastModified } : {}) }
            : { result: 'failed', why: `${latest ?? r.copy.after} changed while this check ran` };
          results.set(id, r);
        }
        if (r.copy) {
          r.copy.rel = copyName(r.copy.after, r.copy.hash, r.copy.ext);
          writeText(vaultPath(...r.copy.rel.split('/')), `${frontmatter(r.copy.fields)}${r.copy.text}`);
        }
        sources[id] = r.result === 'failed'
          ? { ...w, result: 'failed', why: r.why }
          : { ...w, checked: day, result: r.result, why: null, ...('etag' in r ? { etag: r.etag ?? null, lastModified: r.lastModified ?? null } : {}) };
      }
      return { ...derived, sources };
    },
  });
  const after = readDerived() ?? {};
  const tally = { unchanged: 0, changed: 0, baseline: 0, failed: 0 };
  const lines = ids.map(id => {
    const r = results.get(id);
    tally[r.result]++;
    if (r.result === 'failed') return `failed ${id}: ${r.why}`;
    if (!r.copy) return `unchanged ${id}${r.note ?? ''}`;
    const shown = chains.files.get(r.copy.after).manifest ? r.copy.rel.slice(id.length + 1) : r.copy.rel;
    return `${r.result} ${id}: ${shown}${r.detail ?? ''}`;
  });
  const unverified = Object.keys(after.unverified ?? {}).length;
  console.log([
    ...lines,
    `${plural(ids.length, 'source')}: ${Object.entries(tally).map(([k, n]) => `${n} ${k}`).join(', ')}. ${plural(unverified, 'note')} unverified.`,
  ].join('\n'));
}

if (process.argv.length > 2) {
  console.error(USAGE);
  process.exitCode = 2;
} else {
  try {
    await main();
  } catch (e) {
    console.error(`refresh failed: ${e.message}`);
    process.exitCode = 1;
  }
}
