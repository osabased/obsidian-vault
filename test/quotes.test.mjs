import fs from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeVault, userTurn, assistantTurn, toolResult } from './fixture.mjs';

const SID = '9f8e7d6c-0000-4000-8000-000000000001';

const rule = (extra = {}) => ({
  domain: 'demo', slug: 'strict-scripts', topic: 'code', basis: 'stated',
  do: 'Start scripts with --!strict.', not: 'Leave scripts nonstrict.', because: '', applies_to: ['src/**/*.luau'], ...extra,
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
  assert.match(v.read('wiki/demo/strict-scripts.md'), /"I want scripts in strict mode always"/);
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
  assert.equal(v.exists('wiki/demo/strict-scripts.md'), false);
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

test('an inferred quote is checked too', t => {
  const v = session(t, [userTurn('no, that one should be strict')]);
  notTyped(v.propose(SID, rule({ basis: 'inferred', quote: 'every script should be strict' })));
  assert.equal(v.propose(SID, rule({ basis: 'inferred', quote: 'that one should be strict' })).code, 0);
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
  const v = session(t, null);
  assert.equal(v.propose(SID, rule({ basis: 'reading', reading: 'the UI scripts all start with --!strict' })).code, 0);
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
    v.write('raw/refs/guide.md', 'Use **strict mode** always. Set the `Padding` value. See the [docs](https://example.com/docs) or [[wiki/demo/x|the note]] here.\n');
    return v.propose(SID, knowledge('raw/refs/guide.md', q));
  };
  for (const q of ['Use strict mode always', 'Set the Padding value', 'See the docs or the note here', 'Use **strict mode** always']) {
    const r = quote(q);
    assert.equal(r.code, 0, `${q}: ${r.stderr}`);
  }
  assert.equal(quote('Use strict mode never').code, 1);
});

test('a binary source is not checked', t => {
  const v = session(t, [userTurn('hi')]);
  v.write('raw/refs/shot.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
  assert.equal(v.propose(SID, knowledge('raw/refs/shot.png', 'what the image shows')).code, 0);
  v.write('raw/refs/spec.pdf', Buffer.from([...Buffer.from('%PDF-1.7\n'), 0xe2, 0x28, 0xa1, 0xff, 0xfe, 0x9c]));
  const r = v.propose(SID, knowledge('raw/refs/spec.pdf', 'what the spec says', { slug: 'pdf', topic: 'specs', do: 'Read specs first.', not: 'Guess formats.', applies_to: ['docs/**'] }));
  assert.equal(r.code, 0, r.stderr);
});

test('a URL source is not checked', t => {
  const v = session(t, [userTurn('hi')]);
  assert.equal(v.propose(SID, knowledge('https://example.com/notes', 'what the page says')).code, 0);
});
