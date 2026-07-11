import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { app } from 'electron';

let db: Database.Database | null = null;

const SCHEMA_VERSION = 5;

export function getDb(): Database.Database {
  if (db) return db;

  const dir = app.getPath('userData');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'voksa.sqlite');
  // Rename migration: profiles created before the Voksa rename keep their
  // data (WAL sidecar files included, they follow the main file's name).
  if (!fs.existsSync(file)) {
    const legacy = path.join(dir, 'howmation-browse.sqlite');
    if (fs.existsSync(legacy)) {
      try {
        for (const suffix of ['', '-wal', '-shm']) {
          const from = legacy + suffix;
          if (fs.existsSync(from)) fs.renameSync(from, file + suffix);
        }
      } catch {
        // fall through: a fresh DB will be created
      }
    }
  }
  db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  migrate(db);
  return db;
}

/**
 * Versioned migrations driven by `PRAGMA user_version`. Each step is
 * idempotent (`IF NOT EXISTS`) and forward-only. Existing databases created
 * before versioning existed report `user_version = 0`; step 1 recreates the
 * base tables (harmless no-ops if present) and step 2 splits the flat
 * `history` visit-log into deduplicated `urls` + a `visits` timeline.
 */
function migrate(instance: Database.Database): void {
  let version = instance.pragma('user_version', { simple: true }) as number;

  if (version < 1) {
    instance.exec(`
      CREATE TABLE IF NOT EXISTS history (
        id TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        favicon_url TEXT,
        visited_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS bookmark_folders (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS bookmarks (
        id TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        favicon_url TEXT,
        folder_id TEXT,
        position INTEGER NOT NULL DEFAULT 0,
        added_at INTEGER NOT NULL,
        FOREIGN KEY (folder_id) REFERENCES bookmark_folders(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_bookmarks_folder ON bookmarks(folder_id, position);
    `);
    instance.pragma('user_version = 1');
    version = 1;
  }

  if (version < 2) {
    instance.exec(`
      CREATE TABLE IF NOT EXISTS urls (
        id TEXT PRIMARY KEY,
        url TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL DEFAULT '',
        favicon_url TEXT,
        visit_count INTEGER NOT NULL DEFAULT 1,
        last_visit_at INTEGER NOT NULL,
        first_visit_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_urls_last_visit ON urls(last_visit_at DESC);
      CREATE INDEX IF NOT EXISTS idx_urls_visit_count ON urls(visit_count DESC);

      CREATE TABLE IF NOT EXISTS visits (
        id TEXT PRIMARY KEY,
        url_id TEXT NOT NULL,
        visited_at INTEGER NOT NULL,
        FOREIGN KEY (url_id) REFERENCES urls(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_visits_url ON visits(url_id);
      CREATE INDEX IF NOT EXISTS idx_visits_at ON visits(visited_at DESC);
    `);

    // Fold the legacy per-visit `history` rows into the new aggregate.
    const hasLegacy = instance
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='history'`)
      .get();
    if (hasLegacy) {
      const tx = instance.transaction(() => {
        instance.exec(`
          INSERT OR IGNORE INTO urls (id, url, title, favicon_url, visit_count, last_visit_at, first_visit_at)
          SELECT
            lower(hex(randomblob(8))),
            h.url,
            (SELECT h2.title FROM history h2 WHERE h2.url = h.url ORDER BY h2.visited_at DESC LIMIT 1),
            (SELECT h2.favicon_url FROM history h2 WHERE h2.url = h.url ORDER BY h2.visited_at DESC LIMIT 1),
            COUNT(*),
            MAX(h.visited_at),
            MIN(h.visited_at)
          FROM history h
          GROUP BY h.url;

          INSERT INTO visits (id, url_id, visited_at)
          SELECT lower(hex(randomblob(8))), u.id, h.visited_at
          FROM history h JOIN urls u ON u.url = h.url;

          DROP TABLE history;
        `);
      });
      tx();
    }

    instance.pragma('user_version = 2');
    version = 2;
  }

  if (version < 3) {
    instance.exec(`
      CREATE TABLE IF NOT EXISTS downloads (
        id TEXT PRIMARY KEY,
        filename TEXT NOT NULL,
        url TEXT NOT NULL,
        save_path TEXT NOT NULL,
        state TEXT NOT NULL,
        total_bytes INTEGER NOT NULL DEFAULT 0,
        received_bytes INTEGER NOT NULL DEFAULT 0,
        started_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_downloads_started ON downloads(started_at DESC);
    `);
    instance.pragma('user_version = 3');
    version = 3;
  }

  if (version < 4) {
    // Nested bookmark folders. Deleting a folder promotes its children
    // (bookmarks AND subfolders) to the root; both FKs are SET NULL, no
    // destructive cascade. The bookmarks FK from step 1 already behaves
    // this way; this adds the folder→folder edge.
    instance.exec(`
      ALTER TABLE bookmark_folders
        ADD COLUMN parent_id TEXT REFERENCES bookmark_folders(id) ON DELETE SET NULL;
      CREATE INDEX IF NOT EXISTS idx_folders_parent ON bookmark_folders(parent_id, position);
    `);
    instance.pragma('user_version = 4');
    version = 4;
  }

  if (version < 5) {
    // Voksa rename: internal pages moved from the legacy hbb:// scheme to
    // voksa://. Rewrite ONLY the scheme prefix of persisted URLs (substr
    // keeps the rest of the URL byte-for-byte); every other row and column
    // is untouched, so the step is non-destructive. History rows normally
    // never contain internal URLs (recordVisit filters them), but rewrite
    // defensively; OR IGNORE guards the UNIQUE(url) constraint on `urls` in
    // the pathological case where both spellings already coexist.
    instance.exec(`
      UPDATE OR IGNORE urls SET url = 'voksa://' || substr(url, 7) WHERE url LIKE 'hbb://%';
      UPDATE bookmarks SET url = 'voksa://' || substr(url, 7) WHERE url LIKE 'hbb://%';
    `);
    instance.pragma('user_version = 5');
    version = 5;
  }

  void SCHEMA_VERSION;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
