import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeVault, sha256, FIXTURE_EXTRACTOR } from './fixture.mjs';

// What extract.mjs writes to derived/ and prints, and what lint says of the extractors it runs (design §8 item 5, 6.4a).

const PAPER = 'raw/refs/paper.pdf';
const found = async v => (await v.import('lib/lint.mjs')).lint();
const configErrors = async v => (await found(v)).filter(f => f.level === 'error' && f.file === 'vault.config.json').map(f => f.msg);
const derivedFiles = v => (v.exists('derived') ? fs.readdirSync(v.at('derived')).sort() : []);
const hashOf = (v, rel) => sha256(fs.readFileSync(v.at(...rel.split('/'))));
const extract = (v, ...args) => v.run('extract.mjs', args);
const allowOf = value => sha256(value).slice(0, 16);
const REMOVE = "Remove it, or add an allow id to privacy.allow in vault.config.json if it isn't a secret, then extract again:";

// An extractor that returns whatever JSON the file holds after its first byte, which keeps the file from reading as
// UTF-8, so a test can hand extract.mjs any result.
const ECHO = [
  "import fs from 'node:fs';",
  "export const kinds = ['pdf'];",
  "export const extensions = ['.echo'];",
  "export const version = '2';",
  'export async function extract(file) {',
  '  await new Promise(resolve => setTimeout(resolve, 5));',
  "  return JSON.parse(fs.readFileSync(file).subarray(1).toString('utf8'));",
  '}',
  '',
].join('\n');
const echoed = result => Buffer.concat([Buffer.from([0xff]), Buffer.from(JSON.stringify(result))]);

function archive(t, config = {}) {
  const v = makeVault(t, { presets: ['archive'], config: { extractors: ['fixture', 'echo'], ...config } });
  v.write('tools/ext/extractors/echo.mjs', ECHO);
  return v;
}

test("extract writes the archive preset's derived text byte for byte", t => {
  const v = archive(t);
  const out = `derived/${hashOf(v, PAPER)}.md`;
  const preset = v.read(out);
  fs.rmSync(v.at(...out.split('/')));
  const r = extract(v, PAPER);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, `wrote ${PAPER}: ${out} (fixture 1.0, 2 pages)\n`);
  assert.equal(v.read(out), preset);
});

test('extract leaves text the same extractor wrote, and --force writes the same bytes again', t => {
  const v = archive(t);
  const out = `derived/${hashOf(v, PAPER)}.md`;
  const before = v.read(out);
  const r = extract(v, PAPER);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, `unchanged ${PAPER}: ${out}\n`);
  const forced = extract(v, PAPER, '--force');
  assert.equal(forced.code, 0, forced.stderr);
  assert.equal(forced.stdout, `wrote ${PAPER}: ${out} (fixture 1.0, 2 pages)\n`);
  assert.equal(v.read(out), before);
});

test("a newer extractor version is lint's drift warning, and extract replaces the text", async t => {
  const v = archive(t);
  const out = `derived/${hashOf(v, PAPER)}.md`;
  v.write('tools/ext/extractors/fixture.mjs', FIXTURE_EXTRACTOR.replace("version = '1.0'", "version = '1.1'"));
  const drift = `made by fixture 1.0, and fixture is 1.1 now. Run node tools/extract.mjs ${PAPER}`;
  assert.deepEqual((await found(v)).filter(f => f.file === out).map(f => f.msg), [drift]);
  const r = extract(v, PAPER);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, `replaced ${PAPER}: ${out} (fixture 1.1 over fixture 1.0)\n`);
  assert.match(v.read(out), /^extractor_version: '1\.1'$/m);
  const lint = v.run('lint.mjs');
  assert.doesNotMatch(lint.stdout, /made by fixture/);
});

test('each failure is a failed line, exits 1 and writes nothing', t => {
  const v = archive(t);
  const page = text => ({ page: 1, text });
  const cases = {
    'raw/refs/talk.mp4': [null, 'no extractor in extractors reads .mp4'],
    'raw/refs/fake.pdf': [Buffer.from([0xff, 0xfe, 0x00, 0x01]), "fixture threw: doesn't start %PDF-"],
    'raw/refs/zero.echo': [echoed({ kind: 'pdf', parts: [{ page: 0, text: 'Nothing.' }] }), 'echo returned page 0'],
    'raw/refs/both.echo': [echoed({ kind: 'pdf', parts: [{ page: 1, t: 3, text: 'Both.' }] }), 'echo returned a part with both page and t'],
    'raw/refs/kind.echo': [echoed({ kind: 'video', parts: [page('A frame.')] }), 'echo returned kind "video", which isn\'t in its kinds'],
    'raw/refs/empty.echo': [echoed({ kind: 'pdf', parts: [] }), 'echo returned no parts'],
    'raw/refs/fall.echo': [echoed({ kind: 'pdf', parts: [page('One.'), { page: 1, text: 'One again.' }] }), 'echo returned page 1 after page 1'],
    'raw/refs/anchor.echo': [echoed({ kind: 'pdf', parts: [page('One.\n[p. 2]\nTwo.')] }), 'echo returned text with a line that reads as an anchor: [p. 2]'],
    'raw/refs/key.echo': [echoed({ kind: 'pdf', parts: [page('Set api_key = "Zq3xV9pL2mK8wR4t" first.')] }), `its text holds 1 key- or token-shaped value. ${REMOVE}\nraw/refs/key.echo:8 assignment api_key=Zq…4t · allow ${allowOf('Zq3xV9pL2mK8wR4t')}`],
  };
  const before = derivedFiles(v);
  for (const [rel, [bytes, why]] of Object.entries(cases)) {
    if (bytes) v.write(rel, bytes);
    const r = extract(v, rel);
    assert.equal(r.code, 1, `${rel}: ${r.stdout}${r.stderr}`);
    assert.equal(r.stdout, `failed ${rel}: ${why}\n`);
    assert.deepEqual(derivedFiles(v), before, rel);
  }
});

test('a refused text lists each value as scan.mjs lists it once the text is written', t => {
  const rel = 'raw/refs/keys.echo';
  const bytes = echoed({ kind: 'pdf', parts: [{ page: 1, text: 'Set api_key = "Zq3xV9pL2mK8wR4t" first.' }, { page: 2, text: 'Then pass Zq3xV9pL2mK8wR4tYb7NcQ1sHf6DgJ0aEu5WiOy.' }] });
  const v = archive(t);
  v.write(rel, bytes);
  const refused = extract(v, rel);
  assert.equal(refused.code, 1);
  const [head, ...found] = refused.stdout.trimEnd().split('\n');
  assert.equal(head, `failed ${rel}: its text holds 2 key- or token-shaped values. Remove them, or add an allow id to privacy.allow in vault.config.json if it isn't a secret, then extract again:`);
  assert.equal(found.length, 2);
  assert.match(v.run('scan.mjs', [rel]).stdout, /^skipped /);
  const ids = found.map(l => l.match(/ · allow ([0-9a-f]{16})$/)[1]);
  const allowed = archive(t, { privacy: { allow: ids } });
  allowed.write(rel, bytes);
  assert.equal(extract(allowed, rel).code, 0);
  const config = JSON.parse(allowed.read('vault.config.json'));
  allowed.write('vault.config.json', JSON.stringify({ ...config, privacy: { allow: [] } }));
  const scan = allowed.run('scan.mjs', [rel]);
  assert.equal(scan.code, 1);
  assert.deepEqual(scan.stdout.trimEnd().split('\n').slice(0, -1), found);
});

test('a key-shaped value privacy.allow lets through is written', t => {
  const v = archive(t);
  const rel = 'raw/refs/key.echo';
  v.write(rel, echoed({ kind: 'pdf', parts: [{ page: 1, text: 'Set api_key = "Zq3xV9pL2mK8wR4t" first.' }] }));
  const id = allowOf('Zq3xV9pL2mK8wR4t');
  const allowed = archive(t, { privacy: { allow: [id] } });
  allowed.write(rel, fs.readFileSync(v.at(...rel.split('/'))));
  assert.equal(extract(v, rel).code, 1);
  const r = extract(allowed, rel);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^wrote raw\/refs\/key\.echo: derived\/[0-9a-f]{64}\.md \(echo 2, 1 page\)\n$/);
});

test('an async extract is awaited, and each part becomes its anchor line', t => {
  const v = archive(t);
  const rel = 'raw/refs/talk.echo';
  v.write(rel, echoed({ kind: 'pdf', parts: [{ t: 0, text: 'Hello.' }, { t: 754, text: 'Later.' }] }));
  const r = extract(v, rel);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, `wrote ${rel}: derived/${hashOf(v, rel)}.md (echo 2, 2 parts)\n`);
  assert.equal(v.read(`derived/${hashOf(v, rel)}.md`), `---\nkind: pdf\nextractor: echo\nextractor_version: '2'\nsource: ${rel}\n---\n[t=00:00:00]\nHello.\n[t=00:12:34]\nLater.\n`);
});

test('a text file is skipped, and several files print a line each in order', t => {
  const v = archive(t);
  v.write('raw/refs/notes.md', 'Plain notes.\n');
  const r = extract(v, 'raw/refs/notes.md', 'raw/refs/talk.mp4', PAPER);
  assert.equal(r.code, 1);
  assert.deepEqual(r.stdout.trimEnd().split('\n'), [
    'skipped raw/refs/notes.md: it is text, so quotes are checked against it as it is',
    'failed raw/refs/talk.mp4: no extractor in extractors reads .mp4',
    `unchanged ${PAPER}: derived/${hashOf(v, PAPER)}.md`,
  ]);
});

test('no file, an unknown flag, or a path outside raw/ or not a file exits 2 and writes nothing', t => {
  const v = archive(t);
  const out = `derived/${hashOf(v, PAPER)}.md`;
  fs.rmSync(v.at(...out.split('/')));
  for (const args of [[], ['--fast', PAPER], ['vault.config.json'], ['raw/refs/missing.pdf'], ['raw/refs'], [PAPER, 'wiki']]) {
    const r = extract(v, ...args);
    assert.equal(r.code, 2, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /usage: node tools\/extract\.mjs/);
    assert.equal(v.exists(out), false, args.join(' '));
  }
});

test('lint errors on each extractor that can not run, and extract refuses to run with one', async t => {
  const v = archive(t);
  const modules = {
    noextract: "export const kinds = ['pdf'];\nexport const extensions = ['.a'];\nexport const version = '1';\n",
    waits: "await Promise.resolve();\nexport const kinds = ['pdf'];\nexport const extensions = ['.b'];\nexport const version = '1';\nexport function extract() {}\n",
    kinds: "export const kinds = ['scroll'];\nexport const extensions = ['.c'];\nexport const version = '1';\nexport function extract() {}\n",
    exts: "export const kinds = ['pdf'];\nexport const extensions = ['PDF'];\nexport const version = '1';\nexport function extract() {}\n",
    unversioned: "export const kinds = ['pdf'];\nexport const extensions = ['.d'];\nexport const version = ' ';\nexport function extract() {}\n",
  };
  for (const [name, text] of Object.entries(modules)) v.write(`tools/ext/extractors/${name}.mjs`, text);
  const config = JSON.parse(v.read('vault.config.json'));
  v.write('vault.config.json', JSON.stringify({ ...config, extractors: ['fixture', 'missing', 'Bad Name', ...Object.keys(modules)] }, null, 2));
  const errors = await configErrors(v);
  const expect = [
    "extractors names missing, and tools/ext/extractors/missing.mjs doesn't exist",
    'extractors: "Bad Name" must name an extension in lowercase letters, digits, - or _',
    'extractors: noextract: tools/ext/extractors/noextract.mjs exports no extract function',
    'extractors: tools/ext/extractors/kinds.mjs must export kinds, a non-empty list of pdf, video, audio or image',
    'extractors: tools/ext/extractors/exts.mjs must export extensions, a list of lowercase file extensions each with its dot, such as .pdf',
    'extractors: tools/ext/extractors/unversioned.mjs must export version, a non-empty string',
  ];
  for (const msg of expect) assert.ok(errors.includes(msg), `missing ${msg}\n${errors.join('\n')}`);
  assert.ok(errors.some(e => e.startsWith('extractors: waits: ') && /async|await/i.test(e)), errors.join('\n'));
  assert.equal(errors.length, expect.length + 1, errors.join('\n'));
  const r = extract(v, PAPER);
  assert.equal(r.code, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /extractors names missing/);
});

test('extractors that is not a list is a lint error', async t => {
  const v = archive(t, { extractors: 'fixture' });
  assert.deepEqual(await configErrors(v), ['extractors must be a list of extractor extension names']);
});

test('a lone CR in a part can not forge an anchor line', t => {
  const v = archive(t);
  const rel = 'raw/refs/cr.echo';
  v.write(rel, echoed({ kind: 'pdf', parts: [{ page: 1, text: 'one\r[p. 9]\rtwo' }, { page: 2, text: 'three' }] }));
  const before = derivedFiles(v);
  const r = extract(v, rel);
  assert.equal(r.code, 1);
  assert.equal(r.stdout, `failed ${rel}: echo returned text with a line that reads as an anchor: [p. 9]\n`);
  assert.deepEqual(derivedFiles(v), before);
});

test('a line that starts like an anchor but is not one fails extraction, naming the line', t => {
  const v = archive(t);
  const page = text => ({ page: 1, text });
  const cases = {
    'raw/refs/roman.echo': [page('Contents\n[p. iv] Preface'), 'echo returned text with a line that starts like an anchor: [p. iv] Preface'],
    'raw/refs/trail.echo': [page('See\n[p. 3] see figure'), 'echo returned text with a line that starts like an anchor: [p. 3] see figure'],
    'raw/refs/clock.echo': [page('A\n  [t=1:00] later'), 'echo returned text with a line that starts like an anchor: [t=1:00] later'],
  };
  const before = derivedFiles(v);
  for (const [rel, [part, why]] of Object.entries(cases)) {
    v.write(rel, echoed({ kind: 'pdf', parts: [part] }));
    const r = extract(v, rel);
    assert.equal(r.code, 1, rel);
    assert.equal(r.stdout, `failed ${rel}: ${why}\n`);
  }
  assert.deepEqual(derivedFiles(v), before);
});

test('a page or time past the safe integers fails extraction', t => {
  const v = archive(t);
  const cases = {
    'raw/refs/bigpage.echo': [{ page: 1e21, text: 'Far.' }, 'echo returned page 1e+21'],
    'raw/refs/bigtime.echo': [{ t: 1e21, text: 'Far.' }, 'echo returned t=1e+21, not whole seconds'],
  };
  for (const [rel, [part, why]] of Object.entries(cases)) {
    v.write(rel, echoed({ kind: 'pdf', parts: [part] }));
    const r = extract(v, rel);
    assert.equal(r.code, 1, rel);
    assert.equal(r.stdout, `failed ${rel}: ${why}\n`);
  }
});

test('anchorsIn and extract read the same lines as anchors', async t => {
  const v = archive(t);
  const { startsLikeAnchor, anchorsIn } = await v.import('lib/sources.mjs');
  for (const line of ['[p. 3]', '[p. iv] Preface', '  [t=1:00]', '[t=00:00:01]']) assert.equal(startsLikeAnchor(line), true, line);
  for (const line of ['See [p. 3]', 'p. 3', '']) assert.equal(startsLikeAnchor(line), false, line);
  assert.deepEqual(anchorsIn('[p. iv] Preface\n[p. 2]\nplain').bad, ['[p. iv] Preface']);
});

test('a throw on a later file keeps the lines of the files before it', t => {
  const v = archive(t);
  v.write('tools/ext/extractors/boom.mjs', [
    "export const kinds = ['pdf'];",
    "export const extensions = ['.boom'];",
    "export const version = '1';",
    "export function extract() { return { get kind() { throw new Error('exploded'); } }; }",
    '',
  ].join('\n'));
  const config = JSON.parse(v.read('vault.config.json'));
  v.write('vault.config.json', JSON.stringify({ ...config, extractors: [...config.extractors, 'boom'] }));
  const ok = 'raw/refs/ok.echo';
  v.write(ok, echoed({ kind: 'pdf', parts: [{ page: 1, text: 'Fine.' }] }));
  v.write('raw/refs/bad.boom', Buffer.from([0xff, 0x01]));
  v.write('raw/refs/last.echo', echoed({ kind: 'pdf', parts: [{ page: 1, text: 'Last.' }] }));
  const r = extract(v, ok, 'raw/refs/bad.boom', 'raw/refs/last.echo');
  assert.equal(r.code, 1);
  assert.deepEqual(r.stdout.trimEnd().split('\n'), [
    `wrote ${ok}: derived/${hashOf(v, ok)}.md (echo 2, 1 page)`,
    'failed raw/refs/bad.boom: exploded',
    `wrote raw/refs/last.echo: derived/${hashOf(v, 'raw/refs/last.echo')}.md (echo 2, 1 page)`,
  ]);
  assert.equal(v.exists(`derived/${hashOf(v, ok)}.md`), true);
});

test('an extractor can not declare an extension that extname never returns', async t => {
  const v = archive(t);
  v.write('tools/ext/extractors/tarball.mjs', "export const kinds = ['pdf'];\nexport const extensions = ['.tar.gz'];\nexport const version = '1';\nexport function extract() {}\n");
  const config = JSON.parse(v.read('vault.config.json'));
  v.write('vault.config.json', JSON.stringify({ ...config, extractors: [...config.extractors, 'tarball'] }));
  assert.ok((await configErrors(v)).includes('extractors: tools/ext/extractors/tarball.mjs must export extensions, a list of lowercase file extensions each with its dot, such as .pdf'));
});

test('config() gives extractors as a list, whatever the file holds', async t => {
  for (const [held, want] of [[undefined, []], ['fixture', []], [{ a: 1 }, []], [['fixture'], ['fixture']]]) {
    const v = makeVault(t, { config: held === undefined ? {} : { extractors: held } });
    assert.deepEqual((await v.import('lib/vault.mjs')).config().extractors, want, JSON.stringify(held));
  }
});

test("a failure writing derived/ is a run that can't finish, not a failed line for the file", t => {
  const v = archive(t);
  const rel = 'raw/refs/ok.echo';
  v.write(rel, echoed({ kind: 'pdf', parts: [{ page: 1, text: 'Fine.' }] }));
  v.write('raw/refs/next.echo', echoed({ kind: 'pdf', parts: [{ page: 1, text: 'Next.' }] }));
  // A folder where the text belongs, so the write can't land.
  fs.mkdirSync(v.at('derived', `${hashOf(v, rel)}.md`));
  const r = extract(v, PAPER, rel, 'raw/refs/next.echo');
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.equal(r.stdout, `unchanged ${PAPER}: derived/${hashOf(v, PAPER)}.md\n`, 'the line of a file done before it stays, and none follows');
  assert.match(r.stderr, /^extract failed: /);
});
