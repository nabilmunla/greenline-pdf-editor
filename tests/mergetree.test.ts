// 14.9: the Combine list as a tree - folders hold files and sub-folders; folders move as a whole;
// the result flattens to the file order plus each file's folder path (for nested bookmarks).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromGather, fromFiles, moveNode, sortTree, flatten, findNode, countFiles, removeNode, type MNode } from '../src/ui/mergetree';

const g = {
  name: 'Job', path: '/j',
  folders: [
    { name: 'Arch', path: '/j/Arch', folders: [{ name: 'Plans', path: '/j/Arch/Plans', folders: [], files: [{ name: 'P2.pdf', path: '/j/Arch/Plans/P2.pdf' }, { name: 'P10.pdf', path: '/j/Arch/Plans/P10.pdf' }] }], files: [{ name: 'A1.pdf', path: '/j/Arch/A1.pdf' }] },
    { name: 'Struct', path: '/j/Struct', folders: [], files: [{ name: 'S1.pdf', path: '/j/Struct/S1.pdf' }] },
  ],
  files: [{ name: 'Cover.pdf', path: '/j/Cover.pdf' }],
};
const order = (t: MNode) => flatten(t).map((x) => x.path.split('/').pop());
const idOf = (t: MNode, name: string) => { let id = ''; const go = (n: MNode) => { if (n.name === name) id = n.id; if (n.kind === 'folder') n.children.forEach(go); }; go(t); return id; };

test('fromGather keeps the walk order: sub-folders first, then own files; groups are the folder path below the root', () => {
  const t = fromGather(g);
  assert.deepEqual(order(t), ['P2.pdf', 'P10.pdf', 'A1.pdf', 'S1.pdf', 'Cover.pdf']);
  assert.deepEqual(flatten(t).map((x) => x.group), [['Arch', 'Plans'], ['Arch', 'Plans'], ['Arch'], ['Struct'], []]);
  assert.equal(countFiles(t), 5);
});

test('fromFiles is the flat list Combine has today (no groups)', () => {
  const t = fromFiles(['/x/b.pdf', '/y/a.pdf']);
  assert.deepEqual(flatten(t), [{ path: '/x/b.pdf', group: [] }, { path: '/y/a.pdf', group: [] }]);
});

test('a folder moves as a whole; a file moves into another folder; the tree is not changed in place', () => {
  const t = fromGather(g);
  const t2 = moveNode(t, idOf(t, 'Struct'), t.id, 0);
  assert.deepEqual(order(t2), ['S1.pdf', 'P2.pdf', 'P10.pdf', 'A1.pdf', 'Cover.pdf']);
  assert.deepEqual(order(t), ['P2.pdf', 'P10.pdf', 'A1.pdf', 'S1.pdf', 'Cover.pdf']);
  const t3 = moveNode(t2, idOf(t2, 'Cover.pdf'), idOf(t2, 'Plans'), 0);
  assert.deepEqual(order(t3), ['S1.pdf', 'Cover.pdf', 'P2.pdf', 'P10.pdf', 'A1.pdf']);
  assert.deepEqual(flatten(t3)[1].group, ['Arch', 'Plans']);
});

test('a folder never moves into itself or its own sub-folder; a bad id changes nothing', () => {
  const t = fromGather(g);
  assert.equal(moveNode(t, idOf(t, 'Arch'), idOf(t, 'Plans'), 0), t);
  assert.equal(moveNode(t, idOf(t, 'Arch'), idOf(t, 'Arch'), 0), t);
  assert.equal(moveNode(t, 'nope', t.id, 0), t);
  assert.equal(moveNode(t, idOf(t, 'S1.pdf'), idOf(t, 'A1.pdf'), 0), t); // a file is not a target
});

test('index past the end appends; moving within the same folder reorders', () => {
  const t = fromGather(g);
  const plans = idOf(t, 'Plans');
  const t2 = moveNode(t, idOf(t, 'P2.pdf'), plans, 99);
  assert.deepEqual(order(t2).slice(0, 2), ['P10.pdf', 'P2.pdf']);
});

test('sort by name (folders first, numbers as numbers), by date (files only, folders keep name order), as found', () => {
  const t = fromGather(g);
  const shuffled = moveNode(moveNode(t, idOf(t, 'P10.pdf'), idOf(t, 'Plans'), 0), idOf(t, 'Struct'), t.id, 0);
  assert.deepEqual(order(sortTree(shuffled, 'name')), ['P2.pdf', 'P10.pdf', 'A1.pdf', 'S1.pdf', 'Cover.pdf']);
  const dates = new Map([['/j/Arch/Plans/P2.pdf', 300], ['/j/Arch/Plans/P10.pdf', 100], ['/j/Arch/A1.pdf', 5], ['/j/Struct/S1.pdf', 1], ['/j/Cover.pdf', 9]]);
  assert.deepEqual(order(sortTree(t, 'date', dates)), ['P10.pdf', 'P2.pdf', 'A1.pdf', 'S1.pdf', 'Cover.pdf']);
  assert.deepEqual(order(sortTree(shuffled, 'found')), order(t));
});

test('remove a file or a whole folder; findNode', () => {
  const t = fromGather(g);
  const t2 = removeNode(t, idOf(t, 'Arch'));
  assert.deepEqual(order(t2), ['S1.pdf', 'Cover.pdf']);
  assert.equal(findNode(t2, idOf(t, 'Arch')), null);
  assert.equal(findNode(t, idOf(t, 'Plans'))?.name, 'Plans');
});

test('addFiles / addFolder: at the end of the top level, files already in the list are not added twice', async () => {
  const { addFiles, addFolder, hasFolders, filePaths } = await import('../src/ui/mergetree');
  let t = fromFiles(['/a.pdf']);
  t = addFiles(t, ['/a.pdf', '/b.pdf']);
  assert.deepEqual(filePaths(t), ['/a.pdf', '/b.pdf']);
  assert.equal(hasFolders(t), false);
  t = addFolder(t, { name: 'J', path: '/j', folders: [], files: [{ name: 'b.pdf', path: '/b.pdf' }, { name: 'c.pdf', path: '/j/c.pdf' }] });
  assert.deepEqual(filePaths(t), ['/a.pdf', '/b.pdf', '/j/c.pdf']);
  assert.equal(hasFolders(t), true);
  assert.deepEqual(flatten(t).map((x) => x.group), [[], [], ['J']]);
  // (a folder with nothing new in it is not added at all)
  assert.equal(addFolder(t, { name: 'K', path: '/k', folders: [], files: [{ name: 'a.pdf', path: '/a.pdf' }] }), t);
});

test('rows: what the list shows, folded folders hide their contents; numbers count files in combine order', async () => {
  const { visibleRows } = await import('../src/ui/mergetree');
  const t = fromGather(g);
  const rows = visibleRows(t, new Set());
  assert.deepEqual(rows.map((r) => [r.node.name, r.depth, r.num ?? 0]), [['Arch', 0, 0], ['Plans', 1, 0], ['P2.pdf', 2, 1], ['P10.pdf', 2, 2], ['A1.pdf', 1, 3], ['Struct', 0, 0], ['S1.pdf', 1, 4], ['Cover.pdf', 0, 5]]);
  const folded = visibleRows(t, new Set([idOf(t, 'Arch')]));
  assert.deepEqual(folded.map((r) => [r.node.name, r.num ?? 0]), [['Arch', 0], ['Struct', 0], ['S1.pdf', 4], ['Cover.pdf', 5]]);
  assert.equal(rows[0].files, 3);
});
