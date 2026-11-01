import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeVault, sessionId, editFile, denied, ruleNote, sha256, sectionOf } from './fixture.mjs';
import { today } from '../tools/lib/vault.mjs';

// The design checks that need phase 4 or 5 code, each run on the preset it names (design §8 item 3).

const ledgerEdit = (v, sid) => denied(editFile(v, sid, 'src/ledger.txt', { abs: path.join(v.projects.almanac, 'src', 'ledger.txt'), cwd: v.projects.almanac })) ?? '';

test('a project whose lockfile pins pkg 2 delivers only the v2 rule, and review status ranks it first', { todo: '6.1c, phase 4: version readers' }, t => {
  const v = makeVault(t, { presets: ['almanac'] });
  // A later as_of would rank v3 first, so only the version match can put v2 ahead.
  v.write('wiki/almanac/rules/ledger-v3.md', v.read('wiki/almanac/rules/ledger-v3.md').replace(/^as_of: .*$/m, `as_of: ${today()}`));
  const sid = sessionId();
  v.startSession(sid, { cwd: v.projects.almanac });
  const refusal = ledgerEdit(v, sid);
  assert.match(refusal, /almanac\/ledger-v2: Do: Call openLedger with the path\./);
  assert.doesNotMatch(refusal, /almanac\/ledger-v3/, 'the v3 rule is delivered in a project whose lockfile pins pkg 2.4.0');
  assert.doesNotMatch(refusal, /version unknown/);
  const pairs = sectionOf(v.run('review.mjs', ['status']).stdout, 'Rules on one topic whose globs overlap') ?? [];
  assert.match(pairs.join('\n'), /almanac\/ledger-v2 and almanac\/ledger-v3, .* · almanac\/ledger-v2 ranks first: /);
});

test('refresh labels a rule unverified once a source it cites has changed', { todo: '6.2a, phase 4: refresh' }, t => {
  const v = makeVault(t, { presets: ['almanac'] });
  const r = v.run('refresh.mjs');
  const sid = sessionId();
  v.startSession(sid, { cwd: v.projects.almanac });
  assert.match(ledgerEdit(v, sid), /- almanac\/ledger-v2: .* source changed on \d{4}-\d\d-\d\d/, `refresh exited ${r.code}: ${r.stderr}`);
});

test('a doc set of 2,000 links and 50 cited pages starts a session in under 500 ms and is one source', { todo: '6.2b, phase 4: doc sets' }, t => {
  const v = makeVault(t, { presets: ['almanac'] });
  const set = 'raw/refs/ledger-docs';
  const page = i => `https://example.com/pkg/docs/page-${i}.md`;
  for (let i = 0; i < 50; i++) {
    v.write(`wiki/almanac/rules/ledger-option-${i}.md`, ruleNote({
      domain: 'almanac', topic: 'ledger', kind: 'knowledge', basis: 'source', keywords: [`ledger option ${i}`], extra: ['as_of: 2026-10-01'],
      doLine: `Set field ${i} through option ${i}.`, notLine: `Write field ${i} directly.`,
      evidence: [`- 2026-10-01 · source · session 1a2b3c4d · ${set}/page-${i}.md · dated 2026-10-01 · "openLedger option ${i} sets field ${i} of the ledger" (a-${String(i).padStart(8, '0')})`],
    }));
  }
  // Reading and building 50 new rules costs what any 50 notes would, so they are in place before the doc set lands.
  v.startSession(sessionId(), { cwd: v.projects.almanac });
  v.write(`${set}/llms.txt`, ['# pkg', '', '> The pkg ledger API.', '', '## Docs', '', ...Array.from({ length: 2000 }, (_, i) => `- [Page ${i}](${page(i)})`), ''].join('\n'));
  for (let i = 0; i < 50; i++) {
    const text = `# Page ${i}\n\nopenLedger option ${i} sets field ${i} of the ledger.\n`;
    v.write(`${set}/page-${i}.md`, `---\nurl: ${page(i)}\nfetched: 2026-10-01\nsha256: ${sha256(text)}\n---\n${text}`);
  }
  const timed = () => {
    const started = performance.now();
    v.startSession(sessionId(), { cwd: v.projects.almanac });
    return Math.round(performance.now() - started);
  };
  // The first start after the set lands is the one a user waits on; the fastest of three is how test/perf takes it.
  const first = timed();
  assert.ok(first < 500, `the first session start after the doc set landed took ${first} ms`);
  const times = [0, 1, 2].map(timed);
  const ms = Math.round(Math.min(...times));
  t.diagnostic(`session start: first ${first} ms, fastest ${ms} ms of 3`);
  assert.ok(ms < 500, `the fastest of 3 session starts took ${ms} ms`);
  const listed = v.run('review.mjs', ['sources']).stdout.trimEnd().split('\n');
  assert.equal(listed.length, 1, `review.mjs sources lists ${listed.length} sources, not the one doc set:\n${listed.slice(0, 5).join('\n')}\n…`);
  assert.match(listed[0], /^raw\/refs\/ledger-docs\b/);
});

test('the first AskUserQuestion in a session is denied with the rule on it, and the second goes through', { todo: '6.3c, phase 5: tool triggers' }, t => {
  const v = makeVault(t, { presets: ['glim'] });
  const sid = sessionId();
  v.startSession(sid);
  const ask = () => v.edit(sid, 'AskUserQuestion', { questions: [{
    question: 'Which card layout?', header: 'Layout', multiSelect: false,
    options: [{ label: 'Grid', description: 'Cards in an even grid.' }, { label: 'Shelf', description: 'One featured card above a row.' }],
  }] });
  assert.match(denied(ask()) ?? '', /glim\/ask-rule: Do: Offer layouts as two to four options\./, 'the first AskUserQuestion is not denied with glim/ask-rule');
  assert.equal(denied(ask()), null);
});

test('a quote against a PDF is checked against its derived text', { todo: '6.4a, phase 5: derived text' }, t => {
  const v = makeVault(t, { presets: ['archive'] });
  const sid = sessionId();
  v.startSession(sid);
  const fact = (slug, quote, doLine, notLine) => v.propose(sid, {
    domain: v.domain, slug, topic: 'code', kind: 'knowledge', basis: 'source', do: doLine, not: notLine, because: '',
    applies_to: ['src/**/*.zq'], source: 'raw/refs/paper.pdf', source_date: '2026-10-01', quote,
  });
  const fabricated = fact('lit-twice', 'A cell lit twice counts twice', 'Count a cell for each time it lights.', 'Count a lit cell once.');
  assert.equal(fabricated.code, 1, `a quote raw/refs/paper.pdf's derived text doesn't hold was written:\n${fabricated.stdout}`);
  assert.match(fabricated.stderr, /quote isn't in/);
  const real = fact('lit-once', 'A cell lit twice still counts once', 'Count a lit cell once in the glimmer index.', 'Add to the index each time a cell lights.');
  assert.equal(real.code, 0, real.stderr);
});
