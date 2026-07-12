import os from 'node:os';
import { allWindows } from '../windows';
import { getSettings } from '../storage/settings';
import { selectTabsToDiscard, type TabSnapshot } from '../../shared/memorySaver';
import type { AppWindow } from '../window';

/**
 * Memory Saver sweeps. Every tick it asks the pure policy module (which tabs
 * are cold enough to free, given the level, the exclusions and the machine's
 * memory pressure) and hands the verdict to the owning window's TabManager.
 *
 * All the decision-making lives in shared/memorySaver.ts precisely so it can
 * be unit-tested; this class only gathers the snapshot and applies the answer.
 */

/**
 * 1 minute. The shortest threshold is 5 min (maximum, under pressure), so the
 * grain overshoots by at most 20 % at the most aggressive level, and an
 * idle sweep is a handful of array operations.
 */
const TICK_MS = 60_000;

export class MemorySaverController {
  private timer: NodeJS.Timeout | null = null;

  /** Idempotent. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    // Never hold the process alive at quit.
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One sweep across every window. Public so it can be driven from a test. */
  tick(): void {
    const settings = getSettings();
    if (settings.memorySaver === 'off') return;

    // Tab ids are nanoid: unique across windows, so one flat map is enough to
    // find each victim's owner again.
    const owners = new Map<string, AppWindow>();
    const candidates: TabSnapshot[] = [];
    for (const win of allWindows()) {
      for (const candidate of win.tabs.discardCandidates()) {
        candidates.push(candidate);
        owners.set(candidate.id, win);
      }
    }
    if (candidates.length === 0) return;

    const victims = selectTabsToDiscard({
      level: settings.memorySaver,
      now: Date.now(),
      tabs: candidates,
      exceptions: settings.memorySaverExceptions,
      memory: { free: os.freemem(), total: os.totalmem() },
    });

    for (const id of victims) {
      owners.get(id)?.tabs.discard(id);
    }
  }
}

let instance: MemorySaverController | null = null;

export function getMemorySaver(): MemorySaverController {
  if (!instance) instance = new MemorySaverController();
  return instance;
}
