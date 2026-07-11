import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { AppSettings } from '../../shared/types';
import { DEFAULT_STREAM_CONFIG } from '../../shared/streamConfig';

const DEFAULTS: AppSettings = {
  searchEngine: 'google',
  theme: 'system',
  language: 'system',
  homepage: 'voksa://newtab',
  showBookmarkBar: true,
  streamMode: DEFAULT_STREAM_CONFIG,
  extensionOrder: [],
  sitePermissions: {},
  zoomLevels: {},
};

const VALID_ENGINES: AppSettings['searchEngine'][] = [
  'google',
  'duckduckgo',
  'startpage',
  'brave',
];
const VALID_THEMES: AppSettings['theme'][] = ['light', 'dark', 'system'];
const VALID_LANGUAGES: AppSettings['language'][] = ['system', 'fr', 'en'];

let cached: AppSettings | null = null;
let filePath: string | null = null;
let flushTimer: NodeJS.Timeout | null = null;

function getPath(): string {
  if (filePath) return filePath;
  const dir = app.getPath('userData');
  fs.mkdirSync(dir, { recursive: true });
  filePath = path.join(dir, 'settings.json');
  return filePath;
}

function sanitize(parsed: Partial<AppSettings>): AppSettings {
  const merged: AppSettings = {
    ...DEFAULTS,
    ...parsed,
    streamMode: { ...DEFAULT_STREAM_CONFIG, ...(parsed?.streamMode ?? {}) },
  };
  if (!VALID_ENGINES.includes(merged.searchEngine)) merged.searchEngine = 'google';
  if (!VALID_THEMES.includes(merged.theme)) merged.theme = 'system';
  if (!VALID_LANGUAGES.includes(merged.language)) merged.language = 'system';
  if (!Array.isArray(merged.extensionOrder)) merged.extensionOrder = [];
  if (!merged.sitePermissions || typeof merged.sitePermissions !== 'object') {
    merged.sitePermissions = {};
  }
  if (!merged.zoomLevels || typeof merged.zoomLevels !== 'object') {
    merged.zoomLevels = {};
  }
  if (typeof merged.homepage !== 'string' || !merged.homepage.trim()) {
    merged.homepage = DEFAULTS.homepage;
  } else if (/^hbb:\/\//i.test(merged.homepage)) {
    // Legacy alias: settings written before the Voksa rename may point the
    // homepage at hbb://...; migrate the prefix to the canonical scheme.
    merged.homepage = `voksa://${merged.homepage.slice('hbb://'.length)}`;
  }
  return merged;
}

function load(): AppSettings {
  if (cached) return cached;
  const file = getPath();
  let parsed: Partial<AppSettings> = {};
  if (fs.existsSync(file)) {
    try {
      // Strip a UTF-8 BOM (some editors add one) before parsing.
      const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
      parsed = JSON.parse(raw) as Partial<AppSettings>;
    } catch {
      // Corrupted file: preserve it for forensics instead of silently
      // discarding the user's settings, then fall back to defaults.
      try {
        fs.copyFileSync(file, `${file}.bak`);
        console.error('[settings] corrupted settings.json backed up to settings.json.bak');
      } catch {
        // ignore
      }
    }
  }
  cached = sanitize(parsed);
  return cached;
}

/** Atomic write: serialize to a temp file then rename over the target. */
function writeNow(next: AppSettings): void {
  const file = getPath();
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    console.error('[settings] failed to persist', err);
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // ignore
    }
  }
}

function scheduleFlush(): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (cached) writeNow(cached);
  }, 500);
}

/** Force any pending debounced write immediately (call on app quit). */
export function flushSettings(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (cached) writeNow(cached);
}

export function getSettings(): AppSettings {
  return { ...load() };
}

export function setSettings(patch: Partial<AppSettings>): AppSettings {
  const current = load();
  const next: AppSettings = sanitize({
    ...current,
    ...patch,
    streamMode: {
      ...current.streamMode,
      ...(patch.streamMode ?? {}),
    },
  });
  cached = next;
  scheduleFlush();
  return { ...next };
}
