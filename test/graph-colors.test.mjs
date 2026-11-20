import test from 'node:test';
import assert from 'node:assert/strict';
import { makeVault } from './fixture.mjs';

const graph = v => JSON.parse(v.read('.obsidian/graph.json'));

test('build writes the graph color groups after the user\'s own, keeping the other graph settings', t => {
  const v = makeVault(t);
  const mine = { query: 'tag:#draft', color: { a: 1, rgb: 255 } };
  v.write('.obsidian/graph.json', JSON.stringify({ scale: 2, showArrow: true, colorGroups: [mine] }));
  assert.equal(v.run('build.mjs').code, 0);
  const g = graph(v);
  assert.equal(g.scale, 2);
  assert.equal(g.showArrow, true);
  assert.deepEqual(g.colorGroups[0], mine);
  const queries = g.colorGroups.slice(1).map(c => c.query);
  assert.deepEqual(queries, [
    '[type:rule] [kind:taste]',
    '[type:rule] [kind:practice]',
    '[type:rule] [kind:knowledge]',
    '[type:page] [kind:topic]',
    '[type:page] -[kind:topic]',
    'path:/^(active|index|decisions|queue|log)\\.md$/ OR path:/^raw\\/refs\\//',
    'path:/^(reference|docs)\\// OR path:/^(README|AGENTS)\\.md$/',
  ]);
  for (const c of g.colorGroups) assert.ok(Number.isInteger(c.color.rgb) && c.color.a === 1);
  assert.equal(new Set(g.colorGroups.map(c => c.color.rgb)).size, g.colorGroups.length);
});

test('a generated group the user recolored keeps its color, and a second build changes nothing', t => {
  const v = makeVault(t);
  v.write('.obsidian/graph.json', JSON.stringify({ colorGroups: [{ query: '[type:rule] [kind:taste]', color: { a: 1, rgb: 42 } }] }));
  v.run('build.mjs');
  const first = v.read('.obsidian/graph.json');
  const g = JSON.parse(first);
  assert.equal(g.colorGroups.length, 7);
  assert.equal(g.colorGroups.filter(c => c.query === '[type:rule] [kind:taste]').length, 1);
  assert.equal(g.colorGroups[0].query, '[type:rule] [kind:taste]');
  assert.equal(g.colorGroups[0].color.rgb, 42);
  assert.match(v.run('build.mjs').stdout, /up to date/);
  assert.equal(v.read('.obsidian/graph.json'), first);
});

test('build writes the groups into a vault with .obsidian but no graph.json, and leaves a vault without .obsidian alone', t => {
  const v = makeVault(t);
  assert.equal(v.run('build.mjs').code, 0);
  assert.equal(v.exists('.obsidian'), false);
  v.write('.obsidian/app.json', '{}');
  assert.match(v.run('build.mjs').stdout, /\.obsidian\/graph\.json/);
  assert.equal(graph(v).colorGroups.length, 7);
});
