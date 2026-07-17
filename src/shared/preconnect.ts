/**
 * Preconnect policy: WHICH origins are worth warming, and how often.
 *
 * What this is, precisely: Chrome's "standard preloading" tier, which is DNS
 * pre-resolution plus a TCP+TLS handshake, and nothing else. Chrome's extended
 * tier (prefetching and prerendering pages a predictor thinks you will visit)
 * has NO honest implementation here: that machinery lives in the Chrome layer,
 * not in Chromium, so Electron does not expose it. No API, no flag, no
 * preference. We do not fake it, and the setting does not use the word
 * "preload": nothing is preloaded, no page is downloaded ahead of time.
 *
 * Pure module (no Electron, no clock): the controller feeds it a URL and a
 * timestamp and acts on the verdict, which keeps the whole decision testable.
 */

export type HintStrength = 'resolve' | 'preconnect';

export type HintTarget = {
  /** scheme://host[:port] : never a path, a query or credentials. */
  origin: string;
  host: string;
};

/** Same origin, at the same strength, at most once per minute. */
export const HINT_TTL_MS = 60_000;
/** A cursor sweeping down a link list must not open a socket per link. */
export const HINT_MAX_PER_WINDOW = 30;
export const HINT_WINDOW_MS = 60_000;
/** Bound on the tracking map: a long session must not grow it forever. */
export const HINT_MAX_TRACKED = 200;

/**
 * The origin worth warming for `rawUrl`, or null.
 *
 * Only http(s): warming voksa://, file:, data:, blob:, mailto: or a
 * chrome-extension:// origin is meaningless. The path, query, fragment and any
 * credentials are dropped: a connection needs an origin, and keeping the rest
 * would mean holding on to the exact page a user merely hovered.
 */
export function hintTargetFor(rawUrl: string): HintTarget | null {
  if (!rawUrl) return null;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.hostname) return null;
  return { origin: url.origin, host: url.hostname };
}

type Entry = { strength: HintStrength; at: number };

/**
 * Dedupe + throttle. Deliberately a class with an injected clock rather than a
 * module-level Map: two tests must not share state, and `now` must not be read
 * from a real clock.
 */
export class PreconnectBudget {
  private readonly seen = new Map<string, Entry>();
  private recent: number[] = [];

  /**
   * The target to warm, or null when the hint is not worth acting on.
   *
   * An origin already warmed at the SAME or a STRONGER level within the TTL is
   * skipped. The upgrade resolve -> preconnect is allowed (a hovered link
   * deserves a socket even if the omnibox only resolved its name); the reverse
   * is not (the socket is already open, resolving the name again buys nothing).
   */
  admit(rawUrl: string, strength: HintStrength, now: number): HintTarget | null {
    const target = hintTargetFor(rawUrl);
    if (!target) return null;

    const previous = this.seen.get(target.origin);
    if (previous && now - previous.at < HINT_TTL_MS) {
      const isUpgrade = previous.strength === 'resolve' && strength === 'preconnect';
      if (!isUpgrade) return null;
    }

    this.recent = this.recent.filter((at) => now - at < HINT_WINDOW_MS);
    if (this.recent.length >= HINT_MAX_PER_WINDOW) return null;

    this.recent.push(now);
    this.seen.set(target.origin, { strength, at: now });
    if (this.seen.size > HINT_MAX_TRACKED) {
      // Map iterates in insertion order: the oldest key is the first one.
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    return target;
  }

  /** Forget everything (the user cleared their browsing data). */
  clear(): void {
    this.seen.clear();
    this.recent = [];
  }

  /** Test seam: how many origins are currently tracked. */
  get size(): number {
    return this.seen.size;
  }
}
