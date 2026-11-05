import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeVault, sessionId, userTurn, assistantTurn, offerOf, pageNote, zqEntityPage, keepAllowed, ruleNote } from './fixture.mjs';

const typed = said => said.flatMap(s => [userTurn(s), assistantTurn('Noted.')]);
function started(v) {
  const sid = sessionId();
  v.startSession(sid, { transcript: v.transcript(sid, typed(['hi'])) });
  return sid;
}
const askVault = t => makeVault(t, { config: { proposals: 'ask' } });

test('a page change goes only in the folder its kind goes in', t => {
  const v = askVault(t);
  const sid = started(v);
  for (const rel of ['wiki/glim/junk/zq-lib.md', 'wiki/glim/rules/zq-lib.md', 'wiki/glim/topics/zq-lib.md']) {
    const r = v.propose(sid, { page: rel, text: zqEntityPage() });
    assert.notEqual(r.code, 0, rel);
    assert.match(r.stderr, /an entity page goes in wiki\/glim\/entities\//, rel);
  }
  assert.equal(v.propose(sid, { page: 'wiki/glim/entities/zq-lib.md', text: zqEntityPage() }).code, 0);
});

test('a page change into a dot-folder is refused', t => {
  const v = askVault(t);
  const sid = started(v);
  const r = v.propose(sid, { page: 'wiki/glim/.hid/zq-lib.md', text: zqEntityPage() });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /an entity page goes in wiki\/glim\/entities\//);
  assert.equal(v.exists('wiki/glim/.hid/zq-lib.md'), false);
});

test('a page with no valid kind is refused when its folder is no kind folder', t => {
  const v = askVault(t);
  const sid = started(v);
  const r = v.propose(sid, { page: 'wiki/glim/junk/zq-lib.md', text: pageNote({ kind: '' }) });
  assert.notEqual(r.code, 0);
});

test('a page path that differs from an existing note only in Unicode form changes that note, not a second file', t => {
  const v = askVault(t);
  const sid = started(v);
  v.write('wiki/glim/topics/café.md', pageNote());
  const r = v.propose(sid, { page: 'wiki/glim/topics/café.md', text: pageNote({ body: ['Different body.'] }) });
  assert.equal(r.code, 0, r.stderr);
  const o = offerOf(r.stdout);
  assert.match(o.text, /wiki\/glim\/topics\/café\.md · change/);
  assert.equal(keepAllowed(v, sid, o.id, o.text).code, 0);
  assert.equal(v.exists('wiki/glim/topics/café.md'), false);
  assert.match(v.read('wiki/glim/topics/café.md'), /Different body\./);
});

test('a decomposed page path is offered, kept and written under its composed name', t => {
  const v = askVault(t);
  const sid = started(v);
  const r = v.propose(sid, { page: 'wiki/glim/topics/café.md', text: pageNote() });
  assert.equal(r.code, 0, r.stderr);
  const o = offerOf(r.stdout);
  assert.match(o.text, /wiki\/glim\/topics\/café\.md/);
  const k = keepAllowed(v, sid, o.id, o.text);
  assert.equal(k.code, 0, k.stderr);
  assert.ok(v.exists('wiki/glim/topics/café.md'));
});

test('a lone CR in page text is turned into a line break, so keep accepts the offer', t => {
  const v = askVault(t);
  const sid = started(v);
  const r = v.propose(sid, { page: 'wiki/glim/topics/cr-page.md', text: pageNote({ body: ['Line one\rmid CR here.'] }) });
  assert.equal(r.code, 0, r.stderr);
  const o = offerOf(r.stdout);
  assert.ok(!o.text.includes('\r'));
  const k = keepAllowed(v, sid, o.id, o.text);
  assert.equal(k.code, 0, k.stderr);
  assert.match(v.read('wiki/glim/topics/cr-page.md'), /Line one\nmid CR here\./);
});

test("a page can't take the key a moved rule had before its move", t => {
  const v = makeVault(t, { config: { proposals: 'ask' }, domains: { quill: { title: 'Quill', topics: ['code'], markers: ['quill.project'] } } });
  v.write('wiki/glim/rules/the-thing.md', ruleNote({ keywords: ['thing'] }));
  const sid = started(v);
  const move = v.propose(sid, { change: 'move', key: 'glim/the-thing', domain: 'quill' });
  const o = offerOf(move.stdout);
  assert.ok(o, move.stderr);
  assert.equal(keepAllowed(v, sid, o.id, o.text).code, 0);
  const r = v.propose(sid, { page: 'wiki/glim/concepts/the-thing.md', text: pageNote({ kind: 'concept', summary: "'A concept.'" }) });
  assert.equal(r.stderr, 'Not proposed: wiki/quill/rules/the-thing.md already exists. Pick another slug, or leave that note to the user.\n');
});
