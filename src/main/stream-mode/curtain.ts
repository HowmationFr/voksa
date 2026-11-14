import { type WebContentsView } from 'electron';
import { IPC } from '../../shared/ipcChannels';
import { PANIC_CURTAIN_ID } from '../../shared/panicCurtain';

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
/**
 * The screenshot is cosmetic and the caller's navigation waits on raise():
 * past this, the curtain goes up with the solid panel instead. capturePage has
 * no timeout of its own (Electron hands Chromium a zero timeout, and the copy
 * request then waits for the tab's NEXT frame, which a view that is not
 * producing frames may never send): unbounded, it stalled the navigation
 * itself, with no curtain and no load.
 */
const CAPTURE_TIMEOUT_MS = 300;
/**
 * The panic cover is repeated at this pace until the chrome UI acknowledges
 * it. A navigation curtain can afford to be lost (the shroud holds the page);
 * this one cannot, and a chrome UI that is still booting (a window opened
 * while panic is up) has no listener yet.
 */
const PANIC_RESEND_MS = 100;
/**
 * ...and for this many times at most (5 s). The repeat is for the boot race,
 * which is over in a few hundred ms. Past that, a UI that has not acknowledged
 * is not deaf, it is hidden: the ack rides on requestAnimationFrame, which a
 * minimized window does not run (and panic is a GLOBAL hotkey, often pressed
 * with Voksa minimized behind a game). Such a UI already holds the cover in
 * its state and paints it the moment it is shown; repeating to it forever
 * would only queue frames callbacks until then.
 */
const PANIC_MAX_RESENDS = 50;
/** Overlay refcount key of the panic cover (the navigation ones are per tab). */
const PANIC_OVERLAY_KEY = 'panic';

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
  /** The UI was handed a screenshot backdrop (panic turns it solid). */
  screenshot?: boolean;
};

export type BackdropKind = 'screenshot' | 'solid';

export class CurtainController {
  private records = new Map<string, CurtainRecord>();
  private ackResolvers = new Map<string, () => void>();
  private nextToken = 1;
  /** Token of the panic cover while it is up, null otherwise. */
  private panicToken: number | null = null;
  private panicAcked = false;
  private panicResend: NodeJS.Timeout | null = null;
  private panicResendsLeft = 0;

  constructor(
    private readonly chromeView: WebContentsView,
    private readonly overlay: OverlayController,
  ) {
    // A chrome UI document that (re)loads starts with an empty store: under
    // panic it must be handed the cover again, or main would believe in a
    // cover nobody paints. Also what covers a window whose UI was still
    // loading when panic was pressed.
    chromeView.webContents.on('did-finish-load', () => {
      if (this.panicToken === null) return;
      this.stopPanicResend();
      this.panicAcked = false;
      this.panicResendsLeft = PANIC_MAX_RESENDS;
      this.sendPanicCover();
    });
  }

  // --- Panic cover ------------------------------------------------------------
  //
  // NOT a navigation curtain, and deliberately outside `records`. A navigation
  // curtain is cosmetic: it lifts on the masker's ready, on a failed load, on
  // the 6s fail-to-blank timer, because the renderer shroud is what actually
  // hides the page. Panic covers pages that are ALREADY painted, with no
  // shroud behind the panel, so each of those exits would put back on screen
  // exactly what the user panicked about. (Lived: panic used to raise ordinary
  // curtains. They dropped after 6s with Stream Mode on, and within
  // milliseconds when panic itself armed it, since arming makes every tab's
  // masker sweep and send a ready.)
  //
  // So: one solid cover per WINDOW, keyed by a sentinel instead of a tab id
  // (it also covers tabs created or revived while it is up), with a single way
  // down, setPanic(false).

  isPanic(): boolean {
    return this.panicToken !== null;
  }

  setPanic(on: boolean): void {
    if (on) {
      if (this.panicToken !== null) return;
      this.panicToken = this.nextToken++;
      this.panicAcked = false;
      this.panicResendsLeft = PANIC_MAX_RESENDS;
      this.overlay.acquire(PANIC_OVERLAY_KEY);
      this.sendPanicCover();
      // A navigation curtain already painted with a screenshot keeps that
      // frame in the UI, where it would resurface when panic is released:
      // repaint it solid. Same curtain, same token; only the backdrop goes.
      for (const [tabId, rec] of this.records) {
        if (!rec.screenshot) continue;
        rec.screenshot = false;
        try {
          this.chromeView.webContents.send(IPC.CURTAIN_SET, {
            tabId,
            token: rec.token,
            backdrop: null,
          });
        } catch {
          // chromeView destroyed during teardown; ignore
        }
      }
      return;
    }
    if (this.panicToken === null) return;
    this.panicToken = null;
    this.stopPanicResend();
    this.overlay.release(PANIC_OVERLAY_KEY);
    try {
      this.chromeView.webContents.send(IPC.CURTAIN_CLEAR, { tabId: PANIC_CURTAIN_ID });
    } catch {
      // chromeView destroyed during teardown; ignore
    }
  }

  private sendPanicCover(): void {
    const token = this.panicToken;
    if (token === null) return;
    try {
      this.chromeView.webContents.send(IPC.CURTAIN_SET, {
        tabId: PANIC_CURTAIN_ID,
        token,
        backdrop: null,
      });
    } catch {
      // chromeView destroyed: nothing left to cover, and nothing to repeat to.
      return;
    }
    // The ack may already be in (it is synchronous in tests).
    if (this.panicAcked || this.panicResendsLeft <= 0) return;
    this.panicResendsLeft -= 1;
    this.panicResend = setTimeout(() => {
      this.panicResend = null;
      if (!this.panicAcked) this.sendPanicCover();
    }, PANIC_RESEND_MS);
  }

  private stopPanicResend(): void {
    if (this.panicResend) {
      clearTimeout(this.panicResend);
      this.panicResend = null;
    }
  }

  isActive(tabId: string): boolean {
    return this.records.has(tabId);
  }

  /**
   * Raise the curtain over a tab before/around a navigation. Awaits the UI's
   * paint ack so the backdrop is on-screen before the caller issues the load.
   */
  async raise(
    tabId: string,
    /**
     * The tab's view, or null when it has none: a Memory Saver revive raises
     * the curtain BEFORE rebuilding the webContents, precisely so nothing can
     * paint in between. The backdrop is painted by the chromeView (which sits
     * above the tab in z-order), so the tab view is only ever needed for the
     * screenshot flavour.
     */
    tabView: WebContentsView | null,
    kind: BackdropKind,
  ): Promise<void> {
    const token = this.nextToken++;

    // Register the record (and its fail-to-blank timer) BEFORE any await: the
    // screenshot and the UI ack. Previously it was set only after the ack,
    // which left a window where a concurrent drop() (a panic double-press, a
    // fast re-navigation) found no record, no-oped, and the curtain hung until
    // the 6s fail-to-blank. isActive/onReady during the wait are correct with
    // the record present (the tab IS curtained), and the caller only issues
    // its load after this resolves, so no ready races in.
    const prev = this.records.get(tabId);
    if (prev) clearTimeout(prev.safetyTimer);
    this.records.set(tabId, {
      token,
      expectedNonce: null,
      safetyTimer: setTimeout(() => this.clear(tabId, token), SAFETY_TIMEOUT_MS),
    });

    // Never a screenshot under the panic cover: the current frame is exactly
    // what panic hides, and this backdrop is what would show the moment panic
    // is released, until the new document is ready.
    const captured =
      kind === 'screenshot' && tabView && !this.isPanic() ? await this.screenshot(tabView) : null;
    // Dropped (ready, tab closed, stream off) or superseded during the
    // screenshot: painting it now would put up a stale curtain.
    const rec = this.records.get(tabId);
    if (!rec || rec.token !== token) return;
    // Panic may have started while the screenshot was being taken.
    const dataURL = this.isPanic() ? null : captured;
    rec.screenshot = dataURL !== null;

    this.overlay.acquire(this.overlayKey(tabId));
    await this.waitForAck(tabId, token, dataURL);
  }

  /** The tab's current frame as a data URL, or null (solid panel) on failure or timeout. */
  private async screenshot(tabView: WebContentsView): Promise<string | null> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const image = await Promise.race([
        tabView.webContents.capturePage(),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), CAPTURE_TIMEOUT_MS);
        }),
      ]);
      return image && !image.isEmpty() ? image.toDataURL({ scaleFactor: 1 }) : null;
    } catch {
      // capturePage can fail mid-navigation; fall back to a solid panel.
      return null;
    } finally {
      clearTimeout(timer);
    }
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
    if (tabId === PANIC_CURTAIN_ID) {
      // Only the ack of the cover that is up counts: a late one from a
      // previous panic must not stop the repeat of this one.
      if (token === this.panicToken) {
        this.panicAcked = true;
        this.stopPanicResend();
      }
      return;
    }
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
