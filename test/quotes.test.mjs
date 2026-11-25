import fs from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeVault, userTurn, assistantTurn, toolResult, ruleNote, sourcePage, sectionOf, sha256, withFields } from './fixture.mjs';

const SID = '9f8e7d6c-0000-4000-8000-000000000001';

const rule = (extra = {}) => ({
  domain: 'glim', slug: 'strict-scripts', topic: 'code', basis: 'stated',
  do: 'Open each file with a purpose line.', not: 'Start a file straight with code.', because: '', applies_to: ['src/**/*.zq'], ...extra,
});

function session(t, entries) {
  const v = makeVault(t);
  v.startSession(SID, { transcript: entries && v.transcript(SID, entries) });
  return v;
}


function notTyped(r) {
  assert.equal(r.code, 1);
  assert.match(r.stderr, /isn't in anything the user typed/);
}

test('a stated quote the user typed is written', t => {
  const v = session(t, [userTurn('please, I want scripts in strict mode always')]);
  const r = v.propose(SID, rule({ quote: 'I want scripts in strict mode always' }));
  assert.equal(r.code, 0, r.stderr);
  assert.match(v.read('wiki/glim/rules/strict-scripts.md'), /"I want scripts in strict mode always"/);
});

test('case, spacing and curly quotes do not count against a quote', t => {
  const v = session(t, [userTurn('Don’t leave\n  scripts   nonstrict')]);
  assert.equal(v.propose(SID, rule({ quote: "don't leave scripts nonstrict" })).code, 0);
});

test('an ellipsis may skip words, in order, within one message', t => {
  const v = session(t, [userTurn('I want scripts, all of the UI ones, in strict mode'), userTurn('second message')]);
  assert.equal(v.propose(SID, rule({ quote: 'I want scripts … in strict mode' })).code, 0);
  notTyped(v.propose(SID, rule({ slug: 'other', quote: 'in strict mode ... I want scripts' })));
  notTyped(v.propose(SID, rule({ slug: 'third', quote: 'strict mode … second message' })));
});

test('a stated quote the user never typed is refused', t => {
  const v = session(t, [userTurn('make the buttons bigger')]);
  notTyped(v.propose(SID, rule({ quote: 'I want scripts in strict mode always' })));
  assert.equal(v.exists('wiki/glim/rules/strict-scripts.md'), false);
});

test("the agent's own words, tool output and injected context are not the user's", t => {
  const v = session(t, [
    userTurn('ok'),
    assistantTurn('You want scripts in strict mode'),
    toolResult('scripts in strict mode'),
    userTurn([{ type: 'text', text: 'go <system-reminder>scripts in strict mode</system-reminder>' }]),
    { ...userTurn('scripts in strict mode'), isMeta: true },
    { ...userTurn('scripts in strict mode'), isCompactSummary: true },
    userTurn('<task-notification>scripts in strict mode</task-notification>'),
    toolResult('answered', { questions: [{ question: 'Which mode?', options: [{ label: 'scripts in strict mode' }] }], answers: { 'Which mode?': 'scripts in strict mode' } }),
    { ...userTurn('scripts in strict mode'), turnOrigin: 'sdk', promptSource: 'sdk' },
    { ...userTurn('<side-sessions-event>scripts in strict mode</side-sessions-event>'), turnOrigin: 'sdk' },
    { ...userTurn('<cross-session-message from="local_1">scripts in strict mode</cross-session-message>'), turnOrigin: 'sdk' },
    { ...userTurn('scripts in strict mode'), origin: { kind: 'task-notification' }, turnOrigin: 'task_notification' },
    { type: 'attachment', attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: 'scripts in strict mode' } },
  ]);
  notTyped(v.propose(SID, rule({ quote: 'scripts in strict mode' })));
});

test('prompts the user typed while the agent worked, and their own AskUserQuestion answers, count', t => {
  const v = session(t, [
    { ...userTurn('ok'), origin: { kind: 'human' }, turnOrigin: 'human' },
    { type: 'attachment', attachment: { type: 'queued_command', commandMode: 'prompt', origin: { kind: 'human' }, prompt: 'no, keep the tabs roomy' } },
    toolResult('answered', {
      questions: [{ question: 'Which mode?', multiSelect: true, options: [{ label: 'Strict' }, { label: 'Nonstrict' }] }],
      answers: { 'Which mode?': 'Strict,only on phone, desktop can be dense' },
      annotations: { 'Which mode?': { notes: 'tests may stay loose' } },
    }),
  ]);
  const written = (slug, quote, line) => {
    const r = v.propose(SID, rule({ slug, quote, topic: slug, do: `${line}.`, not: `Ignore ${line.toLowerCase()}.`, applies_to: [`${slug}/**`] }));
    assert.equal(r.code, 0, r.stderr);
  };
  written('roomy', 'keep the tabs roomy', 'Space tab buttons apart');
  written('phone', 'only on phone, desktop can be dense', 'Pad mobile layouts');
  written('loose', 'tests may stay loose', 'Allow nonstrict specs');
  notTyped(v.propose(SID, rule({ slug: 'label', quote: 'Nonstrict' })));
});

test('a quote matches whole words only', t => {
  const v = session(t, [userTurn('leave nonstrict mode on for tests')]);
  notTyped(v.propose(SID, rule({ quote: 'strict mode on' })));
  assert.equal(v.propose(SID, rule({ slug: 'whole', quote: 'nonstrict mode on' })).code, 0);
});

test('Unicode forms and dash styles do not count against a quote', t => {
  const v = session(t, [userTurn('use the café layout -- not the grid')]);
  assert.equal(v.propose(SID, rule({ quote: 'use the café layout — not the grid' })).code, 0);
});

test('text blocks of a user message count', t => {
  const v = session(t, [userTurn([{ type: 'text', text: 'scripts in strict mode please' }, { type: 'image', source: {} }])]);
  assert.equal(v.propose(SID, rule({ quote: 'scripts in strict mode' })).code, 0);
});

// A new rule can't stand on basis inferred, so a reword carries it.
test('an inferred quote is checked too', t => {
  const v = makeVault(t);
  v.write('wiki/glim/rules/the-thing.md', ruleNote({ keywords: ['thing'] }));
  v.startSession(SID, { transcript: v.transcript(SID, [userTurn('no, that one should be strict')]) });
  const reword = quote => v.propose(SID, { change: 'reword', key: 'glim/the-thing', basis: 'inferred', quote, do: 'Make each script strict.' });
  notTyped(reword('every script should be strict'));
  assert.equal(reword('that one should be strict').code, 0);
});

test('a session with no transcript cannot back a stated rule', t => {
  const v = session(t, null);
  const r = v.propose(SID, rule({ quote: 'anything' }));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no transcript/);
});

test('a session whose transcript can\'t be read cannot back a stated rule', t => {
  const v = makeVault(t);
  const transcript = v.at('.transcripts', 'unreadable');
  fs.mkdirSync(transcript, { recursive: true });
  v.startSession(SID, { transcript });
  const r = v.propose(SID, rule({ quote: 'anything' }));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no transcript/);
});

test('a reading needs no transcript', t => {
  const v = makeVault(t);
  v.write('wiki/glim/rules/the-thing.md', ruleNote({ keywords: ['thing'] }));
  v.startSession(SID);
  const r = v.propose(SID, { change: 'reword', key: 'glim/the-thing', basis: 'reading', reading: 'the UI files all open with a purpose line', do: 'Open each file with a purpose line.' });
  assert.equal(r.code, 0, r.stderr);
});

const knowledge = (source, quote, extra = {}) => rule({ kind: 'knowledge', basis: 'source', source, source_date: '2026-10-01', quote, ...extra });

test('a source quote must be in the raw/refs file it cites', t => {
  const v = session(t, [userTurn('hi')]);
  v.write('raw/refs/changelog.md', '# Changelog\n\nThe   new solver is\non by default since 0.650.\n');
  const bad = v.propose(SID, knowledge('raw/refs/changelog.md', 'the old solver is gone', { slug: 'bad' }));
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /isn't in raw\/refs\/changelog\.md/);
  assert.equal(v.propose(SID, knowledge('raw/refs/changelog.md', 'the new solver is on by default since 0.650')).code, 0);
});

test('an HTML source is read as its text', t => {
  const v = session(t, [userTurn('hi')]);
  v.write('raw/refs/page.html', '<p>Use <code>UIStroke</code> &amp; padding</p>');
  const r = v.propose(SID, knowledge('raw/refs/page.html', 'Use UIStroke & padding'));
  assert.equal(r.code, 0, r.stderr);
});

test('a saved web page is read with its entities, without scripts, and with inline tags inside words', t => {
  const v = session(t, [userTurn('hi')]);
  v.write('raw/refs/post.html', '<script>var x = 1;</script><p>Don&#8217;t pad the <b>T</b>abs&#x2014;ever&hellip;</p><p>Next</p>');
  assert.equal(v.propose(SID, knowledge('raw/refs/post.html', "Don't pad the Tabs—ever")).code, 0);
  assert.equal(v.propose(SID, knowledge('raw/refs/post.html', 'var x = 1', { slug: 'script' })).code, 1);
});

test('a saved web page is read with its Latin-1 and typographic entities', t => {
  const v = session(t, [userTurn('hi')]);
  v.write('raw/refs/menu.html', '<p>The caf&eacute; costs &euro;5 &ndash; na&iuml;ve&trade; &bull; &Agrave; la carte, &frac12; off</p>');
  const r = v.propose(SID, knowledge('raw/refs/menu.html', 'The café costs €5 – naïve™ • À la carte, ½ off'));
  assert.equal(r.code, 0, r.stderr);
});

test('a Markdown source may be quoted as it reads or as it is written', t => {
  const quote = q => {
    const v = session(t, [userTurn('hi')]);
    v.write('raw/refs/guide.md', 'Use **strict mode** always. Set the `Padding` value. See the [docs](https://example.com/docs) or [[wiki/glim/x|the note]] here.\n');
    return v.propose(SID, knowledge('raw/refs/guide.md', q));
  };
  for (const q of ['Use strict mode always', 'Set the Padding value', 'See the docs or the note here', 'Use **strict mode** always']) {
    const r = quote(q);
    assert.equal(r.code, 0, `${q}: ${r.stderr}`);
  }
  assert.equal(quote('Use strict mode never').code, 1);
});

test('a binary source is checked against its derived text', t => {
  const v = session(t, [userTurn('hi')]);
  v.write('raw/refs/shot.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
  const image = v.propose(SID, knowledge('raw/refs/shot.png', 'what the image shows'));
  assert.equal(image.code, 1);
  assert.match(image.stderr, /raw\/refs\/shot\.png is an image, and what it shows is your reading, so write it on a vault page instead\./);
  const spec = Buffer.from([...Buffer.from('%PDF-1.7\n'), 0xe2, 0x28, 0xa1, 0xff, 0xfe, 0x9c]);
  v.write('raw/refs/spec.pdf', spec);
  const pdf = (quote, slug, doLine, notLine) => v.propose(SID, knowledge('raw/refs/spec.pdf', quote, { slug, topic: slug, do: doLine, not: notLine, applies_to: [`docs/${slug}/**`] }));
  const frames = quote => pdf(quote, 'frames', 'Size each frame at 8 bytes.', 'Pad a frame to 16.');
  const none = frames('the spec says frames are 8 bytes');
  assert.equal(none.code, 1);
  assert.match(none.stderr, /raw\/refs\/spec\.pdf has no text propose\.mjs can read: it isn't UTF-8 and has no derived text\. Run node tools\/extract\.mjs raw\/refs\/spec\.pdf, or save it as UTF-8/);
  v.write(`derived/${sha256(spec)}.md`, withFields(
    { kind: 'pdf', extractor: 'fixture', extractor_version: "'1.0'", source: 'raw/refs/spec.pdf' },
    '[p. 1]\nA frame is 8 bytes long.\nThe header comes\n[p. 2]\nbefore every frame.\n',
  ));
  const fabricated = frames('A frame is 16 bytes long');
  assert.equal(fabricated.code, 1);
  assert.match(fabricated.stderr, /the quote isn't in raw\/refs\/spec\.pdf\. Quote the file's own words\./);
  assert.equal(frames('A frame is 8 bytes long').code, 0);
  const across = pdf('The header comes before every frame', 'headers', 'Write the header ahead of the payload.', 'Append a trailing header.');
  assert.equal(across.code, 0, across.stderr);
});

test('a source that is not UTF-8 text gets the no-text refusal', t => {
  const v = session(t, [userTurn('hi')]);
  v.write('raw/refs/notes.txt', Buffer.from('caf\xe9 au lait is served hot\n', 'latin1'));
  const r = v.propose(SID, knowledge('raw/refs/notes.txt', 'au lait is served hot'));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /raw\/refs\/notes\.txt has no text propose\.mjs can read: it isn't UTF-8 and has no derived text/);
});

test('a URL source is not checked', t => {
  const v = session(t, [userTurn('hi')]);
  assert.equal(v.propose(SID, knowledge('https://example.com/notes', 'what the page says')).code, 0);
});

// The quote warnings on one file, or the tally on wiki.
const wikiFound = async (v, file) => (await v.import('lib/lint.mjs')).lint().filter(f => f.file === file && (file === 'wiki' || /isn't in|can't be checked/.test(f.msg)));

test('a quote from a session whose transcript is gone is checked against the row that recorded it', async t => {
  const v = session(t, [userTurn('please, I want scripts in strict mode always')]);
  assert.equal(v.propose(SID, rule({ quote: 'I want scripts in strict mode always' })).code, 0);
  fs.rmSync(v.at('.transcripts', `${SID}.jsonl`));
  const rel = 'wiki/glim/rules/strict-scripts.md';
  assert.deepEqual(await wikiFound(v, rel), []);
  assert.deepEqual(await wikiFound(v, 'wiki'), []);
  const text = v.read(rel);
  const id = text.match(/\((a-[0-9a-f]{8})\)/)[1];
  v.write(rel, text.replace('"I want scripts in strict mode always"', '"I want scripts in loose mode"'));
  assert.deepEqual((await wikiFound(v, rel)).map(f => f.msg), [`"I want scripts in loose mode" isn't in what row ${id} recorded`]);
  assert.deepEqual(await wikiFound(v, 'wiki'), []);
});

test('a row another session recorded does not back a quote from a session whose transcript is gone, but a rule renamed since still passes', async t => {
  const v = session(t, [userTurn('please, I want scripts in strict mode always')]);
  assert.equal(v.propose(SID, rule({ quote: 'I want scripts in strict mode always' })).code, 0);
  fs.rmSync(v.at('.transcripts', `${SID}.jsonl`));
  const text = v.read('wiki/glim/rules/strict-scripts.md');
  const id = text.match(/\((a-[0-9a-f]{8})\)/)[1];
  v.write('wiki/glim/rules/borrowed.md', ruleNote({ keywords: ['borrow'], evidence: [`- 2026-10-02 · stated · session deadbeef · "I want scripts in strict mode always" (${id})`] }));
  assert.deepEqual((await wikiFound(v, 'wiki/glim/rules/borrowed.md')).map(f => f.msg), [`"I want scripts in strict mode always" isn't in what row ${id} recorded for session deadbeef: it was recorded in session ${SID.slice(0, 8)}`]);
  assert.deepEqual(await wikiFound(v, 'wiki/glim/rules/strict-scripts.md'), []);
  v.write('wiki/glim/rules/renamed.md', text);
  assert.deepEqual(await wikiFound(v, 'wiki/glim/rules/renamed.md'), []);
});

const goneSession = (v, extra = '') => {
  v.write('wiki/glim/rules/no-row.md', ruleNote({ keywords: ['x'], evidence: ['- 2026-10-01 · stated · session 0badc0de · "do the thing" (a-0badc0de)', '- 2026-10-01 · stated · session 0badc0de · "and no id at all"'] }));
  v.write('wiki/glim/rules/from-url.md', ruleNote({ keywords: ['y'], kind: 'knowledge', basis: 'source', extra: ['as_of: 2026-10-01'], evidence: [`- 2026-10-01 · source · session 0badc0de · https://example.com/notes · dated 2026-10-01 · "what the page says${extra}" (a-0badc0df)`] }));
  v.write('wiki/glim/sources/source-shop.md', sourcePage({ source: 'https://example.com/shop', body: ['## You said', '- 2026-10-01 · session 0badc0de · "the tabs feel cramped"', '', "## Agent's reading", '', '## Rules'] }));
};

test('lint tallies the quotes it can\'t check in one warning: URLs, and sessions whose transcript is gone with no row', async t => {
  const v = makeVault(t);
  goneSession(v);
  const found = await wikiFound(v, 'wiki');
  assert.deepEqual(found.map(f => [f.level, f.msg]), [['warn', "4 quotes can't be checked: 1 cites a URL, 3 a session whose transcript is gone. node tools/review.mjs status lists them."]]);
  assert.deepEqual((await (await v.import('lib/lint.mjs')).lint()).filter(f => /can't be checked|isn't in/.test(f.msg) && f.file !== 'wiki'), []);
  const one = makeVault(t);
  one.write('wiki/glim/rules/from-url.md', ruleNote({ keywords: ['y'], kind: 'knowledge', basis: 'source', extra: ['as_of: 2026-10-01'], evidence: ['- 2026-10-01 · source · session 0badc0de · https://example.com/notes · dated 2026-10-01 · "what the page says" (a-0badc0df)'] }));
  assert.deepEqual((await wikiFound(one, 'wiki')).map(f => f.msg), ["1 quote can't be checked: 1 cites a URL. node tools/review.mjs status lists them."]);
});

test("review.mjs status lists the quotes lint can't check, each clipped to 80 characters", t => {
  const v = makeVault(t);
  const long = ', and it goes on long past where the status line would cut it short';
  goneSession(v, long);
  const out = v.run('review.mjs', ['status']);
  assert.equal(out.code, 0, out.stderr);
  assert.deepEqual(sectionOf(out.stdout, "Quotes lint can't check"), [
    '- wiki/glim/rules/from-url.md · https://example.com/notes · "what the page says, and it goes on long past where the status line would cut it…"',
    '- wiki/glim/rules/no-row.md · session 0badc0de · "do the thing"',
    '- wiki/glim/rules/no-row.md · session 0badc0de · "and no id at all"',
    '- wiki/glim/sources/source-shop.md · session 0badc0de · "the tabs feel cramped"',
  ]);
});

const sourceRule = (slug, ...evidence) => withFields(
  { type: 'rule', domain: 'glim', kind: 'knowledge', basis: 'source', as_of: '2026-10-01', topic: 'code', always: false, applies_to: `\n  - 'docs/${slug}/**'`, created: '2026-10-01', updated: '2026-10-01' },
  `\n**Do:** Read the ${slug} source.\n**Not:** Guess at the ${slug} source.\n**Because:** The source says so.\n\n## Examples\n\n## Evidence\n${evidence.map((e, i) => `- 2026-10-01 · source · session 1a2b3c4d · ${e} (a-0000000${i + 1})`).join('\n')}\n`,
);
const evidenceWarnings = async (v, rel) => (await (await v.import('lib/lint.mjs')).lint()).filter(f => f.file === rel).map(f => f.msg);

test('lint warns once per quote it cannot check against a binary with no derived text', async t => {
  const v = makeVault(t, { presets: ['archive'] });
  v.write('wiki/glim/rules/talk-rule.md', sourceRule('talk', 'raw/refs/talk.mp4 · dated 2026-10-01 · "the talk opens on cells"', 'raw/refs/talk.mp4 · dated 2026-10-01 · "and closes on grids"'));
  assert.deepEqual(await evidenceWarnings(v, 'wiki/glim/rules/talk-rule.md'), [
    '"the talk opens on cells" can\'t be checked: raw/refs/talk.mp4 has no derived text. Run node tools/extract.mjs raw/refs/talk.mp4, or save it as UTF-8',
    '"and closes on grids" can\'t be checked: raw/refs/talk.mp4 has no derived text. Run node tools/extract.mjs raw/refs/talk.mp4, or save it as UTF-8',
  ]);
});

test('lint checks a quote from a binary against its derived text', async t => {
  const v = makeVault(t, { presets: ['archive'] });
  v.write('wiki/glim/rules/paper-rule.md', sourceRule('paper', 'raw/refs/paper.pdf · dated 2026-10-01 · "counts each lit cell. A cell lit twice"', 'raw/refs/paper.pdf · dated 2026-10-01 · "a cell lit twice counts twice"'));
  assert.deepEqual(await evidenceWarnings(v, 'wiki/glim/rules/paper-rule.md'), [
    '"a cell lit twice counts twice" isn\'t in raw/refs/paper.pdf. Quote the file\'s own words, with … where you leave some out',
  ]);
});

test('lint warns once per line that quotes an image as a source', async t => {
  const v = makeVault(t);
  v.write('raw/refs/shot.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
  v.write('wiki/glim/rules/shot-rule.md', sourceRule('shot', 'raw/refs/shot.png · dated 2026-10-01 · "the tabs sit on top"', 'raw/refs/shot.png · dated 2026-10-01 · "the cards are wide"'));
  const warning = 'an Evidence line quotes raw/refs/shot.png, an image, as a source. What an image shows is a reading: give it basis reading';
  assert.deepEqual(await evidenceWarnings(v, 'wiki/glim/rules/shot-rule.md'), [warning, warning]);
});

// A file no buffer holds (2 GiB) can't be written in a test, so the read that fails on it is stubbed.
function readFails(t, name, code) {
  const real = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', function (p, ...rest) {
    if (String(p).endsWith(name)) throw Object.assign(new Error(`${code}: stubbed`), { code });
    return real.call(this, p, ...rest);
  });
}

test('a binary is told from its first bytes, and never read whole', async t => {
  const v = makeVault(t, { presets: ['archive'] });
  v.write('raw/refs/clip.dat', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(100), Buffer.from('tail')]));
  v.write('raw/refs/latin.txt', Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x61, 0x75, 0x20, 0x6c, 0x61, 0x69, 0x74]));
  const { fileText } = await v.import('lib/sources.mjs');
  readFails(t, 'clip.dat', 'EIO');
  readFails(t, 'latin.txt', 'EIO');
  assert.equal(fileText(v.at('raw', 'refs', 'clip.dat')), null);
  assert.equal(fileText(v.at('raw', 'refs', 'latin.txt')), null);
});

test('a character cut by the end of the first bytes is not mistaken for a binary', async t => {
  const v = makeVault(t, { presets: ['archive'] });
  const text = `${'a'.repeat(8191)}é and more\n`;
  v.write('raw/refs/long.txt', text);
  const { fileText, lineCount } = await v.import('lib/sources.mjs');
  assert.equal(fileText(v.at('raw', 'refs', 'long.txt')), text);
  assert.equal(lineCount('raw/refs/long.txt'), 1);
});

test('a file too large to read whole is a binary: no text, no derived text, and lint says so', async t => {
  const v = makeVault(t, { presets: ['archive'] });
  v.write('raw/refs/huge.txt', 'the log is long\n');
  v.write('wiki/glim/rules/huge-rule.md', sourceRule('huge', 'raw/refs/huge.txt · dated 2026-10-01 · "the log is long"'));
  readFails(t, 'huge.txt', 'ERR_FS_FILE_TOO_LARGE');
  const { sourceTexts, quoteTexts } = await v.import('lib/quotes.mjs');
  const { lineCount } = await v.import('lib/sources.mjs');
  assert.equal(sourceTexts('raw/refs/huge.txt'), null);
  assert.deepEqual(quoteTexts('raw/refs/huge.txt'), { why: 'no derived text' });
  assert.equal(lineCount('raw/refs/huge.txt'), null);
  assert.deepEqual(await evidenceWarnings(v, 'wiki/glim/rules/huge-rule.md'), [
    '"the log is long" can\'t be checked: raw/refs/huge.txt has no derived text. Run node tools/extract.mjs raw/refs/huge.txt, or save it as UTF-8',
  ]);
});

test("a file another program holds open still passes lint's quote check, as a transient failure", async t => {
  const v = makeVault(t, { presets: ['archive'] });
  v.write('raw/refs/busy.txt', 'the log is long\n');
  v.write('wiki/glim/rules/busy-rule.md', sourceRule('busy', 'raw/refs/busy.txt · dated 2026-10-01 · "the log is long"'));
  readFails(t, 'busy.txt', 'EBUSY');
  assert.deepEqual(await evidenceWarnings(v, 'wiki/glim/rules/busy-rule.md'), []);
});

test('quoteTexts hashes a binary through the hash its caller gives it', async t => {
  const v = makeVault(t, { presets: ['archive'] });
  const { quoteTexts } = await v.import('lib/quotes.mjs');
  const hash = 'ab'.repeat(32);
  v.write(`derived/${hash}.md`, "---\nkind: pdf\nextractor: fixture\nextractor_version: '1.0'\nsource: raw/refs/talk.mp4\n---\n[p. 1]\nA stated line.\n");
  const asked = [];
  const got = quoteTexts('raw/refs/talk.mp4', rel => { asked.push(rel); return hash; });
  assert.deepEqual(asked, ['raw/refs/talk.mp4']);
  assert.equal(got.texts.length, 1);
  assert.match(got.texts[0], /A stated line\./);
  assert.doesNotMatch(got.texts[0], /\[p\. 1\]/);
});

test('a gif, bmp or tiff quote is an image, not a file to extract', async t => {
  const v = makeVault(t, { presets: ['archive'] });
  const { quoteTexts } = await v.import('lib/quotes.mjs');
  for (const name of ['shot.gif', 'shot.bmp', 'shot.tif', 'shot.tiff', 'shot.GIF']) {
    v.write(`raw/refs/${name}`, Buffer.from([0xff, 0x00, 0x01]));
    assert.deepEqual(quoteTexts(`raw/refs/${name}`), { why: 'image' }, name);
  }
});
