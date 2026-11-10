import { test } from 'node:test';
import assert from 'node:assert/strict';
import { columnOf, headCellOf, headLineOf, githubFileUrl, identifierAt, isRemoteOf, matchCell, matchLine, shortPlace } from '../src/core/navigate.ts';

test('identifierAt finds the name under the cursor, also just after it', () => {
  const line = 'result = area(2, 3)';
  assert.deepEqual(identifierAt(line, 10), { name: 'area', start: 9, end: 13 });
  assert.deepEqual(identifierAt(line, 9), { name: 'area', start: 9, end: 13 });
  assert.deepEqual(identifierAt(line, 13), { name: 'area', start: 9, end: 13 }, 'just after the last letter');
  assert.deepEqual(identifierAt(line, 0), { name: 'result', start: 0, end: 6 });
  assert.deepEqual(identifierAt('shots.groupby("x")', 7), { name: 'groupby', start: 6, end: 13 });
  assert.deepEqual(identifierAt('café = 1', 2), { name: 'café', start: 0, end: 4 }, 'letters of any alphabet');
});

test('identifierAt finds nothing on spaces, numbers, strings punctuation and keywords', () => {
  assert.equal(identifierAt('x = 1  ', 6), undefined);
  assert.equal(identifierAt('area(2, 3)', 5), undefined, 'a number');
  assert.equal(identifierAt('def area():', 1), undefined, 'a keyword');
  assert.equal(identifierAt('return x', 3), undefined);
  assert.equal(identifierAt('', 0), undefined);
});

test('matchLine finds the same line, or the nearest line with the same text', () => {
  const local = ['import x', '', 'def area(w, h):', '    return w * h', '', 'area(1, 2)', 'area(1, 2)'];
  assert.equal(matchLine(local, 'def area(w, h):', 2), 2);
  assert.equal(matchLine(local, 'def area(w, h):', 5), 2, 'moved up');
  assert.equal(matchLine(local, 'area(1, 2)', 0), 5, 'the nearest of two');
  assert.equal(matchLine(local, 'area(1, 2)', 9), 6);
  assert.equal(matchLine(local, 'area(1, 2)   ', 5), 5, 'trailing spaces are ignored');
  assert.equal(matchLine(local, 'area(9, 9)', 5), undefined);
  assert.equal(matchLine(local, '   ', 1), undefined, 'a blank line matches nothing');
  assert.equal(matchLine([], 'x', 0), undefined);
  // The pull request added many lines above: the line is far past the end of the local file.
  const short = Array.from({ length: 100 }, (_, i) => `line ${i}`);
  assert.equal(matchLine(short, 'line 50', 500), 50);
  assert.equal(matchLine(short, 'line 99', 0), 99);
});

test('columnOf finds a whole-word name nearest the column', () => {
  assert.equal(columnOf('area = area(2) + my_area(3)', 'area', 9), 7);
  assert.equal(columnOf('area = area(2) + my_area(3)', 'area', 0), 0);
  assert.equal(columnOf('my_area(3)', 'area', 3), undefined);
  assert.equal(columnOf('x.$y = 1', '$y', 0), 2, 'special characters are escaped');
  assert.equal(columnOf('écart = café + café2', 'café', 0), 8, 'not inside a longer name');
});

test('matchCell prefers the cell id, then the same source', () => {
  const local = [{ id: 'a', source: 'x = 1' }, { id: 'b', source: 'y = 2\n' }, { source: 'z = 3' }];
  assert.equal(matchCell(local, 'b', 'anything'), 1);
  assert.equal(matchCell(local, 'gone', 'y = 2'), 1);
  assert.equal(matchCell(local, undefined, 'z = 3'), 2);
  assert.equal(matchCell(local, 'gone', 'w = 4'), undefined);
});

test('isRemoteOf recognises the forms of a GitHub remote', () => {
  for (const url of ['git@github.com:Sofeikov/nbreview.git', 'https://github.com/sofeikov/nbreview', 'https://github.com/sofeikov/nbreview.git', 'ssh://git@github.com/sofeikov/nbreview.git', 'https://github.com/sofeikov/nbreview/']) {
    assert.ok(isRemoteOf(url, 'sofeikov', 'nbreview'), url);
  }
  assert.ok(isRemoteOf('git@github.com-work:sofeikov/nbreview.git', 'sofeikov', 'nbreview'), 'an SSH host alias');
  assert.ok(!isRemoteOf('git@github.com:sofeikov/nbreview-fork.git', 'sofeikov', 'nbreview'));
  assert.ok(!isRemoteOf('git@gitlab.com:sofeikov/nbreview.git', 'sofeikov', 'nbreview'));
  assert.ok(!isRemoteOf('git@notgithub.com:sofeikov/nbreview.git', 'sofeikov', 'nbreview'));
  assert.ok(!isRemoteOf('https://evil.example/github.com/sofeikov/nbreview', 'sofeikov', 'nbreview'));
});

test('shortPlace names a file by its name and a short folder', () => {
  assert.deepEqual(shortPlace('/home/me/repo/pkg/geometry.py', ['/home/me/repo']), { name: 'geometry.py', where: 'pkg' });
  assert.deepEqual(shortPlace('/home/me/repo/a.py', ['/home/me/repo']), { name: 'a.py', where: '' });
  assert.deepEqual(shortPlace('/x/exts/ms-python.vscode-pylance-2026.4.1/dist/bundled/stubs/pandas/core/frame.pyi', ['/home/me/repo']), { name: 'frame.pyi', where: 'pandas/core' });
  assert.deepEqual(shortPlace('/usr/lib/python3/dist-packages/numpy/linalg/linalg.py', []), { name: 'linalg.py', where: 'numpy/linalg' });
  assert.deepEqual(shortPlace('/opt/other/x.py', []), { name: 'x.py', where: '/opt/other' });
});

test('headLineOf keeps the line at the latest commit, and matches it by text otherwise', () => {
  const head = ['import x', '', 'def area(w, h):', '    return w * h'];
  assert.equal(headLineOf(head, 'def area(w, h):', 2, true), 2, 'at the head: the same line');
  assert.equal(headLineOf(head, 'def area(w, h):', 3, true), 2, 'at the head, with a local change above it: by its text');
  assert.equal(headLineOf(head, 'x', 9, true), undefined, 'past the end');
  assert.equal(headLineOf(head, 'def area(w, h):', 5, false), 2, 'moved in the pull request');
  assert.equal(headLineOf(head, 'def gone():', 2, false), undefined);
});

test('headCellOf keeps the cell at the latest commit, and matches it by id or source otherwise', () => {
  const head = [{ id: 'a', source: 'import x' }, { id: 'b', source: 'def f():\n    pass' }];
  assert.equal(headCellOf(head, { index: 1, source: 'def f():\n    pass' }, true), 1);
  assert.equal(headCellOf(head, { index: 0, id: 'b', source: 'changed locally' }, true), 1, 'at the head, changed locally: by id');
  assert.equal(headCellOf(head, { index: 5, source: '' }, true), undefined);
  assert.equal(headCellOf(head, { index: 0, id: 'b', source: 'old' }, false), 1, 'by id');
  assert.equal(headCellOf(head, { index: 0, source: 'def f():\n    pass' }, false), 1, 'by source');
  assert.equal(headCellOf(head, { index: 0, id: 'z', source: 'other' }, false), undefined);
});

test('githubFileUrl links a file or folder at a commit', () => {
  const pr = 'https://github.com/o/r/pull/7';
  assert.equal(githubFileUrl(pr, 'abc123', 'src/a.py'), 'https://github.com/o/r/blob/abc123/src/a.py');
  assert.equal(githubFileUrl(pr, 'abc123', 'src', true), 'https://github.com/o/r/tree/abc123/src');
  assert.equal(githubFileUrl(pr, 'abc123', 'my nb/a#1.ipynb'), 'https://github.com/o/r/blob/abc123/my%20nb/a%231.ipynb', 'each segment encoded, slashes kept');
  assert.equal(githubFileUrl('https://ghe.example.com/o/r/pull/7/files', 'abc', 'x.py'), 'https://ghe.example.com/o/r/blob/abc/x.py', 'other hosts');
});
