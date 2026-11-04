import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { makeVault, cleanEnv, sessionId } from './fixture.mjs';
import { parse } from '../tools/lib/frontmatter.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const LAUNCH = path.join(ROOT, 'mcp', 'launch.mjs');
const ROWS = ['propose', 'keep', 'proposals', 'domain', 'pick', 'log', 'search', 'status'];
const MARKER = { 'anthropic/requiresUserInteraction': true };
const CC = { name: 'claude-code', version: '2.1.309' };
const CODEX = { name: 'codex-mcp-client', version: '0.153.4' };
const ccMeta = call => ({ 'claudecode/toolUseId': call });

const NO_ID = "The vault couldn't tie this call to a session: it came with no call id. Nothing was run.";
const NO_RECORD = "The vault's PreToolUse hook didn't record this call, so it can't tell which session made it. Check that the vault hooks are installed and trusted. Nothing was run.";
const MISMATCH = "This call's record is for another tool or session. Nothing was run.";
const UNLISTED = "The vault's tools answer only the agents listed in vault.config.json. Nothing was run.";
const UNPROMPTED = "The vault listed this tool without its permission prompt on this connection, so it can't tell the user allowed this call. Nothing was run.";

// A row script that prints a schema named for its variant, or, when called, what it was run with, and logs each run to
// the file MCP_TEST_RAN names, so a test can tell nothing ran.
const stub = (name, { from = 'live', schema = 'ok' } = {}) => [
  "import fs from 'node:fs';",
  'const args = process.argv.slice(2);',
  "if (args[0] === '--schema') {",
  `  if (${JSON.stringify(schema)} === 'fails') { process.stderr.write('no schema here\\n'); process.exit(2); }`,
  `  const properties = ${JSON.stringify(name)} === 'keep' ? { id: { type: 'string' }, offer: { type: 'string' } } : { x: { type: 'string' } };`,
  `  process.stdout.write(JSON.stringify({ description: ${JSON.stringify(name)} + ' for ' + args[1], inputSchema: { type: 'object', properties, required: [], additionalProperties: false } }) + '\\n');`,
  '} else {',
  "  const input = fs.readFileSync(0, 'utf8');",
  `  const seen = { script: ${JSON.stringify(name)}, from: ${JSON.stringify(from)}, args, input, cwd: process.cwd(), sessionVars: Object.keys(process.env).filter(k => /^(CLAUDE_CODE_SESSION_ID|CODEX_THREAD_ID)$/.test(k)) };`,
  "  if (process.env.MCP_TEST_RAN) fs.appendFileSync(process.env.MCP_TEST_RAN, JSON.stringify(seen) + '\\n');",
  "  if (args.includes('fail')) { process.stderr.write('Refused: the stub was told to fail.\\n'); process.exit(1); }",
  "  process.stdout.write(JSON.stringify(seen) + '\\n\\n');",
  '}',
  '',
].join('\n');

function liveVault(t, { stubs = true, failing = [], agents } = {}) {
  const v = makeVault(t, agents ? { config: { agents } } : {});
  fs.cpSync(v.at('tools'), v.at('.live', 'tools'), { recursive: true });
  if (stubs) for (const name of ROWS) v.write(`.live/tools/${name}.mjs`, stub(name, { schema: failing.includes(name) ? 'fails' : 'ok' }));
  return v;
}

const ranLog = v => v.at('ran.jsonl');
const runs = v => (fs.existsSync(ranLog(v)) ? fs.readFileSync(ranLog(v), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);

function connect(t, args, { env = {} } = {}) {
  const child = spawn(process.execPath, [LAUNCH, ...args], {
    env: cleanEnv({ CLAUDE_CODE_SESSION_ID: 'outer-session', CODEX_THREAD_ID: 'outer-thread', ...env }),
  });
  t.after(() => child.kill());
  const messages = [];
  const waiting = new Map();
  let buf = '';
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', d => { stderr += d; });
  child.stdout.setEncoding('utf8').on('data', d => {
    buf += d;
    for (let i; (i = buf.indexOf('\n')) >= 0;) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const m = JSON.parse(line);
      messages.push(m);
      if (m.id !== undefined && waiting.has(m.id)) {
        waiting.get(m.id)(m);
        waiting.delete(m.id);
      }
    }
  });
  const exited = new Promise(resolve => child.on('close', code => resolve({ code, stderr })));
  let next = 0;
  const send = obj => child.stdin.write(`${typeof obj === 'string' ? obj : JSON.stringify(obj)}\n`);
  const request = (method, params) => new Promise(resolve => {
    const id = ++next;
    waiting.set(id, resolve);
    send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
  });
  const waitFor = async (pred, ms = 5000) => {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 50))) {
      const hit = messages.find(pred);
      if (hit) return hit;
    }
    return null;
  };
  return { child, messages, send, request, waitFor, exited, stderr: () => stderr };
}

async function open(t, v, clientInfo = CC) {
  const c = connect(t, [v.root], { env: { MCP_TEST_RAN: ranLog(v) } });
  const init = await c.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo });
  c.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return { ...c, init };
}

const list = async c => (await c.request('tools/list', {})).result.tools;
const call = async (c, name, args, meta) => (await c.request('tools/call', { name, arguments: args, ...(meta === undefined ? {} : { _meta: meta }) })).result;
const textOf = r => r.content.map(x => x.text).join('');

async function recorded(v, rec) {
  const { recordCall } = await v.import('lib/calls.mjs');
  recordCall({ subagent: null, offer: null, ...rec });
}

async function registered(v, sid, { agent = 'claude-code', cwd = v.project } = {}) {
  const { touchSession } = await v.import('lib/sessions.mjs');
  touchSession({ session: sid, cwd }, null, agent);
}

test("the handshake is pinned: the client's protocol when the server speaks it, tools that change, no instructions", async t => {
  const v = liveVault(t);
  const c = await open(t, v, { name: 'claude-code', version: '2.1.309' });
  assert.deepEqual(c.init, {
    jsonrpc: '2.0', id: 1,
    result: { protocolVersion: '2025-11-25', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'vault', version: '1' } },
  });
  const codex = connect(t, [v.root]);
  const r = await codex.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: CODEX });
  assert.equal(r.result.protocolVersion, '2025-06-18', 'a version the server speaks is answered with itself');
  const odd = connect(t, [v.root]);
  const o = await odd.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: CODEX });
  assert.equal(o.result.protocolVersion, '2025-11-25', 'any other gets the newest the server speaks');
  assert.deepEqual((await c.request('ping')).result, {});
  assert.deepEqual((await c.request('server/discover', {})).error.code, -32601);
  c.send('this is not json');
  const bad = await c.waitFor(m => m.error?.code === -32700);
  assert.ok(bad, 'an unparsable line gets a parse error');
  assert.equal(bad.id, null);
  assert.ok(c.messages.every(m => m.id !== undefined || m.method), 'the initialized notification got no answer');
});

test('tools/list for a current client marks keep and proposals, gives each schema its consent variant, and hints the read-only tools', async t => {
  const v = liveVault(t);
  const c = await open(t, v, CC);
  const tools = await list(c);
  assert.deepEqual(tools.map(x => x.name), ROWS);
  assert.deepEqual(tools.filter(x => x._meta).map(x => [x.name, x._meta]), [['keep', MARKER], ['proposals', MARKER]]);
  assert.deepEqual(tools.filter(x => x.annotations).map(x => [x.name, x.annotations]), [['search', { readOnlyHint: true }], ['status', { readOnlyHint: true }]]);
  assert.equal(tools[0].description, 'propose for prompt');
  assert.deepEqual(Object.keys(tools.find(x => x.name === 'keep').inputSchema.properties), ['id', 'offer']);
});

test('tools/list for a client older than the marker marks nothing', async t => {
  const v = liveVault(t);
  const c = await open(t, v, { name: 'claude-code', version: '2.1.200' });
  const tools = await list(c);
  assert.deepEqual(tools.map(x => x.name), ROWS);
  assert.deepEqual(tools.filter(x => x._meta), []);
});

test('tools/list for a code client marks nothing, asks for the code variant and hints search and status', async t => {
  const v = liveVault(t, { agents: ['claude-code', 'codex'] });
  const c = await open(t, v, CODEX);
  const tools = await list(c);
  assert.deepEqual(tools.map(x => x.name), ROWS);
  assert.deepEqual(tools.filter(x => x._meta), []);
  assert.deepEqual(tools.filter(x => x.annotations?.readOnlyHint).map(x => x.name), ['search', 'status']);
  assert.ok(tools.every(x => x.description === `${x.name} for code`), tools.map(x => x.description).join(', '));
  assert.deepEqual(Object.keys(tools.find(x => x.name === 'keep').inputSchema.properties), ['id', 'offer']);
});

test('a script whose --schema fails is left out of tools/list and logged, and the rest are listed', async t => {
  const v = liveVault(t, { failing: ['pick', 'log'] });
  const c = await open(t, v, CC);
  assert.deepEqual((await list(c)).map(x => x.name), ROWS.filter(n => n !== 'pick' && n !== 'log'));
  const log = v.read('.state/errors.log');
  assert.match(log, /pick\.mjs --schema prompt failed: .*no schema here/);
  assert.match(log, /log\.mjs --schema prompt failed/);
});

test('a bound call runs the script from .live/tools with the session from its record, its arguments on stdin and no session variable', async t => {
  const v = liveVault(t);
  const sid = sessionId();
  await registered(v, sid);
  await recorded(v, { call: 'toolu_k1', session: sid, tool: 'keep', offer: 'o-1a2b3c4d' });
  await recorded(v, { call: 'toolu_p1', session: sid, tool: 'propose' });
  await recorded(v, { call: 'toolu_l1', session: sid, tool: 'log' });
  await recorded(v, { call: 'toolu_s1', session: sid, tool: 'search' });
  const c = await open(t, v, CC);
  await list(c);
  const kept = await call(c, 'keep', { id: 'o-1a2b3c4d', offer: 'line' }, ccMeta('toolu_k1'));
  assert.equal(kept.isError, undefined, textOf(kept));
  const seen = JSON.parse(textOf(kept));
  assert.equal(textOf(kept), JSON.stringify(seen), 'stdout comes back with its trailing lines trimmed');
  assert.deepEqual(seen.args, [sid, 'toolu_k1']);
  assert.deepEqual(JSON.parse(seen.input), { id: 'o-1a2b3c4d', offer: 'line' });
  assert.equal(seen.from, 'live');
  assert.equal(path.resolve(seen.cwd).toLowerCase(), path.resolve(v.root).toLowerCase());
  assert.deepEqual(seen.sessionVars, []);
  const { readCall } = await v.import('lib/calls.mjs');
  assert.ok(readCall('toolu_k1').allowed, 'a marked call that reached the server was allowed at the prompt');
  assert.deepEqual(JSON.parse(textOf(await call(c, 'propose', {}, ccMeta('toolu_p1')))).args, [sid, 'toolu_p1']);
  assert.equal(readCall('toolu_p1').allowed, null, 'an unmarked call is not allowed');
  assert.deepEqual(JSON.parse(textOf(await call(c, 'log', undefined, ccMeta('toolu_l1')))), { ...seen, script: 'log', args: ['--json', sid], input: '{}' });
  assert.deepEqual(JSON.parse(textOf(await call(c, 'search', { words: 'x' }, ccMeta('toolu_s1')))).args, ['--json']);
});

test('a script that fails comes back as its stderr with isError', async t => {
  const v = liveVault(t);
  const sid = sessionId();
  await registered(v, sid);
  v.write('.live/tools/status.mjs', "process.stderr.write('Refused: no status today.\\n\\n'); process.exit(1);\n");
  await recorded(v, { call: 'toolu_x1', session: sid, tool: 'status' });
  const c = await open(t, v, CC);
  assert.deepEqual(await call(c, 'status', {}, ccMeta('toolu_x1')), { content: [{ type: 'text', text: 'Refused: no status today.' }], isError: true });
});

test('a script that exits without reading its input still answers by its exit code and output', async t => {
  const v = liveVault(t);
  const sid = sessionId();
  await registered(v, sid);
  v.write('.live/tools/status.mjs', "process.stdout.write('status, unread input\\n');\n");
  await recorded(v, { call: 'toolu_e1', session: sid, tool: 'status' });
  const c = await open(t, v, CC);
  assert.deepEqual(await call(c, 'status', { big: 'x'.repeat(4 << 20) }, ccMeta('toolu_e1')), { content: [{ type: 'text', text: 'status, unread input' }] });
  assert.deepEqual((await c.request('ping')).result, {}, 'the server is still up');
});

test('a session in the vault folder runs the scripts in tools/, not .live/tools', async t => {
  const v = liveVault(t);
  v.write('tools/status.mjs', stub('status', { from: 'tools' }));
  const sid = sessionId();
  await registered(v, sid, { cwd: v.root });
  await recorded(v, { call: 'toolu_v1', session: sid, tool: 'status' });
  const c = await open(t, v, CC);
  assert.equal(JSON.parse(textOf(await call(c, 'status', {}, ccMeta('toolu_v1')))).from, 'tools');
});

test('the server refuses a call it cannot bind, and runs nothing', async t => {
  const v = liveVault(t, { agents: ['claude-code', 'codex'] });
  const sid = sessionId();
  await registered(v, sid);
  await recorded(v, { call: 'toolu_r1', session: sid, tool: 'propose' });
  await recorded(v, { call: 'call_c1', session: sid, tool: 'propose' });
  await recorded(v, { call: 'call_c2', session: sid, subagent: 'agent-7', tool: 'propose' });
  const c = await open(t, v, CC);
  const refused = async (name, meta, text) => {
    const r = await call(c, name, {}, meta);
    assert.deepEqual(r, { content: [{ type: 'text', text }], isError: true }, `${name} ${JSON.stringify(meta)}`);
  };
  await refused('propose', undefined, NO_ID);
  await refused('propose', {}, NO_ID);
  await refused('propose', ccMeta('toolu_none'), NO_RECORD);
  await refused('keep', ccMeta('toolu_r1'), MISMATCH);
  const codex = await open(t, v, CODEX);
  const r = await call(codex, 'propose', {}, { callId: 'call_c1', threadId: 'another-thread' });
  assert.deepEqual(r, { content: [{ type: 'text', text: MISMATCH }], isError: true });
  assert.deepEqual(runs(v), []);
  assert.deepEqual(JSON.parse(textOf(await call(codex, 'propose', {}, { callId: 'call_c1', threadId: sid }))).args, [sid, 'call_c1']);
  assert.deepEqual(JSON.parse(textOf(await call(codex, 'propose', {}, { callId: 'call_c2', threadId: 'subagent-thread' }))).args, [sid, 'call_c2'], "a subagent's thread is its own");
  const unknown = await c.request('tools/call', { name: 'nope', arguments: {}, _meta: ccMeta('toolu_r1') });
  assert.equal(unknown.error.code, -32602);
});

test('the server answers only the clients vault.config.json lists, at their minimum version', async t => {
  const v = liveVault(t);
  const sid = sessionId();
  await registered(v, sid);
  await recorded(v, { call: 'call_u1', session: sid, tool: 'propose' });
  await recorded(v, { call: 'toolu_o1', session: sid, tool: 'propose' });
  const codex = await open(t, v, CODEX);
  assert.deepEqual(await call(codex, 'propose', {}, { callId: 'call_u1', threadId: sid }), { content: [{ type: 'text', text: UNLISTED }], isError: true });
  assert.deepEqual((await list(codex)).map(x => x.name), ROWS, 'an unlisted client still sees the tools, so a call says why it is refused');
  const old = await open(t, v, { name: 'claude-code', version: '2.1.200' });
  assert.deepEqual(await call(old, 'propose', {}, ccMeta('toolu_o1')), {
    content: [{ type: 'text', text: "`claude-code` `2.1.200` is older than `2.1.295`, which the vault's tools need. Update it." }], isError: true,
  });
  const none = await open(t, v, { name: 'claude-code' });
  assert.match(textOf(await call(none, 'propose', {}, ccMeta('toolu_o1'))), /^`claude-code` `` is older than `2\.1\.295`/);
  assert.deepEqual(runs(v), []);
});

test('a marked tool this connection never listed with its marker is refused, runs nothing and stays unallowed', async t => {
  const v = liveVault(t, { agents: ['codex'] });
  const sid = sessionId();
  await registered(v, sid);
  await recorded(v, { call: 'toolu_m1', session: sid, tool: 'keep', offer: 'o-1a2b3c4d' });
  await recorded(v, { call: 'toolu_m2', session: sid, tool: 'proposals' });
  const c = await open(t, v, CC);
  assert.deepEqual((await list(c)).filter(x => x._meta), [], 'listed before claude-code is in vault.config.json, so unmarked');
  const conf = JSON.parse(v.read('vault.config.json'));
  v.write('vault.config.json', JSON.stringify({ ...conf, agents: ['claude-code', 'codex'] }));
  assert.deepEqual(await call(c, 'keep', { id: 'o-1a2b3c4d', offer: 'line' }, ccMeta('toolu_m1')), { content: [{ type: 'text', text: UNPROMPTED }], isError: true });
  const fresh = await open(t, v, CC);
  assert.deepEqual(await call(fresh, 'proposals', { mode: 'off' }, ccMeta('toolu_m2')), { content: [{ type: 'text', text: UNPROMPTED }], isError: true }, 'a connection that never listed');
  assert.deepEqual(runs(v), []);
  const { readCall } = await v.import('lib/calls.mjs');
  assert.equal(readCall('toolu_m1').allowed, null);
  assert.equal(readCall('toolu_m2').allowed, null);
  assert.equal((await list(c)).filter(x => x._meta).length, 2);
  assert.equal((await call(c, 'keep', { id: 'o-1a2b3c4d', offer: 'line' }, ccMeta('toolu_m1'))).isError, undefined, 'listed with its marker, it runs');
});

test('a request whose method is not a string gets Invalid Request with its id, and a response is dropped', async t => {
  const v = liveVault(t);
  const c = await open(t, v, CC);
  c.send({ jsonrpc: '2.0', id: 99, method: 5 });
  c.send({ jsonrpc: '2.0', id: 98 });
  c.send({ jsonrpc: '2.0', id: 97, result: {} });
  const bad = await c.waitFor(m => m.id === 99);
  assert.deepEqual(bad, { jsonrpc: '2.0', id: 99, error: { code: -32600, message: 'Invalid Request' } });
  assert.deepEqual((await c.waitFor(m => m.id === 98)).error.code, -32600);
  assert.deepEqual((await c.request('ping')).result, {});
  assert.ok(!c.messages.some(m => m.id === 97), 'a response from the client gets no answer');
});

test('the server tells the client when .live/tools is rebuilt', async t => {
  const v = liveVault(t);
  const c = await open(t, v, CC);
  await list(c);
  fs.renameSync(v.at('.live', 'tools'), v.at('.live', 'tools.old'));
  fs.cpSync(v.at('.live', 'tools.old'), v.at('.live', 'tools'), { recursive: true });
  assert.ok(await c.waitFor(m => m.method === 'notifications/tools/list_changed', 9000), 'list_changed came within two re-stats');
});

test('a propose call through the server writes triggers with backslashes exactly', async t => {
  const v = liveVault(t, { stubs: false });
  const sid = sessionId();
  v.startSession(sid);
  await recorded(v, { call: 'toolu_t1', session: sid, tool: 'propose' });
  const c = await open(t, v, CC);
  const triggers = ['\\bzebra\\b', 'quartz\\\\s'];
  const r = await call(c, 'propose', {
    domain: 'glim', slug: 'new-rule', topic: 'code', basis: 'reading', reading: 'The user rewrote the screen twice.',
    do: 'Zebra quartz mango.', not: 'Plover lantern ember.', applies_to: ['src/new/**'], triggers,
  }, ccMeta('toolu_t1'));
  assert.equal(r.isError, undefined, textOf(r));
  assert.deepEqual(parse(v.read('wiki/glim/rules/new-rule.md')).data.triggers, triggers);
});

test("a subagent's propose through the server queues the rule for the user's review and makes no offer", async t => {
  const v = liveVault(t, { stubs: false });
  const sid = sessionId();
  v.startSession(sid);
  await recorded(v, { call: 'toolu_q1', session: sid, subagent: 'agent-7', tool: 'propose' });
  const c = await open(t, v, CC);
  const r = await call(c, 'propose', {
    domain: 'glim', slug: 'sub-rule', topic: 'code', basis: 'reading', reading: 'The build failed twice on quartz.',
    do: 'Zebra quartz mango.', not: 'Plover lantern ember.', applies_to: ['src/sub/**'],
  }, ccMeta('toolu_q1'));
  assert.equal(r.isError, undefined, textOf(r));
  const id = /^Queued `(u-[0-9a-f]{8})` for the user's review; nothing is written\. Tell your caller what you queued\.$/.exec(textOf(r))?.[1];
  assert.ok(id, textOf(r));
  assert.ok(!v.exists('wiki/glim/rules/sub-rule.md'));
  assert.deepEqual(fs.existsSync(v.at('.state', 'offers')) ? fs.readdirSync(v.at('.state', 'offers')).filter(f => f.endsWith('.json')) : [], []);
  const rows = fs.readdirSync(v.at('raw', 'queue')).flatMap(f => v.read(`raw/queue/${f}`).trim().split('\n').map(l => JSON.parse(l)));
  assert.deepEqual(rows.map(x => [x.id, x.kind, x.why, x.unattended, x.from, x.session, x.key]), [[id, 'rule', 'unattended', 'subagent', null, sid, 'glim/sub-rule']]);
});

test('pending until package B: the real propose and keep answer --schema, and keep takes id and offer on both clients', async t => {
  const v = liveVault(t, { stubs: false, agents: ['claude-code', 'codex'] });
  const ready = ['propose.mjs', 'keep.mjs'].every(s => v.exists(`tools/${s}`) && v.run(s, ['--schema']).code === 0);
  if (!ready) return t.skip('pending: propose.mjs and keep.mjs --schema land with package B');
  for (const client of [CC, CODEX]) {
    const tools = await list(await open(t, v, client));
    const keep = tools.find(x => x.name === 'keep');
    assert.ok(tools.some(x => x.name === 'propose'), client.name);
    assert.deepEqual(Object.keys(keep.inputSchema.properties).sort(), ['id', 'offer'], client.name);
    assert.ok(keep.description.length <= 400, client.name);
  }
});

test('the real pick, log, search and status are listed on both clients, with descriptions within 400 characters', async t => {
  const v = liveVault(t, { stubs: false, agents: ['claude-code', 'codex'] });
  for (const client of [CC, CODEX]) {
    const tools = await list(await open(t, v, client));
    for (const name of ['pick', 'log', 'search', 'status']) {
      const tool = tools.find(x => x.name === name);
      assert.ok(tool, `${client.name}: ${name} is listed`);
      assert.equal(tool.inputSchema.type, 'object', name);
      assert.ok(tool.description.length <= 400, name);
    }
  }
});

test('the launcher fails loudly: one stderr line, exit 1', async t => {
  const v = makeVault(t);
  const cases = [
    [[], /^vault mcp failed: no vault folder given; pass the vault checkout's absolute path as the first argument\n$/],
    [['relative/vault'], /^vault mcp failed: the vault folder "relative\/vault" is not an absolute path\n$/],
    [[v.at('gone')], /^vault mcp failed: .*gone does not exist; pass the vault checkout's absolute path as the first argument\n$/],
    [[v.root], /^vault mcp failed: .*vault-test-\w+ is not a git clone, so \.live\/tools can't be made from its last commit; clone the vault with git clone https:\/\/github\.com\/osabased\/obsidian-vault instead of downloading it, and pass the vault checkout's absolute path as the first argument\n$/],
  ];
  for (const [args, line] of cases) {
    const c = connect(t, args);
    c.child.stdin.end();
    const { code, stderr } = await c.exited;
    assert.equal(code, 1, args.join(' '));
    assert.match(stderr, line, args.join(' '));
    assert.deepEqual(c.messages, []);
  }
});

test("the launcher makes .live/tools from the vault's last commit, then serves from it", async t => {
  const v = makeVault(t);
  v.checkout();
  const tools = await list(await open(t, v));
  assert.ok(tools.some(x => x.name === 'status'), 'status is listed');
  assert.ok(v.exists('.live/tools/mcp/server.mjs'));
});

test('the launcher reads a Git Bash drive path as the Windows one', { skip: process.platform !== 'win32' }, async t => {
  const v = liveVault(t);
  const gitBash = v.root.replaceAll('\\', '/').replace(/^([a-z]):/i, (_, d) => `/${d.toLowerCase()}`);
  const c = connect(t, [gitBash]);
  const r = await c.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: CC });
  assert.equal(r.result.serverInfo.name, 'vault');
});

test('the server exits when its input ends', async t => {
  const v = liveVault(t);
  const c = await open(t, v, CC);
  c.child.stdin.end();
  assert.equal((await c.exited).code, 0);
});

test('plugin.json starts the vault server through the launcher with the vault option', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.deepEqual(manifest.mcpServers, { vault: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/mcp/launch.mjs', '${user_config.vault}'] } });
});
