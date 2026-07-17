/**
 * Pure mapping layer of the browser-data import: foreign formats in, our
 * shapes out. No Electron, no fs, no SQLite: everything here is testable on
 * fixtures, and everything actually touching disks or databases lives in
 * importer.ts.
 *
 * Timestamps are the classic trap. Chrome stores MICROSECONDS since
 * 1601-01-01 (the Windows FILETIME epoch), Firefox stores MICROSECONDS since
 * the Unix epoch: treating either as Unix milliseconds silently dates every
 * visit in the year 420000+ and the omnibox ranking follows. Both converters
 * are tested against known real values.
 */

/** Microseconds between 1601-01-01 and 1970-01-01: the Chrome/WebKit epoch offset. */
const CHROME_EPOCH_OFFSET_MS = 11_644_473_600_000;

/** Chrome/WebKit time (µs since 1601) to epoch ms, or null when unusable. */
export function chromeTimeToMs(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  const ms = value / 1000 - CHROME_EPOCH_OFFSET_MS;
  return ms > 0 ? Math.round(ms) : null;
}

/** Firefox time (µs since the Unix epoch) to epoch ms, or null when unusable. */
export function firefoxTimeToMs(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return Math.round(value / 1000);
}

/** Only web pages are importable: bookmarklets (javascript:), chrome:// and
 * file:// entries have no meaning, or no safe meaning, inside Voksa. */
export function isImportableUrl(url: unknown): url is string {
  return typeof url === 'string' && /^https?:\/\//i.test(url);
}

export type ImportedFolder = {
  /** Source-side id, referenced by children; remapped to real ids at insert time. */
  tempId: string;
  name: string;
  parentTempId: string | null;
};

export type ImportedBookmark = {
  title: string;
  url: string;
  folderTempId: string | null;
};

export type ImportedTree = {
  folders: ImportedFolder[];
  bookmarks: ImportedBookmark[];
};

type ChromeNode = {
  type?: string;
  name?: string;
  url?: string;
  children?: ChromeNode[];
};

/**
 * Flatten Chrome's Bookmarks JSON (the `roots` object) into folder + bookmark
 * lists. The three roots (bookmark_bar, other, synced) become top-level
 * folders only when non-empty, named after their role; the caller parents
 * everything under one "imported" folder so the user's own tree is untouched.
 */
export function parseChromeBookmarks(jsonText: string): ImportedTree {
  let parsed: { roots?: Record<string, ChromeNode> };
  try {
    parsed = JSON.parse(jsonText) as { roots?: Record<string, ChromeNode> };
  } catch {
    return { folders: [], bookmarks: [] };
  }
  const roots = parsed?.roots;
  if (!roots || typeof roots !== 'object') return { folders: [], bookmarks: [] };

  const folders: ImportedFolder[] = [];
  const bookmarks: ImportedBookmark[] = [];
  let nextId = 0;

  const walk = (node: ChromeNode, parentTempId: string | null): void => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'url') {
      if (!isImportableUrl(node.url)) return;
      bookmarks.push({
        title: typeof node.name === 'string' && node.name ? node.name : node.url,
        url: node.url,
        folderTempId: parentTempId,
      });
      return;
    }
    if (node.type === 'folder' && Array.isArray(node.children)) {
      // An empty folder is not worth recreating: importing is about content.
      if (node.children.length === 0) return;
      const tempId = `f${nextId++}`;
      folders.push({
        tempId,
        name: typeof node.name === 'string' && node.name ? node.name : '?',
        parentTempId,
      });
      for (const child of node.children) walk(child, tempId);
    }
  };

  // Chrome's fixed roots carry no user-visible name worth keeping ("Other
  // bookmarks" etc. vary by locale in DISPLAY only; the file always says
  // bookmark_bar/other/synced). Their CHILDREN go to the import root
  // directly: one less nesting level, and the shape everyone expects.
  for (const key of ['bookmark_bar', 'other', 'synced']) {
    const root = roots[key];
    if (root && Array.isArray(root.children)) {
      for (const child of root.children) walk(child, null);
    }
  }
  return { folders, bookmarks };
}

export type FirefoxBookmarkRow = {
  id: number;
  type: number;
  parent: number;
  title: string | null;
  url: string | null;
  guid: string;
};

/**
 * Same flattening for Firefox's moz_bookmarks join (see importer.ts for the
 * query). Firefox's fixed roots are identified by guid; like Chrome's, their
 * children are re-parented onto the import root.
 */
export function parseFirefoxBookmarks(rows: FirefoxBookmarkRow[]): ImportedTree {
  const FIXED_ROOTS = new Set([
    'root________',
    'menu________',
    'toolbar_____',
    'unfiled_____',
    'mobile______',
  ]);
  const folders: ImportedFolder[] = [];
  const bookmarks: ImportedBookmark[] = [];
  const folderTempIdBySourceId = new Map<number, string | null>();

  // Roots map to "no folder" (the import root). Iterating in parent-before-
  // child order is not guaranteed by id, so resolve lazily via a second pass:
  // first register folders, then attach.
  const byId = new Map(rows.map((r) => [r.id, r]));
  const resolveParent = (row: FirefoxBookmarkRow): string | null => {
    const parent = byId.get(row.parent);
    if (!parent || FIXED_ROOTS.has(parent.guid)) return null;
    return folderTempIdBySourceId.get(parent.id) ?? null;
  };

  for (const row of rows) {
    if (row.type === 2 && !FIXED_ROOTS.has(row.guid)) {
      folderTempIdBySourceId.set(row.id, `f${row.id}`);
    }
  }
  for (const row of rows) {
    if (row.type === 2 && !FIXED_ROOTS.has(row.guid)) {
      folders.push({
        tempId: `f${row.id}`,
        name: row.title && row.title.trim() ? row.title : '?',
        parentTempId: resolveParent(row),
      });
    } else if (row.type === 1 && isImportableUrl(row.url)) {
      bookmarks.push({
        title: row.title && row.title.trim() ? row.title : row.url,
        url: row.url,
        folderTempId: resolveParent(row),
      });
    }
  }

  // Folders that ended up with no bookmark anywhere beneath them are noise;
  // keep it simple and honest: a folder survives if any bookmark or surviving
  // folder points at it (fixed-point pass, lists are small).
  const used = new Set(bookmarks.map((b) => b.folderTempId).filter(Boolean) as string[]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of folders) {
      if (used.has(f.tempId) && f.parentTempId && !used.has(f.parentTempId)) {
        used.add(f.parentTempId);
        grew = true;
      }
    }
  }
  return { folders: folders.filter((f) => used.has(f.tempId)), bookmarks };
}

export type ImportedHistoryEntry = {
  url: string;
  title: string;
  visitCount: number;
  lastVisitAt: number;
};

/**
 * Clamp and validate raw history rows from either browser. `now` is a
 * parameter (pure module): timestamps in the future are clock damage, they
 * are clamped rather than believed; rows without a usable timestamp get the
 * import moment, never a fabricated past.
 */
export function sanitizeHistoryRows(
  rows: Array<{ url: unknown; title: unknown; visitCount: unknown; lastVisitAt: number | null }>,
  now: number,
): ImportedHistoryEntry[] {
  const out: ImportedHistoryEntry[] = [];
  for (const row of rows) {
    if (!isImportableUrl(row.url)) continue;
    const count =
      typeof row.visitCount === 'number' && Number.isFinite(row.visitCount)
        ? Math.max(1, Math.floor(row.visitCount))
        : 1;
    const at = row.lastVisitAt !== null && row.lastVisitAt > 0 ? Math.min(row.lastVisitAt, now) : now;
    out.push({
      url: row.url,
      title: typeof row.title === 'string' && row.title ? row.title : row.url,
      visitCount: count,
      lastVisitAt: at,
    });
  }
  return out;
}
