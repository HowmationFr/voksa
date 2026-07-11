import type { Bookmark, BookmarkFolder } from './types';

/**
 * Mixed ordering of bookmarks and folders inside one container.
 *
 * A "container" is either the bookmark bar root (null) or a folder id.
 * Bookmarks live there via `folderId`, folders via `parentId`. Positions
 * 0..N form ONE sequence shared across both tables; uniqueness is
 * guaranteed by construction because every ordering write rewrites the
 * whole container in a transaction (see storage/bookmarks.ts).
 *
 * Pure module (no electron/db imports) shared by main and UI, unit-tested.
 */

export type MixedItemRef = { kind: 'bookmark' | 'folder'; id: string };

export type BarItem =
  | { kind: 'bookmark'; bookmark: Bookmark }
  | { kind: 'folder'; folder: BookmarkFolder };

export function barItemId(item: BarItem): string {
  return item.kind === 'bookmark' ? item.bookmark.id : item.folder.id;
}

export function barItemRef(item: BarItem): MixedItemRef {
  return { kind: item.kind, id: barItemId(item) };
}

/**
 * Merge the bookmarks and folders belonging to `container` into one list
 * sorted by position (folders win position ties so legacy rows that share
 * a position still render deterministically).
 */
export function mergeContainerItems(
  bookmarks: readonly Bookmark[],
  folders: readonly BookmarkFolder[],
  container: string | null,
): BarItem[] {
  const items: BarItem[] = [
    ...folders
      .filter((f) => f.parentId === container)
      .map((folder): BarItem => ({ kind: 'folder', folder })),
    ...bookmarks
      .filter((b) => b.folderId === container)
      .map((bookmark): BarItem => ({ kind: 'bookmark', bookmark })),
  ];
  return items.sort((a, b) => {
    const pa = a.kind === 'bookmark' ? a.bookmark.position : a.folder.position;
    const pb = b.kind === 'bookmark' ? b.bookmark.position : b.folder.position;
    if (pa !== pb) return pa - pb;
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
    return barItemId(a).localeCompare(barItemId(b));
  });
}

export type MixedWrite = {
  table: 'bookmarks' | 'bookmark_folders';
  id: string;
  position: number;
};

/**
 * Turn a desired ordering of one container into the row writes (positions
 * 0..N, plus container re-assignment done by the executor) that realize it.
 */
export function planMixedReorder(items: readonly MixedItemRef[]): MixedWrite[] {
  return items.map((item, index) => ({
    table: item.kind === 'bookmark' ? 'bookmarks' : 'bookmark_folders',
    id: item.id,
    position: index,
  }));
}

/**
 * Would re-parenting `folderId` under `newParentId` create a cycle
 * (folder inside itself or inside one of its own descendants)?
 */
export function wouldCreateFolderCycle(
  folders: readonly Pick<BookmarkFolder, 'id' | 'parentId'>[],
  folderId: string,
  newParentId: string | null,
): boolean {
  if (newParentId === null) return false;
  if (newParentId === folderId) return true;
  const parents = new Map(folders.map((f) => [f.id, f.parentId]));
  let cursor: string | null = newParentId;
  const seen = new Set<string>();
  while (cursor !== null) {
    if (cursor === folderId) return true;
    if (seen.has(cursor)) return true; // pre-existing corruption: treat as cycle
    seen.add(cursor);
    cursor = parents.get(cursor) ?? null;
  }
  return false;
}

export type FlatFolder = { id: string; name: string; depth: number };

/**
 * Depth-first flattening of the folder tree for <select> pickers, with
 * `depth` for indentation. `excludeSubtreeOf` drops a folder and all its
 * descendants (a folder can't be moved into itself).
 */
export function flattenFolderTree(
  folders: readonly BookmarkFolder[],
  excludeSubtreeOf?: string,
): FlatFolder[] {
  const out: FlatFolder[] = [];
  const visited = new Set<string>();
  const walk = (parentId: string | null, depth: number) => {
    const children = folders
      .filter((f) => f.parentId === parentId)
      .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
    for (const f of children) {
      if (f.id === excludeSubtreeOf || visited.has(f.id)) continue;
      visited.add(f.id);
      out.push({ id: f.id, name: f.name, depth });
      walk(f.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}
