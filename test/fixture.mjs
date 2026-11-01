import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const TOOLS = path.resolve(import.meta.dirname, '..', 'tools');

// The tools find the vault from their own location, so each test runs a copy of tools/ inside a vault of its own.
export function makeVault(t, { config = {}, domain = 'demo', topics = ['layout', 'code'], domains = {}, local = {}, under = os.tmpdir() } = {}) {
  const root = fs.mkdtempSync(path.join(under, 'vault-test-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-project-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  });
  fs.cpSync(TOOLS, path.join(root, 'tools'), { recursive: true });
  const at = (...xs) => path.join(root, ...xs);

  const v = {
    root,
    project,
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
    hook(name, input, { timeout } = {}) {
      const log = at('.state', 'errors.log');
      const size = () => (fs.existsSync(log) ? fs.statSync(log).size : 0);
      const before = size();
      const r = v.run(`hooks/${name}.mjs`, [], { input, cwd: input.cwd ?? project, timeout });
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
      const env = cleanEnv({ GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });
      const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: root, env, stdio: 'pipe' });
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

  v.write('vault.config.json', `${JSON.stringify({
    domains: { [domain]: { title: 'Demo', topics }, ...domains },
    ...config,
  }, null, 2)}\n`);
  // The project folder is the default domain's path on this machine; local adds or replaces other domains' entries.
  v.write('vault.local.json', `${JSON.stringify({ domains: { [domain]: { paths: [project.replace(/\\/g, '/')] }, ...local } }, null, 2)}\n`);
  return v;
}

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

export const editFile = (v, sid, rel, { tool = 'Edit', text = 'local x = 1', abs, cwd, agent, timeout } = {}) => v.edit(sid, tool, {
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

export const pageNote = ({ domain = 'demo', kind = 'topic', topic = 'code', summary = "'What we know.'", keywords = [], applies_to = [], extra = [], body = ['Body.'] } = {}) => [
  '---', 'type: page', `domain: ${domain}`, ...(kind ? [`kind: ${kind}`] : []), `topic: ${topic}`, `summary: ${summary}`,
  ...(keywords.length ? list('keywords', keywords) : []), ...(applies_to.length ? list('applies_to', applies_to) : []), ...extra,
  'created: 2026-10-01', 'updated: 2026-10-01', '---', '', ...body, '',
].join('\n');

export const sourcePage = ({ source, dated, body = ['## You said', '', "## Agent's reading", '', '## Rules'], ...opts }) => pageNote({
  ...opts, kind: 'source', extra: [`source: ${source}`, ...(dated ? [`source_date: ${dated}`] : [])], body,
});

export function ruleNote({ domain = 'demo', topic = 'code', basis = 'stated', kind = 'taste', applies_to = [], keywords = [], always = false, doLine = 'Do the thing.', notLine = 'Skip the thing.', because = '', extra = [], evidence = ['- 2026-10-01 · stated · session 1a2b3c4d · "do the thing" (a-00000001)'] } = {}) {
  return [
    '---', 'type: rule', `domain: ${domain}`, `kind: ${kind}`, `basis: ${basis}`, ...extra, `topic: ${topic}`, `always: ${always}`,
    ...list('applies_to', applies_to), 'triggers: []', ...list('keywords', keywords), 'created: 2026-10-01', 'updated: 2026-10-01', '---', '',
    `**Do:** ${doLine}`, `**Not:** ${notLine}`, `**Because:**${because ? ` ${because}` : ''}`, '', '## Examples', '', '## Evidence', ...evidence, '',
  ].join('\n');
}
