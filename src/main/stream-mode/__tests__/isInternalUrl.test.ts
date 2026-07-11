import { describe, it, expect } from 'vitest';
import { isInternalUrl } from '../curtain';

describe('isInternalUrl', () => {
  it('treats internal schemes as internal', () => {
    for (const u of [
      'voksa://newtab',
      'about:blank',
      'chrome://settings',
      'devtools://devtools/bundled/inspector.html',
      'chrome-extension://abc/options.html',
    ]) {
      expect(isInternalUrl(u)).toBe(true);
    }
  });

  it('keeps treating the legacy hbb:// alias as internal (pre-rename profiles)', () => {
    // Old session/bookmark data can still surface hbb:// URLs; they name the
    // same internal pages and must never be curtained (would hang waiting
    // for a masker that never runs).
    expect(isInternalUrl('hbb://newtab')).toBe(true);
    expect(isInternalUrl('hbb://settings')).toBe(true);
  });

  it('treats real web pages as external (maskable + curtainable)', () => {
    for (const u of ['https://example.com', 'http://example.com/path', 'https://youtube.com']) {
      expect(isInternalUrl(u)).toBe(false);
    }
  });

  it('does NOT let a spoofed localhost host bypass the curtain', () => {
    // The v1 prefix check treated these as internal → curtain/shroud bypass.
    expect(isInternalUrl('http://localhost.evil.com')).toBe(false);
    expect(isInternalUrl('http://127.0.0.1.evil.com')).toBe(false);
  });

  it('empty / garbage is internal (fail-safe: no curtain)', () => {
    expect(isInternalUrl('')).toBe(true);
  });
});
