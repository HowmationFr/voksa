import type { BrowserWindow, WebFrameMain } from 'electron';
import type { StreamModeConfig } from '../../shared/streamConfig';
import { isMaskingActive } from './frameGuard';
import { getStreamMode } from './StreamModeController';

/**
 * Stream Mode gate for extension ACTION popups.
 *
 * electron-chrome-extensions opens an action popup (Bitwarden's vault, a mail
 * notifier's inbox...) in a BrowserWindow of its own, with webPreferences we do
 * not control: no page preload. The session preload src/preload/extensionPopup.ts
 * hands it the page preload anyway (L0 shroud + L1 masker at document-start):
 * that is what MASKS the popup. This gate is what turns it into a guarantee.
 * Under Stream Mode the popup may only be on screen while its current document
 * has PROVEN it runs the page preload (STREAM_FRAME_ALIVE from its main frame):
 *  - show() is deferred until the proof arrives. The library creates the window
 *    hidden and shows it itself once laid out, through this very method;
 *  - a popup on screen without the proof when Stream Mode turns on, or one that
 *    became visible through a path that bypassed show(), is destroyed.
 * So if the preload ever stops reaching these popups (a library or Electron
 * change), they fail to INVISIBLE under Stream Mode, never to raw. Subframes are
 * the frame guard's job, exactly like in a tab (the gate only vouches for the
 * main frame, which is the one the preload is attached to).
 */

function docKey(frame: WebFrameMain | null | undefined): string | null {
  try {
    if (!frame || frame.isDestroyed()) return null;
    return `${frame.processId}:${frame.frameToken}`;
  } catch {
    return null;
  }
}

export class ExtensionPopupGate {
  /** Main-frame document that announced the page preload, if any. */
  private aliveKey: string | null = null;
  /** The library asked to show the popup while it could not be shown yet. */
  private pendingShow = false;
  private disposed = false;
  private readonly nativeShow: () => void;

  constructor(
    private readonly win: BrowserWindow,
    private readonly onDisposed?: () => void,
  ) {
    this.nativeShow = win.show.bind(win);
    // An own property shadowing BrowserWindow.prototype.show: the library calls
    // `browserWindow.show()` on this very object.
    win.show = () => this.requestShow();
    win.on('show', this.handleShown);
    win.webContents.on('did-start-navigation', this.handleStartNavigation);
    win.webContents.once('destroyed', this.handleDestroyed);
    // One listener per live popup (the library keeps at most one open), so
    // subscribing directly cannot pile up on the controller singleton.
    getStreamMode().on('config-changed', this.handleConfigChanged);
  }

  /** A frame of the popup announced its preload (STREAM_FRAME_ALIVE). */
  onFrameAlive(frame: WebFrameMain | null): void {
    if (this.disposed || !frame) return;
    try {
      if (frame.parent !== null) return;
    } catch {
      return;
    }
    this.aliveKey = docKey(frame);
    if (this.pendingShow) this.requestShow();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    getStreamMode().off('config-changed', this.handleConfigChanged);
    try {
      if (!this.win.isDestroyed()) {
        this.win.off('show', this.handleShown);
        this.win.webContents.off('did-start-navigation', this.handleStartNavigation);
        this.win.webContents.off('destroyed', this.handleDestroyed);
      }
    } catch {
      // window already gone
    }
    this.onDisposed?.();
  }

  private masking(): boolean {
    return isMaskingActive(getStreamMode().getConfig());
  }

  /** The CURRENT main-frame document runs the page preload. */
  private proven(): boolean {
    if (this.aliveKey === null || this.win.isDestroyed()) return false;
    try {
      return docKey(this.win.webContents.mainFrame) === this.aliveKey;
    } catch {
      return false;
    }
  }

  private requestShow(): void {
    if (this.disposed || this.win.isDestroyed()) return;
    if (this.masking() && !this.proven()) {
      this.pendingShow = true;
      return;
    }
    this.pendingShow = false;
    this.nativeShow();
  }

  private failClosed(reason: string): void {
    console.warn(`[stream] extension popup destroyed: ${reason}`);
    try {
      if (!this.win.isDestroyed()) this.win.destroy();
    } catch {
      // already going away
    }
  }

  private readonly handleConfigChanged = (config: StreamModeConfig): void => {
    if (this.disposed || this.win.isDestroyed()) return;
    if (!isMaskingActive(config)) {
      // Stream OFF: a show held back for the proof is no longer held back.
      if (this.pendingShow) this.requestShow();
      return;
    }
    // Stream ON over a popup that is already on screen: with the preload it
    // re-masks itself like a tab does; without it, nothing would.
    if (this.win.isVisible() && !this.proven()) {
      this.failClosed('Stream Mode armed over a popup that never ran the page preload');
    }
  };

  private readonly handleShown = (): void => {
    if (this.disposed) return;
    if (this.masking() && !this.proven()) {
      this.failClosed('shown under Stream Mode without the page preload');
    }
  };

  private readonly handleStartNavigation = (
    details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
  ): void => {
    // A new document has to prove itself again (frame tokens can be reused
    // across documents of one frame).
    if (details.isMainFrame && !details.isSameDocument) this.aliveKey = null;
  };

  private readonly handleDestroyed = (): void => {
    this.dispose();
  };
}
