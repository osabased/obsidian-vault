import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeVault, ruleNote, sessionId, cleanEnv } from './fixture.mjs';
import * as claudeCode from './drivers/claude-code.mjs';
import * as codex from './drivers/codex.mjs';

// The contract every adapter keeps (design §8 item 6, Tests): the same vault behaves the same through each agent's hooks.
const ALWAYS = /glim\/always-rule: Do: Open each glim file with a purpose line\./;
const ZQ = /glim\/zq-trigger: Do: Set values through a named step\./;
const KEYWORD = /glim\/keyword-rule: Do: Fade a shimmer in over two frames\./;
const LEAD = 'Taste rules apply to a file this turn wrote. Re-read the change against them before you stop.';

function gitProject(v) {
  const env = cleanEnv({ GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: v.project, env, stdio: 'pipe' });
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'start');
}

const shellWrite = (v, rel, text) => {
  const file = path.join(v.project, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

for (const d of [claudeCode, codex]) {
  const vault = t => makeVault(t, { presets: ['glim'], config: d.config });
  const started = (t, opts) => {
    const v = vault(t);
    const sid = sessionId();
    d.start(v, sid, opts?.(v, sid));
    return { v, sid };
  };

  test(`${d.name}: a session start delivers the always rule, and a compact start makes the next edit refuse again`, t => {
    const v = vault(t);
    const sid = sessionId();
    assert.match(d.context(d.start(v, sid)) ?? '', ALWAYS);
    assert.match(d.deny(d.editFile(v, sid, 'src/a.zq')) ?? '', ZQ);
    assert.equal(d.editFile(v, sid, 'src/a.zq'), null);
    d.start(v, sid, { source: 'compact' });
    assert.match(d.deny(d.editFile(v, sid, 'src/a.zq')) ?? '', ZQ);
  });

  test(`${d.name}: the session start's propose note names the project's own agent instructions, no one agent's files`, t => {
    const text = d.context(d.start(vault(t), sessionId())) ?? '';
    assert.match(text, /Leave out what the project's own agent instructions already say; a compiled taste-vault section in them is the vault's copy\./);
    assert.doesNotMatch(text, /CLAUDE\.md|\.claude\/rules/);
  });

  test(`${d.name}: a prompt with a keyword gets the excerpt once`, t => {
    const { v, sid } = started(t);
    assert.match(d.context(d.prompt(v, sid, 'make the shimmer softer')) ?? '', KEYWORD);
    assert.doesNotMatch(d.context(d.prompt(v, sid, 'the shimmer again')) ?? '', KEYWORD);
  });

  test(`${d.name}: the first edit to a covered file is denied with the rule, and the same edit again gives no output`, t => {
    const { v, sid } = started(t);
    assert.match(d.deny(d.editFile(v, sid, 'src/a.zq')) ?? '', ZQ);
    const r = v.run(`adapters/${d.name}/hooks/edit.mjs`, [], { input: d.payload.editFile(v, sid, 'src/a.zq'), cwd: v.project });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, '', 'no objection writes nothing, never an allow');
  });

  test(`${d.name}: an edit outside every glob gives no output`, t => {
    const { v, sid } = started(t);
    assert.equal(d.editFile(v, sid, 'docs/readme.txt'), null);
  });

  test(`${d.name}: a subagent hears the always rules, and its edit is gated apart from the parent's`, t => {
    const { v, sid } = started(t);
    assert.match(d.context(d.subagent(v, sid, 'agent-1')) ?? '', ALWAYS);
    assert.ok(d.deny(d.editFile(v, sid, 'src/a.zq')));
    assert.equal(d.editFile(v, sid, 'src/a.zq'), null);
    assert.match(d.deny(d.editFile(v, sid, 'src/a.zq', { agent: 'agent-1' })) ?? '', ZQ);
    assert.equal(d.editFile(v, sid, 'src/a.zq', { agent: 'agent-1' }), null);
  });

  test(`${d.name}: a shell write, then a stop, continues once with the lead line`, t => {
    const v = vault(t);
    gitProject(v);
    const sid = sessionId();
    d.start(v, sid);
    d.prompt(v, sid, 'write it with a script');
    shellWrite(v, 'src/a.zq', 'set x to 1\n');
    const first = d.continued(d.stop(v, sid)) ?? '';
    assert.ok(first.startsWith(`${LEAD}\nsrc/a.zq:\n`), first);
    assert.match(first, ZQ);
    assert.equal(d.stop(v, sid), null, 'the next stop gives nothing');
  });

  test(`${d.name}: with a broken vault.config.json each hook exits 1 with one failure line and nothing on stdout`, t => {
    const v = vault(t);
    gitProject(v);
    const sid = sessionId();
    d.start(v, sid);
    d.prompt(v, sid, 'write it with a script');
    shellWrite(v, 'src/a.zq', 'set x to 1\n');
    v.write('vault.config.json', '{ not json');
    // Stop goes first: the prompt hook stamps a new turn before it reads config, which would leave the shell write behind it.
    const inputs = {
      stop: d.payload.stop(v, sid),
      'session-start': d.payload.start(v, sid),
      prompt: d.payload.prompt(v, sid, 'shimmer'),
      edit: d.payload.editFile(v, sid, 'src/b.zq'),
      'subagent-start': d.payload.subagent(v, sid, 'agent-1'),
    };
    for (const [hook, input] of Object.entries(inputs)) {
      const r = v.run(`adapters/${d.name}/hooks/${hook}.mjs`, [], { input, cwd: v.project });
      assert.equal(r.code, 1, `${hook}: ${r.stderr}`);
      assert.equal(r.stdout, '', hook);
      assert.match(r.stderr, new RegExp(`^vault ${hook} failed: [^\\n]+; see \\.state/errors\\.log\\n$`), hook);
    }
  });

  test(`${d.name}: an editTools MCP tool is gated in its namespace`, t => {
    const { v, sid } = started(t);
    v.write('wiki/glim/rules/tree-rule.md', ruleNote({ applies_to: ['glim-tree:A.**'], doLine: 'Name nodes plainly.' }));
    const call = () => d.toolCall(v, sid, 'mcp__fixture__set_property', { path: 'A.B.C', value: 'x' });
    assert.match(d.deny(call()) ?? '', /^Taste rules apply to glim-tree:A\.B\.C:\n- glim\/tree-rule: Do: Name nodes plainly\./);
    assert.equal(call(), null);
  });

  test(`${d.name}: propose with no session argument uses the session from the agent's session variable`, async t => {
    const { v, sid } = started(t);
    const { sessionVar } = await v.import(`adapters/${d.name}/adapter.mjs`);
    const rule = {
      domain: 'glim', slug: 'own-session', topic: 'naming', basis: 'reading', reading: 'The user rewrote the screen twice.',
      do: 'Zebra quartz mango.', not: 'Plover lantern ember.', applies_to: ['src/new/**'],
    };
    const r = v.run('propose.mjs', [], { input: rule, env: { [sessionVar]: sid } });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^Wrote wiki\/glim\/rules\/own-session\.md\./);
  });

  test(`${d.name}: propose refuses a session id other than the agent's own, whatever agents lists`, async t => {
    for (const agents of [[], [d === codex ? claudeCode.name : codex.name]]) {
      const v = makeVault(t, { presets: ['glim'], config: { ...d.config, agents } });
      const { sessionVar } = await v.import(`adapters/${d.name}/adapter.mjs`);
      const [sid, other] = [sessionId(), sessionId()];
      d.start(v, sid);
      d.start(v, other);
      const rule = {
        domain: 'glim', slug: 'not-mine', topic: 'naming', basis: 'reading', reading: 'The user rewrote the screen twice.',
        do: 'Zebra quartz mango.', not: 'Plover lantern ember.', applies_to: ['src/new/**'],
      };
      const r = v.run('propose.mjs', [other], { input: rule, env: { [sessionVar]: sid } });
      assert.equal(r.code, 1, `agents ${JSON.stringify(agents)}: ${r.stdout}`);
      assert.match(r.stderr, new RegExp(`${other} isn't this session, which is ${sid}\.`));
    }
  });

  test(`${d.name}: the typed-text provider returns the typed message and none of the injected text`, async t => {
    const v = vault(t);
    const sid = sessionId();
    const file = d.transcript(v, sid, 'Keep the grid gap at eight.');
    d.start(v, sid, { transcript: file });
    const { typedMessages } = await v.import(`adapters/${d.name}/adapter.mjs`);
    assert.deepEqual(typedMessages(file), ['Keep the grid gap at eight.']);
  });
}
