import { type WebContentsView } from 'electron';
import { IPC } from '../../shared/ipcChannels';

/**
 * Stream Mode v2: the curtain is now PURELY cosmetic (anti-flicker). The
 * zero-leak guarantee lives in the renderer "shroud" (page.ts injects
 * `html{opacity:0}` at document-start until the masker has swept), so the
 * curtain's only job is to freeze the previous, already-masked frame during a
 * navigation transition. Its failure mode is a neutral blank panel, never an
 * unmasked frame.
 *
 * Key differences vs v1:
 *  - The tab WebContentsView is NEVER moved off-screen. The opaque backdrop is
 *    painted in the chromeView which sits above the tab in z-order, so the tab
 *    is fully occluded without any bounds juggling (kills the resize / tab-
 *    switch / destroyed-view races).
 *  - Per-tab records keyed by tab id; UI acks and doc-ready are tab-scoped.
 *  - A doc-nonce pairs a raised curtain with the exact document that follows,
 *    so a stale ready from the previous page can't drop it early.
 *  - The safety timeout FAILS TO BLANK (clears the backdrop but the renderer
 *    shroud keeps the page hidden) instead of revealing an unmasked page.
 */

const SAFETY_TIMEOUT_MS = 6000;
const UI_ACK_TIMEOUT_MS = 600;

export type OverlayController = {
  acquire: (key: string) => void;
  release: (key: string) => void;
};

/** Hosts that never run the page masker → never curtain (would hang). */
export function isInternalUrl(url: string): boolean {
  if (!url) return true;
  try {
    const proto = new URL(url).protocol;
    return (
      proto === 'voksa:' ||
      // Legacy alias: pre-rename profiles can still surface hbb:// URLs
      // (old session/bookmark data before Tab.load canonicalizes them);
      // they name the same internal pages, which never run the masker, so
      // dropping the alias here would hang the curtain waiting for a ready.
      proto === 'hbb:' ||
      proto === 'about:' ||
      proto === 'chrome:' ||
      proto === 'devtools:' ||
      proto === 'chrome-extension:'
    );
  } catch {
    return url.startsWith('voksa://') || url.startsWith('hbb://') || url.startsWith('about:');
  }
}

type CurtainRecord = {
  token: number;
  expectedNonce: string | null;
  safetyTimer: NodeJS.Timeout;
};

export type BackdropKind = 'screenshot' | 'solid';

export class CurtainController {
  private records = new Map<string, CurtainRecord>();
  private ackResolvers = new Map<string, () => void>();
  private nextToken = 1;

  constructor(
    private readonly chromeView: WebContentsView,
    private readonly overlay: OverlayController,
  ) {}

  isActive(tabId: string): boolean {
    return this.records.has(tabId);
  }

  /**
   * Raise the curtain over a tab before/around a navigation. Awaits the UI's
   * paint ack so the backdrop is on-screen before the caller issues the load.
   */
  async raise(
    tabId: string,
    tabView: WebContentsView,
    kind: BackdropKind,
  ): Promise<void> {
    const token = this.nextToken++;

    let dataURL: string | null = null;
    if (kind === 'screenshot') {
      try {
        const image = await tabView.webContents.capturePage();
        if (!image.isEmpty()) dataURL = image.toDataURL({ scaleFactor: 1 });
      } catch {
        // capturePage can fail mid-navigation; fall back to a solid panel.
      }
    }

    this.overlay.acquire(this.overlayKey(tabId));
    await this.waitForAck(tabId, token, dataURL);

    const prev = this.records.get(tabId);
    if (prev) clearTimeout(prev.safetyTimer);
    this.records.set(tabId, {
      token,
      expectedNonce: null,
      safetyTimer: setTimeout(() => this.clear(tabId, token), SAFETY_TIMEOUT_MS),
    });
  }

  /** A new document started in this tab: pair the pending curtain to it. */
  onDocStart(tabId: string, nonce: string): void {
    const rec = this.records.get(tabId);
    if (rec && rec.expectedNonce == null) rec.expectedNonce = nonce;
  }

  /** The masker in this tab finished its initial sweep: drop the curtain. */
  onReady(tabId: string, nonce: string | null): void {
    const rec = this.records.get(tabId);
    if (!rec) return;
    // Only drop for the document this curtain was raised for (or any, if no
    // doc-start was ever paired, e.g. instant same-doc masking).
    if (rec.expectedNonce == null || nonce == null || rec.expectedNonce === nonce) {
      this.clear(tabId, rec.token);
    }
  }

  /** Force-drop (download started, stream toggled off, load failed). */
  drop(tabId: string): void {
    const rec = this.records.get(tabId);
    if (rec) this.clear(tabId, rec.token);
  }

  /** Tab closed while a curtain was up: no view ops, so nothing can throw. */
  handleTabClosed(tabId: string): void {
    const rec = this.records.get(tabId);
    if (rec) this.clear(tabId, rec.token);
  }

  /** The chrome UI confirmed the backdrop is painted. */
  ackFromUi(tabId: string, token: number): void {
    this.ackResolvers.get(this.ackKey(tabId, token))?.();
  }

  private waitForAck(tabId: string, token: number, dataURL: string | null): Promise<void> {
    return new Promise((resolve) => {
      const key = this.ackKey(tabId, token);
      const done = () => {
        this.ackResolvers.delete(key);
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, UI_ACK_TIMEOUT_MS);
      this.ackResolvers.set(key, done);
      try {
        this.chromeView.webContents.send(IPC.CURTAIN_SET, { tabId, token, backdrop: dataURL });
      } catch {
        done();
      }
    });
  }

  private clear(tabId: string, token: number): void {
    const rec = this.records.get(tabId);
    if (!rec || rec.token !== token) return;
    clearTimeout(rec.safetyTimer);
    this.records.delete(tabId);
    this.overlay.release(this.overlayKey(tabId));
    try {
      this.chromeView.webContents.send(IPC.CURTAIN_CLEAR, { tabId });
    } catch {
      // chromeView destroyed during teardown; ignore
    }
  }

  private overlayKey(tabId: string): string {
    return `curtain:${tabId}`;
  }
  private ackKey(tabId: string, token: number): string {
    return `${tabId}:${token}`;
  }
}
