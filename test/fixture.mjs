import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const TOOLS = path.resolve(import.meta.dirname, '..', 'tools');

// The tools find the vault from their own location, so each test runs a copy of tools/ inside a vault of its own.
export function makeVault(t, { config = {}, domain = 'demo', topics = ['layout', 'code'], domains = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-'));
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
    write(rel, text, { settled = true } = {}) {
      const file = at(...rel.split('/'));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
      // Hooks skip notes saved within delivery.settleSeconds, so a fixture note is dated back unless a test wants it fresh.
      if (settled) {
        const t = new Date(Date.now() - 3600e3);
        fs.utimesSync(file, t, t);
      }
      return file;
    },
    read: rel => fs.readFileSync(at(...rel.split('/')), 'utf8'),
    exists: rel => fs.existsSync(at(...rel.split('/'))),
    run(script, args = [], { input, env = {}, cwd = root } = {}) {
      const r = spawnSync(process.execPath, [at('tools', ...script.split('/')), ...args], {
        cwd,
        input: input === undefined ? '' : typeof input === 'string' ? input : JSON.stringify(input),
        env: cleanEnv(env),
        encoding: 'utf8',
      });
      return { code: r.status, stdout: r.stdout, stderr: r.stderr };
    },
    hook(name, input) {
      const r = v.run(`hooks/${name}.mjs`, [], { input, cwd: input.cwd ?? project });
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
    edit: (sid, tool, toolInput, { cwd = project, agent } = {}) => v.hook('edit', {
      session_id: sid, cwd, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: toolInput, ...(agent ? { agent_id: agent } : {}),
    }),
    import: rel => import(pathToFileURL(at('tools', ...rel.split('/'))).href),
  };

  v.write('vault.config.json', `${JSON.stringify({
    domains: { [domain]: { title: 'Demo', projects: [project.replace(/\\/g, '/')], topics }, ...domains },
    ...config,
  }, null, 2)}\n`);
  return v;
}

// The test run may itself be inside a Claude Code session, whose id would make propose.mjs and pick.mjs refuse the fixture's.
function cleanEnv(extra) {
  const env = { ...process.env };
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.CLAUDE_CODE_SAFE_MODE;
  return { ...env, ...extra };
}

let sessions = 0;
export const sessionId = () => `a1b2c3d4-0000-4000-8000-${String(++sessions).padStart(12, '0')}`;

export const editFile = (v, sid, rel, { tool = 'Edit', text = 'local x = 1', abs, cwd, agent } = {}) => v.edit(sid, tool, {
  file_path: abs ?? path.join(v.project, ...rel.split('/')), ...(tool === 'Write' ? { content: text } : { old_string: 'a', new_string: text }),
}, { cwd, agent });
export const prompt = (v, sid, text, { cwd = v.project } = {}) => v.hook('prompt', { session_id: sid, cwd, prompt: text, hook_event_name: 'UserPromptSubmit' });

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
