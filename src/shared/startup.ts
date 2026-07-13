/**
 * What Voksa opens when it starts.
 *
 * Pure module (no Electron): main imports it for the boot decision, the UI for
 * the radio group, and the tests for both. The decision itself lives here as
 * `pickStartupPlan` precisely because the alternative (an `if` chain buried in
 * app.whenReady) is untestable without relaunching the process.
 */

export const STARTUP_MODES = ['newtab', 'restore', 'urls'] as const;
export type StartupMode = (typeof STARTUP_MODES)[number];

/**
 * New profiles open the new tab page, like Chrome. Existing profiles are
 * migrated to 'restore' (see storage/settings.ts): Voksa restored the session
 * unconditionally until 0.3, and taking that away from someone on a mere
 * update would look exactly like losing their tabs.
 */
export const DEFAULT_STARTUP_MODE: StartupMode = 'newtab';

/** Bounded so a hand-edited settings.json can't open a thousand tabs at boot. */
export const MAX_STARTUP_URLS = 20;

export function isStartupMode(value: unknown): value is StartupMode {
  return typeof value === 'string' && (STARTUP_MODES as readonly string[]).includes(value);
}

/** Trim, drop empties and duplicates, cap the count. Stored raw (like homepage): normalizeInput turns them into URLs at open time. */
export function sanitizeStartupUrls(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const url = entry.trim();
    if (!url || out.includes(url)) continue;
    out.push(url);
    if (out.length >= MAX_STARTUP_URLS) break;
  }
  return out;
}

/** A window snapshot, as far as the startup decision is concerned. */
export type StartupSession = { windows: unknown[] } | null;

export type StartupPlan =
  | { kind: 'restore' }
  | { kind: 'urls'; urls: string[] }
  | { kind: 'newtab' };

/**
 * The boot decision, in one place.
 *
 * Falls back to 'newtab' whenever the chosen mode has nothing to act on (an
 * empty session, an empty URL list): a browser that starts with no window at
 * all would be a browser you cannot use.
 */
export function pickStartupPlan(
  mode: StartupMode,
  session: StartupSession,
  startupUrls: string[],
): StartupPlan {
  if (mode === 'restore' && session && session.windows.length > 0) return { kind: 'restore' };
  if (mode === 'urls') {
    const urls = sanitizeStartupUrls(startupUrls);
    if (urls.length > 0) return { kind: 'urls', urls };
  }
  return { kind: 'newtab' };
}
