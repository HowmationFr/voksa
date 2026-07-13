import { describe, it, expect } from 'vitest';
import {
  DEFAULT_STARTUP_MODE,
  MAX_STARTUP_URLS,
  isStartupMode,
  pickStartupPlan,
  sanitizeStartupUrls,
} from '../startup';

const session = (windows: number) => ({ windows: Array.from({ length: windows }, () => ({})) });

describe('startup mode', () => {
  it('defaults to the new tab page (a fresh profile does not restore what it never had)', () => {
    expect(DEFAULT_STARTUP_MODE).toBe('newtab');
  });

  it('recognises only the three modes', () => {
    expect(isStartupMode('newtab')).toBe(true);
    expect(isStartupMode('restore')).toBe(true);
    expect(isStartupMode('urls')).toBe(true);
    expect(isStartupMode('resume')).toBe(false);
    expect(isStartupMode(undefined)).toBe(false);
  });
});

describe('sanitizeStartupUrls', () => {
  it('trims, drops empties and duplicates, keeps order', () => {
    expect(sanitizeStartupUrls([' a.com ', '', '   ', 'b.com', 'a.com'])).toEqual([
      'a.com',
      'b.com',
    ]);
  });

  it('ignores non-strings and non-arrays (a hand-edited settings.json can say anything)', () => {
    expect(sanitizeStartupUrls([1, null, 'ok', {}])).toEqual(['ok']);
    expect(sanitizeStartupUrls('a.com')).toEqual([]);
    expect(sanitizeStartupUrls(undefined)).toEqual([]);
  });

  it('caps the list so a boot cannot open a thousand tabs', () => {
    const many = Array.from({ length: 100 }, (_, i) => `site${i}.com`);
    expect(sanitizeStartupUrls(many)).toHaveLength(MAX_STARTUP_URLS);
  });
});

describe('pickStartupPlan', () => {
  it("restores the previous session only in 'restore' mode", () => {
    expect(pickStartupPlan('restore', session(2), [])).toEqual({ kind: 'restore' });
    expect(pickStartupPlan('newtab', session(2), [])).toEqual({ kind: 'newtab' });
    expect(pickStartupPlan('urls', session(2), [])).toEqual({ kind: 'newtab' });
  });

  it('opens the configured pages', () => {
    expect(pickStartupPlan('urls', null, ['a.com', 'b.com'])).toEqual({
      kind: 'urls',
      urls: ['a.com', 'b.com'],
    });
  });

  it('never leaves the browser with nothing to open', () => {
    // Each of these would otherwise mean "restore/open nothing", i.e. a window
    // with no tab, or worse no window at all.
    expect(pickStartupPlan('restore', null, [])).toEqual({ kind: 'newtab' });
    expect(pickStartupPlan('restore', session(0), [])).toEqual({ kind: 'newtab' });
    expect(pickStartupPlan('urls', null, ['   '])).toEqual({ kind: 'newtab' });
  });
});
