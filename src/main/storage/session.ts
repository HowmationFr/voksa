import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

export type SessionTab = { url: string; title: string };

export type SessionData = {
  windowBounds?: { x: number; y: number; width: number; height: number };
  maximized?: boolean;
  tabs: SessionTab[];
  activeIndex: number;
  closedStack: SessionTab[];
};

let filePath: string | null = null;
let flushTimer: NodeJS.Timeout | null = null;
let pending: SessionData | null = null;

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

export function loadSession(): SessionData | null {
  const file = getPath();
  if (!fs.existsSync(file)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8')) as SessionData;
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
  } catch {
    return null;
  }
}

function writeNow(data: SessionData): void {
  const file = getPath();
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // ignore
    }
  }
}

/** Debounced, atomic save; called frequently (tab changes, window moves). */
export function saveSession(data: SessionData): void {
  pending = data;
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (pending) writeNow(pending);
  }, 500);
}

export function flushSession(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (pending) writeNow(pending);
}
