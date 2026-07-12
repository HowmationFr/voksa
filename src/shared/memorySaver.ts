/**
 * Memory Saver policy: WHICH background tabs should have their renderer freed.
 *
 * Pure module (no Electron, no clock, no OS): the main-process controller
 * feeds it a snapshot and applies the verdict. That keeps the only part with
 * real decision-making fully unit-testable, which matters because a wrong
 * verdict here is felt directly by the user (a tab reloading under their
 * fingers, or a video muted-but-playing being killed).
 *
 * Chrome semantics we mirror:
 *  - 'moderate' only acts when the machine is genuinely short on memory;
 *  - 'balanced' mixes a long inactivity timeout with memory pressure;
 *  - 'maximum' frees aggressively after a short inactivity.
 */

export type MemorySaverLevel = 'off' | 'moderate' | 'balanced' | 'maximum';

export const MEMORY_SAVER_LEVELS: readonly MemorySaverLevel[] = [
  'off',
  'moderate',
  'balanced',
  'maximum',
];

export const DEFAULT_MEMORY_SAVER: MemorySaverLevel = 'balanced';

/** What the controller knows about one tab at sweep time. */
export type TabSnapshot = {
  id: string;
  /** Epoch ms of the last time this tab was the active one (or was created). */
  lastActiveAt: number;
  /** Active tab of ITS window: never discarded, whichever window has focus. */
  isActive: boolean;
  /** Playing sound right now: never discarded. */
  isAudible: boolean;
  /**
   * Muted BY THE USER. Excluded too: a deliberately muted tab is almost always
   * a media tab someone parked on purpose (a muted video keeps playing and is
   * not audible), and killing it would lose the playback position.
   */
  isMuted: boolean;
  /** voksa:// page: rendered by the chrome UI, holds no page to free. */
  isInternal: boolean;
  /** Already freed: nothing left to do. */
  isDiscarded: boolean;
  /** Mid-navigation: discarding now would race the load. */
  isLoading: boolean;
  /**
   * A Stream Mode curtain is up over this tab. Tearing the tab down under it
   * churns the window's overlay refcount for nothing; the next sweep will get
   * it once the curtain dropped.
   */
  hasCurtain: boolean;
  /** Hostname, matched against the exception list. Empty when unknown. */
  host: string;
};

export type SystemMemory = {
  /** Bytes of free physical memory. */
  free: number;
  /** Bytes of total physical memory. */
  total: number;
};

export type PolicyInput = {
  level: MemorySaverLevel;
  /** Epoch ms. Passed in, never read from a clock, so tests are deterministic. */
  now: number;
  tabs: TabSnapshot[];
  /** Hosts the user never wants freed (exact host or parent domain). */
  exceptions: string[];
  memory: SystemMemory;
};

const MINUTE = 60_000;

/**
 * Per-level rules. `idleMs` is the plain inactivity timeout; `pressureIdleMs`
 * (when set) is the shorter timeout that applies only while free memory is
 * below `pressureBelow` (a fraction of total). A level with no `idleMs` only
 * ever acts under pressure.
 */
const RULES: Record<
  Exclude<MemorySaverLevel, 'off'>,
  {
    idleMs: number | null;
    pressureIdleMs: number | null;
    pressureBelow: number;
    /**
     * Teardowns per sweep. Closing a dozen webContents in one tick stutters
     * the main process; spreading them over successive sweeps is invisible.
     */
    maxPerSweep: number;
  }
> = {
  // Barely noticeable: only when the machine actually needs the memory.
  moderate: { idleMs: null, pressureIdleMs: 30 * MINUTE, pressureBelow: 0.2, maxPerSweep: 3 },
  // Chrome's default trade-off: a long timeout, shortened under pressure.
  balanced: { idleMs: 120 * MINUTE, pressureIdleMs: 20 * MINUTE, pressureBelow: 0.3, maxPerSweep: 3 },
  // Aggressive: a background tab is fair game after a short while.
  maximum: { idleMs: 15 * MINUTE, pressureIdleMs: 5 * MINUTE, pressureBelow: 0.3, maxPerSweep: 5 },
};

/** Free memory as a fraction of total; 1 (no pressure) when total is unknown. */
export function freeMemoryRatio(memory: SystemMemory): number {
  if (!Number.isFinite(memory.total) || memory.total <= 0) return 1;
  const ratio = memory.free / memory.total;
  if (!Number.isFinite(ratio)) return 1;
  return Math.min(1, Math.max(0, ratio));
}

/**
 * True when `host` is protected by the exception list. Matches the exact host
 * and any subdomain of a listed domain ('example.com' covers 'app.example.com'),
 * which is what a user typing a site name expects.
 */
export function isExceptedHost(host: string, exceptions: string[]): boolean {
  if (!host) return false;
  const target = normalizeHost(host);
  if (!target) return false;
  for (const raw of exceptions) {
    const entry = normalizeHost(raw);
    if (!entry) continue;
    if (target === entry || target.endsWith(`.${entry}`)) return true;
  }
  return false;
}

/**
 * A host as the exception list compares it. The PORT is dropped on both sides:
 * a tab's host() comes from URL.host, which carries it ("localhost:3000"), so
 * a user who typed "localhost" would otherwise never protect anything. The
 * scheme, a www. prefix and a path are stripped too, because those are what
 * people actually paste.
 */
function normalizeHost(raw: unknown): string {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '')
    .replace(/^www\./, '');
}

/**
 * Tabs that may NEVER be discarded, whatever the level. Split out from the
 * timing rules so the safety net is readable on its own and can be asserted
 * directly in tests: these exclusions are the difference between a feature
 * and a bug report.
 */
export function isProtected(tab: TabSnapshot, exceptions: string[]): boolean {
  return (
    tab.isActive ||
    tab.isAudible ||
    tab.isMuted ||
    tab.isInternal ||
    tab.isDiscarded ||
    tab.isLoading ||
    tab.hasCurtain ||
    isExceptedHost(tab.host, exceptions)
  );
}

/**
 * Ids of the tabs whose renderer should be freed now, least-recently-active
 * first (the coldest tab is the cheapest to lose) and capped per sweep.
 */
export function selectTabsToDiscard(input: PolicyInput): string[] {
  if (input.level === 'off') return [];
  const rule = RULES[input.level];
  const underPressure = freeMemoryRatio(input.memory) < rule.pressureBelow;

  const threshold =
    underPressure && rule.pressureIdleMs !== null
      ? rule.idleMs === null
        ? rule.pressureIdleMs
        : Math.min(rule.idleMs, rule.pressureIdleMs)
      : rule.idleMs;
  // 'moderate' with no pressure: nothing to do.
  if (threshold === null) return [];

  return input.tabs
    .filter((tab) => !isProtected(tab, input.exceptions))
    .filter((tab) => input.now - tab.lastActiveAt >= threshold)
    // Ties broken by id so a sweep is deterministic (and testable).
    .sort((a, b) => a.lastActiveAt - b.lastActiveAt || (a.id < b.id ? -1 : 1))
    .slice(0, rule.maxPerSweep)
    .map((tab) => tab.id);
}

/** Human-readable idle threshold of a level right now (for the settings UI). */
export function activeThresholdMs(
  level: MemorySaverLevel,
  memory: SystemMemory,
): number | null {
  if (level === 'off') return null;
  const rule = RULES[level];
  const underPressure = freeMemoryRatio(memory) < rule.pressureBelow;
  if (underPressure && rule.pressureIdleMs !== null) {
    return rule.idleMs === null ? rule.pressureIdleMs : Math.min(rule.idleMs, rule.pressureIdleMs);
  }
  return rule.idleMs;
}
