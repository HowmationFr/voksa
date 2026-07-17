import { describe, it, expect } from 'vitest';
import {
  DEFAULT_MEMORY_SAVER,
  activeThresholdMs,
  freeMemoryRatio,
  isExceptedHost,
  isProtected,
  selectTabsToDiscard,
  type MemorySaverLevel,
  type PolicyInput,
  type TabSnapshot,
} from '../memorySaver';

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;

/** A plain background tab, idle for `idleMin` minutes, discardable by default. */
function tab(id: string, idleMin: number, over: Partial<TabSnapshot> = {}): TabSnapshot {
  return {
    id,
    lastActiveAt: NOW - idleMin * MINUTE,
    isActive: false,
    isAudible: false,
    isMuted: false,
    isInternal: false,
    isPinned: false,
    isDiscarded: false,
    isLoading: false,
    hasCurtain: false,
    host: 'example.com',
    ...over,
  };
}

/** Roomy machine: 8 GB free out of 16 GB (50% free, no pressure at any level). */
const RELAXED = { free: 8e9, total: 16e9 };
/** Squeezed machine: 1.6 GB free out of 16 GB (10% free, pressure everywhere). */
const TIGHT = { free: 1.6e9, total: 16e9 };

function run(over: Partial<PolicyInput>): string[] {
  return selectTabsToDiscard({
    level: 'balanced',
    now: NOW,
    tabs: [],
    exceptions: [],
    memory: RELAXED,
    ...over,
  });
}

describe('default level', () => {
  it('is balanced (Chrome-like: on out of the box)', () => {
    expect(DEFAULT_MEMORY_SAVER).toBe('balanced');
  });
});

describe('freeMemoryRatio', () => {
  it('reports the free fraction', () => {
    expect(freeMemoryRatio({ free: 4e9, total: 16e9 })).toBeCloseTo(0.25);
  });

  it('reports no pressure when the total is unusable (never discard on bad data)', () => {
    expect(freeMemoryRatio({ free: 0, total: 0 })).toBe(1);
    expect(freeMemoryRatio({ free: 1, total: Number.NaN })).toBe(1);
  });

  it('clamps to 0..1', () => {
    expect(freeMemoryRatio({ free: 32e9, total: 16e9 })).toBe(1);
    expect(freeMemoryRatio({ free: -1, total: 16e9 })).toBe(0);
  });
});

describe('isExceptedHost', () => {
  it('matches the exact host', () => {
    expect(isExceptedHost('example.com', ['example.com'])).toBe(true);
  });

  it('covers subdomains of a listed domain', () => {
    expect(isExceptedHost('app.example.com', ['example.com'])).toBe(true);
    expect(isExceptedHost('a.b.example.com', ['example.com'])).toBe(true);
  });

  it('does not match a different domain that merely ends the same', () => {
    expect(isExceptedHost('notexample.com', ['example.com'])).toBe(false);
    expect(isExceptedHost('example.com.evil.net', ['example.com'])).toBe(false);
  });

  it('tolerates what a user actually types (scheme, www, path, case, spaces)', () => {
    for (const entry of ['https://Example.com/', ' www.example.com ', 'EXAMPLE.COM']) {
      expect(isExceptedHost('example.com', [entry]), entry).toBe(true);
    }
    expect(isExceptedHost('www.example.com', ['example.com'])).toBe(true);
  });

  it('ignores empty entries and an unknown host', () => {
    expect(isExceptedHost('example.com', ['', '   '])).toBe(false);
    expect(isExceptedHost('', ['example.com'])).toBe(false);
  });

  it('ignores the port on BOTH sides (a tab host carries it, what users type does not)', () => {
    // Tab.host() comes from URL.host, which keeps the port: without stripping
    // it, a dev server a user explicitly protected would still be discarded.
    expect(isExceptedHost('localhost:3000', ['localhost'])).toBe(true);
    expect(isExceptedHost('localhost', ['localhost:3000'])).toBe(true);
    expect(isExceptedHost('app.example.com:8443', ['example.com'])).toBe(true);
  });
});

describe('isProtected: the tabs that may never be freed', () => {
  it('protects the active tab, audible and muted tabs, internal pages, loading tabs, curtained tabs, and already-freed tabs', () => {
    expect(isProtected(tab('a', 999, { isActive: true }), [])).toBe(true);
    expect(isProtected(tab('a', 999, { isAudible: true }), [])).toBe(true);
    // A muted tab is a parked media tab: a muted video keeps playing and is
    // never "audible", so muting must protect it too.
    expect(isProtected(tab('a', 999, { isMuted: true }), [])).toBe(true);
    expect(isProtected(tab('a', 999, { isInternal: true }), [])).toBe(true);
    expect(isProtected(tab('a', 999, { isLoading: true }), [])).toBe(true);
    expect(isProtected(tab('a', 999, { hasCurtain: true }), [])).toBe(true);
    expect(isProtected(tab('a', 999, { isDiscarded: true }), [])).toBe(true);
  });

  it('protects a pinned tab: pinning is the explicit "keep this hot" gesture', () => {
    expect(isProtected(tab('a', 999, { isPinned: true }), [])).toBe(true);
  });

  it('protects an excepted host', () => {
    expect(isProtected(tab('a', 999, { host: 'mail.example.com' }), ['example.com'])).toBe(true);
  });

  it('leaves a plain idle background tab discardable', () => {
    expect(isProtected(tab('a', 999), [])).toBe(false);
  });
});

describe('selectTabsToDiscard: safety exclusions win at every level', () => {
  const LEVELS: MemorySaverLevel[] = ['moderate', 'balanced', 'maximum'];

  it('never frees a protected tab, however idle, however tight the memory', () => {
    for (const level of LEVELS) {
      const picked = run({
        level,
        memory: TIGHT,
        tabs: [
          tab('active', 999, { isActive: true }),
          tab('audible', 999, { isAudible: true }),
          tab('muted', 999, { isMuted: true }),
          tab('internal', 999, { isInternal: true }),
          tab('loading', 999, { isLoading: true }),
          tab('curtained', 999, { hasCurtain: true }),
          tab('gone', 999, { isDiscarded: true }),
          tab('kept', 999, { host: 'keepme.com' }),
        ],
        exceptions: ['keepme.com'],
      });
      expect(picked, level).toEqual([]);
    }
  });

  it("'off' never frees anything, even a tab idle for days on a starved machine", () => {
    expect(run({ level: 'off', memory: TIGHT, tabs: [tab('a', 60 * 24)] })).toEqual([]);
  });
});

describe('selectTabsToDiscard: moderate', () => {
  it('does nothing while the machine has room, whatever the idle time', () => {
    expect(run({ level: 'moderate', memory: RELAXED, tabs: [tab('a', 60 * 24)] })).toEqual([]);
  });

  it('frees tabs idle past 30 min once memory is genuinely short', () => {
    const picked = run({
      level: 'moderate',
      memory: TIGHT,
      tabs: [tab('fresh', 29), tab('stale', 31)],
    });
    expect(picked).toEqual(['stale']);
  });
});

describe('selectTabsToDiscard: balanced', () => {
  it('frees after 2 h of inactivity on a roomy machine', () => {
    const picked = run({
      level: 'balanced',
      memory: RELAXED,
      tabs: [tab('recent', 119), tab('old', 121)],
    });
    expect(picked).toEqual(['old']);
  });

  it('drops to 20 min under memory pressure', () => {
    const picked = run({
      level: 'balanced',
      memory: TIGHT,
      tabs: [tab('fresh', 19), tab('stale', 21)],
    });
    expect(picked).toEqual(['stale']);
  });
});

describe('selectTabsToDiscard: maximum', () => {
  it('frees after 15 min of inactivity', () => {
    const picked = run({
      level: 'maximum',
      memory: RELAXED,
      tabs: [tab('fresh', 14), tab('stale', 16)],
    });
    expect(picked).toEqual(['stale']);
  });

  it('drops to 5 min under memory pressure', () => {
    const picked = run({
      level: 'maximum',
      memory: TIGHT,
      tabs: [tab('fresh', 4), tab('stale', 6)],
    });
    expect(picked).toEqual(['stale']);
  });

  it('is strictly more aggressive than balanced, which is more aggressive than moderate', () => {
    const tabs = [tab('a', 20)];
    expect(run({ level: 'maximum', memory: RELAXED, tabs })).toEqual(['a']);
    expect(run({ level: 'balanced', memory: RELAXED, tabs })).toEqual([]);
    expect(run({ level: 'moderate', memory: RELAXED, tabs })).toEqual([]);
  });
});

describe('selectTabsToDiscard: sweep ordering and cap', () => {
  it('frees the coldest tabs first', () => {
    const picked = run({
      level: 'maximum',
      memory: RELAXED,
      tabs: [tab('warm', 20), tab('coldest', 300), tab('cold', 120)],
    });
    expect(picked).toEqual(['coldest', 'cold', 'warm']);
  });

  it('caps how many tabs one sweep frees (a dozen teardowns at once stutters the app)', () => {
    // Idle past the longest threshold (balanced = 2 h), so every level would
    // otherwise take all twelve.
    const many = Array.from({ length: 12 }, (_, i) => tab(`t${i}`, 130 + i));
    // maximum allows 5 per sweep, balanced 3.
    expect(run({ level: 'maximum', memory: RELAXED, tabs: many })).toHaveLength(5);
    expect(run({ level: 'balanced', memory: RELAXED, tabs: many })).toHaveLength(3);
  });

  it('breaks ties deterministically by id', () => {
    const picked = run({
      level: 'maximum',
      memory: RELAXED,
      tabs: [tab('b', 60), tab('a', 60), tab('c', 60)],
    });
    expect(picked).toEqual(['a', 'b', 'c']);
  });
});

describe('activeThresholdMs', () => {
  it('has no threshold when off, or when moderate has no pressure to react to', () => {
    expect(activeThresholdMs('off', TIGHT)).toBeNull();
    expect(activeThresholdMs('moderate', RELAXED)).toBeNull();
  });

  it('reports the shortened threshold under pressure', () => {
    expect(activeThresholdMs('balanced', RELAXED)).toBe(120 * MINUTE);
    expect(activeThresholdMs('balanced', TIGHT)).toBe(20 * MINUTE);
    expect(activeThresholdMs('maximum', TIGHT)).toBe(5 * MINUTE);
  });
});
