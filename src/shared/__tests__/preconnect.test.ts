import { describe, it, expect } from 'vitest';
import {
  HINT_MAX_PER_WINDOW,
  HINT_MAX_TRACKED,
  HINT_TTL_MS,
  HINT_WINDOW_MS,
  PreconnectBudget,
  hintTargetFor,
} from '../preconnect';

const NOW = 1_800_000_000_000;

describe('hintTargetFor', () => {
  it('accepts http(s) and keeps the origin only', () => {
    expect(hintTargetFor('https://example.com/path?q=secret#frag')).toEqual({
      origin: 'https://example.com',
      host: 'example.com',
    });
    expect(hintTargetFor('http://example.com:8080/x')?.origin).toBe('http://example.com:8080');
  });

  it('never keeps the page: the path, query, fragment and credentials are dropped', () => {
    // A hover is not a visit. Holding the full URL of a link the user merely
    // pointed at would be keeping something we have no business keeping.
    const target = hintTargetFor('https://user:pw@example.com/private/doc?token=abc');
    expect(target?.origin).toBe('https://example.com');
    expect(JSON.stringify(target)).not.toContain('private');
    expect(JSON.stringify(target)).not.toContain('token');
    expect(JSON.stringify(target)).not.toContain('pw');
  });

  it('rejects every scheme there would be nothing to connect to', () => {
    for (const url of [
      'voksa://settings',
      'file:///c:/x.html',
      'data:text/html,hi',
      'blob:https://x.com/1',
      'javascript:alert(1)',
      'about:blank',
      'mailto:a@b.com',
      'chrome-extension://abc/popup.html',
      'not a url',
      '',
    ]) {
      expect(hintTargetFor(url), url).toBeNull();
    }
  });
});

describe('PreconnectBudget', () => {
  it('warms an origin once, then holds off for the TTL', () => {
    const b = new PreconnectBudget();
    expect(b.admit('https://a.com/1', 'preconnect', NOW)?.origin).toBe('https://a.com');
    expect(b.admit('https://a.com/2', 'preconnect', NOW + 1_000)).toBeNull();
    expect(b.admit('https://a.com/3', 'preconnect', NOW + HINT_TTL_MS)?.origin).toBe(
      'https://a.com',
    );
  });

  it('treats origins independently', () => {
    const b = new PreconnectBudget();
    expect(b.admit('https://a.com', 'preconnect', NOW)).not.toBeNull();
    expect(b.admit('https://b.com', 'preconnect', NOW)).not.toBeNull();
    expect(b.admit('http://a.com', 'preconnect', NOW)).not.toBeNull(); // different scheme
  });

  it('upgrades resolve -> preconnect, but never downgrades', () => {
    // Hovering a link the omnibox only DNS-resolved deserves a real socket.
    const up = new PreconnectBudget();
    expect(up.admit('https://a.com', 'resolve', NOW)).not.toBeNull();
    expect(up.admit('https://a.com', 'preconnect', NOW + 1)).not.toBeNull();

    // The reverse buys nothing: the socket is already open.
    const down = new PreconnectBudget();
    expect(down.admit('https://a.com', 'preconnect', NOW)).not.toBeNull();
    expect(down.admit('https://a.com', 'resolve', NOW + 1)).toBeNull();
  });

  it('caps how many origins one minute may warm (a cursor sweeping a link list)', () => {
    const b = new PreconnectBudget();
    for (let i = 0; i < HINT_MAX_PER_WINDOW; i++) {
      expect(b.admit(`https://s${i}.com`, 'preconnect', NOW), `#${i}`).not.toBeNull();
    }
    expect(b.admit('https://over.com', 'preconnect', NOW)).toBeNull();
    // ...and the window slides.
    expect(b.admit('https://over.com', 'preconnect', NOW + HINT_WINDOW_MS)).not.toBeNull();
  });

  it('bounds the tracking map over a long session', () => {
    const b = new PreconnectBudget();
    for (let i = 0; i < HINT_MAX_TRACKED + 50; i++) {
      // Spread the hints so the per-window cap is not what stops us.
      b.admit(`https://s${i}.com`, 'preconnect', NOW + i * HINT_WINDOW_MS);
    }
    expect(b.size).toBeLessThanOrEqual(HINT_MAX_TRACKED);
  });

  it('rejects ineligible URLs without spending budget', () => {
    const b = new PreconnectBudget();
    for (let i = 0; i < 100; i++) b.admit('voksa://settings', 'preconnect', NOW);
    expect(b.admit('https://a.com', 'preconnect', NOW)).not.toBeNull();
  });

  it('forgets everything on clear (browsing data wiped)', () => {
    const b = new PreconnectBudget();
    b.admit('https://a.com', 'preconnect', NOW);
    b.clear();
    expect(b.size).toBe(0);
    expect(b.admit('https://a.com', 'preconnect', NOW + 1)).not.toBeNull();
  });
});
