import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeVault, sha256, withFields } from './fixture.mjs';
import { secretsIn } from '../tools/lib/secrets.mjs';

// The key- and token-shaped values secretsIn finds, and what scan.mjs prints of them (design §8 item 5, 6.4e).

const TOKEN = 'Zq3xV9pL2mK8wR4tY7uN1bC6dF0gH5jS';
const found = text => secretsIn(text).map(({ line, kind, masked, name }) => ({ line, kind, masked, ...(name && { name }) }));
const allowOf = value => sha256(value).slice(0, 16);

test('secretsIn finds a private key, a secret assigned to a name, and a machine-made token', () => {
  const key = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun\n-----END RSA PRIVATE KEY-----';
  const text = [
    'Notes.',
    'api_key = "ab12cd34ef56gh78"',
    `password: hunter2xyz9`,
    `export DB_CREDENTIALS='s3cr3tValue99'`,
    `curl -H "Authorization: Bearer ${TOKEN}"`,
    key,
    '-----BEGIN PRIVATE KEY-----',
    'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC',
  ].join('\n');
  assert.deepEqual(found(text), [
    { line: 2, kind: 'assignment', masked: 'ab…78', name: 'api_key' },
    { line: 3, kind: 'assignment', masked: 'hu…z9', name: 'password' },
    { line: 4, kind: 'assignment', masked: 's3…99', name: 'DB_CREDENTIALS' },
    { line: 5, kind: 'token', masked: 'Zq…jS' },
    { line: 6, kind: 'private key', masked: 'private key' },
    { line: 9, kind: 'private key', masked: 'private key' },
  ]);
  const all = secretsIn(text);
  assert.equal(all[0].value, 'ab12cd34ef56gh78');
  assert.equal(all[0].allow, allowOf('ab12cd34ef56gh78'));
  assert.equal(all[4].value, key, 'a private key runs to its END line');
  assert.equal(all[5].value, '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC', 'or to the end of the text');
});

test('a value both an assignment and a token is listed once', () => {
  assert.deepEqual(found(`secret_token=${TOKEN}`), [{ line: 1, kind: 'assignment', masked: 'Zq…jS', name: 'secret_token' }]);
  assert.deepEqual(found(`one ${TOKEN}\ntwo ${TOKEN}`).map(f => f.line), [1, 2], 'once per line');
});

test("secretsIn passes code, placeholders and the long runs that aren't secrets", () => {
  const passing = [
    'token = getToken()',
    'apiKey: process.env.API_KEY',
    'API_KEY=<your key>',
    'primary_key = 42',
    'keyboard=qwerty123',
    'password=changeme',
    'token: xxxxxxxx',
    'secret = ${SECRET_VALUE_1}',
    'api_key = {{ vault_key_1 }}',
    'password: your-password-123',
    'access_token = example_token_2024',
    '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAu1SU1LfVLPHCozMxH2Mo\n4lgOEePzNm0tRgeLezV6ffAt0gunVTLw7onLRnrq0/IzW7yWR7QkrmBL7jTKEn5u\n-----END PUBLIC KEY-----',
    '<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk">',
    '<script integrity="sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K/uxy9rx7HNQlGYl1kPzQho1wx4JwY8wC"></script>',
    'sha256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    'commit 9fceb02d0ae598e95dc970b74767f19372d61af8',
    'id 123e4567-e89b-12d3-a456-426614174000',
    'wiki/glim/concepts/a-very-long-slug-for-a-page-about-glim-cells-2026',
    'getUserAccountSettingsFromRemoteServerCacheEntries',
    'getUserAccountSettingsFromRemoteServerCache2024',
  ];
  for (const text of passing) assert.deepEqual(found(text), [], text);
});

function vault(t, config = {}) {
  const v = makeVault(t, { presets: ['archive'], config });
  v.write('raw/refs/notes.md', `# Notes\n\nThe cell grid.\napi_key = "ab12cd34ef56gh78"\n${'\n'.repeat(3)}auth ${TOKEN}\n`);
  v.write('raw/refs/clean.md', '# Clean\n\nNothing here.\n');
  return v;
}

test('scan prints each value with its allow id, and exits 1', t => {
  const v = vault(t);
  const r = v.run('scan.mjs', ['raw/refs/notes.md', 'raw/refs/clean.md']);
  assert.equal(r.code, 1, r.stderr);
  assert.deepEqual(r.stdout.trimEnd().split('\n'), [
    `raw/refs/notes.md:4 assignment api_key=ab…78 · allow ${allowOf('ab12cd34ef56gh78')}`,
    `raw/refs/notes.md:8 token Zq…jS · allow ${allowOf(TOKEN)}`,
    "2 key- or token-shaped values in 1 file. Remove them, or add an allow id to privacy.allow in vault.config.json if it isn't a secret.",
  ]);
  assert.doesNotMatch(r.stdout, /ab12cd34|Zq3xV9/, 'scan never repeats a value');
});

test('scan exits 0 when it finds nothing', t => {
  const v = vault(t);
  const r = v.run('scan.mjs', ['raw/refs/clean.md']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, 'No key- or token-shaped values in 1 file.\n');
});

test('scan reads a binary through its derived text, under its own name, and skips one with none', t => {
  const v = vault(t);
  const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from([0xff, 0xfe])]);
  v.write('raw/refs/keys.pdf', pdf);
  v.write(`derived/${sha256(pdf)}.md`, withFields(
    { kind: 'pdf', extractor: 'fixture', extractor_version: "'1.0'", source: 'raw/refs/keys.pdf' },
    `[p. 1]\nSome text.\n[p. 2]\nsecret: ${TOKEN}\n`,
  ));
  const r = v.run('scan.mjs', ['raw/refs/keys.pdf', 'raw/refs/talk.mp4', 'raw/refs/paper.pdf']);
  assert.equal(r.code, 1, r.stderr);
  assert.deepEqual(r.stdout.trimEnd().split('\n'), [
    `raw/refs/keys.pdf:10 assignment secret=Zq…jS · allow ${allowOf(TOKEN)}`,
    "skipped raw/refs/talk.mp4: it isn't UTF-8 and has no derived text. Run node tools/extract.mjs raw/refs/talk.mp4, then scan again.",
    "1 key- or token-shaped value in 1 file. Remove them, or add an allow id to privacy.allow in vault.config.json if it isn't a secret.",
  ]);
});

test('privacy.allow lets a listed value through', t => {
  const v = vault(t, { privacy: { allow: [allowOf(TOKEN)] } });
  const r = v.run('scan.mjs', ['raw/refs/notes.md']);
  assert.equal(r.code, 1, r.stderr);
  assert.deepEqual(r.stdout.trimEnd().split('\n').map(l => l.split(' ')[0]), ['raw/refs/notes.md:4', '1']);
  const both = vault(t, { privacy: { allow: [allowOf(TOKEN), allowOf('ab12cd34ef56gh78')] } });
  assert.equal(both.run('scan.mjs', ['raw/refs/notes.md']).code, 0);
});

test('scan exits 2 on no file, a bad flag or a file it can not read', t => {
  const v = vault(t);
  for (const args of [[], ['--all', 'raw/refs/notes.md'], ['raw/refs/missing.md'], ['raw/refs']]) {
    const r = v.run('scan.mjs', args);
    assert.equal(r.code, 2, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /usage: node tools\/scan\.mjs/);
  }
});

test('lint errors on privacy that is not an object of allow ids', async t => {
  const cases = [
    [{ privacy: [] }, ['privacy must be an object, such as { "allow": [] }']],
    [{ privacy: { allow: 'all' } }, ['privacy.allow must be a list of the allow ids scan.mjs prints']],
    [{ privacy: { allow: [allowOf(TOKEN), 'ABCDEF0123456789', 'abc', 7] } }, [
      'privacy.allow: "ABCDEF0123456789" isn\'t an allow id, which is 16 lowercase hex digits as scan.mjs prints it',
      'privacy.allow: "abc" isn\'t an allow id, which is 16 lowercase hex digits as scan.mjs prints it',
      'privacy.allow: 7 isn\'t an allow id, which is 16 lowercase hex digits as scan.mjs prints it',
    ]],
    [{ privacy: { allow: [allowOf(TOKEN)] } }, []],
  ];
  for (const [config, expect] of cases) {
    const v = makeVault(t, { config });
    const errors = (await (await v.import('lib/lint.mjs')).lint()).filter(f => f.level === 'error' && f.file === 'vault.config.json').map(f => f.msg);
    assert.deepEqual(errors, expect, JSON.stringify(config));
  }
});

const bytes = (v, rel) => fs.readFileSync(v.at(...rel.split('/')));
const SECRET = 'api_key = "ab12cd34ef56gh78"';
const BASE64 = 'MIIEpAIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun';

test('a PEM block hides only its base64 and armor headers, and only when the END with its own label closes it', () => {
  const cases = {
    'a certificate with a line that is neither': [`-----BEGIN CERTIFICATE-----\n${SECRET}\n-----END CERTIFICATE-----`, [2]],
    'a header name armor never uses': [`-----BEGIN CERTIFICATE-----\npassword: hunter2xyz9\n${BASE64}\n-----END CERTIFICATE-----`, [2, 3]],
    'a BEGIN with no END': [`Your cert file starts:\n-----BEGIN PUBLIC KEY-----\n${BASE64}\n\nThen set:\n${SECRET}`, [3, 6]],
    'an END with another label': [`-----BEGIN TRUSTED CERTIFICATE-----\n${BASE64}\n-----END CERTIFICATE-----\n${SECRET}`, [2, 4]],
    'a clearsigned message': [`-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA256\n\n${SECRET}\n-----BEGIN PGP SIGNATURE-----\n\n${BASE64}\n-----END PGP SIGNATURE-----\nlater ${TOKEN}`, [4, 9]],
  };
  for (const [name, [text, lines]] of Object.entries(cases)) assert.deepEqual(found(text).map(f => f.line), lines, name);
  const closed = `-----BEGIN PGP PUBLIC KEY BLOCK-----\nVersion: Glim 2\nComment: the ledger key\n\n${BASE64}\n=Zq3x\n-----END PGP PUBLIC KEY BLOCK-----\n${SECRET}`;
  assert.deepEqual(found(closed).map(f => f.line), [8], 'a closed public block still passes, and scanning resumes after it');
});

test("a PGP private key block is a private key, and an unclosed private key's value runs to the end of the text", () => {
  const block = `-----BEGIN PGP PRIVATE KEY BLOCK-----\nVersion: Glim 2\n\n${BASE64}\n=Zq3x\n-----END PGP PRIVATE KEY BLOCK-----`;
  assert.deepEqual(found(`${block}\n${SECRET}`), [
    { line: 1, kind: 'private key', masked: 'private key' },
    { line: 7, kind: 'assignment', masked: 'ab…78', name: 'api_key' },
  ]);
  assert.equal(secretsIn(block)[0].value, block);
  const encrypted = `-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,3F17F5316E2BAC89\n\n${BASE64}\n-----END RSA PRIVATE KEY-----`;
  assert.deepEqual(found(encrypted).map(f => f.kind), ['private key']);
});

test('a PEM block indented, in a list or quoted reads as one block', () => {
  const pem = (lead, inner, label = 'RSA PRIVATE KEY') => `${lead}-----BEGIN ${label}-----\n${inner}${BASE64}\n${inner}${BASE64}\n${inner}-----END ${label}-----`;
  for (const [name, text] of Object.entries({
    yaml: `key: |\n${pem('  ', '  ')}`,
    list: `- ${pem('', '  ')}`,
    json: `[\n  "-----BEGIN RSA PRIVATE KEY-----",\n  "${BASE64}",\n  "${BASE64}",\n  "-----END RSA PRIVATE KEY-----"\n]`,
  })) {
    assert.deepEqual(found(text).map(f => f.kind), ['private key'], name);
  }
  assert.deepEqual(found(`key: |\n${pem('    ', '    ', 'PUBLIC KEY')}\n${SECRET}`).map(f => f.line), [6], 'an indented public key passes, and its END ends it');
  assert.deepEqual(found(`-----BEGIN PUBLIC KEY-----\n${BASE64}\n  -----END PUBLIC KEY-----\n${SECRET}`).map(f => f.line), [4], 'so does an END indented otherwise');
});

test('a run of words and numbers joined as names, paths and URLs join them is no token', () => {
  const passing = [
    'source: raw/refs/Quarterly-Report-2024-Final.pdf',
    'source: raw/refs/IMG_20250314_Whiteboard-Photo.jpg',
    'source: raw/refs/MeetingRecording-2025-03-14-Team.mp4',
    'source: raw/refs/ACME_Corp_Statement_Of_Work_2025Q1.pdf',
    'handleUserAuthenticationCallback2FAResponseWithRetries',
    'handleOAuth2CallbackWithPKCEVerifier',
    'see https://glim.example/docs/api/v2/Authentication/OAuth2Flow',
    'https://ledger.example/docs/reference/RenderingContext2D/drawImageWithShadow',
  ];
  for (const text of passing) assert.deepEqual(found(text), [], text);
  for (const token of [TOKEN, 'Zq3xV9pL2mK8wR4tYb7NcQ1sHf6DgJ0aEu5WiOy', 'aB3dE5fG7hJ9kL1mN2pQ4rS6tU8vW0xYz', `raw/refs/${TOKEN}`]) {
    assert.deepEqual(found(`see ${token}`).map(f => f.kind), ['token'], token);
  }
});

test("derived text's frontmatter, which the core writes, isn't scanned, and a text file's own is", t => {
  const v = vault(t);
  const rel = `raw/refs/${TOKEN}.pdf`;
  v.write(rel, Buffer.concat([Buffer.from('%PDF-1.4\nA lit cell.\n'), Buffer.from([0xff])]));
  const r = v.run('extract.mjs', [rel]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^wrote /);
  const scan = v.run('scan.mjs', [rel]);
  assert.equal(scan.code, 0, scan.stdout + scan.stderr);
  v.write('raw/refs/own.md', `---\nurl: https://glim.example/${TOKEN}\n---\n# Own\n`);
  assert.match(v.run('scan.mjs', ['raw/refs/own.md']).stdout, /^raw\/refs\/own\.md:2 token /);
});

test('scan takes a bundle folder and scans each file in it, a binary through its derived text', t => {
  const v = vault(t);
  v.write('raw/refs/kit/a.txt', `${SECRET}\n`);
  v.write('raw/refs/kit/b.txt', 'b\n');
  v.write('raw/refs/kit/deep/paper.pdf', bytes(v, 'raw/refs/paper.pdf'));
  v.write('raw/refs/kit/talk.mp4', bytes(v, 'raw/refs/talk.mp4'));
  assert.equal(v.run('bundle.mjs', ['raw/refs/kit']).code, 0);
  assert.match(v.run('review.mjs', ['sources']).stdout, /raw\/refs\/kit\b/);
  const r = v.run('scan.mjs', ['raw/refs/kit']);
  assert.equal(r.code, 1, r.stderr);
  assert.deepEqual(r.stdout.trimEnd().split('\n'), [
    `raw/refs/kit/a.txt:1 assignment api_key=ab…78 · allow ${allowOf('ab12cd34ef56gh78')}`,
    "skipped raw/refs/kit/talk.mp4: it isn't UTF-8 and has no derived text. Run node tools/extract.mjs raw/refs/kit/talk.mp4, then scan again.",
    "1 key- or token-shaped value in 1 file. Remove them, or add an allow id to privacy.allow in vault.config.json if it isn't a secret.",
  ]);
  v.write('raw/refs/kit/a.txt', 'a\n');
  assert.equal(v.run('scan.mjs', ['raw/refs/kit/']).stdout, 'skipped raw/refs/kit/talk.mp4: it isn\'t UTF-8 and has no derived text. Run node tools/extract.mjs raw/refs/kit/talk.mp4, then scan again.\nNo key- or token-shaped values in 4 files.\n');
  v.write('raw/refs/loose/a.txt', `${SECRET}\n`);
  for (const ref of ['raw/refs/loose', 'raw/refs/kit/deep']) {
    const other = v.run('scan.mjs', [ref]);
    assert.equal(other.code, 2, `${ref}: ${other.stdout}`);
    assert.match(other.stderr, /usage: node tools\/scan\.mjs/);
  }
});

test("scan and extract exit 2 when they can't finish", t => {
  const v = vault(t);
  v.write('vault.config.json', '{ "privacy": { "allow": [], } }');
  for (const [script, args] of [['scan.mjs', ['raw/refs/notes.md']], ['extract.mjs', ['raw/refs/paper.pdf']]]) {
    const r = v.run(script, args);
    assert.equal(r.code, 2, `${script}: ${r.stdout}${r.stderr}`);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, new RegExp(`^${script.replace('.mjs', '')} failed: `));
  }
});

test('scan takes a doc set folder, which review.mjs sources lists, and scans each file in it', t => {
  const v = vault(t);
  v.write('raw/refs/docs/llms.txt', '# Docs\n- [A](https://glim.example/a.md)\n');
  v.write('raw/refs/docs/a.md', `${SECRET}\n`);
  v.write('raw/refs/docs/sub/b.md', 'b\n');
  assert.match(v.run('review.mjs', ['sources']).stdout, /raw\/refs\/docs\b/);
  const r = v.run('scan.mjs', ['raw/refs/docs']);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.deepEqual(r.stdout.trimEnd().split('\n'), [
    `raw/refs/docs/a.md:1 assignment api_key=ab…78 · allow ${allowOf('ab12cd34ef56gh78')}`,
    "1 key- or token-shaped value in 1 file. Remove them, or add an allow id to privacy.allow in vault.config.json if it isn't a secret.",
  ]);
  assert.equal(v.run('scan.mjs', ['raw/refs/docs/sub']).code, 2, 'a folder inside a doc set is not the source');
});

test('a folder scan reads dotfiles too, and skips only what git never tracks', t => {
  const v = vault(t);
  v.write('raw/refs/kit/a.txt', 'a\n');
  v.write('raw/refs/kit/.env', `${SECRET}\n`);
  v.write('raw/refs/kit/sub/.npmrc', `auth ${TOKEN}\n`);
  v.write('raw/refs/kit/.git/config', `${SECRET}\n`);
  assert.equal(v.run('bundle.mjs', ['raw/refs/kit']).code, 0);
  const r = v.run('scan.mjs', ['raw/refs/kit']);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.deepEqual(r.stdout.trimEnd().split('\n').slice(0, 2).map(l => l.split(' ')[0]), ['raw/refs/kit/.env:1', 'raw/refs/kit/sub/.npmrc:1']);
  assert.match(r.stdout, /in 2 files\./);
});

test('scan names the file in a bundle it could not read, and exits 2', t => {
  if (process.getuid?.() === 0) return t.skip('root reads any file');
  const v = vault(t);
  v.write('raw/refs/kit/a.txt', 'a\n');
  v.write('raw/refs/kit/busy.txt', 'b\n');
  assert.equal(v.run('bundle.mjs', ['raw/refs/kit']).code, 0);
  const file = v.at('raw', 'refs', 'kit', 'busy.txt');
  if (process.platform === 'win32') {
    t.after(() => { try { execFileSync('icacls', [file, '/remove:d', process.env.USERNAME]); } catch {} });
    execFileSync('icacls', [file, '/deny', `${process.env.USERNAME}:(RD)`]);
  } else {
    t.after(() => { try { fs.chmodSync(file, 0o644); } catch {} });
    fs.chmodSync(file, 0);
  }
  const r = v.run('scan.mjs', ['raw/refs/kit']);
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /^raw\/refs\/kit\/busy\.txt can't be read \((?:EPERM|EACCES|EBUSY)\)\. /);
});
