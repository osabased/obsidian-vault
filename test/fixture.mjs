import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const TOOLS = path.resolve(import.meta.dirname, '..', 'tools');

// The tools find the vault from their own location, so each test runs a copy of tools/ inside a vault of its own.
// presets names shapes from PRESETS to add; the test's own domains, local and config merge over theirs.
// sources gives the almanac preset's saved sources a url, repo and commit to point at, such as a server from serve() or a
// repository from gitRepo(), in place of hosts that never resolve.
export function makeVault(t, { config = {}, domain = 'glim', topics = ['layout', 'code'], domains = {}, local = {}, presets = [], under = os.tmpdir(), sources = {} } = {}) {
  const unknown = presets.filter(p => !Object.hasOwn(PRESETS, p));
  if (unknown.length) throw new Error(`no preset ${unknown.join(', ')}; the presets are ${Object.keys(PRESETS).join(', ')}`);
  if (presets.includes('glim') && domain !== 'glim') throw new Error(`the glim preset fills the default domain, so it needs domain 'glim', not '${domain}'`);
  const root = fs.mkdtempSync(path.join(under, 'vault-test-'));
  const folders = [root];
  const newProject = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-project-'));
    folders.push(dir);
    return dir;
  };
  const project = newProject();
  t.after(() => {
    for (const dir of folders) fs.rmSync(dir, { recursive: true, force: true });
  });
  fs.cpSync(TOOLS, path.join(root, 'tools'), { recursive: true });
  const at = (...xs) => path.join(root, ...xs);

  const v = {
    root,
    project,
    projects: { [domain]: project },
    domain,
    at,
    // Hooks skip notes saved within delivery.settleSeconds, so a fixture note is dated back unless a test wants it fresh.
    write(rel, text, { settled = true, saved = settled ? new Date(Date.now() - 3600e3) : null } = {}) {
      const file = at(...rel.split('/'));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
      if (saved) fs.utimesSync(file, saved, saved);
      return file;
    },
    read: rel => fs.readFileSync(at(...rel.split('/')), 'utf8'),
    exists: rel => fs.existsSync(at(...rel.split('/'))),
    run(script, args = [], { input, env = {}, cwd = root, timeout } = {}) {
      const r = spawnSync(process.execPath, [at('tools', ...script.split('/')), ...args], {
        cwd,
        input: input === undefined ? '' : typeof input === 'string' ? input : JSON.stringify(input),
        env: cleanEnv(env),
        encoding: 'utf8',
        timeout,
      });
      return { code: r.status, stdout: r.stdout, stderr: r.stderr, ...(r.error && { error: r.error }) };
    },
    // Lets a test run several tools at once. A tool still running at the deadline is killed and resolves with no code.
    runAsync(script, args = [], { input, env = {}, cwd = root, timeout = 60e3 } = {}) {
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [at('tools', ...script.split('/')), ...args], { cwd, env: cleanEnv(env), timeout });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8').on('data', d => { stdout += d; });
        child.stderr.setEncoding('utf8').on('data', d => { stderr += d; });
        child.on('error', reject);
        child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
        child.stdin.end(input === undefined ? '' : typeof input === 'string' ? input : JSON.stringify(input));
      });
    },
    // A failed hook exits 1 with a line on stderr and the call goes ahead, so a hook that crashed would read as one that let
    // the call through.
    hook(name, input, { agent = 'claude-code', timeout } = {}) {
      const log = at('.state', 'errors.log');
      const size = () => (fs.existsSync(log) ? fs.statSync(log).size : 0);
      const before = size();
      const r = v.run(`adapters/${agent}/hooks/${name}.mjs`, [], { input, cwd: input.cwd ?? project, timeout });
      if (r.error?.code === 'ETIMEDOUT') throw new Error(`the ${name} hook was still running at the ${timeout} ms deadline`);
      if (r.error) throw r.error;
      if (r.code !== 0) throw new Error(`the ${name} hook exited ${r.code}: ${r.stderr}`);
      if (size() > before) throw new Error(`the ${name} hook logged an error: ${fs.readFileSync(log).subarray(before).toString('utf8')}`);
      return r.stdout.trim() ? JSON.parse(r.stdout) : null;
    },
    transcript(sid, entries) {
      const file = at('.transcripts', `${sid}.jsonl`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, entries.map(e => `${JSON.stringify(e)}\n`).join(''));
      return file;
    },
    startSession(sid, { cwd = project, transcript = null, source = 'startup' } = {}) {
      return v.hook('session-start', { session_id: sid, transcript_path: transcript, cwd, hook_event_name: 'SessionStart', source });
    },
    propose: (sid, input) => v.run('propose.mjs', [sid], { input }),
    edit: (sid, tool, toolInput, { cwd = project, agent, timeout } = {}) => v.hook('edit', {
      session_id: sid, cwd, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: toolInput, ...(agent ? { agent_id: agent } : {}),
    }, { timeout }),
    // A git checkout or a sync gives every note a fresh mtime without changing what it says. The commit is there because
    // the design settles a note by whether git reports it unchanged from HEAD. The user's git config stays out, since a
    // hooks path, a template or a line-ending check there could fail the commit. Git for Windows reads /dev/null as its
    // null device and refuses os.devNull's \\.\nul.
    checkout() {
      const git = gitIn(root);
      git('init', '-q');
      git('add', '-A');
      git('commit', '-q', '--allow-empty', '-m', 'notes');
      if (!fs.existsSync(at('wiki'))) return;
      const now = new Date();
      for (const e of fs.readdirSync(at('wiki'), { recursive: true, withFileTypes: true })) {
        if (e.isFile()) fs.utimesSync(path.join(e.parentPath, e.name), now, now);
      }
    },
    import: rel => import(pathToFileURL(at('tools', ...rel.split('/'))).href),
  };

  // The default domain reaches the project folder by its marker, so every test exercises markers; a test's own entry for
  // it changes only the fields it gives.
  const marker = `${domain}.project`;
  fs.writeFileSync(path.join(project, marker), '');
  const asOf = localDay(new Date(Date.now() - 30 * 86400e3));
  const shapes = presets.map(name => PRESETS[name](v, { newProject, asOf, sources }));
  v.write('vault.config.json', `${JSON.stringify({
    domains: merged([{ [domain]: { title: 'Glim', topics, markers: [marker] } }, ...shapes.map(s => s.domains ?? {}), domains]),
    ...merged([...shapes.map(s => s.config ?? {}), config]),
  }, null, 2)}\n`);
  v.write('vault.local.json', `${JSON.stringify({ domains: merged([...shapes.map(s => s.local ?? {}), local]) }, null, 2)}\n`);
  return v;
}

const gitIn = cwd => {
  const env = cleanEnv({ GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });
  return (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, env, stdio: 'pipe' }).toString('utf8').trim();
};

// A git repository in a temp folder holding files, committed, as a git source to refresh from. change writes or, given
// null, removes files and commits, returning the new commit.
export function gitRepo(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-repo-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = gitIn(dir);
  git('init', '-q');
  const change = more => {
    for (const [rel, text] of Object.entries(more)) {
      const file = path.join(dir, ...rel.split('/'));
      if (text === null) {
        fs.rmSync(file, { force: true });
        continue;
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    }
    git('add', '-A');
    git('commit', '-q', '--allow-empty', '-m', 'docs');
    return git('rev-parse', 'HEAD');
  };
  return { dir: dir.replace(/\\/g, '/'), commit: change(files), change };
}

// An HTTP server on 127.0.0.1 for refresh to fetch from. routes maps a path to { body, etag, lastModified, status,
// location, hang }; a GET that sends the route's etag or lastModified back gets 304, and a route with hang never answers.
export async function serve(t, routes = {}) {
  const table = new Map(Object.entries(routes));
  const hits = new Map();
  const server = http.createServer((req, res) => {
    const at = req.url.split('?')[0];
    hits.set(at, (hits.get(at) ?? 0) + 1);
    const r = table.get(at);
    if (!r) return res.writeHead(404).end('not found');
    if (r.hang) return;
    const headers = {
      ...(r.etag ? { ETag: r.etag } : {}), ...(r.lastModified ? { 'Last-Modified': r.lastModified } : {}), ...(r.location ? { Location: r.location } : {}),
    };
    const fresh = (r.etag && req.headers['if-none-match'] === r.etag) || (r.lastModified && req.headers['if-modified-since'] === r.lastModified);
    if (fresh && !r.status) return res.writeHead(304, headers).end();
    res.writeHead(r.status ?? 200, { 'Content-Type': 'text/plain; charset=utf-8', ...headers }).end(r.body ?? '');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  // A route that never answers holds its socket open, and close() would wait on it.
  t.after(() => new Promise(resolve => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { url: p => `${base}${p}`, set: (p, route) => table.set(p, route), hits: p => hits.get(p) ?? 0 };
}

// Each key's value from the objects given, later ones winning. Where two give an object for a key, their fields merge
// the same way, one level only: a test's entry for a domain changes only the fields it gives, and its namespaces join a
// preset's.
function merged(objects) {
  const out = {};
  for (const o of objects) {
    for (const [k, x] of Object.entries(o)) out[k] = isPlain(out[k]) && isPlain(x) ? { ...out[k], ...x } : x;
  }
  return out;
}
const isPlain = x => typeof x === 'object' && x !== null && !Array.isArray(x);

// The test run may itself be inside a Claude Code session, whose id would make propose.mjs and pick.mjs refuse the fixture's,
// or inside the pre-commit hook, whose GIT_DIR and GIT_INDEX_FILE would point a test's git at the vault's own repository.
export function cleanEnv(extra) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k)));
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.CLAUDE_CODE_SAFE_MODE;
  return { ...env, ...extra };
}

let sessions = 0;
export const sessionId = () => `a1b2c3d4-0000-4000-8000-${String(++sessions).padStart(12, '0')}`;

export const editFile = (v, sid, rel, { tool = 'Edit', text = 'set x to 1', abs, cwd, agent, timeout } = {}) => v.edit(sid, tool, {
  file_path: abs ?? path.join(v.project, ...rel.split('/')), ...(tool === 'Write' ? { content: text } : { old_string: 'a', new_string: text }),
}, { cwd, agent, timeout });
export const prompt = (v, sid, text, { cwd = v.project } = {}) => v.hook('prompt', { session_id: sid, cwd, prompt: text, hook_event_name: 'UserPromptSubmit' });

// Rules on three topics that share no words, globs or keywords with each other or the perf notes, so proposing them at
// once fails only if the proposes race.
export const unrelatedRules = (domain, tag) => [
  { topic: 'naming', reading: 'The user renamed the shop widgets after their screen.', do: 'Name widgets with a screen prefix.', not: 'Leave widget names bare.' },
  { topic: 'errors', reading: 'The user asked for quieter save failures.', do: 'Retry a failed save twice before showing a toast.', not: 'Show the toast on the first failure.' },
  { topic: 'docs', reading: 'The user put a purpose line atop each file.', do: 'Open each file with a one-line purpose comment.', not: 'Start a file straight with its imports.' },
].map((r, i) => ({ domain, slug: `${tag}-${i}`, basis: 'reading', applies_to: [`src/${tag}-${i}/**/*.txt`], ...r }));

// Every session starts before the first propose, so the proposes overlap.
export function proposeAtOnce(v, rules, { timeout } = {}) {
  const sids = rules.map(() => {
    const sid = sessionId();
    v.startSession(sid);
    return sid;
  });
  return Promise.all(rules.map((rule, i) => v.runAsync('propose.mjs', [sids[i]], { input: rule, timeout })));
}

export const denied = out => (out?.hookSpecificOutput?.permissionDecision === 'deny' ? out.hookSpecificOutput.permissionDecisionReason : null);

export const lintFound = async (v, re) => (await v.import('lib/lint.mjs')).lint().filter(f => f.file.startsWith('wiki/') && re.test(f.msg));

export const userTurn =text => ({ type: 'user', message: { role: 'user', content: text } });
export const assistantTurn = text => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
export const toolResult = (text, toolUseResult = {}) => ({
  type: 'user', toolUseResult, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: text }] },
});

const list = (name, xs) => (xs.length ? [`${name}:`, ...xs.map(x => `  - '${x}'`)] : [`${name}: []`]);

export const pageNote = ({ domain = 'glim', kind = 'topic', topic = 'code', summary = "'What we know.'", keywords = [], applies_to = [], extra = [], body = ['Body.'] } = {}) => [
  '---', 'type: page', `domain: ${domain}`, ...(kind ? [`kind: ${kind}`] : []), `topic: ${topic}`, `summary: ${summary}`,
  ...(keywords.length ? list('keywords', keywords) : []), ...(applies_to.length ? list('applies_to', applies_to) : []), ...extra,
  'created: 2026-10-01', 'updated: 2026-10-01', '---', '', ...body, '',
].join('\n');

export const sourcePage = ({ source, dated, body = ['## You said', '', "## Agent's reading", '', '## Rules'], ...opts }) => pageNote({
  ...opts, kind: 'source', extra: [`source: ${source}`, ...(dated ? [`source_date: ${dated}`] : [])], body,
});

export function ruleNote({ domain = 'glim', topic = 'code', basis = 'stated', kind = 'taste', applies_to = [], triggers = [], keywords = [], always = false, doLine = 'Do the thing.', notLine = 'Skip the thing.', because = '', extra = [], evidence = ['- 2026-10-01 · stated · session 1a2b3c4d · "do the thing" (a-00000001)'] } = {}) {
  return [
    '---', 'type: rule', `domain: ${domain}`, `kind: ${kind}`, `basis: ${basis}`, ...extra, `topic: ${topic}`, `always: ${always}`,
    ...list('applies_to', applies_to), ...list('triggers', triggers), ...list('keywords', keywords), 'created: 2026-10-01', 'updated: 2026-10-01', '---', '',
    `**Do:** ${doLine}`, `**Not:** ${notLine}`, `**Because:**${because ? ` ${because}` : ''}`, '', '## Examples', '', '## Evidence', ...evidence, '',
  ].join('\n');
}

export const sha256 = data => createHash('sha256').update(data).digest('hex');
// Each file under a vault folder, by its path from the vault root, with the hash of its bytes, to compare before and after a run.
export const filesUnder = (v, dir) => Object.fromEntries(fs.readdirSync(v.at(...dir.split('/')), { recursive: true, withFileTypes: true })
  .filter(e => e.isFile()).map(e => [path.relative(v.root, path.join(e.parentPath, e.name)).replace(/\\/g, '/'), sha256(fs.readFileSync(path.join(e.parentPath, e.name)))]));
// The refusal an edit to src/ledger.txt in the almanac preset's project, or in dir, gets, or '' when it goes through.
export const ledgerEdit = (v, sid, dir = v.projects.almanac) => denied(editFile(v, sid, 'src/ledger.txt', { abs: path.join(dir, 'src', 'ledger.txt'), cwd: dir })) ?? '';
// The tools date notes by the local day, so a fixture's dates are local too.
const localDay = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
// The lines under a section's title in review.mjs output, or undefined when it has no such section.
export const sectionOf = (out, title) => out.trimEnd().split('\n\n').find(b => b.startsWith(`${title}\n`))?.split('\n').slice(1);
const link = rel => `[[${rel.replace(/\.md$/, '')}|${path.posix.basename(rel, '.md')}]]`;
const topicPage = ({ domain, topic, summary, links }) => pageNote({ domain, topic, summary, body: ['What the vault holds on this topic.', '', '## Rules', ...links.map(l => `- ${link(l)}`)] });
export const withFields = (fields, body) => `---\n${Object.entries(fields).map(([k, x]) => `${k}: ${x}`).join('\n')}\n---\n${body}`;

// An alias that maps a name's first part to a folder through the project's tree.json, and the rest to a .zq file in it.
const FIXTURE_ALIAS = [
  "import fs from 'node:fs';",
  "import path from 'node:path';",
  'export function toFile(names, root) {',
  "  const map = path.join(root, 'tree.json');",
  '  if (!fs.existsSync(map)) return null;',
  "  const folder = JSON.parse(fs.readFileSync(map, 'utf8'))[names[0]];",
  "  return folder ? `${path.join(root, folder, ...names.slice(1))}.zq` : null;",
  '}',
  '',
].join('\n');

const FIXTURE_READER = [
  "import fs from 'node:fs';",
  "import path from 'node:path';",
  "export const ecosystem = 'fixture';",
  "export const lockfiles = ['almanac.lock'];",
  "export const scheme = 'SEMVER';",
  'export function read(dir) {',
  '  const out = {};',
  "  for (const line of fs.readFileSync(path.join(dir, 'almanac.lock'), 'utf8').split(/\\r?\\n/)) {",
  '    const m = line.match(/^(\\S+) (\\S+)$/);',
  '    if (m) out[m[1]] = m[2];',
  '  }',
  '  return out;',
  '}',
  '',
].join('\n');
// Reads the text between a PDF's first line and the bytes past ASCII, one page per form feed.
export const FIXTURE_EXTRACTOR = [
  "import fs from 'node:fs';",
  "export const kinds = ['pdf'];",
  "export const extensions = ['.pdf'];",
  "export const version = '1.0';",
  'export function extract(file) {',
  '  const bytes = fs.readFileSync(file);',
  "  if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error(\"doesn't start %PDF-\");",
  "  const text = Buffer.from(bytes.subarray(bytes.indexOf(0x0a) + 1).filter(b => b < 0x80)).toString('latin1');",
  "  return { kind: 'pdf', parts: text.split('\\f').map((t, i) => ({ page: i + 1, text: t.trim() })) };",
  '}',
  '',
].join('\n');
export const LEDGER_GUIDE ='# Opening a ledger\n\nIn pkg 2, openLedger takes a path and returns the ledger.\nIn pkg 3, openLedger takes an options object with a path field.\n';
export const LEDGER_REPO = 'openLedger returns the ledger it opened.\n';

// The presets' rules quote proposal a-00000001 from a session no preset registers, as if its transcript were pruned, so
// lint checks them against the inbox row that recorded the words. One row backs them all, whichever preset writes it.
function proposedRow(v, note) {
  const rel = 'raw/inbox/2026-10-01-1a2b3c4d.jsonl';
  if (v.exists(rel)) return;
  v.write(rel, `${JSON.stringify({
    id: 'a-00000001', at: '2026-10-01T10:00:00.000Z', source: 'agent', kind: 'stated', text: 'do the thing', note,
    session: '1a2b3c4d-0000-4000-8000-000000000001', transcript: null, cwd: null, domain: note.split('/')[0],
  })}\n`);
}

// The five shapes a domain can take (design §8 item 3). Each writes its notes and files into v and returns its share of
// vault.config.json and vault.local.json. Tests address their keys, slugs and ids, so those stay as they are.
export const PRESETS = {
  // Code taste, reached by the default domain's marker in v.project.
  glim(v) {
    const notes = {
      'wiki/glim/rules/always-rule.md': ruleNote({ always: true, doLine: 'Open each glim file with a purpose line.', notLine: 'Start a file straight with code.', because: 'The user reads the first line first.' }),
      'wiki/glim/rules/zq-trigger.md': ruleNote({ applies_to: ['src/**/*.zq'], triggers: ['set \\w+ to'], doLine: 'Set values through a named step.', notLine: 'Set a value inline.', because: 'The user traces values by step name.' }),
      'wiki/glim/rules/keyword-rule.md': ruleNote({ keywords: ['shimmer'], doLine: 'Fade a shimmer in over two frames.', notLine: 'Flash a shimmer on at once.', because: 'The user found the flash harsh.' }),
      'wiki/glim/rules/ask-rule.md': ruleNote({ topic: 'layout', extra: ['tools:', "  - 'AskUserQuestion'"], doLine: 'Offer layouts as two to four options.', notLine: 'Ask an open question about layout.', because: 'The user picks faster from options.' }),
      'wiki/glim/concepts/zq-files.md': pageNote({ kind: 'concept', summary: "'How a .zq file is laid out.'", applies_to: ['src/**/*.zq'], body: ['A .zq file holds one named step per line.'] }),
    };
    notes['wiki/glim/topics/code.md'] = topicPage({ domain: 'glim', topic: 'code', summary: "'Code taste for glim files.'", links: Object.keys(notes) });
    for (const [rel, text] of Object.entries(notes)) v.write(rel, text);
    proposedRow(v, 'glim/always-rule');
    const project = v.project.replace(/\\/g, '/');
    v.write('raw/picks/2026-10-01-91170001.jsonl', `${JSON.stringify({
      id: 'q-91170001', at: '2026-10-01T10:00:00.000Z', source: 'pick', session: '91170001-0000-4000-8000-000000000001', transcript: null, cwd: project,
      domain: 'glim', project, subject: 'cards', question: 'Which card layout?', header: null,
      options: [{ label: 'A, Grid', description: 'Cards in an even grid.' }, { label: 'B, Shelf', description: 'One featured card above a row.' }],
      multiSelect: false, pick: 'B, Shelf', notes: 'the featured card reads first', reason: null, status: 'user',
    })}\n`);
    v.write('tools/ext/aliases/fixture.mjs', FIXTURE_ALIAS);
    return {
      domains: { glim: { aliases: { 'glim-tree': 'fixture' } } },
      config: {
        namespaces: { 'glim-tree': { separator: '.', escape: '\\' } },
        editTools: { mcp__fixture__set_property: { namespace: 'glim-tree', path: 'tool_input.path', after: 'tool_input.value' } },
      },
    };
  },

  // Knowledge, reached by its marker in a project of its own, whose lockfile the fixture reader reads.
  almanac(v, { newProject, asOf, sources }) {
    const dir = newProject();
    v.projects.almanac = dir;
    fs.writeFileSync(path.join(dir, 'almanac.project'), '');
    fs.writeFileSync(path.join(dir, 'almanac.lock'), 'pkg 2.4.0\n');
    const guide = LEDGER_GUIDE;
    v.write('raw/refs/ledger-guide.md', withFields({
      url: sources.url ?? 'https://pkg.invalid/ledger', fetched: asOf, etag: `'"ledger-1"'`, last_modified: 'Tue, 15 Sep 2026 08:12:31 GMT', sha256: sha256(guide),
    }, guide));
    v.write('raw/refs/ledger-repo.md', withFields({ repo: sources.repo ?? 'https://example.com/pkg.git', path: 'docs/ledger.md', commit: sources.commit ?? 'a1b2c3d4e5f6' }, LEDGER_REPO));
    const knowledge = (since, before, quote, doLine, notLine) => ruleNote({
      domain: 'almanac', topic: 'ledger', kind: 'knowledge', basis: 'source', applies_to: ['src/**'], keywords: ['openLedger'], doLine, notLine, because: 'The ledger guide says so.',
      extra: [`as_of: ${asOf}`, `requires: [{ package: { ecosystem: fixture, name: pkg }, ranges: [{ type: SEMVER, events: [{ introduced: '${since}' }${before ? `, { fixed: '${before}' }` : ''}] }] }]`],
      evidence: [`- ${asOf} · source · session 1a2b3c4d · raw/refs/ledger-guide.md · dated ${asOf} · "${quote}" (a-00000002)`],
    });
    const notes = {
      'wiki/almanac/rules/ledger-v2.md': knowledge('2.0.0', '3.0.0', 'openLedger takes a path and returns the ledger', 'Call openLedger with the path.', 'Pass openLedger an options object.'),
      'wiki/almanac/rules/ledger-v3.md': knowledge('3.0.0', null, 'openLedger takes an options object with a path field', 'Call openLedger with { path }.', 'Pass openLedger a bare path.'),
    };
    const rules = Object.keys(notes);
    const source = ref => sourcePage({
      domain: 'almanac', topic: 'ledger', summary: `'What ${ref} says about openLedger.'`, source: ref, dated: asOf,
      body: ['## You said', '', "## Agent's reading", 'How openLedger is called in each major version.', '', '## Rules', ...rules.map(r => `- ${link(r)}`)],
    });
    notes['wiki/almanac/sources/source-ledger-guide.md'] = source('raw/refs/ledger-guide.md');
    notes['wiki/almanac/sources/source-ledger-repo.md'] = source('raw/refs/ledger-repo.md');
    notes['wiki/almanac/topics/ledger.md'] = topicPage({ domain: 'almanac', topic: 'ledger', summary: "'Facts about the pkg ledger API.'", links: Object.keys(notes) });
    for (const [rel, text] of Object.entries(notes)) v.write(rel, text);
    v.write('tools/ext/readers/fixture.mjs', FIXTURE_READER);
    return { domains: { almanac: { title: 'Almanac', topics: ['ledger'], markers: ['almanac.project'], readers: ['fixture'] } } };
  },

  // Research: pages only, read in the vault, over a binary source with derived text and one without.
  archive(v) {
    const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('The glimmer index counts each lit cell.\fA cell lit twice still counts once.\n'), Buffer.from([0xff, 0xfe])]);
    v.write('raw/refs/paper.pdf', pdf);
    v.write('tools/ext/extractors/fixture.mjs', FIXTURE_EXTRACTOR);
    v.write('raw/refs/talk.mp4', Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0xff]));
    v.write(`derived/${sha256(pdf)}.md`, withFields(
      { kind: 'pdf', extractor: 'fixture', extractor_version: "'1.0'", source: 'raw/refs/paper.pdf' },
      '[p. 1]\nThe glimmer index counts each lit cell.\n[p. 2]\nA cell lit twice still counts once.\n',
    ));
    const paper = 'wiki/archive/sources/source-paper.md';
    v.write(paper, sourcePage({
      domain: 'archive', topic: 'papers', summary: "'How the paper counts lit cells.'", keywords: ['glimmer index'], source: 'raw/refs/paper.pdf',
      body: ['## You said', '', "## Agent's reading", 'A cell lit twice counts once.[^1]', '', '[^1]: raw/refs/paper.pdf#page=2', '', '## Rules'],
    }));
    v.write('wiki/archive/topics/papers.md', topicPage({ domain: 'archive', topic: 'papers', summary: "'Papers on lit cells.'", links: [paper] }));
    return { domains: { archive: { title: 'Archive', topics: ['papers'], vaultOnly: true } }, config: { extractors: ['fixture'] } };
  },

  // Personal, reached by a path in vault.local.json, with a page in the user's own words.
  journal(v, { newProject }) {
    const dir = newProject();
    v.projects.journal = dir;
    const mine = 'wiki/journal/concepts/morning-pages.md';
    v.write(mine, pageNote({
      domain: 'journal', kind: 'concept', topic: 'days', summary: "'How I start a day.'", extra: ['author: user'],
      body: ['I write three pages before I open any mail.', '', '## Agent notes', ''],
    }));
    v.write('wiki/journal/topics/days.md', topicPage({ domain: 'journal', topic: 'days', summary: "'How the user plans a day.'", links: [mine] }));
    return { domains: { journal: { title: 'Journal', topics: ['days'] } }, local: { journal: { paths: [dir.replace(/\\/g, '/')] } } };
  },

  // Everywhere: its pages and keyword rules reach every session, with no markers or paths.
  commons(v) {
    const notes = {
      'wiki/commons/rules/plain-rule.md': ruleNote({ domain: 'commons', topic: 'words', keywords: ['plainspeak'], doLine: 'Use the short word.', notLine: 'Reach for the long word.', because: 'The user reads in a terminal.' }),
      'wiki/commons/concepts/plain-words.md': pageNote({ domain: 'commons', kind: 'concept', topic: 'words', summary: "'Short words that say the same.'", keywords: ['plainspeak'], body: ['Use for utilize; end for terminate.'] }),
    };
    notes['wiki/commons/topics/words.md'] = topicPage({ domain: 'commons', topic: 'words', summary: "'Word choice everywhere.'", links: Object.keys(notes) });
    for (const [rel, text] of Object.entries(notes)) v.write(rel, text);
    proposedRow(v, 'commons/plain-rule');
    return { domains: { commons:{ title: 'Commons', topics: ['words'], everywhere: true } } };
  },
};
