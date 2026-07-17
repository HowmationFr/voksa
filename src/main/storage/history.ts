import { nanoid } from 'nanoid';
import { getDb } from './db';
import type { HistoryEntry } from '../../shared/types';

type UrlRow = {
  id: string;
  url: string;
  title: string;
  favicon_url: string | null;
  visit_count: number;
  last_visit_at: number;
  first_visit_at: number;
};

function rowToEntry(row: UrlRow): HistoryEntry {
  return {
    id: row.id,
    url: row.url,
    title: row.title,
    faviconUrl: row.favicon_url,
    visitedAt: row.last_visit_at,
  };
}

/** Escape LIKE metacharacters so a user query is matched literally. */
function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, '\\$&');
}

/**
 * Record a visit. Deduplicated by URL: the first visit inserts the `urls`
 * row (with whatever title/favicon are known so far, corrected shortly after
 * by `updateLatestTitle`/`updateLatestFavicon`), later visits only bump the
 * count + recency and NEVER clobber a good title with a stale one. Every
 * visit also appends to the `visits` timeline.
 */
export function recordVisit(url: string, title: string, faviconUrl: string | null): void {
  // Internal pages never enter history; hbb:// is the pre-rename legacy
  // alias of voksa:// and must stay filtered too.
  if (!url || url.startsWith('voksa://') || url.startsWith('hbb://') || url.startsWith('about:'))
    return;
  const db = getDb();
  const now = Date.now();
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO urls (id, url, title, favicon_url, visit_count, last_visit_at, first_visit_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(url) DO UPDATE SET
         visit_count = visit_count + 1,
         last_visit_at = excluded.last_visit_at`,
    ).run(nanoid(), url, title, faviconUrl, now, now);
    const row = db.prepare(`SELECT id FROM urls WHERE url = ?`).get(url) as { id: string };
    db.prepare(`INSERT INTO visits (id, url_id, visited_at) VALUES (?, ?, ?)`).run(
      nanoid(),
      row.id,
      now,
    );
  });
  tx();
}

/**
 * Bulk-merge imported history (browser import). Per URL: counts ADD, recency
 * takes the max, and an existing row keeps its title and favicon (what Voksa
 * observed beats what another browser recorded). One visits-timeline row is
 * appended per imported URL at its last visit: imports carry per-URL
 * aggregates, not per-visit timelines, and fabricating a fake timeline would
 * pollute the time-ranged clear-browsing-data. Returns rows merged.
 */
export function importHistoryEntries(
  entries: Array<{ url: string; title: string; visitCount: number; lastVisitAt: number }>,
): number {
  if (entries.length === 0) return 0;
  const db = getDb();
  const upsert = db.prepare(
    `INSERT INTO urls (id, url, title, favicon_url, visit_count, last_visit_at, first_visit_at)
     VALUES (?, ?, ?, NULL, ?, ?, ?)
     ON CONFLICT(url) DO UPDATE SET
       visit_count = visit_count + excluded.visit_count,
       last_visit_at = MAX(last_visit_at, excluded.last_visit_at)`,
  );
  const selectId = db.prepare(`SELECT id FROM urls WHERE url = ?`);
  const insertVisit = db.prepare(`INSERT INTO visits (id, url_id, visited_at) VALUES (?, ?, ?)`);
  let merged = 0;
  const tx = db.transaction(() => {
    for (const e of entries) {
      // Same gate as recordVisit: internal pages never enter history.
      if (!e.url || e.url.startsWith('voksa://') || e.url.startsWith('hbb://')) continue;
      upsert.run(nanoid(), e.url, e.title, e.visitCount, e.lastVisitAt, e.lastVisitAt);
      const row = selectId.get(e.url) as { id: string };
      insertVisit.run(nanoid(), row.id, e.lastVisitAt);
      merged += 1;
    }
  });
  tx();
  return merged;
}

export function updateLatestTitle(url: string, title: string): void {
  if (!title) return;
  getDb().prepare(`UPDATE urls SET title = ? WHERE url = ?`).run(title, url);
}

export function updateLatestFavicon(url: string, faviconUrl: string): void {
  getDb().prepare(`UPDATE urls SET favicon_url = ? WHERE url = ?`).run(faviconUrl, url);
}

export function listHistory(limit = 200, offset = 0): HistoryEntry[] {
  const rows = getDb()
    .prepare(`SELECT * FROM urls ORDER BY last_visit_at DESC LIMIT ? OFFSET ?`)
    .all(limit, offset) as UrlRow[];
  return rows.map(rowToEntry);
}

/**
 * Prefix-match on the URL plus infix-match on the title, ordered by
 * frequency then recency. Prepared statement + LIMIT keep the main-process
 * cost bounded even on a large history.
 */
export function searchHistory(query: string, limit = 8): HistoryEntry[] {
  const q = likeEscape(query.trim());
  if (!q) return [];
  const rows = getDb()
    .prepare(
      `SELECT * FROM urls
       WHERE url LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\'
       ORDER BY visit_count DESC, last_visit_at DESC
       LIMIT ?`,
    )
    .all(`%${q}%`, `%${q}%`, limit) as UrlRow[];
  return rows.map(rowToEntry);
}

/** Frequency-ranked most-visited sites, for the new-tab page. */
export function listTopSites(limit = 8): HistoryEntry[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM urls
       WHERE url LIKE 'http%'
       ORDER BY visit_count DESC, last_visit_at DESC
       LIMIT ?`,
    )
    .all(limit) as UrlRow[];
  return rows.map(rowToEntry);
}

export function deleteHistoryEntry(id: string): void {
  getDb().prepare(`DELETE FROM urls WHERE id = ?`).run(id);
}

export function clearHistory(): void {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM visits`).run();
    db.prepare(`DELETE FROM urls`).run();
  });
  tx();
}

/**
 * Delete every visit recorded at or after `since` (ms epoch), then repair
 * the `urls` aggregates: URLs left with zero visits disappear, the others
 * get their visit_count / last_visit_at recomputed from what remains.
 */
export function deleteHistorySince(since: number): void {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM visits WHERE visited_at >= ?`).run(since);
    db.prepare(
      `DELETE FROM urls WHERE id NOT IN (SELECT DISTINCT url_id FROM visits)`,
    ).run();
    db.prepare(
      `UPDATE urls SET
         visit_count = (SELECT COUNT(*) FROM visits v WHERE v.url_id = urls.id),
         last_visit_at = (SELECT MAX(visited_at) FROM visits v WHERE v.url_id = urls.id)`,
    ).run();
  });
  tx();
}
