import test from 'node:test';
import assert from 'node:assert/strict';
import { globToRegExp, bestMatch, normGlob, validGlob, specificity, bySpecificity, overlapping } from '../tools/lib/glob.mjs';

const hits = (glob, rel) => globToRegExp(glob).test(rel);

test('** crosses folders, * does not', () => {
  assert.ok(hits('src/**/*.luau', 'src/a.luau'));
  assert.ok(hits('src/**/*.luau', 'src/a/b/c.luau'));
  assert.ok(hits('src/**', 'src/a/b'));
  assert.ok(hits('**/*.md', 'x/y/z.md'));
  assert.ok(hits('**/*.md', 'z.md'));
  assert.ok(!hits('src/*.luau', 'src/a/b.luau'));
  assert.ok(hits('src/*.luau', 'src/b.luau'));
  assert.ok(!hits('src/**/*.luau', 'other/a.luau'));
});

test('? matches one non-slash character', () => {
  assert.ok(hits('a/?.md', 'a/b.md'));
  assert.ok(!hits('a/?.md', 'a/bc.md'));
  assert.ok(!hits('a?b', 'a/b'));
});

test('{a,b} picks one alternative', () => {
  assert.ok(hits('src/*.{lua,luau}', 'src/a.luau'));
  assert.ok(hits('src/*.{lua,luau}', 'src/a.lua'));
  assert.ok(!hits('src/*.{lua,luau}', 'src/a.md'));
  assert.ok(hits('{client,server}/**', 'server/x/y.lua'));
});

test('matching ignores case and anchors both ends', () => {
  assert.ok(hits('SRC/*.LUAU', 'src/Main.luau'));
  assert.ok(!hits('src/*.lua', 'src/a.luau'));
  assert.ok(!hits('src/*.lua', 'x/src/a.lua'));
});

test('regex metacharacters in a glob are literal', () => {
  assert.ok(hits('a.b+c(1).md', 'a.b+c(1).md'));
  assert.ok(!hits('a.md', 'aXmd'));
});

test('normGlob turns backslashes to slashes and drops a leading ./ or /', () => {
  assert.equal(normGlob('src\\ui\\**'), 'src/ui/**');
  assert.equal(normGlob('./src/a'), 'src/a');
  assert.equal(normGlob('/src/a'), 'src/a');
  assert.ok(hits('.\\src\\*.lua', 'src/a.lua'));
});

test('validGlob rejects blanks, non-strings and bad braces', () => {
  assert.equal(validGlob('src/**'), true);
  assert.equal(validGlob(''), false);
  assert.equal(validGlob('  '), false);
  assert.equal(validGlob(null), false);
  assert.equal(validGlob(5), false);
  assert.equal(validGlob('a/{b'), false);
  assert.equal(validGlob('a/b}'), false);
  assert.equal(validGlob('a/{b,{c,d}}'), false);
});

test('specificity counts literal folders then literal characters', () => {
  assert.deepEqual(specificity('src/ui/*.lua'), [2, 'src/ui/.lua'.length]);
  assert.deepEqual(specificity('**/*.lua'), [0, '/.lua'.length]);
  assert.deepEqual(specificity('src/**'), [1, 'src/'.length]);
});

test('bySpecificity sorts more literal folders first, then longer', () => {
  const globs = ['**/*.lua', 'src/**', 'src/ui/*.lua', 'src/ui/**'];
  const sorted = [...globs].sort((a, b) => bySpecificity(specificity(a), specificity(b)));
  assert.deepEqual(sorted, ['src/ui/*.lua', 'src/ui/**', 'src/**', '**/*.lua']);
});

test('bestMatch returns the most specific matching glob or null', () => {
  const globs = ['**/*.lua', 'src/**', 'src/ui/*.lua', '{bad'];
  assert.equal(bestMatch(globs, 'src/ui/a.lua'), 'src/ui/*.lua');
  assert.equal(bestMatch(globs, 'src/other/a.lua'), 'src/**');
  assert.equal(bestMatch(globs, 'lib/a.lua'), '**/*.lua');
  assert.equal(bestMatch(globs, 'lib/a.md'), null);
  assert.equal(bestMatch([], 'a'), null);
});

test('overlapping returns the first pair some path matches', () => {
  assert.deepEqual(overlapping(['src/**'], ['**/*.lua']), ['src/**', '**/*.lua']);
  assert.deepEqual(overlapping(['a/*.lua', 'src/**'], ['src/ui/*.md', 'src/*.md']), ['src/**', 'src/ui/*.md']);
  assert.equal(overlapping(['src/*.lua'], ['src/*.md']), null);
  assert.equal(overlapping(['src/*.lua'], ['src/a/*.lua']), null);
  assert.equal(overlapping(['a/*'], ['a/b/*']), null);
  assert.equal(overlapping([], ['**']), null);
  assert.equal(overlapping(['{bad'], ['**']), null);
});

test('overlapping handles braces, ? and case', () => {
  assert.deepEqual(overlapping(['src/*.{lua,luau}'], ['SRC/a.LUAU']), ['src/*.{lua,luau}', 'SRC/a.LUAU']);
  assert.notEqual(overlapping(['a/?.md'], ['a/b.md']), null);
  assert.equal(overlapping(['a/?.md'], ['a/bc.md']), null);
});

test('overlapping reads each list under its folder', () => {
  assert.equal(overlapping(['x/*.lua'], ['*.lua']), null);
  assert.deepEqual(overlapping(['x/*.lua'], ['*.lua'], ['', 'x']), ['x/*.lua', '*.lua']);
  assert.deepEqual(overlapping(['*.lua'], ['x/*.lua'], ['x', '']), ['*.lua', 'x/*.lua']);
});
