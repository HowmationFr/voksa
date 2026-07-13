import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { AppSettings } from '../../shared/types';
import { DEFAULT_STREAM_CONFIG } from '../../shared/streamConfig';
import { DEFAULT_MEMORY_SAVER, MEMORY_SAVER_LEVELS } from '../../shared/memorySaver';
import {
  DEFAULT_SEARCH_ENGINE,
  getEngine,
  resolveEngines,
  sanitizeCustomEngines,
} from '../../shared/searchEngines';
import {
  DEFAULT_STARTUP_MODE,
  isStartupMode,
  sanitizeStartupUrls,
} from '../../shared/startup';

const DEFAULTS: AppSettings = {
  searchEngine: DEFAULT_SEARCH_ENGINE,
  customEngines: [],
  theme: 'system',
  language: 'system',
  homepage: 'voksa://newtab',
  showBookmarkBar: true,
  streamMode: DEFAULT_STREAM_CONFIG,
  extensionOrder: [],
  sitePermissions: {},
  zoomLevels: {},
  memorySaver: DEFAULT_MEMORY_SAVER,
  memorySaverExceptions: [],
  startupMode: DEFAULT_STARTUP_MODE,
  startupUrls: [],
  preconnect: true,
};

const VALID_THEMES: AppSettings['theme'][] = ['light', 'dark', 'system'];
const VALID_LANGUAGES: AppSettings['language'][] = ['system', 'fr', 'en'];
/** Bounded so a hand-edited settings.json can't grow the sweep unboundedly. */
const MAX_EXCEPTIONS = 200;

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
  // Custom engines first: the default engine may BE one of them, and a custom
  // engine the user deleted (or that a hand-edited file broke) must not leave
  // the browser pointing at an engine that no longer exists.
  merged.customEngines = sanitizeCustomEngines(merged.customEngines);
  const engines = resolveEngines(merged.customEngines);
  if (getEngine(merged.searchEngine, engines).id !== merged.searchEngine) {
    merged.searchEngine = DEFAULT_SEARCH_ENGINE;
  }
  if (!VALID_THEMES.includes(merged.theme)) merged.theme = 'system';
  if (!VALID_LANGUAGES.includes(merged.language)) merged.language = 'system';
  if (!Array.isArray(merged.extensionOrder)) merged.extensionOrder = [];
  if (!merged.sitePermissions || typeof merged.sitePermissions !== 'object') {
    merged.sitePermissions = {};
  }
  if (!merged.zoomLevels || typeof merged.zoomLevels !== 'object') {
    merged.zoomLevels = {};
  }
  if (!MEMORY_SAVER_LEVELS.includes(merged.memorySaver)) {
    merged.memorySaver = DEFAULT_MEMORY_SAVER;
  }
  merged.memorySaverExceptions = Array.isArray(merged.memorySaverExceptions)
    ? merged.memorySaverExceptions
        .filter((h): h is string => typeof h === 'string')
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean)
        .slice(0, MAX_EXCEPTIONS)
    : [];
  if (!isStartupMode(merged.startupMode)) merged.startupMode = DEFAULT_STARTUP_MODE;
  merged.startupUrls = sanitizeStartupUrls(merged.startupUrls);
  if (typeof merged.preconnect !== 'boolean') merged.preconnect = DEFAULTS.preconnect;
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
  // The FILE existing is what makes this an existing profile, not whether we
  // managed to read it: a corrupt settings.json must not cost the user their
  // session restore on top of their settings.
  const fromExistingProfile = fs.existsSync(file);
  if (fromExistingProfile) {
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
  // Migration 0.3 -> 0.4. Until 0.4 Voksa restored the previous session
  // unconditionally, so a profile that predates `startupMode` has been living
  // with 'restore'. The new DEFAULT is 'newtab' (what a fresh profile gets),
  // but silently applying it here would look, to that user, exactly like the
  // browser losing all their tabs on an update. So: existing profile keeps its
  // behaviour, and can now change it in Settings.
  if (fromExistingProfile && parsed.startupMode === undefined) {
    parsed = { ...parsed, startupMode: 'restore' };
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
