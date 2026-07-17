import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

/** `pinned` is optional on disk: files written before pinning simply omit it. */
export type SessionTab = { url: string; title: string; pinned?: boolean };

/** One browser window: its geometry, its tabs, its own reopen-closed stack. */
export type SessionWindow = {
  windowBounds?: { x: number; y: number; width: number; height: number };
  maximized?: boolean;
  tabs: SessionTab[];
  activeIndex: number;
  closedStack: SessionTab[];
};

/**
 * v2 on-disk shape: one entry per window, in creation order. v1 files
 * (a single flat window written by single-window builds) are migrated on
 * load; see loadSession.
 */
export type SessionData = {
  windows: SessionWindow[];
};

let filePath: string | null = null;
let flushTimer: NodeJS.Timeout | null = null;
/**
 * Live snapshots, one per window (keyed by BaseWindow.id), assembled into a
 * single SessionData on write. Insertion order is creation order, which is
 * also the restore order. Chrome-like semantics live in index.ts: a window
 * closed while others remain is REMOVED from here; quitting keeps them all.
 */
const snapshots = new Map<number, SessionWindow>();
let dirty = false;
/** True while the boot restore is still creating windows (see beginRestore). */
let restoring = false;

function getPath(): string {
  if (filePath) return filePath;
  const dir = app.getPath('userData');
  fs.mkdirSync(dir, { recursive: true });
  filePath = path.join(dir, 'session.json');
  return filePath;
}

/**
 * Legacy alias: session files written by builds before the Voksa rename
 * store internal pages under the hbb:// scheme; rewrite the prefix so the
 * restored tabs carry the canonical voksa:// URLs.
 */
function migrateTab(tab: SessionTab): SessionTab {
  if (tab.url.startsWith('hbb://')) {
    return { ...tab, url: `voksa://${tab.url.slice('hbb://'.length)}` };
  }
  return tab;
}

function sanitizeWindow(raw: unknown): SessionWindow | null {
  const data = raw as SessionWindow | null;
  if (!data || !Array.isArray(data.tabs)) return null;
  return {
    windowBounds: data.windowBounds,
    maximized: !!data.maximized,
    tabs: data.tabs.filter((t) => t && typeof t.url === 'string').map(migrateTab),
    activeIndex: typeof data.activeIndex === 'number' ? data.activeIndex : 0,
    closedStack: Array.isArray(data.closedStack)
      ? data.closedStack
          .slice(0, 25)
          .filter((t) => t && typeof t.url === 'string')
          .map(migrateTab)
      : [],
  };
}

export function loadSession(): SessionData | null {
  const file = getPath();
  if (!fs.existsSync(file)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      windows?: unknown[];
      tabs?: unknown[];
    };
    if (!data) return null;
    // v2: one entry per window.
    if (Array.isArray(data.windows)) {
      const windows = data.windows
        .map(sanitizeWindow)
        .filter((w): w is SessionWindow => w !== null);
      return windows.length > 0 ? { windows } : null;
    }
    // v1 migration: single-window builds stored one flat window at top level.
    const single = sanitizeWindow(data);
    return single ? { windows: [single] } : null;
  } catch {
    return null;
  }
}

function assemble(): SessionData {
  return { windows: [...snapshots.values()] };
}

function writeNow(): void {
  dirty = false;
  const file = getPath();
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(assemble()), 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // ignore
    }
  }
}

function scheduleWrite(): void {
  dirty = true;
  // Frozen during the boot restore: see beginRestore.
  if (restoring) return;
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (dirty) writeNow();
  }, 500);
}

/**
 * Freeze every disk write until the boot restore finished creating ALL the
 * saved windows. The snapshot map starts EMPTY and fills up one window at a
 * time (windows boot sequentially, each awaiting its chrome UI load), so any
 * write in between would assemble a file holding only the windows booted so
 * far and durably erase the others. While frozen the map still updates; the
 * on-disk file stays exactly as the previous run left it, which is also the
 * right outcome if the app dies mid-boot.
 */
export function beginRestore(): void {
  restoring = true;
}

/** Boot restore over: write the assembled state if anything changed. */
export function endRestore(): void {
  if (!restoring) return;
  restoring = false;
  if (dirty) writeNow();
}

/** Debounced, atomic save of ONE window's state (tab changes, moves...). */
export function updateWindowSnapshot(windowId: number, snapshot: SessionWindow): void {
  snapshots.set(windowId, snapshot);
  scheduleWrite();
}

/**
 * Forget a window (closed while other windows remain: Chrome semantics say
 * it does not come back at next boot). Written immediately: the removal must
 * be durable even if the app dies right after.
 */
export function removeWindowSnapshot(windowId: number): void {
  if (!snapshots.delete(windowId)) return;
  if (restoring) {
    dirty = true;
    return;
  }
  writeNow();
}

export function flushSession(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  // A quit during the boot restore (fatal error, user kills the app) must
  // NOT persist the half-assembled map over a complete saved session.
  if (restoring) return;
  if (dirty) writeNow();
}
