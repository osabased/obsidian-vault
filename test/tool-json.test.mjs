import test from 'node:test';
import assert from 'node:assert/strict';
import { makeVault, ruleNote, pageNote as page, sessionId, userTurn } from './fixture.mjs';

// The MCP server drives these tools with JSON on stdin; each one's JSON must do what its argv form does.
const SAID = 'keep the cards roomy';

function started(t) {
  const v = makeVault(t);
  const sid = sessionId();
  v.startSession(sid, { transcript: v.transcript(sid, [userTurn(SAID)]) });
  return { v, sid };
}

const schemaOf = (v, script, ...args) => {
  const r = v.run(script, ['--schema', ...args]);
  assert.equal(r.code, 0, `${script}: ${r.stderr}`);
  return JSON.parse(r.stdout);
};

test('every tool prints a --schema of a description and an object inputSchema, for either variant', t => {
  const v = makeVault(t);
  const fields = {
    'pick.mjs': ['show', 'subject', 'question', 'options', 'pick', 'status', 'confirms', 'comment', 'domain', 'project', 'notes', 'reason', 'sheet', 'replaces', 'header'],
    'log.mjs': ['pages', 'ingest', 'batch', 'query'],
    'search.mjs': ['words', 'domain', 'kind', 'topic', 'raw', 'limit'],
    'status.mjs': [],
  };
  for (const [script, names] of Object.entries(fields)) {
    const s = schemaOf(v, script);
    assert.deepEqual(schemaOf(v, script, 'prompt'), s, script);
    assert.deepEqual(schemaOf(v, script, 'code'), s, script);
    assert.ok(s.description.length > 0 && s.description.length <= 400, `${script} description is ${s.description.length} chars`);
    assert.equal(s.inputSchema.type, 'object');
    assert.equal(s.inputSchema.additionalProperties, false);
    assert.deepEqual(Object.keys(s.inputSchema.properties).sort(), [...names].sort(), script);
    for (const p of Object.values(s.inputSchema.properties)) assert.ok(p.type, script);
    assert.equal(v.run(script, ['--schema', 'other']).code, 2, script);
  }
  const search = schemaOf(v, 'search.mjs').inputSchema;
  assert.deepEqual(search.required, ['words']);
  assert.equal(search.properties.limit.type, 'number');
  assert.equal(search.properties.raw.type, 'boolean');
  assert.deepEqual(schemaOf(v, 'log.mjs').inputSchema.required, ['pages']);
});

test('pick show: JSON prints what the argv form prints, for a domain and project too, and refuses strays', t => {
  const { v, sid } = started(t);
  const made = v.run('pick.mjs', [sid], { input: { subject: 'cards', comment: SAID } });
  assert.equal(made.code, 0, made.stderr);
  const argv = v.run('pick.mjs', ['show', sid, 'cards']);
  assert.equal(argv.code, 0, argv.stderr);
  assert.match(argv.stdout, /^Picks for cards in /);
  const json = v.run('pick.mjs', [sid], { input: { show: 'cards' } });
  assert.deepEqual(json, argv);
  const full = v.run('pick.mjs', ['show', sid, 'cards', 'glim', v.project]);
  assert.equal(full.code, 0, full.stderr);
  assert.deepEqual(v.run('pick.mjs', [sid], { input: { show: 'cards', domain: 'glim', project: v.project } }), full);
  assert.match(v.run('pick.mjs', [sid], { input: { show: 'nothing-here' } }).stdout, /^No picks for nothing-here in /);

  for (const input of [{ show: 'cards', comment: 'x' }, { show: 'cards', subject: 'cards' }, { show: 'Not Kebab' }, { show: 'cards', domain: 'nope' }]) {
    const r = v.run('pick.mjs', [sid], { input });
    assert.equal(r.code, 1, JSON.stringify(input));
    assert.match(r.stderr, /^Not shown: /, JSON.stringify(input));
  }
});

test('log: JSON with --json <sid> logs what the argv form logs, naming the session', t => {
  const { v, sid } = started(t);
  v.write('raw/refs/shop.png', 'png');
  v.write('wiki/glim/source-shop.md', page({ kind: 'source', source: 'raw/refs/shop.png' }));
  v.write('wiki/glim/code.md', page({ kind: 'topic', body: ['## Rules'] }));
  const logged = () => v.read('log.md').trim().split('\n').map(l => l.replace(/^- \d{4}-\d\d-\d\d \d\d:\d\d · /, ''));
  const env = { CLAUDE_CODE_SESSION_ID: sid };
  const cases = [
    [['wiki/glim/code.md'], { pages: ['wiki/glim/code.md'] }],
    [['ingest', 'raw/refs/shop.png', 'wiki/glim/source-shop.md', 'wiki/glim/code.md'], { ingest: 'raw/refs/shop.png', pages: ['wiki/glim/source-shop.md', 'wiki/glim/code.md'] }],
    [['ingest', '--batch', 'https://example.com/notes', 'wiki/glim/code.md'], { ingest: 'https://example.com/notes', batch: true, pages: ['wiki/glim/code.md'] }],
    [['query', 'How should tab bars space their tabs?', 'wiki/glim/code.md'], { query: 'How should tab bars space their tabs?', pages: ['wiki/glim/code.md'] }],
  ];
  for (const [args, input] of cases) {
    const a = v.run('log.mjs', args, { env });
    assert.equal(a.code, 0, a.stderr);
    const j = v.run('log.mjs', ['--json', sid], { input });
    assert.equal(j.code, 0, j.stderr);
    assert.deepEqual(j, a, args.join(' '));
  }
  const lines = logged();
  assert.equal(lines.length, 8);
  for (let i = 0; i < 8; i += 2) assert.equal(lines[i], lines[i + 1]);
  assert.match(lines[0], new RegExp(`^wrote page glim/code · session ${sid.slice(0, 8)}$`));
});

test('log: JSON that does not name one operation, or names a wrong page, logs nothing', t => {
  const { v, sid } = started(t);
  v.write('wiki/glim/code.md', page({ kind: 'topic', body: ['## Rules'] }));
  v.write('raw/refs/shop.png', 'png');
  const pages = ['wiki/glim/code.md'];
  for (const [input, code] of [
    [{}, 2],
    [{ pages: [] }, 2],
    [{ pages: pages.concat(pages) }, 2],
    [{ pages, batch: true }, 2],
    [{ pages, ingest: 'raw/refs/shop.png', query: 'Why?' }, 2],
    [{ ingest: 'raw/refs/shop.png' }, 2],
    [{ query: '  ', pages }, 2],
    [{ pages, extra: 1 }, 2],
    [{ pages: 'wiki/glim/code.md' }, 2],
    [{ pages: ['wiki/glim/nope.md'] }, 1],
    [{ ingest: 'raw/refs/missing.png', pages }, 1],
  ]) {
    const r = v.run('log.mjs', ['--json', sid], { input });
    assert.equal(r.code, code, `${JSON.stringify(input)}: ${r.stderr}`);
  }
  assert.equal(v.exists('log.md'), false);
  assert.equal(v.run('log.mjs', ['--json'], { input: 'not json' }).code, 2);
});

test('search: JSON prints what the argv form prints, with every option', t => {
  const v = makeVault(t);
  v.write('wiki/glim/rules/zebra-stripes.md', ruleNote({ keywords: ['zebra'], doLine: 'Paint zebra.' }));
  v.write('wiki/glim/concepts/zebra.md', page({ kind: 'concept', keywords: ['zebra'], summary: "'Zebra stripes.'" }));
  v.write('raw/refs/zebra-notes.md', 'Zebra notes on stripes.\n');
  const cases = [
    [['zebra'], { words: 'zebra' }],
    [['zebra', 'stripes'], { words: 'zebra stripes' }],
    [['zebra', '--domain', 'glim', '--kind', 'rule', '--limit', '1'], { words: 'zebra', domain: 'glim', kind: 'rule', limit: 1 }],
    [['zebra', '--topic', 'layout'], { words: 'zebra', topic: 'layout' }],
    [['zebra', '--raw'], { words: 'zebra', raw: true }],
    [['nothing-matches-this'], { words: 'nothing-matches-this' }],
  ];
  for (const [args, input] of cases) {
    const a = v.run('search.mjs', args);
    assert.equal(a.code, 0, a.stderr);
    assert.match(a.stdout, /\S/);
    assert.deepEqual(v.run('search.mjs', ['--json'], { input }), a, args.join(' '));
  }
  for (const input of [{}, { words: '' }, { words: 3 }, { words: 'zebra', limit: 0 }, { words: 'zebra', limit: 1.5 }, { words: 'zebra', limit: '2' }, { words: 'zebra', kind: 'nope' }, { words: 'zebra', raw: 'yes' }, { words: 'zebra', extra: 1 }]) {
    const r = v.run('search.mjs', ['--json'], { input });
    assert.equal(r.code, 2, `${JSON.stringify(input)}: ${r.stderr}`);
  }
  assert.equal(v.run('search.mjs', ['--json'], { input: 'nope' }).code, 2);
});

test('status: [sid] with {} on stdin prints what the argv form prints, and fields are refused', t => {
  const { v, sid } = started(t);
  const a = v.run('status.mjs', [sid]);
  assert.equal(a.code, 0, a.stderr);
  assert.deepEqual(v.run('status.mjs', [sid], { input: {} }), a);
  assert.deepEqual(v.run('status.mjs', [sid], { input: '' }), a);
  assert.equal(v.run('status.mjs', ['no-such-session'], { input: {} }).code, 1);
});
