import { getDb } from './db';
import type { DownloadItem } from '../../shared/types';

type Row = {
  id: string;
  filename: string;
  url: string;
  save_path: string;
  state: string;
  total_bytes: number;
  received_bytes: number;
  started_at: number;
};

function rowToItem(row: Row): DownloadItem {
  return {
    id: row.id,
    filename: row.filename,
    url: row.url,
    savePath: row.save_path,
    state: row.state as DownloadItem['state'],
    receivedBytes: row.received_bytes,
    totalBytes: row.total_bytes,
    startedAt: row.started_at,
    paused: false,
  };
}

/** Upsert a finished/updated download so it survives a restart. */
export function saveDownload(item: DownloadItem): void {
  getDb()
    .prepare(
      `INSERT INTO downloads (id, filename, url, save_path, state, total_bytes, received_bytes, started_at)
       VALUES (@id, @filename, @url, @savePath, @state, @totalBytes, @receivedBytes, @startedAt)
       ON CONFLICT(id) DO UPDATE SET
         state = excluded.state,
         total_bytes = excluded.total_bytes,
         received_bytes = excluded.received_bytes`,
    )
    .run({
      id: item.id,
      filename: item.filename,
      url: item.url,
      savePath: item.savePath,
      state: item.state,
      totalBytes: item.totalBytes,
      receivedBytes: item.receivedBytes,
      startedAt: item.startedAt,
    });
}

export function listPersistedDownloads(limit = 100): DownloadItem[] {
  const rows = getDb()
    .prepare(`SELECT * FROM downloads ORDER BY started_at DESC LIMIT ?`)
    .all(limit) as Row[];
  return rows.map(rowToItem);
}

export function removePersistedDownload(id: string): void {
  getDb().prepare(`DELETE FROM downloads WHERE id = ?`).run(id);
}

export function clearPersistedDownloads(): void {
  getDb().prepare(`DELETE FROM downloads`).run();
}

/** Delete persisted download entries started at or after `since` (ms epoch). */
export function clearPersistedDownloadsSince(since: number): void {
  getDb().prepare(`DELETE FROM downloads WHERE started_at >= ?`).run(since);
}
