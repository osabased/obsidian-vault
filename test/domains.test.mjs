import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { makeVault, ruleNote, sessionId, denied, editFile as edit, prompt, userTurn, assistantTurn, cleanEnv, recordedCall, keepAllowed, offerOf } from './fixture.mjs';

// Design 6.3e and §8 item 7: a session in a project no domain reaches registers, hears one line, proposes to global, and
// starts a domain through tools/domain.mjs, which offers it, and keep.mjs, which writes it once the user allows it.
const LINE = /Vault: this project is in no domain\./;
const QUILL = { name: 'quill', title: 'Quill', topics: ['code'], marker: 'quill.project' };

function folder(t, files = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-domain-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const rel of files) {
    const file = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
  }
  return dir;
}

const context = out => out?.hookSpecificOutput?.additionalContext ?? '';
const posix = p => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const registry = (v, sid) => JSON.parse(v.read(`.state/sessions/${sid}.json`));
const typed = said => said.flatMap(s => [userTurn(s), assistantTurn('Noted.')]);

// A session started in dir, whose user typed said, in order.
function started(v, dir, said = ['yes, start a quill domain']) {
  const sid = sessionId();
  const out = v.startSession(sid, { cwd: dir, transcript: said ? v.transcript(sid, typed(said)) : null });
  return { sid, out };
}

const offerDomain = (v, sid, input) => v.run('domain.mjs', [sid], { input });
// domain.mjs only offers, so a domain is added by keeping the offer with a call the user allowed; a refused offer is
// returned as it is.
function addDomain(v, sid, input) {
  const r = offerDomain(v, sid, input);
  const o = r.code === 0 ? offerOf(r.stdout) : null;
  return o ? keepAllowed(v, sid, o.id, o.text) : r;
}
const widgetRule = domain => ({
  domain, slug: 'name-widgets', topic: 'code', basis: 'reading', reading: 'The user renamed the widgets.',
  do: 'Name widgets after their screen.', not: 'Leave widget names bare.', keywords: ['widgetz'],
});

// The lint lines a fresh process prints, since config() is cached per process.
const lintLines = v => v.run('lint.mjs').stdout.split('\n').filter(Boolean);
const lintErrors = v => lintLines(v).filter(l => l.startsWith('error '));

// The one span the write added, checked to be the only change: what comes before and after it is the file as it was.
function inserted(before, after) {
  let a = 0;
  while (a < before.length && before[a] === after[a]) a++;
  const span = after.slice(a, a + after.length - before.length);
  assert.equal(after.slice(a + span.length), before.slice(a), 'bytes outside the new entry changed');
  return span;
}

test('a session start in a folder no domain reaches registers the session and sends the line, again after compaction', t => {
  const v = makeVault(t);
  const dir = folder(t, ['src/a.txt']);
  const { sid, out } = started(v, dir, null);
  const text = context(out);
  assert.match(text, LINE);
  assert.match(text, /the vault's `propose` tool/);
  assert.match(text, /the vault's `domain` tool/);
  assert.equal(posix(registry(v, sid).cwd), posix(dir));
  assert.match(context(v.startSession(sid, { cwd: dir, source: 'compact' })), LINE);
});

test("a domain session's start and a vault-folder start send no line", t => {
  const v = makeVault(t);
  assert.doesNotMatch(context(v.startSession(sessionId())), LINE);
  assert.doesNotMatch(context(v.startSession(sessionId(), { cwd: v.root })), LINE);
});

test('a prompt in a folder no domain reaches registers its session', t => {
  const v = makeVault(t);
  const dir = folder(t);
  const sid = sessionId();
  prompt(v, sid, 'hello there', { cwd: dir });
  assert.equal(posix(registry(v, sid).cwd), posix(dir));
});

test('a session no domain reaches proposes to global, and another domain is refused with a line naming the domain tool', t => {
  const v = makeVault(t);
  const { sid } = started(v, folder(t), null);
  const r = v.propose(sid, widgetRule('global'));
  assert.equal(r.code, 0, r.stderr);
  assert.ok(v.exists('wiki/global/rules/name-widgets.md'));
  const other = v.propose(sid, { ...widgetRule('glim'), slug: 'other-widgets' });
  assert.equal(other.code, 1);
  assert.match(other.stderr, /^Not proposed: domain must be global\. .*the vault's `domain` tool/);
  // A domain session is pointed there too for a domain outside its own.
  const own = sessionId();
  v.startSession(own);
  assert.match(v.propose(own, { ...widgetRule('nope'), slug: 'nope-widgets' }).stderr, /^Not proposed: domain must be glim or global\. .*the vault's `domain` tool/);
});

test('an unregistered session is still refused a global rule', t => {
  const v = makeVault(t);
  const r = v.propose(sessionId(), widgetRule('global'));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /has no session/);
});

test('domain.mjs --help lists the fields, and a run without a registered session is refused', t => {
  const v = makeVault(t);
  const help = v.run('domain.mjs', ['--help']);
  assert.equal(help.code, 0, help.stderr);
  for (const field of ['name', 'title', 'topics', 'marker', 'path', 'vaultOnly']) assert.match(help.stdout, new RegExp(`^ {2}${field} `, 'm'));
  assert.doesNotMatch(help.stdout, /approved/);
  assert.match(addDomain(v, sessionId(), QUILL).stderr, /^Not added: .*has no session/);
  assert.match(v.run('domain.mjs', [], { input: QUILL }).stderr, /^Not added: there's no session id/);
});

test('domain.mjs refuses each bad field with one line and writes nothing', t => {
  const v = makeVault(t);
  const dir = folder(t, ['quill.project', 'pkg/src/a.txt']);
  const { sid } = started(v, path.join(dir, 'pkg'));
  const config = v.read('vault.config.json');
  const local = v.read('vault.local.json');
  const cases = [
    [{ approved: 'yes' }, /approved isn't a field/],
    [{ name: 'Quill' }, /name must be lowercase-kebab-case/],
    [{ name: 'global' }, /global/],
    [{ name: 'glim' }, /vault\.config\.json already has a domain glim/],
    [{ name: 'propose' }, /^(?=.*key "propose")(?=.*tools\/\S+:\d+)/],
    [{ title: 'Taste rules' }, /^(?=.*title "Taste rules")(?=.*tools\/\S+:\d+)/],
    [{ title: undefined }, /title/],
    [{ title: 'Two\nlines' }, /title/],
    [{ topics: 'code' }, /topics must be a list/],
    [{ marker: 'src/quill.project' }, /marker must be a file name/],
    [{ marker: 'nope.project' }, /no nope\.project in .* or a folder above it/],
    [{ path: true }, /one of marker, path and vaultOnly/],
    [{ marker: undefined }, /one of marker, path and vaultOnly/],
    [{ marker: undefined, vaultOnly: true }, /vaultOnly.*vault folder/],
    [{ colour: 'red' }, /colour isn't a field/],
  ];
  for (const [change, why] of cases) {
    const input = Object.fromEntries(Object.entries({ ...QUILL, ...change }).filter(([, x]) => x !== undefined));
    const r = addDomain(v, sid, input);
    assert.equal(r.code, 1, `${JSON.stringify(change)}: ${r.stdout}`);
    assert.match(r.stderr, /^Not added: [^\n]+\n$/, JSON.stringify(change));
    assert.match(r.stderr, why, JSON.stringify(change));
  }
  assert.equal(v.read('vault.config.json'), config);
  assert.equal(v.read('vault.local.json'), local);
  assert.equal(v.exists('log.md') && /added domain/.test(v.read('log.md')), false);
});

test('domain.mjs writes nothing until the offer is kept, and a session with no transcript is offered it too', t => {
  const v = makeVault(t);
  const dir = folder(t, ['quill.project']);
  const config = v.read('vault.config.json');
  const { sid } = started(v, dir, null);
  const r = offerDomain(v, sid, QUILL);
  assert.equal(r.code, 0, r.stderr);
  const o = offerOf(r.stdout);
  assert.match(o.text, /^\*\*Start this domain\?\*\* quill, "Quill": a project holding quill\.project is in it, such as /);
  assert.equal(v.read('vault.config.json'), config);
  const k = keepAllowed(v, sid, o.id, o.text);
  assert.equal(k.code, 0, k.stderr);
  assert.ok(Object.hasOwn(JSON.parse(v.read('vault.config.json')).domains, 'quill'));
});

for (const [kind, before] of [
  ['CRLF with a BOM', '\uFEFF{\r\n  "domains": {\r\n    "glim": {\r\n      "title": "Glim",\r\n      "topics": ["layout", "code"],\r\n      "markers": ["glim.project"]\r\n    }\r\n  },\r\n  "delivery": { "settleSeconds": 60 }\r\n}\r\n'],
  ['LF with tabs', '{\n\t"domains": {\n\t\t"glim": {"title": "Glim", "topics": ["layout", "code"], "markers": ["glim.project"]}\n\t},\n\t"lint": {"remindAfterDays": 14}\n}\n'],
]) {
  test(`a marker write, ${kind}, keeps every byte of vault.config.json outside the entry and the comma before it`, t => {
    const v = makeVault(t);
    v.write('vault.config.json', before);
    const dir = folder(t, ['quill.project', 'src/a.txt']);
    const { sid } = started(v, path.join(dir, 'src'));
    const r = addDomain(v, sid, QUILL);
    assert.equal(r.code, 0, r.stderr);
    const after = v.read('vault.config.json');
    const span = inserted(before, after);
    const [eol, indent] = kind.startsWith('CRLF') ? ['\r\n', '  '] : ['\n', '\t'];
    assert.ok(span.startsWith(`,${eol}${indent}${indent}"quill": `), JSON.stringify(span));
    assert.equal(span.replaceAll(eol, '').includes(kind.startsWith('CRLF') ? '\n' : '\r'), false, 'mixed line ends');
    assert.deepEqual(JSON.parse(`{${span.slice(1)}}`), { quill: { title: 'Quill', topics: ['code'], markers: ['quill.project'] } });
    assert.deepEqual(Object.keys(JSON.parse(after.replace(/^\uFEFF/, '')).domains), ['glim', 'quill']);
    assert.equal(v.read('log.md').split('\n').filter(l => /added domain/.test(l)).length, 1);
    assert.match(v.read('log.md'), /^- .* · added domain quill · session a1b2c3d4$/m);
    const reach = registry(v, sid).reach;
    assert.equal(posix(reach.cwd), posix(path.join(dir, 'src')));
    assert.ok(reach.domains.includes('quill'));
    assert.ok(reach.roots.some(x => x.domain === 'quill' && posix(x.root) === posix(dir)), JSON.stringify(reach.roots));
  });
}

test('after a marker write the session proposes for the domain, gets its always rule on the next prompt, and its edits are refused once', t => {
  const v = makeVault(t);
  const dir = folder(t, ['quill.project', 'src/a.txt']);
  const { sid } = started(v, dir);
  const r = addDomain(v, sid, QUILL);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /quill\.project/);
  assert.match(r.stdout, /vault\.config\.json/);
  assert.match(r.stdout, /the vault's `propose` tool/);
  assert.match(r.stdout, /the vault's `pick` tool/);
  const rule = v.propose(sid, {
    domain: 'quill', slug: 'name-steps', topic: 'code', basis: 'reading', reading: 'The user renamed the steps.',
    do: 'Name steps after their screen.', not: 'Leave step names bare.', applies_to: ['src/**/*.txt'],
  });
  assert.equal(rule.code, 0, rule.stderr);
  // Before the fixture note below, which no build has seen.
  assert.deepEqual(lintErrors(v), []);
  assert.deepEqual(lintLines(v).filter(l => /quill reaches no project|no other quill rule has topic/.test(l)), []);
  v.write('wiki/quill/rules/quill-always.md', ruleNote({ domain: 'quill', topic: 'code', always: true, doLine: 'Open each quill file with its purpose.' }));
  assert.match(context(prompt(v, sid, 'next step', { cwd: dir })), /quill\/quill-always: Do: Open each quill file with its purpose\./);
  const file = path.join(dir, 'src', 'a.txt');
  assert.match(denied(edit(v, sid, '', { abs: file, cwd: dir })) ?? '', /quill\/name-steps/);
  assert.equal(edit(v, sid, '', { abs: file, cwd: dir }), null);
});

test('a path write creates vault.local.json when it is missing, and adds to it when present', t => {
  const elsewhere = folder(t);
  const v = makeVault(t, { domains: { alpha: { title: 'Alpha', topics: ['code'] } }, local: { alpha: { paths: [elsewhere] } } });
  const input = { ...QUILL, marker: undefined, path: true };
  delete input.marker;
  const dir = folder(t, ['src/a.txt']);
  const { sid } = started(v, path.join(dir, 'src'));
  const r = addDomain(v, sid, input);
  assert.equal(r.code, 0, r.stderr);
  const local = JSON.parse(v.read('vault.local.json')).domains;
  assert.deepEqual(Object.keys(local), ['alpha', 'quill']);
  assert.deepEqual(local.alpha.paths, [elsewhere]);
  assert.deepEqual(local.quill.paths.map(posix), [posix(path.join(dir, 'src'))]);
  assert.deepEqual(JSON.parse(v.read('vault.config.json')).domains.quill, { title: 'Quill', topics: ['code'] });
  assert.deepEqual(lintErrors(v), []);
  assert.deepEqual(lintLines(v).filter(l => /quill reaches no project/.test(l)), []);

  fs.rmSync(v.at('vault.local.json'));
  const other = folder(t);
  const second = started(v, other).sid;
  const made = addDomain(v, second, { ...input, name: 'brook', title: 'Brook' });
  assert.equal(made.code, 0, made.stderr);
  assert.deepEqual(JSON.parse(v.read('vault.local.json')).domains.brook.paths.map(posix), [posix(other)]);
});

test('a path write from a worktree under .claude/worktrees/ adds the main checkout', t => {
  const v = makeVault(t);
  const repo = folder(t, ['a.txt']);
  const env = cleanEnv({ GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, env, stdio: 'pipe' });
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'start');
  git('worktree', 'add', '-q', path.join('.claude', 'worktrees', 'w1'));
  const { sid } = started(v, path.join(repo, '.claude', 'worktrees', 'w1'));
  const input = { ...QUILL, path: true };
  delete input.marker;
  const r = addDomain(v, sid, input);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(v.read('vault.local.json')).domains.quill.paths.map(posix), [posix(repo)]);
});

test('from the vault folder, vaultOnly is written, a marker is taken without looking for its file, and path is refused', t => {
  const v = makeVault(t);
  const { sid } = started(v, v.root);
  const pages = addDomain(v, sid, { ...QUILL, marker: undefined, vaultOnly: true });
  assert.equal(pages.code, 0, pages.stderr);
  assert.deepEqual(JSON.parse(v.read('vault.config.json')).domains.quill, { title: 'Quill', topics: ['code'], vaultOnly: true });
  assert.deepEqual(lintErrors(v), []);
  assert.deepEqual(lintLines(v).filter(l => /quill reaches no project/.test(l)), []);
  const marked = addDomain(v, sid, { ...QUILL, name: 'brook', title: 'Brook', marker: 'brook.project' });
  assert.equal(marked.code, 0, marked.stderr);
  assert.match(marked.stdout, /didn't look for brook\.project/);
  const input = { ...QUILL, name: 'reed', title: 'Reed', path: true };
  delete input.marker;
  assert.match(addDomain(v, sid, input).stderr, /^Not added: path .*vault folder/);
});

test('two keeps of domain offers at once both land', async t => {
  const v = makeVault(t);
  const a = started(v, folder(t, ['quill.project'])).sid;
  const b = started(v, folder(t, ['brook.project']), ['yes, a brook domain']).sid;
  const keepOf = (sid, input) => {
    const o = offerOf(offerDomain(v, sid, input).stdout);
    const kept = { id: o.id, offer: o.text };
    return v.runAsync('keep.mjs', [sid, recordedCall(v, sid, { offer: o.id, input: kept })], { input: kept });
  };
  const [ra, rb] = await Promise.all([keepOf(a, QUILL), keepOf(b, { ...QUILL, name: 'brook', title: 'Brook', marker: 'brook.project' })]);
  assert.equal(ra.code, 0, ra.stderr);
  assert.equal(rb.code, 0, rb.stderr);
  assert.deepEqual(Object.keys(JSON.parse(v.read('vault.config.json')).domains).sort(), ['brook', 'glim', 'quill']);
  assert.equal(v.read('log.md').split('\n').filter(l => /added domain/.test(l)).length, 2);
});

test('a marker another domain lists is written, and the output names that domain', t => {
  const v = makeVault(t);
  const { sid } = started(v, folder(t, ['glim.project']));
  const r = addDomain(v, sid, { ...QUILL, marker: 'glim.project' });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /glim also has glim\.project as a marker/);
  assert.deepEqual(JSON.parse(v.read('vault.config.json')).domains.quill.markers, ['glim.project']);
});

test('a session no domain reached at start takes a domain added to the config later, from its next prompt', t => {
  const v = makeVault(t);
  const dir = folder(t, ['zeta.project']);
  const { sid } = started(v, dir, null);
  const config = JSON.parse(v.read('vault.config.json'));
  config.domains.zeta = { title: 'Zeta', topics: ['code'], markers: ['zeta.project'] };
  v.write('vault.config.json', JSON.stringify(config, null, 2));
  const r = v.propose(sid, widgetRule('zeta'));
  assert.equal(r.code, 0, r.stderr);
  v.write('wiki/zeta/rules/zeta-always.md', ruleNote({ domain: 'zeta', topic: 'code', always: true, doLine: 'Open each zeta file with its purpose.' }));
  assert.match(context(prompt(v, sid, 'next step', { cwd: dir })), /zeta\/zeta-always/);
});

test('a session resumed in a second folder no domain reaches adds that folder by path', t => {
  const v = makeVault(t);
  const second = folder(t);
  const { sid } = started(v, folder(t));
  v.startSession(sid, { cwd: second, source: 'resume' });
  const input = { ...QUILL, path: true };
  delete input.marker;
  const r = addDomain(v, sid, input);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(v.read('vault.local.json')).domains.quill.paths.map(posix), [posix(second)]);
});

test("a marker above a nearer folder that another domain's marker holds is refused, since sessions there stop at the nearer one", t => {
  const v = makeVault(t);
  const dir = folder(t, ['quill.project', 'pkg/glim.project']);
  const { sid } = started(v, path.join(dir, 'pkg'));
  const r = addDomain(v, sid, QUILL);
  assert.equal(r.code, 1, r.stdout);
  assert.match(r.stderr, /^Not added: \S*pkg holds glim\.project, which puts it in glim\b/);
  const both = folder(t, ['quill.project', 'glim.project']);
  assert.equal(addDomain(v, started(v, both).sid, QUILL).code, 0);
});

test('domain.mjs writes the name composed, as propose.mjs reads a domain', t => {
  const v = makeVault(t);
  const { sid } = started(v, folder(t, ['quill.project']));
  const r = addDomain(v, sid, { ...QUILL, name: `cafe${String.fromCodePoint(0x301)}`, title: 'Cafe' });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(Object.hasOwn(JSON.parse(v.read('vault.config.json')).domains, `caf${String.fromCodePoint(0xe9)}`));
});

test('a path that holds the vault folder is refused', t => {
  const outer = folder(t);
  const v = makeVault(t, { under: outer });
  const { sid } = started(v, outer);
  const input = { ...QUILL, path: true };
  delete input.marker;
  const r = addDomain(v, sid, input);
  assert.equal(r.code, 1, r.stdout);
  assert.match(r.stderr, /^Not added: \S+ holds the vault/);
});

test('a domain the user denied at the prompt is refused when offered again in that session, and not after an allowed keep', t => {
  const v = makeVault(t);
  const { sid } = started(v, folder(t, ['quill.project']));
  const o = offerOf(offerDomain(v, sid, QUILL).stdout);
  recordedCall(v, sid, { offer: o.id, input: { id: o.id, offer: o.text }, allow: false });
  const again = offerDomain(v, sid, QUILL);
  assert.equal(again.code, 1);
  assert.equal(again.stderr, "Not added: the user denied starting this domain at the prompt in this session. Don't offer it again unless they ask.\n");
  assert.equal(JSON.parse(v.read('vault.config.json')).domains.quill, undefined);

  const { sid: other } = started(v, folder(t, ['quill.project']));
  const first = offerOf(offerDomain(v, other, QUILL).stdout);
  assert.equal(keepAllowed(v, other, first.id, first.text, { recorded: { id: first.id, offer: 'other lines' } }).code, 1);
  assert.ok(offerOf(offerDomain(v, other, QUILL).stdout), 'an allowed keep that wrote nothing is no Deny');
});
