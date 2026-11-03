import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeVault } from './fixture.mjs';

const base = { call: 'toolu_01', session: 's-1', subagent: null, tool: 'keep', offer: 'o-1a2b3c4d' };

async function calls(t) {
  const v = makeVault(t);
  return { v, ...(await v.import('lib/calls.mjs')) };
}

test('a recorded call reads back with the fields the hook saw and nothing allowed or used', async t => {
  const { v, recordCall, readCall, inputHash } = await calls(t);
  assert.equal(readCall('toolu_01'), null);
  assert.deepEqual(recordCall({ ...base, input: { id: 'o-1a2b3c4d' } }), { seen: null });
  const rec = readCall('toolu_01');
  assert.deepEqual({ ...rec, at: undefined }, { ...base, input: inputHash({ id: 'o-1a2b3c4d' }), at: undefined, allowed: null, used: null });
  assert.match(rec.input, /^[0-9a-f]{64}$/);
  assert.ok(Number.isFinite(Date.parse(rec.at)));
  assert.ok(v.exists('.state/calls/toolu_01.json'));
});

test('a call id that is not a safe file name is stored under its hash and still reads back', async t => {
  const { recordCall, readCall } = await calls(t);
  recordCall({ ...base, call: '../x/y z', offer: null });
  assert.equal(readCall('../x/y z').call, '../x/y z');
});

test('a second keep for one offer returns the first call and writes nothing', async t => {
  const { v, recordCall, readCall, keepCallFor } = await calls(t);
  recordCall(base);
  assert.deepEqual(recordCall({ ...base, call: 'toolu_02' }), { seen: 'toolu_01' });
  assert.equal(readCall('toolu_02'), null);
  assert.equal(v.exists('.state/calls/toolu_02.json'), false);
  assert.equal(keepCallFor('o-1a2b3c4d').call, 'toolu_01');
  assert.equal(keepCallFor('o-ffffffff'), null);
});

test('a call without an offer never reads as seen, and hooks that rerun for one call keep its allowance', async t => {
  const { recordCall, allowCall, readCall } = await calls(t);
  recordCall({ ...base, tool: 'proposals', offer: null });
  assert.deepEqual(recordCall({ ...base, call: 'toolu_02', tool: 'proposals', offer: null }), { seen: null });
  allowCall('toolu_01');
  recordCall({ ...base, tool: 'proposals', offer: null });
  assert.ok(readCall('toolu_01').allowed);
});

test('useCall fails before allowCall, passes once after, then fails', async t => {
  const { recordCall, allowCall, useCall, readCall } = await calls(t);
  const who = { session: 's-1', tool: 'keep', offer: 'o-1a2b3c4d' };
  recordCall(base);
  assert.equal(useCall('toolu_01', who), false);
  assert.equal(allowCall('toolu_01').call, 'toolu_01');
  const allowed = readCall('toolu_01').allowed;
  assert.ok(Number.isFinite(Date.parse(allowed)));
  assert.equal(allowCall('toolu_01').allowed, allowed);
  assert.equal(useCall('toolu_01', who), true);
  assert.ok(readCall('toolu_01').used);
  assert.equal(useCall('toolu_01', who), false);
});

test('allowCall on a call nobody recorded gives null, and useCall on it fails', async t => {
  const { allowCall, useCall } = await calls(t);
  assert.equal(allowCall('toolu_09'), null);
  assert.equal(useCall('toolu_09', { session: 's-1', tool: 'keep' }), false);
});

test('useCall fails for another session, tool or offer, and the call stays usable by the right one', async t => {
  const { recordCall, allowCall, useCall } = await calls(t);
  recordCall(base);
  allowCall('toolu_01');
  assert.equal(useCall('toolu_01', { session: 's-2', tool: 'keep', offer: 'o-1a2b3c4d' }), false);
  assert.equal(useCall('toolu_01', { session: 's-1', tool: 'proposals', offer: 'o-1a2b3c4d' }), false);
  assert.equal(useCall('toolu_01', { session: 's-1', tool: 'keep', offer: 'o-ffffffff' }), false);
  assert.equal(useCall('toolu_01', { session: 's-1', tool: 'keep' }), false);
  assert.equal(useCall('toolu_01', { session: 's-1', tool: 'keep', offer: 'o-1a2b3c4d' }), true);
});

test('a call recorded without an offer matches useCall without one', async t => {
  const { recordCall, allowCall, useCall } = await calls(t);
  recordCall({ ...base, tool: 'proposals', offer: null });
  allowCall('toolu_01');
  assert.equal(useCall('toolu_01', { session: 's-1', tool: 'proposals', offer: 'o-1a2b3c4d' }), false);
  assert.equal(useCall('toolu_01', { session: 's-1', tool: 'proposals' }), true);
});

test('pruneCalls drops records and offer files older than the age and keeps newer ones', async t => {
  const { v, recordCall, readCall, keepCallFor, pruneCalls } = await calls(t);
  recordCall(base);
  recordCall({ ...base, call: 'toolu_03', tool: 'proposals', offer: null });
  const old = JSON.parse(v.read('.state/calls/toolu_01.json'));
  old.at = new Date(Date.now() - 3 * 864e5).toISOString();
  v.write('.state/calls/toolu_01.json', JSON.stringify(old), { saved: new Date(Date.now() - 3 * 864e5) });
  fs.utimesSync(v.at('.state/calls/offers/o-1a2b3c4d.json'), new Date(Date.now() - 3 * 864e5), new Date(Date.now() - 3 * 864e5));
  pruneCalls();
  assert.equal(readCall('toolu_01'), null);
  assert.equal(keepCallFor('o-1a2b3c4d'), null);
  assert.ok(readCall('toolu_03'));
  pruneCalls(0);
  assert.equal(readCall('toolu_03'), null);
});

test('pruneCalls with nothing recorded does nothing', async t => {
  const { pruneCalls } = await calls(t);
  assert.doesNotThrow(() => pruneCalls());
});

test('inputHash reads keys in any order at every depth, keeps array order, and takes no input as {}', async t => {
  const { inputHash } = await calls(t);
  assert.equal(inputHash({ a: 1, b: { c: [1, { d: 2, e: 3 }], f: 'x' } }), inputHash({ b: { f: 'x', c: [1, { e: 3, d: 2 }] }, a: 1 }));
  assert.notEqual(inputHash({ a: [1, 2] }), inputHash({ a: [2, 1] }));
  assert.equal(inputHash(null), inputHash({}));
  assert.equal(inputHash(undefined), inputHash({}));
  assert.equal(inputHash({ a: 1, b: undefined }), inputHash({ a: 1 }));
  assert.notEqual(inputHash({ a: '1' }), inputHash({ a: 1 }));
});

test('useCall passes only for the input the call was recorded with, in any key order, and a mismatch spends the call', async t => {
  const { recordCall, allowCall, useCall, readCall } = await calls(t);
  const who = { session: 's-1', tool: 'keep', offer: 'o-1a2b3c4d' };
  recordCall({ ...base, input: { id: 'o-1a2b3c4d', offer: 'line one' } });
  allowCall('toolu_01');
  assert.equal(useCall('toolu_01', { ...who, input: { offer: 'line one', id: 'o-1a2b3c4d' } }), true);
  const other = { ...who, offer: 'o-2b3c4d5e' };
  recordCall({ ...base, call: 'toolu_02', offer: other.offer, input: { id: other.offer, offer: 'line one' } });
  allowCall('toolu_02');
  assert.equal(useCall('toolu_02', { ...other, input: { id: other.offer, offer: 'line two' } }), false);
  assert.notEqual(readCall('toolu_02').used, null);
  assert.equal(useCall('toolu_02', { ...other, input: { id: other.offer, offer: 'line one' } }), false);
});

test('a record with no input hash never passes useCall', async t => {
  const { v, recordCall, allowCall, useCall } = await calls(t);
  recordCall({ ...base, tool: 'proposals', offer: null });
  allowCall('toolu_01');
  const rec = JSON.parse(v.read('.state/calls/toolu_01.json'));
  delete rec.input;
  v.write('.state/calls/toolu_01.json', JSON.stringify(rec));
  assert.equal(useCall('toolu_01', { session: 's-1', tool: 'proposals' }), false);
});
