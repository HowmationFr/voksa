/**
 * Browser-data import, side-effect half: profile detection, file access,
 * database reads and inserts. Every format decision lives in mapping.ts
 * (pure, tested); this file only moves bytes.
 *
 * Passwords are deliberately NOT importable: they sit in OS-encrypted vaults
 * (DPAPI / Keychain), and a browser that quietly decrypts another browser's
 * vault is doing exactly what malware does. The UI says so in plain words.
 *
 * Locked databases: Chrome and Firefox keep History / places.sqlite open
 * while running. The file is COPIED to a temp path first and the copy is
 * opened read-only: better-sqlite3 never touches the original, and a copy
 * that fails (hard lock) surfaces as "close the other browser first" instead
 * of a corrupt half-read.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { addBookmark, addFolder, findBookmarkByUrl } from '../storage/bookmarks';
import { importHistoryEntries } from '../storage/history';
import {
  parseChromeBookmarks,
  parseFirefoxBookmarks,
  sanitizeHistoryRows,
  chromeTimeToMs,
  firefoxTimeToMs,
  type FirefoxBookmarkRow,
  type ImportedTree,
} from './mapping';

export type ImportSource = {
  id: string;
  browser: 'chrome' | 'firefox';
  /** Human-readable profile label ("Default", "Profile 1", "abcd.default-release"). */
  profileName: string;
  profileDir: string;
  hasBookmarks: boolean;
  hasHistory: boolean;
};

export type ImportSelection = {
  sourceId: string;
  bookmarks: boolean;
  history: boolean;
};

export type ImportResult =
  | {
      ok: true;
      bookmarksImported: number;
      bookmarksSkipped: number;
      historyImported: number;
      folderName: string | null;
    }
  | { ok: false; error: 'source-gone' | 'locked' | 'nothing-selected' | 'read-failed' };

/** Cap: the omnibox ranking feeds on counts and recency; the 20k most recent
 * pages carry all of both, and a 300k-row import would only slow every query. */
const MAX_HISTORY_ROWS = 20_000;

function chromeUserDataDir(): string | null {
  const home = os.homedir();
  switch (process.platform) {
    case 'win32':
      return process.env.LOCALAPPDATA
        ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data')
        : null;
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'Google', 'Chrome');
    default:
      return path.join(home, '.config', 'google-chrome');
  }
}

function firefoxProfilesDir(): string | null {
  const home = os.homedir();
  switch (process.platform) {
    case 'win32':
      return process.env.APPDATA
        ? path.join(process.env.APPDATA, 'Mozilla', 'Firefox', 'Profiles')
        : null;
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'Firefox', 'Profiles');
    default:
      return path.join(home, '.mozilla', 'firefox');
  }
}

function listDirs(dir: string | null): string[] {
  if (!dir) return [];
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

function exists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

export function detectSources(): ImportSource[] {
  const out: ImportSource[] = [];

  // Chrome: profile dirs live directly under User Data (Default, Profile 1...).
  for (const dir of listDirs(chromeUserDataDir())) {
    const name = path.basename(dir);
    if (!/^(Default|Profile \d+)$/.test(name)) continue;
    const hasBookmarks = exists(path.join(dir, 'Bookmarks'));
    const hasHistory = exists(path.join(dir, 'History'));
    if (!hasBookmarks && !hasHistory) continue;
    out.push({
      id: `chrome:${dir}`,
      browser: 'chrome',
      profileName: name,
      profileDir: dir,
      hasBookmarks,
      hasHistory,
    });
  }

  // Firefox: every profile dir carries places.sqlite (bookmarks AND history).
  for (const dir of listDirs(firefoxProfilesDir())) {
    const hasPlaces = exists(path.join(dir, 'places.sqlite'));
    if (!hasPlaces) continue;
    out.push({
      id: `firefox:${dir}`,
      browser: 'firefox',
      profileName: path.basename(dir),
      profileDir: dir,
      hasBookmarks: true,
      hasHistory: true,
    });
  }

  return out;
}

/**
 * Copy a possibly-locked SQLite database (plus its WAL sidecar, whose pages
 * may hold the newest rows) to a temp dir and open the copy read-only.
 * Returns null when even the copy is impossible (exclusive lock).
 */
function openSqliteCopy(sourcePath: string): { db: Database.Database; cleanup: () => void } | null {
  let tempDir: string | null = null;
  try {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voksa-import-'));
    const target = path.join(tempDir, path.basename(sourcePath));
    fs.copyFileSync(sourcePath, target);
    for (const sidecar of ['-wal', '-shm']) {
      const side = `${sourcePath}${sidecar}`;
      if (exists(side)) fs.copyFileSync(side, `${target}${sidecar}`);
    }
    const db = new Database(target, { readonly: true, fileMustExist: true });
    const dir = tempDir;
    return {
      db,
      cleanup: () => {
        try {
          db.close();
        } catch {
          // already closed
        }
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {
          // temp dir cleanup is best-effort
        }
      },
    };
  } catch {
    if (tempDir) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    return null;
  }
}

/** Insert a parsed tree under a fresh root folder. Duplicate URLs (already
 * bookmarked anywhere) are skipped, so re-running an import cannot multiply
 * the user's bookmarks. */
function insertTree(tree: ImportedTree, rootName: string): {
  imported: number;
  skipped: number;
  folderName: string | null;
} {
  const toInsert = tree.bookmarks.filter((b) => !findBookmarkByUrl(b.url));
  if (toInsert.length === 0) return { imported: 0, skipped: tree.bookmarks.length, folderName: null };

  const root = addFolder(rootName, null);
  const realIdByTempId = new Map<string, string>();
  // mapping.ts emits parents before children (walk order), so one pass is
  // enough; a missing parent (its content was all duplicates) falls back to
  // the import root rather than being dropped.
  const usedFolders = new Set(toInsert.map((b) => b.folderTempId).filter(Boolean) as string[]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of tree.folders) {
      if (usedFolders.has(f.tempId) && f.parentTempId && !usedFolders.has(f.parentTempId)) {
        usedFolders.add(f.parentTempId);
        grew = true;
      }
    }
  }
  for (const folder of tree.folders) {
    if (!usedFolders.has(folder.tempId)) continue;
    const parentReal = folder.parentTempId
      ? (realIdByTempId.get(folder.parentTempId) ?? root.id)
      : root.id;
    realIdByTempId.set(folder.tempId, addFolder(folder.name, parentReal).id);
  }
  for (const bookmark of toInsert) {
    const folderId = bookmark.folderTempId
      ? (realIdByTempId.get(bookmark.folderTempId) ?? root.id)
      : root.id;
    addBookmark(bookmark.url, bookmark.title, null, folderId);
  }
  return {
    imported: toInsert.length,
    skipped: tree.bookmarks.length - toInsert.length,
    folderName: rootName,
  };
}

function importChrome(source: ImportSource, what: { bookmarks: boolean; history: boolean }): ImportResult {
  let bookmarksImported = 0;
  let bookmarksSkipped = 0;
  let historyImported = 0;
  let folderName: string | null = null;

  if (what.bookmarks) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(source.profileDir, 'Bookmarks'), 'utf8');
    } catch {
      return { ok: false, error: 'read-failed' };
    }
    const res = insertTree(parseChromeBookmarks(text), 'Importés de Chrome');
    bookmarksImported = res.imported;
    bookmarksSkipped = res.skipped;
    folderName = res.folderName;
  }

  if (what.history) {
    const opened = openSqliteCopy(path.join(source.profileDir, 'History'));
    if (!opened) return { ok: false, error: 'locked' };
    try {
      const rows = opened.db
        .prepare(
          `SELECT url, title, visit_count AS visitCount, last_visit_time AS t
           FROM urls WHERE hidden = 0
           ORDER BY last_visit_time DESC LIMIT ?`,
        )
        .all(MAX_HISTORY_ROWS) as Array<{ url: unknown; title: unknown; visitCount: unknown; t: unknown }>;
      const sanitized = sanitizeHistoryRows(
        rows.map((r) => ({ url: r.url, title: r.title, visitCount: r.visitCount, lastVisitAt: chromeTimeToMs(r.t) })),
        Date.now(),
      );
      historyImported = importHistoryEntries(sanitized);
    } catch {
      return { ok: false, error: 'read-failed' };
    } finally {
      opened.cleanup();
    }
  }

  return { ok: true, bookmarksImported, bookmarksSkipped, historyImported, folderName };
}

function importFirefox(source: ImportSource, what: { bookmarks: boolean; history: boolean }): ImportResult {
  const opened = openSqliteCopy(path.join(source.profileDir, 'places.sqlite'));
  if (!opened) return { ok: false, error: 'locked' };

  let bookmarksImported = 0;
  let bookmarksSkipped = 0;
  let historyImported = 0;
  let folderName: string | null = null;
  try {
    if (what.bookmarks) {
      const rows = opened.db
        .prepare(
          `SELECT b.id, b.type, b.parent, b.title, b.guid, p.url
           FROM moz_bookmarks b LEFT JOIN moz_places p ON b.fk = p.id
           WHERE b.type IN (1, 2)`,
        )
        .all() as FirefoxBookmarkRow[];
      const res = insertTree(parseFirefoxBookmarks(rows), 'Importés de Firefox');
      bookmarksImported = res.imported;
      bookmarksSkipped = res.skipped;
      folderName = res.folderName;
    }
    if (what.history) {
      const rows = opened.db
        .prepare(
          `SELECT url, title, visit_count AS visitCount, last_visit_date AS t
           FROM moz_places WHERE hidden = 0 AND visit_count > 0
           ORDER BY last_visit_date DESC LIMIT ?`,
        )
        .all(MAX_HISTORY_ROWS) as Array<{ url: unknown; title: unknown; visitCount: unknown; t: unknown }>;
      const sanitized = sanitizeHistoryRows(
        rows.map((r) => ({ url: r.url, title: r.title, visitCount: r.visitCount, lastVisitAt: firefoxTimeToMs(r.t) })),
        Date.now(),
      );
      historyImported = importHistoryEntries(sanitized);
    }
  } catch {
    return { ok: false, error: 'read-failed' };
  } finally {
    opened.cleanup();
  }

  return { ok: true, bookmarksImported, bookmarksSkipped, historyImported, folderName };
}

export function runImport(selection: ImportSelection): ImportResult {
  if (!selection.bookmarks && !selection.history) return { ok: false, error: 'nothing-selected' };
  const source = detectSources().find((s) => s.id === selection.sourceId);
  if (!source) return { ok: false, error: 'source-gone' };
  const what = {
    bookmarks: selection.bookmarks && source.hasBookmarks,
    history: selection.history && source.hasHistory,
  };
  return source.browser === 'chrome' ? importChrome(source, what) : importFirefox(source, what);
}
