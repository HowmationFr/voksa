import { WebContentsView } from 'electron';
import { nanoid } from 'nanoid';
import type { TabState, TabError } from '../../shared/types';
import { recordVisit, updateLatestFavicon, updateLatestTitle } from '../storage/history';
import { clearGoogleAuthFlow } from '../ua';

const VOKSA_NEW_TAB = 'voksa://newtab';

/**
 * Legacy alias: profiles written before the Voksa rename still carry hbb://
 * URLs (old session files, bookmarks, hand-typed input that skipped
 * normalizeInput). Rewrite them on entry so tab state and the chrome UI only
 * ever see the canonical voksa:// scheme.
 */
function canonicalizeInternalUrl(url: string): string {
  return /^hbb:\/\//i.test(url) ? `voksa://${url.slice('hbb://'.length)}` : url;
}

export type TabEventMap = {
  'state-changed': (tab: Tab) => void;
  'title-changed': (tab: Tab) => void;
  'favicon-changed': (tab: Tab) => void;
  destroyed: (tab: Tab) => void;
};

export type TabInit = {
  url?: string;
  title?: string;
  userAgent: string;
  preloadPath: string;
  /**
   * Lazy session restore: create the view but do NOT load the URL until the
   * tab is first activated. Only the active restored tab loads on boot.
   */
  deferLoad?: boolean;
};

export class Tab {
  readonly id: string;
  readonly view: WebContentsView;
  url: string;
  title: string;
  favicon: string | null = null;
  isLoading = false;
  canGoBack = false;
  canGoForward = false;
  isCrashed = false;
  isAudible = false;
  isMuted = false;
  isInternal = false;
  zoomPercent = 100;
  error: TabError | null = null;
  /** Set when created with deferLoad; cleared once loadIfPending() runs. */
  pendingLoad = false;
  /** Re-entrancy flag used by TabManager's will-navigate handler. */
  curtainInProgress = false;

  private listeners: Partial<Record<keyof TabEventMap, Set<(tab: Tab) => void>>> = {};
  private lastBounds: Electron.Rectangle = { x: 0, y: 0, width: 0, height: 0 };

  constructor(init: TabInit) {
    this.id = nanoid(10);
    const ua = init.userAgent;

    // IMPORTANT: no custom partition; tabs use `session.defaultSession` so
    // they share the same session as the Chrome Web Store integration, the
    // UA-override webRequest hooks, and the permission handlers.
    this.view = new WebContentsView({
      webPreferences: {
        preload: init.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        // Run the preload (shroud + masker) in EVERY subframe so iframe
        // content is masked too; without this, cross-origin/same-origin
        // iframe text renders unmasked under Stream Mode.
        nodeIntegrationInSubFrames: true,
        sandbox: true,
        webSecurity: true,
        backgroundThrottling: true,
      },
    });

    this.view.webContents.setUserAgent(ua);
    // Neutral background: matches Chrome's behaviour and avoids a white flash
    // when navigating to dark sites. The real anti-flash guarantee is the
    // Stream Mode curtain / shroud; this just picks a sane blank colour.
    this.view.setBackgroundColor('#00000000');

    this.url = canonicalizeInternalUrl(init.url ?? VOKSA_NEW_TAB);
    this.title = init.title ?? 'Nouvel onglet';
    this.isInternal = this.url.startsWith('voksa://');

    this.wireEvents();

    if (init.deferLoad && !this.isInternal) {
      // Keep url/title for the tab strip but don't navigate yet.
      this.pendingLoad = true;
    } else {
      void this.load(this.url);
    }
  }

  on<K extends keyof TabEventMap>(event: K, cb: TabEventMap[K]): void {
    if (!this.listeners[event]) this.listeners[event] = new Set();
    this.listeners[event]!.add(cb as (tab: Tab) => void);
  }

  off<K extends keyof TabEventMap>(event: K, cb: TabEventMap[K]): void {
    this.listeners[event]?.delete(cb as (tab: Tab) => void);
  }

  private emit(event: keyof TabEventMap): void {
    const set = this.listeners[event];
    if (!set) return;
    for (const cb of set) cb(this);
  }

  setBounds(rect: Electron.Rectangle): void {
    this.lastBounds = rect;
    this.view.setBounds(rect);
  }

  getBounds(): Electron.Rectangle {
    return this.lastBounds;
  }

  /** Load a deferred (session-restored) tab the first time it is activated. */
  loadIfPending(): void {
    if (!this.pendingLoad) return;
    this.pendingLoad = false;
    void this.load(this.url);
  }

  toState(isActive: boolean): TabState {
    return {
      id: this.id,
      wcId: this.view.webContents.id,
      url: this.url,
      title: this.title,
      favicon: this.favicon,
      isLoading: this.isLoading,
      canGoBack: this.canGoBack,
      canGoForward: this.canGoForward,
      isCrashed: this.isCrashed,
      isActive,
      isAudible: this.isAudible,
      isMuted: this.isMuted,
      isInternal: this.isInternal,
      zoomPercent: this.zoomPercent,
      error: this.error,
    };
  }

  setMuted(muted: boolean): void {
    try {
      this.view.webContents.setAudioMuted(muted);
      this.isMuted = muted;
      this.emit('state-changed');
    } catch {
      // ignore
    }
  }

  setZoomFactor(factor: number): void {
    try {
      this.view.webContents.setZoomFactor(factor);
      this.zoomPercent = Math.round(factor * 100);
      this.emit('state-changed');
    } catch {
      // ignore
    }
  }

  getZoomFactor(): number {
    try {
      return this.view.webContents.getZoomFactor();
    } catch {
      return 1;
    }
  }

  host(): string {
    try {
      return new URL(this.url).host;
    } catch {
      return '';
    }
  }

  /**
   * Load an already-normalized URL. Search/URL normalization is done by
   * TabManager (via shared/urlUtils) so it can honour the configured search
   * engine; Tab just distinguishes internal pages from real navigations.
   */
  async load(url: string): Promise<void> {
    // Defense in depth: accept the legacy hbb:// alias here too, so any
    // caller that bypassed normalizeInput still lands on voksa://.
    url = canonicalizeInternalUrl(url);
    this.url = url;
    this.isInternal = url.startsWith('voksa://');

    if (this.isInternal) {
      // Internal pages (voksa://…) are rendered by the Chrome UI overlay, never
      // loaded into the tab's WebContentsView (see CLAUDE.md §4.1).
      this.title = this.titleForInternalUrl(url);
      this.favicon = null;
      this.isLoading = false;
      this.isCrashed = false;
      this.canGoBack = false;
      this.canGoForward = false;
      try {
        this.view.webContents.stop();
      } catch {
        // ignore
      }
      this.emit('title-changed');
      this.emit('state-changed');
      return;
    }

    try {
      await this.view.webContents.loadURL(url);
    } catch {
      // Failed loads surface via the did-fail-load handler (error page in a
      // later phase); swallow the rejection so it isn't an unhandled error.
    }
  }

  private titleForInternalUrl(url: string): string {
    switch (url) {
      case 'voksa://newtab':
        return 'Nouvel onglet';
      case 'voksa://history':
        return 'Historique';
      case 'voksa://bookmarks':
        return 'Favoris';
      case 'voksa://settings':
        return 'Paramètres';
      case 'voksa://stream':
        return 'Mode Stream';
      case 'voksa://downloads':
        return 'Téléchargements';
      default:
        return 'Nouvel onglet';
    }
  }

  back(): void {
    const nav = this.view.webContents.navigationHistory;
    if (nav.canGoBack()) nav.goBack();
  }

  forward(): void {
    const nav = this.view.webContents.navigationHistory;
    if (nav.canGoForward()) nav.goForward();
  }

  reload(): void {
    this.view.webContents.reload();
  }

  stop(): void {
    this.view.webContents.stop();
  }

  destroy(): void {
    const wc = this.view.webContents;
    try {
      clearGoogleAuthFlow(wc.id);
    } catch {
      // ignore
    }
    try {
      if (!wc.isDestroyed()) {
        wc.setAudioMuted(true);
        wc.loadURL('about:blank').catch(() => undefined);
      }
    } catch {
      // ignore; webContents may already be tearing down
    }

    setTimeout(() => {
      try {
        if (!wc.isDestroyed()) {
          wc.close({ waitForBeforeUnload: false });
        }
      } catch {
        // ignore
      }
    }, 80);

    this.emit('destroyed');
    this.listeners = {};
  }

  private wireEvents(): void {
    const wc = this.view.webContents;

    wc.on('page-title-updated', (_e, title) => {
      this.title = title || this.url;
      this.emit('title-changed');
      this.emit('state-changed');
      if (!this.isInternal) {
        try {
          updateLatestTitle(this.url, this.title);
        } catch {
          // ignore
        }
      }
    });

    wc.on('page-favicon-updated', (_e, favicons) => {
      const fav = favicons && favicons.length ? favicons[0] : null;
      this.favicon = fav;
      this.emit('favicon-changed');
      this.emit('state-changed');
      if (fav && !this.isInternal) {
        try {
          updateLatestFavicon(this.url, fav);
        } catch {
          // ignore
        }
      }
    });

    wc.on('did-start-loading', () => {
      this.isLoading = true;
      this.emit('state-changed');
    });

    wc.on('did-start-navigation', (_e, _url, _isInPlace, isMainFrame) => {
      if (isMainFrame) this.error = null;
    });

    wc.on('did-navigate', (_e, url) => {
      this.url = url;
      this.isInternal = url.startsWith('voksa://');
      this.isCrashed = false;
      this.error = null;
      this.emit('state-changed');
      if (!this.isInternal && /^https?:/.test(url)) {
        try {
          recordVisit(url, this.title, this.favicon);
        } catch {
          // ignore
        }
      }
    });

    wc.on('did-fail-load', (_e, code, description, validatedURL, isMainFrame) => {
      // -3 (ERR_ABORTED) is a normal cancelled navigation, not an error.
      if (!isMainFrame || code === -3) return;
      this.error = { code, description, url: validatedURL || this.url };
      this.isLoading = false;
      this.emit('state-changed');
    });

    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (!isMainFrame) return;
      this.url = url;
      this.emit('state-changed');
      // SPA route changes (YouTube / Twitter / GitHub) are real navigations
      // for history purposes even though no full document load occurs.
      if (!this.isInternal && /^https?:/.test(url)) {
        try {
          recordVisit(url, this.title, this.favicon);
        } catch {
          // ignore
        }
      }
    });

    wc.on('render-process-gone', () => {
      this.isCrashed = true;
      this.isLoading = false;
      this.emit('state-changed');
    });

    wc.on('audio-state-changed', ((...args: unknown[]) => {
      const ev = args[0] as { audible?: boolean } | undefined;
      const fallback = args[1] as boolean | undefined;
      this.isAudible = Boolean(ev?.audible ?? fallback);
      this.emit('state-changed');
    }) as unknown as () => void);

    wc.on('did-stop-loading', () => {
      this.isLoading = false;
      const nav = wc.navigationHistory;
      this.canGoBack = nav.canGoBack();
      this.canGoForward = nav.canGoForward();
      this.emit('state-changed');
    });
  }
}

export { VOKSA_NEW_TAB };
