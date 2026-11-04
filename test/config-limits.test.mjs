import test from 'node:test';
import assert from 'node:assert/strict';
import { makeVault, sessionId, userTurn, assistantTurn, offerOf } from './fixture.mjs';

// queue.sweepAfterHours and pages.maxOfferChars each guard a session or a cap: a value that isn't a positive number
// falls back to its default, and lint reports it.
const BAD_HOURS = ['12', 0, -1, null, [], {}];
const BAD_CHARS = ['4000', 0, -5, 2.5, null, true];

// Each call starts from the fixture's own config, so one case's value never carries into the next.
const base = new WeakMap();
function withConfig(v, extra) {
  if (!base.has(v)) base.set(v, JSON.parse(v.read('vault.config.json')));
  v.write('vault.config.json', JSON.stringify({ ...base.get(v), ...extra }));
}

test('config() takes the default for a sweepAfterHours or maxOfferChars that is not a positive number', async t => {
  const v = makeVault(t);
  const { config, reloadConfig } = await v.import('lib/vault.mjs');
  for (const hours of BAD_HOURS) {
    withConfig(v, { queue: { sweepAfterHours: hours } });
    reloadConfig();
    assert.equal(config().queue.sweepAfterHours, 12, JSON.stringify(hours));
  }
  for (const chars of BAD_CHARS) {
    withConfig(v, { pages: { maxOfferChars: chars } });
    reloadConfig();
    assert.equal(config().pages.maxOfferChars, 4000, JSON.stringify(chars));
  }
  withConfig(v, { queue: { sweepAfterHours: 0.5 }, pages: { maxOfferChars: 100 } });
  reloadConfig();
  assert.equal(config().queue.sweepAfterHours, 0.5);
  assert.equal(config().pages.maxOfferChars, 100);
});

test('lintConfig reports a sweepAfterHours or maxOfferChars that is not a positive number, and passes good ones', async t => {
  const v = makeVault(t);
  const { lintConfig } = await v.import('lib/lint.mjs');
  const found = () => {
    const out = [];
    lintConfig((level, file, msg) => out.push(`${level} ${file} ${msg}`));
    return out.filter(m => /sweepAfterHours|maxOfferChars|^error vault\.config\.json (queue|pages) /.test(m));
  };
  for (const hours of BAD_HOURS) {
    withConfig(v, { queue: { sweepAfterHours: hours } });
    assert.deepEqual(found(), ['error vault.config.json queue.sweepAfterHours must be a number of hours above 0'], JSON.stringify(hours));
  }
  for (const chars of BAD_CHARS) {
    withConfig(v, { pages: { maxOfferChars: chars } });
    assert.deepEqual(found(), ['error vault.config.json pages.maxOfferChars must be a whole number of characters above 0'], JSON.stringify(chars));
  }
  for (const shape of [{ queue: 'often' }, { pages: [] }]) {
    withConfig(v, shape);
    assert.equal(found().length, 1, JSON.stringify(shape));
  }
  withConfig(v, { queue: { sweepAfterHours: 0.5 }, pages: { maxOfferChars: 100 } });
  assert.deepEqual(found(), []);
  withConfig(v, { queue: {}, pages: {} });
  assert.deepEqual(found(), []);
});

test("a sweepAfterHours of 0 doesn't sweep a session that was seen a minute ago", t => {
  const v = makeVault(t, { config: { proposals: 'ask', queue: { sweepAfterHours: 0 } } });
  const a = sessionId();
  v.startSession(a, { transcript: v.transcript(a, [userTurn('call them by their screen'), assistantTurn('Noted.')]) });
  const r = v.propose(a, {
    domain: 'glim', slug: 'tidy-names', topic: 'code', basis: 'stated', quote: 'call them by their screen',
    do: 'Name widgets after their screen.', not: 'Leave widget names bare.', keywords: ['widgetz'], applies_to: ['src/**/*.zq'],
  });
  const o = offerOf(r.stdout);
  assert.ok(o, r.stdout + r.stderr);
  v.startSession(sessionId());
  assert.equal(v.exists('raw/queue'), false);
  assert.equal(JSON.parse(v.read(`.state/offers/${o.id}.json`)).state, 'pending');
});
