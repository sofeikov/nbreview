import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importedName, importTargets, inCode, moduleFiles, topLevelLine } from '../src/core/pyImports.ts';

/** The targets of a click on the `n`th occurrence of `word` in the source. */
function at(source: string, word: string, n = 0, filePath = 'pkg/mod.py') {
  const lines = source.split('\n');
  let seen = 0;
  for (let i = 0; i < lines.length; i++) {
    const re = new RegExp(`(?<![\\w])${word}(?![\\w])`, 'g');
    for (let m = re.exec(lines[i]); m; m = re.exec(lines[i])) {
      if (seen++ === n) {
        return importTargets(lines, i, m.index, filePath);
      }
    }
  }
  throw new Error(`no ${word} #${n}`);
}

test('a name imported with from leads to the module, or to a submodule of that name', () => {
  const src = 'from manualcheck.geometry import area\n\nprint(area(1, 2))';
  assert.deepEqual(at(src, 'area', 1), [
    { module: 'manualcheck.geometry', name: 'area', fromTop: undefined },
    { module: 'manualcheck.geometry.area', fromTop: undefined },
  ]);
  assert.deepEqual(at(src, 'area', 0), at(src, 'area', 1), 'the name in the import statement itself');
});

test('a word of the module path leads to that module', () => {
  const src = 'from manualcheck.geometry import area\nimport os.path as osp';
  assert.deepEqual(at(src, 'manualcheck'), [{ module: 'manualcheck', fromTop: undefined }]);
  assert.deepEqual(at(src, 'geometry'), [{ module: 'manualcheck.geometry', fromTop: undefined }]);
  assert.deepEqual(at(src, 'path'), [{ module: 'os.path' }]);
  assert.deepEqual(at(src, 'osp'), [{ module: 'os.path' }]);
});

test('an alias leads to the name it stands for', () => {
  const src = 'from geo import area as a, perimeter\nx = a(1) + perimeter(2)';
  assert.deepEqual(at(src, 'a', 1), [{ module: 'geo', name: 'area', fromTop: undefined }, { module: 'geo.area', fromTop: undefined }]);
  assert.deepEqual(at(src, 'perimeter', 1)[0], { module: 'geo', name: 'perimeter', fromTop: undefined });
});

test('module.name after import module, also through an alias and a package', () => {
  const src = 'import manualcheck.geometry\nimport manualcheck.geometry as g\nmanualcheck.geometry.area(1)\ng.area(2)';
  assert.deepEqual(at(src, 'area', 0), [
    { module: 'manualcheck.geometry.area', fromTop: undefined },
    { module: 'manualcheck.geometry', name: 'area', fromTop: undefined },
  ]);
  assert.deepEqual(at(src, 'area', 1), at(src, 'area', 0));
  assert.deepEqual(at(src, 'geometry', 2), [
    { module: 'manualcheck.geometry', fromTop: undefined },
    { module: 'manualcheck', name: 'geometry', fromTop: undefined },
  ], 'the middle of a chain');
});

test('from package import module, then module.name', () => {
  const src = 'from manualcheck import geometry\ngeometry.area(1)';
  assert.deepEqual(at(src, 'area'), [
    { module: 'manualcheck.geometry.area', fromTop: undefined },
    { module: 'manualcheck.geometry', name: 'area', fromTop: undefined },
  ]);
});

test('relative imports start from the file\'s package', () => {
  const src = 'from .geometry import area\nfrom .. import util\nfrom ..core.x import y\narea(1)';
  assert.deepEqual(at(src, 'area', 1, 'src/pkg/sub/mod.py')[0], { module: 'src.pkg.sub.geometry', name: 'area', fromTop: true });
  assert.deepEqual(at(src, 'util', 0, 'src/pkg/sub/mod.py'), [
    { module: 'src.pkg', name: 'util', fromTop: true },
    { module: 'src.pkg.util', fromTop: true },
  ]);
  assert.deepEqual(at(src, 'core', 0, 'src/pkg/sub/mod.py'), [{ module: 'src.pkg.core', fromTop: true }]);
  assert.deepEqual(at('from ... import x\nx', 'x', 1, 'mod.py'), [], 'above the repository');
});

test('statements over several lines, with brackets, backslashes and comments', () => {
  const src = 'from geo import (  # shapes\n    area,\n    perimeter as per,  # sides\n)\nfrom a.b import \\\n    c\nper(1)\nc(2)';
  assert.deepEqual(at(src, 'per', 1)[0], { module: 'geo', name: 'perimeter', fromTop: undefined });
  assert.deepEqual(at(src, 'area', 0)[0], { module: 'geo', name: 'area', fromTop: undefined });
  assert.deepEqual(at(src, 'c', 1)[0], { module: 'a.b', name: 'c', fromTop: undefined });
});

test('the last import before the line wins, and star imports after it may replace it', () => {
  const src = 'from a import f\nf()\nfrom b import f\nf()\nfrom c import *\ng()\nf()';
  assert.equal(at(src, 'f', 1)[0].module, 'a');
  assert.equal(at(src, 'f', 3)[0].module, 'b');
  assert.deepEqual(at(src, 'g'), [{ module: 'c', name: 'g', fromTop: undefined }]);
  assert.deepEqual(at(src, 'f', 4).map(t => `${t.module}:${t.name}`), ['c:f', 'b:f', 'b.f:undefined'], 'c may have its own f');
  assert.equal(at('f()\nfrom a import f', 'f', 0)[0].module, 'a', 'imported in a later cell');
  assert.deepEqual(at('from a import *\nfrom b import *\nh()', 'h').map(t => t.module), ['b', 'a'], 'the latest star first');
  assert.deepEqual(at('from a import f\nfrom b import *\nfrom c import *\nf()', 'f', 1).map(t => t.module), ['c', 'b', 'a', 'a.f']);
});

test('a statement ends at a semicolon, and an unclosed bracket doesn\'t take in the rest', () => {
  assert.deepEqual(at('from a import b; c = 1\nc', 'c', 1), []);
  assert.equal(at('from a import b; c = 1\nb', 'b', 1)[0].module, 'a');
  assert.equal(at('from a import (b,\nfrom geo import area\narea()', 'area', 1)[0].module, 'geo');
  assert.equal(at('import x\n)\nx', 'x', 1)[0].module, 'x');
});

test('names that aren\'t imported, and attributes of other things, lead nowhere', () => {
  assert.deepEqual(at('def area(): pass\narea()', 'area', 1), []);
  assert.deepEqual(at('import geo\nshape().area', 'area'), []);
  assert.deepEqual(at('import geo\nshapes[0].area', 'area'), []);
  assert.deepEqual(at('import geo\nx = "geo".area', 'area'), []);
  assert.deepEqual(at('# from geo import area\narea()', 'area', 1), [], 'a comment isn\'t an import');
  assert.deepEqual(at('from geo import area\nx = 1  # area in cm', 'area', 1), [], 'a word in a comment');
  assert.deepEqual(at('from geo import area\nprint("area")', 'area', 1), [], 'a word in a string');
});

test('inCode says whether a column is code, not a comment or a string', () => {
  assert.equal(inCode('x = area(1)  # area', 4), true);
  assert.equal(inCode('x = area(1)  # area', 16), false);
  assert.equal(inCode('s = "a # b" + area', 14), true, 'a # in a string');
  assert.equal(inCode(`s = "it's" + f'{area}'`, 16), false, 'inside an f-string');
  assert.equal(inCode('s = """doc""" + area', 16), true);
  assert.equal(inCode(String.raw`s = 'a\'b' + area`, 13), true, 'an escaped quote');
});

test('importedName finds a re-export, as in __init__.py', () => {
  const init = '"""Shapes."""\nfrom .geometry import area\nfrom .util import *\n';
  // The star import comes after, and may have its own `area`: it is looked at first.
  assert.deepEqual(importedName(init, 'area', 'manualcheck/__init__.py').map(t => t.module), ['manualcheck.util', 'manualcheck.geometry', 'manualcheck.geometry.area']);
  assert.deepEqual(importedName(init, 'other', 'manualcheck/__init__.py'), [{ module: 'manualcheck.util', name: 'other', fromTop: true }]);
});

test('moduleFiles lists the files a module can be: from the top for a module, beside a notebook first', () => {
  assert.deepEqual(moduleFiles({ module: 'manualcheck.geometry' }, 'manualcheck/sync.py'), [
    'manualcheck/geometry.py', 'manualcheck/geometry/__init__.py',
    'src/manualcheck/geometry.py', 'src/manualcheck/geometry/__init__.py',
    'manualcheck/manualcheck/geometry.py', 'manualcheck/manualcheck/geometry/__init__.py',
  ]);
  assert.deepEqual(moduleFiles({ module: 'utils' }, 'nbs/explore.ipynb'), [
    'nbs/utils.py', 'nbs/utils/__init__.py', 'utils.py', 'utils/__init__.py', 'src/utils.py', 'src/utils/__init__.py',
  ]);
  assert.deepEqual(moduleFiles({ module: 'geo' }, 'top.ipynb'), ['geo.py', 'geo/__init__.py', 'src/geo.py', 'src/geo/__init__.py']);
  assert.deepEqual(moduleFiles({ module: 'src.pkg.geo', fromTop: true }, 'src/pkg/x.py'), ['src/pkg/geo.py', 'src/pkg/geo/__init__.py']);
  assert.deepEqual(moduleFiles({ module: 'a..b' }, 'x.py'), [], 'not a dotted name');
  assert.deepEqual(moduleFiles({ module: '..' }, 'x.py'), []);
});

test('topLevelLine finds a def, a class or an assignment at the top level only', () => {
  const src = 'import x\n\nclass Shape:\n    def area(self): ...\n\nasync def fetch(url): ...\nLIMIT: int = 3\ndef area(w, h):\n    area = 2\nif area == 1: pass';
  assert.equal(topLevelLine(src, 'Shape'), 2);
  assert.equal(topLevelLine(src, 'fetch'), 5);
  assert.equal(topLevelLine(src, 'LIMIT'), 6);
  assert.equal(topLevelLine(src, 'area'), 7, 'not the method or the local');
  assert.equal(topLevelLine(src, 'are'), undefined);
  assert.equal(topLevelLine('area == 1', 'area'), undefined, 'a comparison');
});
