import { nanoid } from 'nanoid';
import { getDb } from './db';
import {
  planMixedReorder,
  wouldCreateFolderCycle,
  type MixedItemRef,
} from '../../shared/bookmarkOrdering';
import type { Bookmark, BookmarkFolder } from '../../shared/types';

type Row = {
  id: string;
  url: string;
  title: string;
  favicon_url: string | null;
  folder_id: string | null;
  position: number;
  added_at: number;
};

type FolderRow = {
  id: string;
  name: string;
  parent_id: string | null;
  position: number;
};

function rowToBookmark(row: Row): Bookmark {
  return {
    id: row.id,
    url: row.url,
    title: row.title,
    faviconUrl: row.favicon_url,
    folderId: row.folder_id,
    position: row.position,
    addedAt: row.added_at,
  };
}

function rowToFolder(row: FolderRow): BookmarkFolder {
  return { id: row.id, name: row.name, parentId: row.parent_id, position: row.position };
}

/**
 * Next free position in a container's MIXED sequence: bookmarks
 * (folder_id) and folders (parent_id) share the same 0..N ordering.
 */
function nextPositionInContainer(container: string | null): number {
  const row = getDb()
    .prepare(
      `SELECT MAX(p) + 1 AS next FROM (
         SELECT COALESCE(MAX(position), -1) AS p FROM bookmarks WHERE folder_id IS ?
         UNION ALL
         SELECT COALESCE(MAX(position), -1) AS p FROM bookmark_folders WHERE parent_id IS ?
       )`,
    )
    .get(container, container) as { next: number | null };
  return row.next ?? 0;
}

export function listBookmarks(): Bookmark[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM bookmarks
       ORDER BY folder_id IS NULL DESC, folder_id, position ASC, added_at ASC`,
    )
    .all() as Row[];
  return rows.map(rowToBookmark);
}

export function addBookmark(
  url: string,
  title: string,
  faviconUrl: string | null,
  folderId: string | null = null,
): Bookmark {
  const db = getDb();
  // Dedup by URL: bookmarking an already-bookmarked page is a no-op that
  // returns the existing entry, so the address-bar star can never create
  // duplicates that then make the toggle behave erratically.
  const existing = findBookmarkByUrl(url);
  if (existing) return existing;
  const id = nanoid();
  const position = nextPositionInContainer(folderId);
  const added_at = Date.now();
  db.prepare(
    `INSERT INTO bookmarks (id, url, title, favicon_url, folder_id, position, added_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, url, title, faviconUrl, folderId, position, added_at);
  return {
    id,
    url,
    title,
    faviconUrl,
    folderId,
    position,
    addedAt: added_at,
  };
}

export function removeBookmark(id: string): void {
  getDb().prepare(`DELETE FROM bookmarks WHERE id = ?`).run(id);
}

export function updateBookmark(id: string, patch: Partial<Omit<Bookmark, 'id'>>): void {
  const cols: string[] = [];
  const vals: unknown[] = [];
  if (patch.url !== undefined) {
    cols.push('url = ?');
    vals.push(patch.url);
  }
  if (patch.title !== undefined) {
    cols.push('title = ?');
    vals.push(patch.title);
  }
  if (patch.faviconUrl !== undefined) {
    cols.push('favicon_url = ?');
    vals.push(patch.faviconUrl);
  }
  if (patch.folderId !== undefined) {
    cols.push('folder_id = ?');
    vals.push(patch.folderId);
  }
  if (patch.position !== undefined) {
    cols.push('position = ?');
    vals.push(patch.position);
  }
  if (!cols.length) return;
  vals.push(id);
  getDb()
    .prepare(`UPDATE bookmarks SET ${cols.join(', ')} WHERE id = ?`)
    .run(...(vals as Parameters<ReturnType<typeof getDb>['prepare']>));
}

export function findBookmarkByUrl(url: string): Bookmark | null {
  const row = getDb().prepare(`SELECT * FROM bookmarks WHERE url = ? LIMIT 1`).get(url) as
    | Row
    | undefined;
  return row ? rowToBookmark(row) : null;
}

export function searchBookmarks(query: string, limit = 8): Bookmark[] {
  const like = `%${query}%`;
  const rows = getDb()
    .prepare(
      `SELECT * FROM bookmarks
       WHERE url LIKE ? OR title LIKE ?
       ORDER BY added_at DESC
       LIMIT ?`,
    )
    .all(like, like, limit) as Row[];
  return rows.map(rowToBookmark);
}

// --- Folders -----------------------------------------------------------------

export function listFolders(): BookmarkFolder[] {
  const rows = getDb()
    .prepare(`SELECT * FROM bookmark_folders ORDER BY parent_id IS NULL DESC, parent_id, position`)
    .all() as FolderRow[];
  return rows.map(rowToFolder);
}

export function addFolder(name: string, parentId: string | null = null): BookmarkFolder {
  const id = nanoid();
  const position = nextPositionInContainer(parentId);
  getDb()
    .prepare(`INSERT INTO bookmark_folders (id, name, parent_id, position) VALUES (?, ?, ?, ?)`)
    .run(id, name, parentId, position);
  return { id, name, parentId, position };
}

export function renameFolder(id: string, name: string): void {
  getDb().prepare(`UPDATE bookmark_folders SET name = ? WHERE id = ?`).run(name, id);
}

/** Re-parent a folder (appended at the end of its new container). No-op on cycles. */
export function moveFolder(id: string, parentId: string | null): void {
  if (parentId === id) return;
  if (wouldCreateFolderCycle(listFolders(), id, parentId)) return;
  const position = nextPositionInContainer(parentId);
  getDb()
    .prepare(`UPDATE bookmark_folders SET parent_id = ?, position = ? WHERE id = ?`)
    .run(parentId, position, id);
}

/**
 * Delete a folder. Its direct children (bookmarks AND subfolders) are
 * promoted to the ROOT (both FKs are ON DELETE SET NULL), then re-appended
 * to the root sequence in their previous relative order so nothing lands
 * on a colliding position.
 */
export function removeFolder(id: string): void {
  const db = getDb();
  const tx = db.transaction(() => {
    const childFolders = db
      .prepare(`SELECT id FROM bookmark_folders WHERE parent_id = ? ORDER BY position`)
      .all(id) as { id: string }[];
    const childBookmarks = db
      .prepare(`SELECT id FROM bookmarks WHERE folder_id = ? ORDER BY position`)
      .all(id) as { id: string }[];

    db.prepare(`DELETE FROM bookmark_folders WHERE id = ?`).run(id);

    let position = nextPositionInContainer(null);
    const upFolder = db.prepare(`UPDATE bookmark_folders SET position = ? WHERE id = ?`);
    const upBookmark = db.prepare(`UPDATE bookmarks SET position = ? WHERE id = ?`);
    for (const f of childFolders) upFolder.run(position++, f.id);
    for (const b of childBookmarks) upBookmark.run(position++, b.id);
  });
  tx();
}

/** Move a bookmark into a folder (or the root), appended at the end. */
export function moveBookmarkToFolder(id: string, folderId: string | null): void {
  const position = nextPositionInContainer(folderId);
  getDb()
    .prepare(`UPDATE bookmarks SET folder_id = ?, position = ? WHERE id = ?`)
    .run(folderId, position, id);
}

/**
 * Rewrite one container's full mixed ordering (bookmarks + folders) as
 * positions 0..N, re-assigning items to `container` as needed. One
 * transaction: the sequence is never observed half-written. Folder moves
 * are cycle-guarded (a cycle turns the whole reorder into a no-op rather
 * than silently corrupting the tree).
 */
export function reorderMixed(container: string | null, items: MixedItemRef[]): void {
  const db = getDb();
  const folders = listFolders();
  for (const item of items) {
    if (item.kind === 'folder' && wouldCreateFolderCycle(folders, item.id, container)) return;
  }
  const upBookmark = db.prepare(`UPDATE bookmarks SET folder_id = ?, position = ? WHERE id = ?`);
  const upFolder = db.prepare(`UPDATE bookmark_folders SET parent_id = ?, position = ? WHERE id = ?`);
  const tx = db.transaction(() => {
    for (const write of planMixedReorder(items)) {
      (write.table === 'bookmarks' ? upBookmark : upFolder).run(container, write.position, write.id);
    }
  });
  tx();
}
