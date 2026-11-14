import { describe, expect, it } from 'vitest';
import { fullscreenLayoutActive, tabOnScreen, type LayoutState } from '../tabs/panicLayout';

const state = (over: Partial<LayoutState> = {}): LayoutState => ({
  activeTabId: 'a',
  fullscreenTabId: null,
  panic: false,
  ...over,
});

describe('fullscreenLayoutActive', () => {
  it('follows the active tab that asked for fullscreen', () => {
    expect(fullscreenLayoutActive(state())).toBe(false);
    expect(fullscreenLayoutActive(state({ fullscreenTabId: 'a' }))).toBe(true);
  });

  it('is never on under panic: the chrome view paints the cover', () => {
    expect(fullscreenLayoutActive(state({ fullscreenTabId: 'a', panic: true }))).toBe(false);
  });

  it('comes back when panic is released over the same tab', () => {
    const during = state({ fullscreenTabId: 'a', panic: true });
    expect(fullscreenLayoutActive({ ...during, panic: false })).toBe(true);
  });

  it('does NOT come back over another tab (the user clicked away during panic)', () => {
    // Lived in review: a window-level flag hid the chrome over tab b, which
    // never asked for fullscreen and has no Escape to leave it.
    expect(fullscreenLayoutActive(state({ activeTabId: 'b', fullscreenTabId: 'a' }))).toBe(false);
  });

  it('returns with the tab that asked, when the user comes back to it', () => {
    const away = state({ activeTabId: 'b', fullscreenTabId: 'a' });
    expect(fullscreenLayoutActive({ ...away, activeTabId: 'a' })).toBe(true);
  });

  it('is off once the asking tab is gone, or with no tab at all', () => {
    expect(fullscreenLayoutActive(state({ activeTabId: 'b', fullscreenTabId: null }))).toBe(false);
    expect(fullscreenLayoutActive(state({ activeTabId: null, fullscreenTabId: null }))).toBe(false);
    expect(fullscreenLayoutActive(state({ activeTabId: null, fullscreenTabId: 'a' }))).toBe(false);
  });
});

describe('tabOnScreen', () => {
  it('only the active tab is laid out on screen', () => {
    expect(tabOnScreen('a', state())).toBe(true);
    expect(tabOnScreen('b', state())).toBe(false);
  });

  it('NO tab is on screen under panic, the active one included', () => {
    expect(tabOnScreen('a', state({ panic: true }))).toBe(false);
    expect(tabOnScreen('b', state({ panic: true }))).toBe(false);
    expect(tabOnScreen('a', state({ panic: true, fullscreenTabId: 'a' }))).toBe(false);
  });

  it('the active tab is back the moment panic is released', () => {
    expect(tabOnScreen('a', state({ panic: false }))).toBe(true);
  });
});
