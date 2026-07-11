import { describe, it, expect } from 'vitest';
import {
  barItemId,
  flattenFolderTree,
  mergeContainerItems,
  planMixedReorder,
  wouldCreateFolderCycle,
} from '../bookmarkOrdering';
import type { Bookmark, BookmarkFolder } from '../types';

function bm(id: string, folderId: string | null, position: number): Bookmark {
  return { id, url: `https://${id}.test`, title: id, faviconUrl: null, folderId, position, addedAt: 0 };
}

function fd(id: string, parentId: string | null, position: number, name = id): BookmarkFolder {
  return { id, name, parentId, position };
}

describe('mergeContainerItems', () => {
  it('merges bookmarks and folders of one container, sorted by position', () => {
    const bookmarks = [bm('b1', null, 2), bm('b2', 'f1', 0), bm('b3', null, 0)];
    const folders = [fd('f1', null, 1), fd('f2', 'f1', 5)];
    const root = mergeContainerItems(bookmarks, folders, null);
    expect(root.map(barItemId)).toEqual(['b3', 'f1', 'b1']);
    const inF1 = mergeContainerItems(bookmarks, folders, 'f1');
    expect(inF1.map(barItemId)).toEqual(['b2', 'f2']);
  });

  it('breaks position ties deterministically (folder first)', () => {
    const items = mergeContainerItems([bm('b1', null, 0)], [fd('f1', null, 0)], null);
    expect(items.map(barItemId)).toEqual(['f1', 'b1']);
  });
});

describe('planMixedReorder', () => {
  it('assigns positions 0..N in the given order, routed to the right table', () => {
    const writes = planMixedReorder([
      { kind: 'folder', id: 'f1' },
      { kind: 'bookmark', id: 'b1' },
      { kind: 'bookmark', id: 'b2' },
    ]);
    expect(writes).toEqual([
      { table: 'bookmark_folders', id: 'f1', position: 0 },
      { table: 'bookmarks', id: 'b1', position: 1 },
      { table: 'bookmarks', id: 'b2', position: 2 },
    ]);
  });
});

describe('wouldCreateFolderCycle', () => {
  const folders = [fd('a', null, 0), fd('b', 'a', 0), fd('c', 'b', 0)];

  it('rejects a folder as its own parent', () => {
    expect(wouldCreateFolderCycle(folders, 'a', 'a')).toBe(true);
  });

  it('rejects moving a folder under its own descendant (deep)', () => {
    expect(wouldCreateFolderCycle(folders, 'a', 'c')).toBe(true);
  });

  it('allows moving to the root or under an unrelated folder', () => {
    expect(wouldCreateFolderCycle(folders, 'c', null)).toBe(false);
    expect(wouldCreateFolderCycle(folders, 'c', 'a')).toBe(false);
  });
});

describe('flattenFolderTree', () => {
  const folders = [
    fd('a', null, 0),
    fd('b', 'a', 0),
    fd('c', 'b', 0),
    fd('d', null, 1),
  ];

  it('walks depth-first with depths', () => {
    expect(flattenFolderTree(folders)).toEqual([
      { id: 'a', name: 'a', depth: 0 },
      { id: 'b', name: 'b', depth: 1 },
      { id: 'c', name: 'c', depth: 2 },
      { id: 'd', name: 'd', depth: 0 },
    ]);
  });

  it('excludes a subtree (folder cannot be moved into itself)', () => {
    expect(flattenFolderTree(folders, 'b').map((f) => f.id)).toEqual(['a', 'd']);
  });

  it('survives corrupted parent links without infinite loops', () => {
    const cyclic = [fd('x', 'y', 0), fd('y', 'x', 0)];
    expect(flattenFolderTree(cyclic)).toEqual([]);
  });
});
