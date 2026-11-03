import test from 'node:test';
import assert from 'node:assert/strict';
import { makeVault, sessionId } from './fixture.mjs';

// The scripts that read their fields as JSON on stdin say why the input was refused before the usage, since an agent
// whose shell mangled a backslash otherwise sees only the usage and guesses.
const SCRIPTS = ['propose.mjs', 'pick.mjs', 'proposals.mjs', 'domain.mjs', 'keep.mjs'];

function started(t) {
  const v = makeVault(t);
  const sid = sessionId();
  v.startSession(sid);
  return { v, sid };
}

test('JSON that does not parse exits 2 with the parser\'s reason and where, then the usage', t => {
  const { v, sid } = started(t);
  for (const script of SCRIPTS) {
    const r = v.run(script, [sid], { input: '{"triggers": ["export\\s+function"]}' });
    assert.equal(r.code, 2, script);
    assert.match(r.stderr, /^The input isn't valid JSON: Bad escaped character in JSON at position \d+.*\.\nusage: node tools\//, script);
    assert.equal(v.exists('raw/inbox'), false, script);
  }
});

test('no input, or JSON that is not an object, exits 2 saying so', t => {
  const { v, sid } = started(t);
  for (const script of SCRIPTS) {
    assert.match(v.run(script, [sid], { input: ' \n' }).stderr, /^No JSON came on stdin\.\nusage: /, script);
    for (const input of ['[1]', 'null', '"x"']) {
      const r = v.run(script, [sid], { input });
      assert.equal(r.code, 2, `${script} ${input}`);
      assert.match(r.stderr, /^The input must be one JSON object\.\nusage: /, `${script} ${input}`);
    }
  }
});

// The helpers are checked on the copy in a fixture vault like the tools, since lib/ finds the vault from its own place.
const helpers = async t => (await makeVault(t).import('lib/input.mjs'));

test('line and lines refuse a control character, U+0008 among them, and name it', async t => {
  const { line, lines, Refused } = await helpers(t);
  for (const c of ['\u0008', '\u0000', '\u001B', '\u007F', '\u0085', '\u000B']) {
    const hex = c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0');
    assert.throws(() => line({ x: `a${c}b` }, 'x'), e => e instanceof Refused && e.message.startsWith('x holds a control character, U+') && e.message.includes(`U+${hex},`), hex);
    assert.throws(() => lines({ y: ['ok', `a${c}b`] }, 'y'), e => e instanceof Refused && e.message.includes(`U+${hex},`), hex);
  }
});

test('line trims, refuses a tab inside, and its one-line check comes first', async t => {
  const { line } = await helpers(t);
  assert.equal(line({ x: '  a b ' }, 'x'), 'a b');
  assert.throws(() => line({ x: 'a\tb' }, 'x'), /U\+0009,/);
  assert.throws(() => line({ x: 'a\n\u0008b' }, 'x'), /x must be one line\./);
  assert.throws(() => line({ x: 3 }, 'x'), /x must be a string\./);
  assert.throws(() => line({}, 'x'), /x is missing\./);
  assert.equal(line({}, 'x', false), '');
});

test('lines takes a list of one-line strings, trimmed, and an absent field gives an empty list', async t => {
  const { lines } = await helpers(t);
  assert.deepEqual(lines({ y: [' a ', 'b'] }, 'y'), ['a', 'b']);
  assert.deepEqual(lines({}, 'y'), []);
  for (const bad of ['a', [1], [''], ['a\nb'], [' ']]) assert.throws(() => lines({ y: bad }, 'y'), /y must be a list of one-line strings\./, JSON.stringify(bad));
});

const FIELDS = [
  { name: 'domain', type: 'string', required: true, help: ['this session\'s domain, or global', 'for every project'] },
  { name: 'do', type: 'string', label: 'do, not', help: ['one line each'] },
  { name: 'not', type: 'string' },
  { name: 'keywords', type: 'string[]', help: ['words a request would use'] },
  { name: 'basis', type: 'string', enum: ['stated', 'pick'], help: ['what to cite:'] },
  { label: 'stated', indent: 2, help: ['their words', '  quote: as typed', 'second line'] },
  { name: 'quote', type: 'string', describe: 'see basis' },
  { name: 'options', type: 'object[]', items: { type: 'object', properties: { label: { type: 'string' } }, required: ['label'], additionalProperties: false }, help: ['at least two'] },
  { text: ['', 'A group:'] },
  { name: 'ok', type: 'boolean', help: ['true or false'] },
  { name: 'limit', type: 'number', help: ['a count'] },
  { label: 'notes, reason', help: ['as above'] },
];
const HEAD = ['usage: node tools/x.mjs [session-id] < x.json', '', 'x.json is an object with these fields:'];
const TAIL = ['', 'Last line.'];
const RENDERED = [
  ...HEAD,
  "  domain       this session's domain, or global",
  '               for every project',
  '  do, not      one line each',
  '  keywords     words a request would use',
  '  basis        what to cite:',
  '    stated       their words',
  '                   quote: as typed',
  '                 second line',
  '  options      at least two',
  '',
  'A group:',
  '  ok           true or false',
  '  limit        a count',
  '  notes, reason  as above',
  ...TAIL,
].join('\n');

test('renderHelp lays out rows at the label width, with entries, indents and literal blocks as the scripts\' help does', async t => {
  const { renderHelp } = await helpers(t);
  assert.equal(renderHelp(HEAD, FIELDS, TAIL, 13), RENDERED);
  assert.equal(renderHelp(HEAD.join('\n'), FIELDS, TAIL.join('\n'), 13), RENDERED);
  assert.equal(renderHelp(['a'], [{ name: 'm', type: 'string', help: ['x'] }, { name: 'mm', type: 'string', help: ['y', 'z'] }], [], 6), 'a\n  m     x\n  mm    y\n        z');
});

test('schemaOf gives the description and an object schema with a property per named field', async t => {
  const { schemaOf } = await helpers(t);
  const s = schemaOf('Proposes a rule.', FIELDS);
  assert.deepEqual(Object.keys(s), ['description', 'inputSchema']);
  assert.equal(s.description, 'Proposes a rule.');
  assert.deepEqual(s.inputSchema.required, ['domain']);
  assert.equal(s.inputSchema.type, 'object');
  assert.equal(s.inputSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(s.inputSchema.properties), ['domain', 'do', 'not', 'keywords', 'basis', 'quote', 'options', 'ok', 'limit']);
  const p = s.inputSchema.properties;
  assert.deepEqual(p.domain, { type: 'string', description: "this session's domain, or global for every project" });
  assert.deepEqual(p.not, { type: 'string' });
  assert.deepEqual(p.keywords, { type: 'array', items: { type: 'string' }, description: 'words a request would use' });
  assert.deepEqual(p.basis, { type: 'string', enum: ['stated', 'pick'], description: 'what to cite:' });
  assert.deepEqual(p.quote, { type: 'string', description: 'see basis' });
  assert.equal(p.options.type, 'array');
  assert.deepEqual(p.options.items.required, ['label']);
  assert.equal(p.ok.type, 'boolean');
  assert.equal(p.limit.type, 'number');
  assert.deepEqual(JSON.parse(JSON.stringify(s)), s);
  assert.deepEqual(schemaOf('d', [{ name: 'a', type: 'object[]' }]).inputSchema, { type: 'object', properties: { a: { type: 'array', items: { type: 'object' } } }, required: [], additionalProperties: false });
});

test('schemaArg reads --schema and an optional variant and nothing else', async t => {
  const { schemaArg, UsageError } = await helpers(t);
  assert.equal(schemaArg([]), null);
  assert.equal(schemaArg(['abc-123']), null);
  assert.equal(schemaArg(['--help']), null);
  assert.equal(schemaArg(['--schema']), 'prompt');
  assert.equal(schemaArg(['--schema', 'prompt']), 'prompt');
  assert.equal(schemaArg(['--schema', 'code']), 'code');
  assert.throws(() => schemaArg(['--schema', 'other']), UsageError);
  assert.throws(() => schemaArg(['--schema', 'code', 'x']), UsageError);
});

// The help is what a shell run reads, and the schema what the vault's tools hand a client; both come from one fields
// list, so a field named in one is named in the other.
const TOOLS = ['propose.mjs', 'proposals.mjs', 'domain.mjs', 'keep.mjs'];

test('keep and proposals print their fields as pinned, and no script asks for approved', t => {
  const v = makeVault(t);
  const help = script => {
    const r = v.run(script, ['--help']);
    assert.equal(r.code, 0, `${script}: ${r.stderr}`);
    return r.stdout;
  };
  assert.equal(help('keep.mjs'), [
    'usage: node tools/keep.mjs [session-id] [call-id] < keep.json',
    '',
    'keep.json is an object with these fields:',
    '  id       the id of the offer, like o-1a2b3c4d, as propose, domain or proposals returned it',
    "  offer    the offer's lines, exactly as they were returned",
    '',
  ].join('\n'));
  assert.equal(help('proposals.mjs'), [
    'usage: node tools/proposals.mjs [session-id] [call-id] < mode.json',
    '',
    'Sets when agents propose rules, in vault.config.json. mode.json is an object with these fields:',
    '  mode       corrections: propose writes a rule as soon as the agent proposes it',
    '             ask: the agent offers each rule, and keep writes it once the user agrees',
    '             off: the agent proposes a rule only when the user asks for one',
    '  domain     optional, a domain to give a mode of its own; without it, or with global, the mode for global and',
    '             every domain without one of its own',
    '',
    'A session in the vault folder proposes as in corrections whatever the mode, since /ingest goes through each rule with',
    'the user.',
    '',
  ].join('\n'));
  assert.match(help('propose.mjs'), /\n {2}asked {8}the user's words asking you to keep the rule, as they typed them in their latest message\. Needed outside\n {15}the vault folder when proposals is off for the domain\.\n/);
  for (const script of TOOLS) assert.doesNotMatch(help(script), /approved/, script);
});

test('--schema prints a short description and a closed schema with every field the help names, for both variants', t => {
  const v = makeVault(t);
  for (const script of TOOLS) {
    const named = [...v.run(script, ['--help']).stdout.matchAll(/^ {2}([a-z_A-Z]+)(?:, ([a-z_]+))? {2,}/gm)].flatMap(m => m.slice(1).filter(Boolean));
    const seen = [];
    for (const variant of ['prompt', 'code']) {
      const r = v.run(script, ['--schema', variant]);
      assert.equal(r.code, 0, `${script} ${variant}: ${r.stderr}`);
      const s = JSON.parse(r.stdout);
      seen.push(s.description);
      assert.ok(s.description.length > 0 && s.description.length <= 400, `${script} ${variant}`);
      assert.equal(s.inputSchema.type, 'object');
      assert.equal(s.inputSchema.additionalProperties, false);
      for (const name of named) assert.ok(Object.hasOwn(s.inputSchema.properties, name), `${script} ${variant} lacks ${name}`);
      assert.ok(!Object.hasOwn(s.inputSchema.properties, 'approved'), script);
    }
    assert.notEqual(seen[0], seen[1], `${script}'s variants say how the user agrees`);
    assert.deepEqual(JSON.parse(v.run(script, ['--schema']).stdout).description, seen[0], script);
  }
});
