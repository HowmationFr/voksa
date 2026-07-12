import { WebContentsView } from 'electron';
import { nanoid } from 'nanoid';
import type { TabState, TabError } from '../../shared/types';
import { recordVisit, updateLatestFavicon, updateLatestTitle } from '../storage/history';
import { clearGoogleAuthFlow } from '../ua';

const VOKSA_NEW_TAB = 'voksa://newtab';

/**
 * Cap on the retained navigation snapshot. `pageState` carries scroll position
 * AND form values, which on a form-heavy page can run to hundreds of KB. Past
 * this we keep the url/title chain only: a discarded tab must never become a
 * memory hog of its own, which would defeat the entire point.
 */
const MAX_NAV_SNAPSHOT_BYTES = 2 * 1024 * 1024;

/** A revive that never navigates must not gag history recording forever. */
const RESTORE_SUPPRESSION_TIMEOUT_MS = 15_000;

/**
 * Legacy alias: profiles written before the Voksa rename still carry hbb://
 * URLs (old session files, bookmarks, hand-typed input that skipped
 * normalizeInput). Rewrite them on entry so tab state and the chrome UI only
 * ever see the canonical voksa:// scheme.
 */
function canonicalizeInternalUrl(url: string): string {
  return /^hbb:\/\//i.test(url) ? `voksa://${url.slice('hbb://'.length)}` : url;
}

/**
 * Kill a view's renderer: mute, blank it (stops media and timers at once),
 * then close for real. Lifted out of Tab.destroy() so a DISCARD can reuse the
 * exact same teardown without emitting 'destroyed'.
 *
 * CRITICAL: the caller MUST have detached the tab's listeners first. The
 * about:blank load fires did-navigate, and a still-wired handler would
 * overwrite `tab.url` with 'about:blank', erasing the very URL the discarded
 * tab needs in order to come back.
 */
export function teardownView(view: WebContentsView): void {
  const wc = view.webContents;
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
      // waitForBeforeUnload: false is mandatory. A discard must never pop a
      // native "are you sure you want to leave" dialog for a background tab
      // the user is not even looking at. Chrome behaves the same way; the
      // form values are preserved through pageState instead.
      if (!wc.isDestroyed()) {
        wc.close({ waitForBeforeUnload: false });
      }
    } catch {
      // ignore
    }
  }, 80);
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
   * Lazy session restore: create the tab WITHOUT any webContents. It is born
   * in the discarded state and materializes on first activation, exactly like
   * a tab the Memory Saver freed. On a 20-tab session that boots one renderer
   * instead of twenty.
   */
  deferLoad?: boolean;
};

export class Tab {
  readonly id: string;
  /**
   * null while discarded: the tab has NO webContents at all, so its renderer
   * memory is genuinely returned to the OS (as opposed to a blank page, which
   * still holds a process). `view === null` is exactly `isDiscarded`.
   */
  view: WebContentsView | null = null;
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
  isDiscarded = false;
  zoomPercent = 100;
  error: TabError | null = null;
  /** Epoch ms of the last activation: the Memory Saver's idle clock. */
  lastActiveAt = Date.now();
  /** Re-entrancy flag used by TabManager's will-navigate handler. */
  curtainInProgress = false;

  private listeners: Partial<Record<keyof TabEventMap, Set<(tab: Tab) => void>>> = {};
  private lastBounds: Electron.Rectangle = { x: 0, y: 0, width: 0, height: 0 };

  /** Kept so a discarded tab can rebuild an identical view on revive. */
  private readonly userAgent: string;
  private readonly preloadPath: string;

  /** Session history saved at discard time (url + title + scroll + forms). */
  private navEntries: Electron.NavigationEntry[] | null = null;
  private navIndex = 0;

  /** Silences recordVisit for the ONE navigation that replays saved history. */
  private suppressVisitRecording = false;
  private suppressTimer: NodeJS.Timeout | null = null;

  /** Detachers for every listener wireEvents() put on the CURRENT webContents. */
  private wcListeners: Array<() => void> = [];

  constructor(init: TabInit) {
    this.id = nanoid(10);
    this.userAgent = init.userAgent;
    this.preloadPath = init.preloadPath;

    this.url = canonicalizeInternalUrl(init.url ?? VOKSA_NEW_TAB);
    this.title = init.title ?? 'Nouvel onglet';
    this.isInternal = this.url.startsWith('voksa://');

    if (init.deferLoad && !this.isInternal) {
      // Born discarded: no view, no renderer. Materializes on first activation
      // through the exact same path as a Memory Saver revive.
      this.isDiscarded = true;
      return;
    }

    this.createView();
    void this.load(this.url);
  }

  /** The live webContents, or null while discarded. */
  get wc(): Electron.WebContents | null {
    const wc = this.view?.webContents;
    return wc && !wc.isDestroyed() ? wc : null;
  }

  /**
   * Build the WebContentsView and wire it. The webPreferences MUST stay
   * byte-identical to the original: the page preload (Stream Mode L0 shroud +
   * masker) and nodeIntegrationInSubFrames are what make a revived page as
   * safe as a freshly loaded one.
   */
  createView(): void {
    if (this.view) return;

    // IMPORTANT: no custom partition; tabs use `session.defaultSession` so
    // they share the same session as the Chrome Web Store integration, the
    // UA-override webRequest hooks, and the permission handlers.
    this.view = new WebContentsView({
      webPreferences: {
        preload: this.preloadPath,
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

    this.view.webContents.setUserAgent(this.userAgent);
    // Neutral background: matches Chrome's behaviour and avoids a white flash
    // when navigating to dark sites. The real anti-flash guarantee is the
    // Stream Mode curtain / shroud; this just picks a sane blank colour.
    this.view.setBackgroundColor('#00000000');
    // Mute lives on the webContents, so a revive builds one that is UNMUTED
    // while the tab strip still shows the speaker crossed out: carry it over.
    // (Zoom needs no such care: it is re-applied per host on did-finish-load.)
    if (this.isMuted) {
      try {
        this.view.webContents.setAudioMuted(true);
      } catch {
        // ignore
      }
    }
    this.isDiscarded = false;

    this.wireEvents();
  }

  // --- Memory Saver ---------------------------------------------------------

  /**
   * Snapshot the session history before the renderer dies, so back/forward
   * (and, through pageState, scroll position and form values) survive.
   */
  captureNavigation(): void {
    this.navEntries = null;
    this.navIndex = 0;
    const wc = this.wc;
    if (!wc) return;
    try {
      const nav = wc.navigationHistory;
      const entries = nav.getAllEntries();
      const index = nav.getActiveIndex();
      if (entries.length === 0 || index < 0 || index >= entries.length) return;
      const heavy = JSON.stringify(entries).length > MAX_NAV_SNAPSHOT_BYTES;
      // Too heavy: keep the chain, drop the page states. Back/forward still
      // work; only scroll and form restoration are lost.
      this.navEntries = heavy ? entries.map(({ url, title }) => ({ url, title })) : entries;
      this.navIndex = index;
    } catch {
      // Fail to "plain reload the url": never leave a tab that cannot come back.
      this.navEntries = null;
    }
    this.canGoBack = this.navEntries ? this.navIndex > 0 : false;
    this.canGoForward = this.navEntries
      ? this.navIndex < this.navEntries.length - 1
      : false;
  }

  /**
   * Detach every listener and hand the dying view back to the caller. Does NOT
   * emit 'destroyed': the Tab object lives on, keeping its url, title, favicon
   * and saved history. Detaching first is what makes teardownView() safe.
   */
  detachView(): WebContentsView | null {
    this.unwireEvents();
    const dying = this.view;
    this.view = null;
    this.isDiscarded = true;
    this.isLoading = false;
    this.isCrashed = false;
    this.isAudible = false;
    this.error = null;
    return dying;
  }

  /**
   * Arm the history-recording suppression. The navigation that REPLAYS saved
   * entries is not a user visit: recording it would bump visit_count and skew
   * the omnibox ranking. One-shot, with a watchdog so a revive that never
   * navigates (dead network) cannot gag this tab's history for good.
   */
  beginRestoreNavigation(): void {
    this.suppressVisitRecording = true;
    if (this.suppressTimer) clearTimeout(this.suppressTimer);
    this.suppressTimer = setTimeout(() => {
      this.suppressVisitRecording = false;
      this.suppressTimer = null;
    }, RESTORE_SUPPRESSION_TIMEOUT_MS);
  }

  private clearSuppression(): void {
    this.suppressVisitRecording = false;
    if (this.suppressTimer) {
      clearTimeout(this.suppressTimer);
      this.suppressTimer = null;
    }
  }

  /**
   * Drop the saved history: the caller is about to navigate this tab somewhere
   * else, so replaying the page it was sleeping on would overwrite that.
   */
  forgetNavigation(): void {
    this.navEntries = null;
    this.navIndex = 0;
  }

  /** Replay the saved history into the fresh webContents (or plain-load). */
  async restoreNavigation(): Promise<void> {
    const wc = this.wc;
    if (!wc) return;
    const entries = this.navEntries;
    if (entries && entries.length > 0) {
      try {
        await wc.navigationHistory.restore({ entries, index: this.navIndex });
        this.navEntries = null;
        return;
      } catch {
        // Fall through to a plain load: a tab must always come back.
      }
    }
    await this.load(this.url);
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
    this.view?.setBounds(rect);
  }

  getBounds(): Electron.Rectangle {
    return this.lastBounds;
  }

  toState(isActive: boolean): TabState {
    return {
      id: this.id,
      // -1 while discarded: there IS no webContents. Only ever read for the
      // active tab (extension browser-action targeting), which is never
      // discarded, so no consumer sees -1 in practice.
      wcId: this.view ? this.view.webContents.id : -1,
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
      isDiscarded: this.isDiscarded,
      zoomPercent: this.zoomPercent,
      error: this.error,
    };
  }

  setMuted(muted: boolean): void {
    try {
      this.wc?.setAudioMuted(muted);
      this.isMuted = muted;
      this.emit('state-changed');
    } catch {
      // ignore
    }
  }

  setZoomFactor(factor: number): void {
    try {
      this.wc?.setZoomFactor(factor);
      this.zoomPercent = Math.round(factor * 100);
      this.emit('state-changed');
    } catch {
      // ignore
    }
  }

  getZoomFactor(): number {
    try {
      return this.wc?.getZoomFactor() ?? 1;
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
    // An explicit navigation always records, even if it interrupts a revive.
    this.clearSuppression();

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
        this.wc?.stop();
      } catch {
        // ignore
      }
      this.emit('title-changed');
      this.emit('state-changed');
      return;
    }

    const wc = this.wc;
    if (!wc) {
      // Dormant: there is nothing to load into. TabManager wakes a tab before
      // navigating it (wakeForNavigation), so reaching here means the caller
      // skipped that. Drop the stale saved history rather than leave the tab
      // pointing at a URL it will never show: the next materialization then
      // plain-loads this.url, which is what was asked for.
      this.forgetNavigation();
      return;
    }
    try {
      await wc.loadURL(url);
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
      case 'voksa://extensions':
        return 'Extensions';
      case 'voksa://credits':
        return 'Crédits';
      default:
        return 'Nouvel onglet';
    }
  }

  back(): void {
    const nav = this.wc?.navigationHistory;
    if (nav?.canGoBack()) nav.goBack();
  }

  forward(): void {
    const nav = this.wc?.navigationHistory;
    if (nav?.canGoForward()) nav.goForward();
  }

  reload(): void {
    this.wc?.reload();
  }

  stop(): void {
    this.wc?.stop();
  }

  destroy(): void {
    this.clearSuppression();
    const dying = this.detachView();
    if (dying) teardownView(dying);
    this.emit('destroyed');
    this.listeners = {};
  }

  /** Register a webContents listener and remember how to take it off again. */
  private onWc(event: string, handler: (...args: never[]) => void): void {
    const wc = this.view?.webContents;
    if (!wc) return;
    const wcAny = wc as unknown as {
      on(e: string, h: (...args: never[]) => void): void;
      removeListener(e: string, h: (...args: never[]) => void): void;
    };
    wcAny.on(event, handler);
    this.wcListeners.push(() => {
      try {
        wcAny.removeListener(event, handler);
      } catch {
        // webContents already gone
      }
    });
  }

  private unwireEvents(): void {
    for (const off of this.wcListeners) off();
    this.wcListeners = [];
  }

  private wireEvents(): void {
    const wc = this.view?.webContents;
    if (!wc) return;

    this.onWc('page-title-updated', ((_e: unknown, title: string) => {
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
    }) as (...args: never[]) => void);

    this.onWc('page-favicon-updated', ((_e: unknown, favicons: string[]) => {
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
    }) as (...args: never[]) => void);

    this.onWc('did-start-loading', (() => {
      this.isLoading = true;
      this.emit('state-changed');
    }) as (...args: never[]) => void);

    this.onWc('did-start-navigation', ((
      _e: unknown,
      _url: string,
      _isInPlace: boolean,
      isMainFrame: boolean,
    ) => {
      if (isMainFrame) this.error = null;
    }) as (...args: never[]) => void);

    this.onWc('did-navigate', ((_e: unknown, url: string) => {
      this.url = url;
      this.isInternal = url.startsWith('voksa://');
      this.isCrashed = false;
      this.error = null;
      // ONE-SHOT: the replayed navigation of a revive is not a user visit.
      // Consumed here and only here, so the very next real navigation records.
      const replayed = this.suppressVisitRecording;
      this.clearSuppression();
      this.emit('state-changed');
      if (!replayed && !this.isInternal && /^https?:/.test(url)) {
        try {
          recordVisit(url, this.title, this.favicon);
        } catch {
          // ignore
        }
      }
    }) as (...args: never[]) => void);

    this.onWc('did-fail-load', ((
      _e: unknown,
      code: number,
      description: string,
      validatedURL: string,
      isMainFrame: boolean,
    ) => {
      // -3 (ERR_ABORTED) is a normal cancelled navigation, not an error.
      if (!isMainFrame || code === -3) return;
      this.error = { code, description, url: validatedURL || this.url };
      this.isLoading = false;
      this.emit('state-changed');
    }) as (...args: never[]) => void);

    this.onWc('did-navigate-in-page', ((
      _e: unknown,
      url: string,
      isMainFrame: boolean,
    ) => {
      if (!isMainFrame) return;
      this.url = url;
      this.emit('state-changed');
      // A restored page replays hash/scroll changes from pageState: those are
      // replay artefacts, not visits. Skip WITHOUT consuming the one-shot,
      // which belongs to did-navigate.
      if (this.suppressVisitRecording) return;
      // SPA route changes (YouTube / Twitter / GitHub) are real navigations
      // for history purposes even though no full document load occurs.
      if (!this.isInternal && /^https?:/.test(url)) {
        try {
          recordVisit(url, this.title, this.favicon);
        } catch {
          // ignore
        }
      }
    }) as (...args: never[]) => void);

    this.onWc('render-process-gone', (() => {
      this.isCrashed = true;
      this.isLoading = false;
      this.emit('state-changed');
    }) as (...args: never[]) => void);

    this.onWc('audio-state-changed', ((...args: unknown[]) => {
      const ev = args[0] as { audible?: boolean } | undefined;
      const fallback = args[1] as boolean | undefined;
      this.isAudible = Boolean(ev?.audible ?? fallback);
      this.emit('state-changed');
    }) as unknown as (...args: never[]) => void);

    this.onWc('did-stop-loading', (() => {
      this.isLoading = false;
      const nav = this.wc?.navigationHistory;
      if (nav) {
        this.canGoBack = nav.canGoBack();
        this.canGoForward = nav.canGoForward();
      }
      this.emit('state-changed');
    }) as (...args: never[]) => void);
  }
}
