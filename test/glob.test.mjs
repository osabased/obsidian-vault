import test from 'node:test';
import assert from 'node:assert/strict';
import { globToRegExp, bestMatch, normGlob, validGlob, specificity, bySpecificity, overlapping, entryParts, entryKey, globListProblems, matchTarget } from '../tools/lib/glob.mjs';

const hits = (glob, rel) => globToRegExp(glob).test(rel);

test('** crosses folders, * does not', () => {
  assert.ok(hits('src/**/*.zqx', 'src/a.zqx'));
  assert.ok(hits('src/**/*.zqx', 'src/a/b/c.zqx'));
  assert.ok(hits('src/**', 'src/a/b'));
  assert.ok(hits('**/*.md', 'x/y/z.md'));
  assert.ok(hits('**/*.md', 'z.md'));
  assert.ok(!hits('src/*.zqx', 'src/a/b.zqx'));
  assert.ok(hits('src/*.zqx', 'src/b.zqx'));
  assert.ok(!hits('src/**/*.zqx', 'other/a.zqx'));
});

test('? matches one non-slash character', () => {
  assert.ok(hits('a/?.md', 'a/b.md'));
  assert.ok(!hits('a/?.md', 'a/bc.md'));
  assert.ok(!hits('a?b', 'a/b'));
});

test('{a,b} picks one alternative', () => {
  assert.ok(hits('src/*.{zq,zqx}', 'src/a.zqx'));
  assert.ok(hits('src/*.{zq,zqx}', 'src/a.zq'));
  assert.ok(!hits('src/*.{zq,zqx}', 'src/a.md'));
  assert.ok(hits('{client,server}/**', 'server/x/y.zq'));
});

test('matching ignores case and anchors both ends', () => {
  assert.ok(hits('SRC/*.ZQX', 'src/Main.zqx'));
  assert.ok(!hits('src/*.zq', 'src/a.zqx'));
  assert.ok(!hits('src/*.zq', 'x/src/a.zq'));
});

test('regex metacharacters in a glob are literal', () => {
  assert.ok(hits('a.b+c(1).md', 'a.b+c(1).md'));
  assert.ok(!hits('a.md', 'aXmd'));
});

test('normGlob turns backslashes to slashes and drops a leading ./ or /', () => {
  assert.equal(normGlob('src\\ui\\**'), 'src/ui/**');
  assert.equal(normGlob('./src/a'), 'src/a');
  assert.equal(normGlob('/src/a'), 'src/a');
  assert.ok(hits('.\\src\\*.zq', 'src/a.zq'));
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
  assert.deepEqual(specificity('src/ui/*.zq'), [2, 'src/ui/.zq'.length]);
  assert.deepEqual(specificity('**/*.zq'), [0, '/.zq'.length]);
  assert.deepEqual(specificity('src/**'), [1, 'src/'.length]);
});

test('bySpecificity sorts more literal folders first, then longer', () => {
  const globs = ['**/*.zq', 'src/**', 'src/ui/*.zq', 'src/ui/**'];
  const sorted = [...globs].sort((a, b) => bySpecificity(specificity(a), specificity(b)));
  assert.deepEqual(sorted, ['src/ui/*.zq', 'src/ui/**', 'src/**', '**/*.zq']);
});

test('bestMatch returns the most specific matching glob or null', () => {
  const globs = ['**/*.zq', 'src/**', 'src/ui/*.zq', '{bad'];
  assert.equal(bestMatch(globs, 'src/ui/a.zq'), 'src/ui/*.zq');
  assert.equal(bestMatch(globs, 'src/other/a.zq'), 'src/**');
  assert.equal(bestMatch(globs, 'lib/a.zq'), '**/*.zq');
  assert.equal(bestMatch(globs, 'lib/a.md'), null);
  assert.equal(bestMatch([], 'a'), null);
});

test('overlapping returns the first pair some path matches', () => {
  assert.deepEqual(overlapping(['src/**'], ['**/*.zq']), ['src/**', '**/*.zq']);
  assert.deepEqual(overlapping(['a/*.zq', 'src/**'], ['src/ui/*.md', 'src/*.md']), ['src/**', 'src/ui/*.md']);
  assert.equal(overlapping(['src/*.zq'], ['src/*.md']), null);
  assert.equal(overlapping(['src/*.zq'], ['src/a/*.zq']), null);
  assert.equal(overlapping(['a/*'], ['a/b/*']), null);
  assert.equal(overlapping([], ['**']), null);
  assert.equal(overlapping(['{bad'], ['**']), null);
});

test('overlapping handles braces, ? and case', () => {
  assert.deepEqual(overlapping(['src/*.{zq,zqx}'], ['SRC/a.ZQX']), ['src/*.{zq,zqx}', 'SRC/a.ZQX']);
  assert.notEqual(overlapping(['a/?.md'], ['a/b.md']), null);
  assert.equal(overlapping(['a/?.md'], ['a/bc.md']), null);
});

test('overlapping reads each list under its folder', () => {
  assert.equal(overlapping(['x/*.zq'], ['*.zq']), null);
  assert.deepEqual(overlapping(['x/*.zq'], ['*.zq'], ['', 'x']), ['x/*.zq', '*.zq']);
  assert.deepEqual(overlapping(['*.zq'], ['x/*.zq'], ['x', '']), ['*.zq', 'x/*.zq']);
});

test('a ! entry removes what it matches from the entries before it', () => {
  const list = ['src/**/*.ts', '!src/**/*.test.ts'];
  assert.equal(bestMatch(list, 'src/a.ts'), 'src/**/*.ts');
  assert.equal(bestMatch(list, 'src/a/b.ts'), 'src/**/*.ts');
  assert.equal(bestMatch(list, 'src/a.test.ts'), null);
  assert.equal(bestMatch(list, 'src/x/a.TEST.ts'), null);
  assert.equal(bestMatch(list, 'lib/a.ts'), null);
});

test('a positive entry after a ! entry adds back', () => {
  const list = ['src/**', '!src/gen/**', 'src/gen/keep.ts'];
  assert.equal(bestMatch(list, 'src/a.ts'), 'src/**');
  assert.equal(bestMatch(list, 'src/gen/x.ts'), null);
  assert.equal(bestMatch(list, 'src/gen/keep.ts'), 'src/gen/keep.ts');
});

test('the order of entries decides: a ! entry before the positive one removes nothing', () => {
  assert.equal(bestMatch(['!src/a.ts', 'src/**'], 'src/a.ts'), 'src/**');
});

test('a list with no positive entry matches nothing', () => {
  assert.equal(bestMatch(['!src/**'], 'src/a.ts'), null);
  assert.equal(bestMatch(['!src/**', '!**/*.md'], 'docs/a.md'), null);
});

test('bestMatch skips namespaced entries for a file', () => {
  assert.equal(bestMatch(['glim:**', '**'], 'a/b.md'), '**');
  assert.equal(bestMatch(['glim:**', '!**'], 'a/b.md'), null);
  assert.equal(bestMatch(['glim:**'], 'glim:a'), null);
});

test('validGlob accepts a leading ! and checks the rest', () => {
  assert.equal(validGlob('!src/**/*.test.ts'), true);
  assert.equal(validGlob('!'), false);
  assert.equal(validGlob('! '), false);
  assert.equal(validGlob('!!src/a'), false);
  assert.equal(validGlob('!src/{a'), false);
});

const NS = { 'example-ui': { separator: '.', escape: '\\' }, tree: { separator: '::', escape: '^' } };

test('validGlob checks a namespace against the declared ones', () => {
  assert.equal(validGlob('example-ui:Main.**', NS), true);
  assert.equal(validGlob('!example-ui:Main.**', NS), true);
  assert.equal(validGlob('other:Main', NS), false);
  assert.equal(validGlob('example-ui:', NS), false);
  assert.equal(validGlob('example-ui:A.{b', NS), false);
  assert.equal(validGlob('example-ui:A.\\{b', NS), true);
  assert.equal(validGlob('example-ui:Main'), false);
  assert.equal(validGlob('src/a.md', NS), true);
  assert.equal(validGlob('c:/x', NS), true);
  assert.equal(validGlob('constructor:x', NS), false);
});

test('validGlob refuses a namespace with a broken declaration', () => {
  assert.equal(validGlob('bad:x', { bad: { separator: '', escape: '\\' } }), false);
  assert.equal(validGlob('bad:x', { bad: { separator: '.', escape: '\\\\' } }), false);
  assert.equal(validGlob('bad:x', { bad: { separator: '.' } }), false);
});

test('globListProblems reports a ! entry with no positive entry before it', () => {
  assert.deepEqual(globListProblems(['src/**', '!src/a.ts']), []);
  assert.deepEqual(globListProblems(['!src/a.ts', 'src/**']), ['exclusion in applies_to comes before any entry that adds files: !src/a.ts']);
  assert.equal(globListProblems(['!a', '!b']).length, 2);
  assert.deepEqual(globListProblems([]), []);
});

test('globListProblems counts each namespace on its own', () => {
  const problems = globListProblems(['src/**', '!example-ui:Main.A', 'example-ui:Main.**', '!example-ui:Main.B'], NS);
  assert.deepEqual(problems, ['exclusion in applies_to comes before any entry that adds example-ui targets: !example-ui:Main.A']);
  assert.deepEqual(globListProblems(['!other:x', '{bad'], NS), []);
});

test('overlapping ignores ! entries and namespaced entries', () => {
  assert.equal(overlapping(['!src/**'], ['src/a.ts']), null);
  assert.deepEqual(overlapping(['src/**', '!src/a.ts'], ['src/a.ts']), ['src/**', 'src/a.ts']);
  assert.equal(overlapping(['example-ui:**'], ['**']), null);
  assert.equal(overlapping(['**'], ['example-ui:Main']), null);
});

test('entryParts splits a leading !, a namespace prefix and the glob', () => {
  assert.deepEqual(entryParts('src/**'), { negated: false, namespace: 'file', glob: 'src/**' });
  assert.deepEqual(entryParts('!src/**'), { negated: true, namespace: 'file', glob: 'src/**' });
  assert.deepEqual(entryParts('example-ui:Main.**'), { negated: false, namespace: 'example-ui', glob: 'Main.**' });
  assert.deepEqual(entryParts('!example-ui:Main'), { negated: true, namespace: 'example-ui', glob: 'Main' });
  assert.deepEqual(entryParts('C:/x'), { negated: false, namespace: 'file', glob: 'C:/x' });
});

test('entryKey makes spellings of one file entry equal and keeps namespace case', () => {
  assert.equal(entryKey('./SRC\\A/**'), 'src/a/**');
  assert.equal(entryKey('!./src/a'), '!src/a');
  assert.equal(entryKey('file:src/a'), 'src/a');
  assert.equal(entryKey('example-ui:Main.A'), 'example-ui:Main.A');
  assert.notEqual(entryKey('example-ui:Main.A'), entryKey('example-ui:main.a'));
});

test('specificity reads a namespaced entry by its own separator', () => {
  assert.deepEqual(specificity('example-ui:Main.A.*', NS), [2, 'Main.A.'.length]);
  assert.deepEqual(specificity('tree:Main::A::*', NS), [2, 'Main::A::'.length]);
  assert.deepEqual(specificity('example-ui:**', NS), [0, 0]);
});

const at = (list, path, namespace = 'example-ui') => matchTarget(list, { namespace, path }, NS);

test('matchTarget: * stays in one segment, ** crosses segments', () => {
  assert.equal(at(['example-ui:Main.*'], 'Main.A'), 'example-ui:Main.*');
  assert.equal(at(['example-ui:Main.*'], 'Main.A.B'), null);
  assert.equal(at(['example-ui:Main.**'], 'Main.A.B.C'), 'example-ui:Main.**');
  assert.equal(at(['example-ui:Main.**'], 'Main'), null);
  assert.equal(at(['example-ui:**.Button'], 'Main.A.Button'), 'example-ui:**.Button');
  assert.equal(at(['example-ui:**.Button'], 'Button'), 'example-ui:**.Button');
  assert.equal(at(['example-ui:A.**'], 'A.B.C'), 'example-ui:A.**');
  assert.equal(at(['example-ui:A.**'], 'AB.C'), null);
  assert.equal(at(['example-ui:A*'], 'AB'), 'example-ui:A*');
  assert.equal(at(['example-ui:A*'], 'A.B'), null);
  assert.equal(at(['example-ui:A.?'], 'A.B'), 'example-ui:A.?');
  assert.equal(at(['example-ui:A.?'], 'A.BC'), null);
});

test('matchTarget: {a,b} picks one alternative, also across segments', () => {
  assert.equal(at(['example-ui:{Menu,Hud}.*'], 'Hud.Cell'), 'example-ui:{Menu,Hud}.*');
  assert.equal(at(['example-ui:{Menu,Hud}.*'], 'Shop.Cell'), null);
  assert.equal(at(['example-ui:Main.{A.B,C}'], 'Main.A.B'), 'example-ui:Main.{A.B,C}');
  assert.equal(at(['example-ui:Main.{A.B,C}'], 'Main.A'), null);
});

test('matchTarget: the escape character makes a separator or metacharacter literal', () => {
  assert.equal(at(['example-ui:Main.Cell\\.1'], 'Main.Cell\\.1'), 'example-ui:Main.Cell\\.1');
  assert.equal(at(['example-ui:Main.Cell\\.1'], 'Main.Cell.1'), null);
  assert.equal(at(['example-ui:Main.*'], 'Main.Cell\\.1'), 'example-ui:Main.*');
  assert.equal(at(['example-ui:Main.Cell\\.*'], 'Main.Cell\\.1'), 'example-ui:Main.Cell\\.*');
  assert.equal(at(['example-ui:Main.a\\*b'], 'Main.a*b'), 'example-ui:Main.a\\*b');
  assert.equal(at(['example-ui:Main.a\\*b'], 'Main.axb'), null);
  assert.equal(at(['example-ui:Main.\\{x\\}'], 'Main.{x}'), 'example-ui:Main.\\{x\\}');
  assert.equal(at(['example-ui:Main.{a\\,b,c}'], 'Main.a,b'), 'example-ui:Main.{a\\,b,c}');
  assert.equal(at(['example-ui:Main.a\\\\b'], 'Main.a\\\\b'), 'example-ui:Main.a\\\\b');
});

test('matchTarget: a multi-character separator and another escape character', () => {
  assert.equal(at(['tree:Main::*'], 'Main::A', 'tree'), 'tree:Main::*');
  assert.equal(at(['tree:Main::*'], 'Main::A::B', 'tree'), null);
  assert.equal(at(['tree:Main::**'], 'Main::A::B', 'tree'), 'tree:Main::**');
  assert.equal(at(['tree:Main::*'], 'Main::A:B', 'tree'), 'tree:Main::*');
  assert.equal(at(['tree:Main::A^::B'], 'Main::A^::B', 'tree'), 'tree:Main::A^::B');
  assert.equal(at(['tree:Main::A^::B'], 'Main::A::B', 'tree'), null);
});

test('matchTarget: names match with case', () => {
  assert.equal(at(['example-ui:Main.A'], 'main.a'), null);
});

test('matchTarget: ! entries apply in order within the namespace', () => {
  const list = ['example-ui:Main.**', '!example-ui:Main.Debug.**', 'example-ui:Main.Debug.Keep'];
  assert.equal(at(list, 'Main.Hud.A'), 'example-ui:Main.**');
  assert.equal(at(list, 'Main.Debug.X'), null);
  assert.equal(at(list, 'Main.Debug.Keep'), 'example-ui:Main.Debug.Keep');
  assert.equal(at(['!example-ui:Main.**'], 'Main.A'), null);
});

test('matchTarget: the most specific added entry wins', () => {
  assert.equal(at(['example-ui:**', 'example-ui:Main.A.*', 'example-ui:Main.**'], 'Main.A.B'), 'example-ui:Main.A.*');
});

test('matchTarget uses only the entries of the target namespace', () => {
  const list = ['src/**', 'tree:Main::**', '!example-ui:Main.A'];
  assert.equal(at(list, 'Main.A'), null);
  assert.equal(at(list, 'Main::A', 'tree'), 'tree:Main::**');
  assert.equal(at(list, 'src/a.ts', 'file'), 'src/**');
  assert.equal(at(list, 'src/a.ts', 'tree'), null);
  assert.equal(matchTarget(list, { path: 'src/a.ts' }, NS), 'src/**');
});

test('matchTarget: an undeclared or broken namespace matches nothing', () => {
  assert.equal(matchTarget(['ghost:**'], { namespace: 'ghost', path: 'A' }, NS), null);
  assert.equal(matchTarget(['ghost:**'], { namespace: 'ghost', path: 'A' }), null);
  assert.equal(matchTarget(['bad:**'], { namespace: 'bad', path: 'A' }, { bad: { separator: '.', escape: '' } }), null);
  assert.equal(matchTarget(['bad:**'], { namespace: 'bad', path: 'A' }, { bad: { separator: '.', escape: 'ab' } }), null);
});

test('matchTarget: an escape outside the BMP is one character, as lint counts it', () => {
  const ns = { 'glim-tree': { separator: '.', escape: '𝄞' } };
  assert.equal(validGlob('glim-tree:Shop𝄞.a.{x,y}', ns), true);
  assert.equal(matchTarget(['glim-tree:Shop𝄞.a.**'], { namespace: 'glim-tree', path: 'Shop𝄞.a.Buy' }, ns), 'glim-tree:Shop𝄞.a.**');
  assert.equal(matchTarget(['glim-tree:Shop.a.**'], { namespace: 'glim-tree', path: 'Shop𝄞.a.Buy' }, ns), null);
  assert.equal(matchTarget(['glim-tree:{Shop𝄞,a,b}.*'], { namespace: 'glim-tree', path: 'Shop𝄞,a.Buy' }, ns), 'glim-tree:{Shop𝄞,a,b}.*');
});

test('matchTarget: a file target keeps the file rules', () => {
  assert.equal(matchTarget(['SRC/**', '!src/gen/**'], { namespace: 'file', path: 'src/A.ts' }, NS), 'SRC/**');
  assert.equal(matchTarget(['SRC/**', '!src/gen/**'], { namespace: 'file', path: 'src/gen/A.ts' }, NS), null);
});

test('a positive entry a later ! entry removes is not the best match', () => {
  const list = ['src/ui/**', '!src/ui/x/**', 'src/**/*.zqx'];
  assert.equal(bestMatch(list, 'src/ui/x/a.zqx'), 'src/**/*.zqx');
  assert.equal(bestMatch(list, 'src/ui/a.zqx'), 'src/ui/**');
  assert.equal(bestMatch(['src/ui/**', '!src/ui/x/**'], 'src/ui/x/a.zqx'), null);
});

test('overlapping reads a folder name as it is spelled, not as glob syntax', () => {
  assert.deepEqual(overlapping(['*.ts'], ['**/*.ts'], ['pkg{1}', '']), ['*.ts', '**/*.ts']);
  assert.equal(overlapping(['*.ts'], ['pkg1/*.ts'], ['pkg{1}', '']), null);
  assert.deepEqual(overlapping(['*.ts'], ['a*b/*.ts'], ['a*b', '']), ['*.ts', 'a*b/*.ts']);
  assert.equal(overlapping(['*.ts'], ['axb/*.ts'], ['a*b', '']), null);
});
