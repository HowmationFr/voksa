import { nanoid } from 'nanoid';
import path from 'node:path';
import { shell, type Session, type DownloadItem as ElectronDownloadItem } from 'electron';
import type { DownloadItem } from '../../shared/types';
import {
  saveDownload,
  listPersistedDownloads,
  removePersistedDownload,
  clearPersistedDownloads,
  clearPersistedDownloadsSince,
} from '../storage/downloads';

/**
 * Owns the browser's download lifecycle: hooks `will-download`, tracks live
 * progress, persists completed items, and exposes pause/resume/cancel/open
 * actions to the chrome UI. Emits `onChanged` on every state transition so the
 * UI can render a live list.
 */
export class DownloadManager {
  private items = new Map<string, DownloadItem>();
  private natives = new Map<string, ElectronDownloadItem>();

  constructor(
    session: Session,
    private readonly onChanged: (items: DownloadItem[]) => void,
    private readonly onStarted?: (webContentsId: number) => void,
  ) {
    for (const persisted of listPersistedDownloads()) {
      // Only completed/interrupted ones are meaningful across restarts.
      this.items.set(persisted.id, persisted);
    }
    session.on('will-download', (_event, item, webContents) => {
      this.track(item, webContents?.id);
    });
  }

  private track(native: ElectronDownloadItem, webContentsId?: number): void {
    const id = nanoid();
    const record: DownloadItem = {
      id,
      filename: native.getFilename(),
      url: native.getURL(),
      savePath: '',
      state: 'progressing',
      receivedBytes: 0,
      totalBytes: native.getTotalBytes(),
      startedAt: Date.now(),
      paused: false,
    };
    this.items.set(id, record);
    this.natives.set(id, native);
    if (webContentsId != null && this.onStarted) this.onStarted(webContentsId);

    native.on('updated', (_e, state) => {
      record.receivedBytes = native.getReceivedBytes();
      record.totalBytes = native.getTotalBytes();
      record.savePath = native.getSavePath();
      record.paused = native.isPaused();
      record.state = state === 'interrupted' ? 'interrupted' : record.paused ? 'paused' : 'progressing';
      this.emit();
    });
    native.once('done', (_e, state) => {
      record.savePath = native.getSavePath();
      record.receivedBytes = native.getReceivedBytes();
      record.state =
        state === 'completed' ? 'completed' : state === 'cancelled' ? 'cancelled' : 'interrupted';
      record.paused = false;
      this.natives.delete(id);
      try {
        saveDownload(record);
      } catch {
        // ignore persistence failures
      }
      this.emit();
    });
    this.emit();
  }

  getAll(): DownloadItem[] {
    return [...this.items.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  pause(id: string): void {
    this.natives.get(id)?.pause();
  }
  resume(id: string): void {
    const n = this.natives.get(id);
    if (n && n.canResume()) n.resume();
  }
  cancel(id: string): void {
    this.natives.get(id)?.cancel();
  }

  openFile(id: string): void {
    const item = this.items.get(id);
    if (item?.savePath) void shell.openPath(item.savePath);
  }
  openFolder(id: string): void {
    const item = this.items.get(id);
    if (item?.savePath) shell.showItemInFolder(item.savePath);
  }

  remove(id: string): void {
    this.natives.get(id)?.cancel();
    this.natives.delete(id);
    this.items.delete(id);
    try {
      removePersistedDownload(id);
    } catch {
      // ignore
    }
    this.emit();
  }

  clearCompleted(): void {
    for (const [id, item] of [...this.items]) {
      if (item.state !== 'progressing' && item.state !== 'paused') {
        this.items.delete(id);
      }
    }
    try {
      clearPersistedDownloads();
    } catch {
      // ignore
    }
    this.emit();
  }

  /**
   * "Clear browsing data" entry point: drop the download HISTORY (never the
   * files on disk, never in-flight downloads), optionally bounded to items
   * started at or after `since`.
   */
  clearHistory(since: number | null): void {
    for (const [id, item] of [...this.items]) {
      const active = item.state === 'progressing' || item.state === 'paused';
      if (active) continue;
      if (since === null || item.startedAt >= since) this.items.delete(id);
    }
    try {
      if (since === null) clearPersistedDownloads();
      else clearPersistedDownloadsSince(since);
    } catch {
      // ignore
    }
    this.emit();
  }

  /** Basename helper for a save path (used by the UI). */
  static basename(p: string): string {
    return path.basename(p);
  }

  private emit(): void {
    this.onChanged(this.getAll());
  }
}
