import { session } from 'electron';
import { getSettings } from '../storage/settings';
import { getStreamMode } from '../stream-mode/StreamModeController';
import { PreconnectBudget, type HintStrength } from '../../shared/preconnect';

/**
 * Warms the connection to sites the user is about to open: a hovered link, the
 * top address-bar suggestion, the default search engine.
 *
 * Two Electron APIs do the actual work, and they are the ONLY ones that exist
 * for this: `session.resolveHost()` (DNS) and `session.preconnect()`
 * (TCP + TLS). There is no prefetch and no prerender API in Electron, because
 * Chrome's preloading machinery lives in the Chrome layer rather than in
 * Chromium. So this warms connections and downloads nothing, which is exactly
 * what the setting says it does.
 *
 * The session is `defaultSession` on purpose: tabs use it too (Tab.createView
 * takes no partition), so the socket pool and DNS cache warmed here are the
 * very ones the navigation will draw from. Warming any other session would be
 * theatre.
 *
 * OFF under Stream Mode, and that is not superstition. The status bubble is
 * already suppressed while streaming so that a hovered URL "never leaves the
 * main process" (handlers.ts), and Stream Mode's stated threat model names
 * destination URLs. Warming a link the user merely pointed at emits a DNS query
 * and a TLS ClientHello carrying that host in the SNI: the URL would leave the
 * process after all, for pages they never even open. No viewer of the shared
 * screen would see it, but the promise Voksa makes would stop being true, and a
 * promise with an asterisk is not a promise. The cost is a little speed while
 * streaming; the invariant is worth more.
 */
export class PreconnectController {
  private readonly budget = new PreconnectBudget();

  hint(rawUrl: string, strength: HintStrength): void {
    if (!getSettings().preconnect) return;
    if (getStreamMode().getConfig().enabled) return;

    const target = this.budget.admit(rawUrl, strength, Date.now());
    if (!target) return;

    try {
      const ses = session.defaultSession;
      if (strength === 'preconnect') {
        ses.preconnect({ url: target.origin, numSockets: 1 });
      } else {
        // resolveHost REJECTS on NXDOMAIN or with the network down. An
        // unhandled rejection in main would be a crash for a speculative hint.
        void ses.resolveHost(target.host).catch(() => undefined);
      }
    } catch {
      // A speculative optimisation is never allowed to break navigation.
    }
  }

  /** The user cleared their browsing data: forget which origins we warmed. */
  clear(): void {
    this.budget.clear();
  }
}

let instance: PreconnectController | null = null;

export function getPreconnect(): PreconnectController {
  if (!instance) instance = new PreconnectController();
  return instance;
}
