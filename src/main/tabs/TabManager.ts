import path from 'node:path';
import { EventEmitter } from 'node:events';
import { app, BaseWindow, webContents, type WebContents, type WebFrameMain } from 'electron';
import { Tab } from './Tab';
import type { ChromeBounds, TabState } from '../../shared/types';
import type { SessionWindow, SessionTab } from '../storage/session';
import { computeTabBounds } from './bounds';
import { getSettings, setSettings } from '../storage/settings';
import { normalizeInput } from '../../shared/urlUtils';
import { sameMaskingConfig, type StreamModeConfig } from '../../shared/streamConfig';
import { getStreamMode } from '../stream-mode/StreamModeController';
import { CurtainController, isInternalUrl } from '../stream-mode/curtain';
import { FrameGuard } from '../stream-mode/frameGuard';
import {
  getUaForUrl,
  isAnyGoogleDomain,
  isGoogleAuthDomain,
  setInGoogleAuthFlow,
} from '../ua';
import {
  notifyTabSelected,
  registerTabWithExtensions,
  unregisterTabFromExtensions,
} from '../extensions/webstore';

const MAX_CLOSED = 25;

export class TabManager extends EventEmitter {
  private readonly tabs: Tab[] = [];
  private activeId: string | null = null;
  private chromeBounds: ChromeBounds = { top: 88, bottom: 0, left: 0, right: 0 };
  private closedStack: SessionTab[] = [];
  private shuttingDown = false;
  /**
   * Stream Mode frame guards, keyed by webContents id (NOT tab id): managed
   * popups run the page preload too, so they need the same protection against
   * preload-less subframes (electron/electron#34727).
   */
  private readonly frameGuards = new Map<number, FrameGuard>();
  /** Kept so dispose() can unsubscribe from the stream controller singleton. */
  private readonly onStreamConfigChanged: (cfg: StreamModeConfig) => void;

  constructor(
    private readonly window: BaseWindow,
    private readonly userAgent: string,
    private readonly curtain: CurtainController,
  ) {
    super();
    // Once the window starts closing, every layout/activation path must stop:
    // the teardown destroys each tab webContents, electron-chrome-extensions
    // reacts to each destruction by asking us to remove the tab, and a naive
    // close() would then activate the next tab (or create a fresh one) against
    // an already destroyed window: "TypeError: Object has been destroyed"
    // dialogs at quit, one per tab.
    window.on('close', () => {
      this.shuttingDown = true;
    });
    window.on('resize', () => this.applyActiveBounds());
    window.on('enter-full-screen', () => this.applyActiveBounds());
    window.on('leave-full-screen', () => this.applyActiveBounds());
    // NB: no more config-changed curtain loop for toggle-ON. That is handled
    // entirely renderer-side: each tab's preload shrouds, sweeps synchronously,
    // and lifts within a single task: no screenshots, no shared-backdrop race.
    // Toggle-OFF must drop any curtains still up so tabs aren't stuck blanked.
    let prevStreamCfg = getStreamMode().getConfig();
    this.onStreamConfigChanged = (cfg) => {
      const maskingChanged = !sameMaskingConfig(prevStreamCfg, cfg);
      prevStreamCfg = cfg;
      if (!cfg.enabled) {
        for (const t of this.tabs) this.curtain.drop(t.id);
      }
      // Cosmetic-only updates (accent color) must not reach the guards:
      // invalidating coverage hides every subframe until the next verdict,
      // which would make the color picker blink the live page on each step.
      if (!maskingChanged) return;
      // Forwarded from here (one listener) rather than subscribed per guard:
      // a listener per tab would trip Node's max-listeners warning on the
      // controller singleton. Runs BEFORE the handlers.ts config broadcast, so
      // the gate is raised before the renderers re-sweep.
      for (const guard of this.frameGuards.values()) guard.onConfigChanged();
    };
    getStreamMode().on('config-changed', this.onStreamConfigChanged);
  }

  /**
   * Full teardown when the owning window is gone (index.ts wires it on
   * 'closed'). Two distinct leaks are plugged here:
   *  - the subscription on the stream controller singleton, or every closed
   *    window would retain its whole TabManager through the closure and keep
   *    dropping curtains against a destroyed chromeView;
   *  - the tab webContents themselves: a BaseWindow does NOT destroy its
   *    child WebContentsViews' webContents on close (unlike BrowserWindow),
   *    so without this every closed window would leave its pages loaded,
   *    playing audio and holding memory until the app quits.
   */
  dispose(): void {
    getStreamMode().off('config-changed', this.onStreamConfigChanged);
    const tabWebContentsIds = new Set(this.tabs.map((t) => t.view.webContents.id));
    for (const tab of [...this.tabs]) {
      try {
        unregisterTabFromExtensions(tab.view.webContents);
      } catch {
        // ignore
      }
      tab.destroy();
    }
    this.tabs.length = 0;
    this.activeId = null;
    // Managed popups (window.open / OAuth) are independent BrowserWindows,
    // guarded from HERE (they run the page preload). They cannot outlive this
    // window: their opener tab is destroyed just above, so window.opener is
    // dead and the flow is over anyway, while an orphaned guard would leave
    // every iframe the popup inserts under Stream Mode gated forever (fails
    // closed, but the popup would be visibly broken) since no window would
    // own its frame messages any more.
    for (const [wcId, guard] of this.frameGuards) {
      if (!tabWebContentsIds.has(wcId)) {
        const popup = webContents.fromId(wcId);
        if (popup && !popup.isDestroyed()) {
          try {
            popup.close();
          } catch {
            // already going away
          }
        }
      }
      guard.dispose();
    }
    this.frameGuards.clear();
  }

  /**
   * True when this manager owns the given webContents: one of its tabs, or a
   * managed popup it guards (frame guards are keyed by webContents id and
   * cover both). Used by the window registry to route page-originated IPC.
   */
  ownsWebContents(webContentsId: number): boolean {
    return (
      this.frameGuards.has(webContentsId) ||
      this.tabs.some((t) => t.view.webContents.id === webContentsId)
    );
  }

  private streamOn(): boolean {
    return getStreamMode().isEnabled();
  }

  /** Attach a Stream Mode frame guard to a page-preload webContents. */
  private guard(wc: WebContents): void {
    const id = wc.id;
    if (this.frameGuards.has(id)) return;
    this.frameGuards.set(id, new FrameGuard(wc, () => this.frameGuards.delete(id)));
  }

  /** A frame announced its preload (IPC.STREAM_FRAME_ALIVE). */
  handleFrameAlive(sender: WebContents, frame: WebFrameMain | null): void {
    this.frameGuards.get(sender.id)?.onFrameAlive(frame);
  }

  /** A frame gated its iframes and wants a coverage verdict (IPC.STREAM_FRAME_GATE). */
  handleFrameGate(sender: WebContents, frame: WebFrameMain | null, seq: number): void {
    this.frameGuards.get(sender.id)?.onGateSignal(frame, seq);
  }

  /** True once the window is closing or gone: layout and activation must stop. */
  private isShuttingDown(): boolean {
    return this.shuttingDown || this.window.isDestroyed();
  }

  /** Pre-raise the curtain (awaited) before a browser-initiated navigation. */
  private async preRaise(tab: Tab, targetUrl: string | undefined): Promise<void> {
    if (!this.streamOn()) return;
    if (!targetUrl || isInternalUrl(targetUrl)) return;
    if (this.curtain.isActive(tab.id)) return;
    // Old page is external + masked → freeze its frame; else a solid panel.
    const kind = isInternalUrl(tab.url) ? 'solid' : 'screenshot';
    await this.curtain.raise(tab.id, tab.view, kind);
  }

  private preloadPath(): string {
    return path.join(app.getAppPath(), 'dist-electron', 'preload', 'page.js');
  }

  create(
    url?: string,
    opts?: { activate?: boolean; title?: string; deferLoad?: boolean },
  ): Tab {
    const normalized = url ? normalizeInput(url, getSettings().searchEngine) : undefined;
    const tab = new Tab({
      url: normalized,
      title: opts?.title,
      userAgent: this.userAgent,
      preloadPath: this.preloadPath(),
      deferLoad: opts?.deferLoad,
    });
    this.wireTab(tab);
    this.tabs.push(tab);
    try {
      registerTabWithExtensions(tab.view.webContents, this.window);
    } catch (err) {
      console.warn('[tabs] registerTabWithExtensions failed:', err);
    }
    if (opts?.activate !== false) {
      this.setActive(tab.id);
      // Cover the first paint of a brand-new external tab with a solid panel
      // (no prior frame to screenshot). The renderer shroud guarantees no
      // unmasked content; this just avoids a window-background flash.
      if (this.streamOn() && normalized && !isInternalUrl(normalized)) {
        void this.curtain.raise(tab.id, tab.view, 'solid');
      }
    }
    this.emitList();
    return tab;
  }

  findByWebContents(wc: WebContents): Tab | null {
    return this.tabs.find((t) => t.view.webContents.id === wc.id) ?? null;
  }

  close(id: string): void {
    const idx = this.tabs.findIndex((t) => t.id === id);
    if (idx === -1) return;
    const [tab] = this.tabs.splice(idx, 1);
    const wasActive = this.activeId === id;

    if (tab.url && tab.url !== 'voksa://newtab') {
      this.closedStack.push({ url: tab.url, title: tab.title });
      if (this.closedStack.length > MAX_CLOSED) this.closedStack.shift();
    }

    this.curtain.handleTabClosed(tab.id);
    // Guards hold timers and webContents listeners: drop them with the tab
    // (the guard also self-disposes on 'destroyed', this just does it earlier).
    this.frameGuards.get(tab.view.webContents.id)?.dispose();
    try {
      unregisterTabFromExtensions(tab.view.webContents);
    } catch {
      // ignore
    }
    try {
      this.window.contentView.removeChildView(tab.view);
    } catch {
      // view might not be attached
    }
    tab.destroy();

    // During shutdown the tabs die one by one under our feet (the extension
    // runtime relays each webContents destruction back into close()). Never
    // activate a survivor or spawn a replacement tab against a dying window,
    // and never emit tabs-changed: the session-persistence listener would
    // overwrite the saved session with the shrinking (soon empty) tab list.
    if (this.isShuttingDown()) {
      if (wasActive) {
        this.activeId = this.tabs[idx]?.id ?? this.tabs[idx - 1]?.id ?? null;
      }
      return;
    }

    if (wasActive) {
      const next = this.tabs[idx] ?? this.tabs[idx - 1] ?? null;
      this.activeId = next?.id ?? null;
      if (next) {
        this.setActive(next.id);
      } else {
        this.create();
        return;
      }
    }

    this.emitList();
  }

  reopenClosed(): void {
    const last = this.closedStack.pop();
    if (!last) return;
    this.create(last.url, { title: last.title });
  }

  setActive(id: string): void {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;
    this.activeId = id;
    tab.loadIfPending();
    this.applyActiveBounds();
    this.bringActiveToFront();
    try {
      notifyTabSelected(tab.view.webContents);
    } catch {
      // extensions runtime not available, non-fatal
    }
    this.emitList();
  }

  reorder(ids: string[]): void {
    const map = new Map(this.tabs.map((t) => [t.id, t]));
    const next: Tab[] = [];
    for (const id of ids) {
      const t = map.get(id);
      if (t) next.push(t);
    }
    for (const t of this.tabs) {
      if (!next.includes(t)) next.push(t);
    }
    this.tabs.length = 0;
    this.tabs.push(...next);
    this.emitList();
  }

  getActive(): Tab | null {
    return this.tabs.find((t) => t.id === this.activeId) ?? null;
  }

  getAll(): Tab[] {
    return [...this.tabs];
  }

  listState(): TabState[] {
    return this.tabs.map((t) => t.toState(t.id === this.activeId));
  }

  setChromeBounds(bounds: ChromeBounds): void {
    this.chromeBounds = bounds;
    this.applyActiveBounds();
  }

  cycle(delta: number): void {
    if (this.tabs.length < 2) return;
    const idx = this.tabs.findIndex((t) => t.id === this.activeId);
    if (idx === -1) return;
    const nextIdx = (idx + delta + this.tabs.length) % this.tabs.length;
    this.setActive(this.tabs[nextIdx].id);
  }

  activateByIndex(index: number): void {
    if (index === 8) {
      const last = this.tabs[this.tabs.length - 1];
      if (last) this.setActive(last.id);
      return;
    }
    const t = this.tabs[index];
    if (t) this.setActive(t.id);
  }

  async navigate(id: string, rawUrl: string): Promise<void> {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;
    const url = normalizeInput(rawUrl, getSettings().searchEngine);
    if (!isInternalUrl(url)) await this.preRaise(tab, url);
    await tab.load(url);
  }

  async back(id: string): Promise<void> {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;
    const nav = tab.view.webContents.navigationHistory;
    if (!nav.canGoBack()) return;
    const target = nav.getEntryAtIndex(nav.getActiveIndex() - 1)?.url;
    await this.preRaise(tab, target);
    tab.back();
  }

  async forward(id: string): Promise<void> {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;
    const nav = tab.view.webContents.navigationHistory;
    if (!nav.canGoForward()) return;
    const target = nav.getEntryAtIndex(nav.getActiveIndex() + 1)?.url;
    await this.preRaise(tab, target);
    tab.forward();
  }

  async reload(id: string): Promise<void> {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;
    await this.preRaise(tab, tab.url);
    tab.reload();
  }

  stop(id: string): void {
    this.tabs.find((t) => t.id === id)?.stop();
  }

  duplicate(id: string): void {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;
    this.create(tab.url, { title: tab.title });
  }

  setMuted(id: string, muted?: boolean): void {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;
    tab.setMuted(muted ?? !tab.isMuted);
  }

  closeOthers(id: string): void {
    for (const t of [...this.tabs]) if (t.id !== id) this.close(t.id);
  }

  closeRight(id: string): void {
    const idx = this.tabs.findIndex((t) => t.id === id);
    if (idx === -1) return;
    for (const t of this.tabs.slice(idx + 1)) this.close(t.id);
  }

  // --- Zoom -----------------------------------------------------------------
  private persistZoom(host: string, factor: number): void {
    if (!host) return;
    const zoomLevels = { ...getSettings().zoomLevels };
    if (Math.abs(factor - 1) < 0.001) delete zoomLevels[host];
    else zoomLevels[host] = factor;
    setSettings({ zoomLevels });
  }

  adjustZoom(id: string, delta: number): void {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab || tab.isInternal) return;
    const cur = tab.getZoomFactor();
    const next = Math.min(5, Math.max(0.25, delta > 0 ? cur * 1.1 : cur / 1.1));
    tab.setZoomFactor(next);
    this.persistZoom(tab.host(), next);
  }

  resetZoom(id: string): void {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;
    tab.setZoomFactor(1);
    this.persistZoom(tab.host(), 1);
  }

  private applyPersistedZoom(tab: Tab): void {
    const factor = getSettings().zoomLevels[tab.host()] ?? 1;
    tab.setZoomFactor(factor);
  }

  // --- Find in page ---------------------------------------------------------
  findInPage(id: string, text: string, forward: boolean, matchCase: boolean): void {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab || !text) return;
    tab.view.webContents.findInPage(text, { forward, matchCase, findNext: false });
  }

  stopFind(id: string): void {
    const tab = this.tabs.find((t) => t.id === id);
    tab?.view.webContents.stopFindInPage('clearSelection');
  }

  // --- Session persistence --------------------------------------------------

  serialize(): SessionWindow {
    const bounds = this.window.getBounds();
    const activeIndex = Math.max(
      0,
      this.tabs.findIndex((t) => t.id === this.activeId),
    );
    return {
      windowBounds: bounds,
      maximized: this.window.isMaximized(),
      tabs: this.tabs.map((t) => ({ url: t.url, title: t.title })),
      activeIndex,
      closedStack: this.closedStack.slice(-MAX_CLOSED),
    };
  }

  restore(data: SessionWindow): boolean {
    const restorable = data.tabs.filter((t) => t.url && t.url.trim().length > 0);
    if (restorable.length === 0) return false;
    this.closedStack = Array.isArray(data.closedStack) ? data.closedStack.slice(-MAX_CLOSED) : [];
    const activeIndex = Math.min(Math.max(0, data.activeIndex), restorable.length - 1);
    restorable.forEach((t, i) => {
      this.create(t.url, { activate: false, title: t.title, deferLoad: i !== activeIndex });
    });
    const activeTab = this.tabs[activeIndex];
    if (activeTab) this.setActive(activeTab.id);
    return true;
  }

  private htmlFullscreen = false;

  /** Enter/leave HTML5 (video) fullscreen: chrome hidden, tab fills window. */
  setHtmlFullscreen(on: boolean): void {
    this.htmlFullscreen = on;
    this.applyActiveBounds();
    this.emit('html-fullscreen', on);
  }

  private applyActiveBounds(): void {
    if (this.isShuttingDown()) return;
    const active = this.getActive();
    if (!active) return;
    let bounds: Electron.Rectangle;
    if (this.htmlFullscreen) {
      const [w, h] = this.window.getContentSize();
      bounds = { x: 0, y: 0, width: w, height: h };
    } else {
      bounds = computeTabBounds(this.window, this.chromeBounds);
    }
    for (const t of this.tabs) {
      if (t.view.webContents.isDestroyed()) continue;
      if (t.id === active.id) {
        t.setBounds(bounds);
      } else {
        t.setBounds({ x: -100000, y: -100000, width: bounds.width, height: bounds.height });
      }
    }
  }

  private bringActiveToFront(): void {
    if (this.isShuttingDown()) return;
    const active = this.getActive();
    if (!active) return;
    try {
      this.window.contentView.removeChildView(active.view);
    } catch {
      // not attached, that's fine
    }
    this.window.contentView.addChildView(active.view);
    this.emit('active-tab-changed', active);
  }

  private wireTab(tab: Tab): void {
    tab.on('state-changed', () => this.emitList());

    const wc = tab.view.webContents;

    // Stream Mode frame guard: must exist before the first document loads, so
    // no frame's liveness announce is missed.
    this.guard(wc);

    wc.setWindowOpenHandler(({ url, disposition }) => {
      if (disposition === 'foreground-tab' || disposition === 'background-tab') {
        this.create(url, { activate: disposition !== 'background-tab' });
        return { action: 'deny' };
      }
      if (disposition === 'new-window') {
        // Real popup (OAuth / SSO / postMessage flows): allow it so
        // window.opener survives, but run OUR preload so the masker + shroud +
        // webdriver patch apply just like a tab.
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            webPreferences: {
              preload: this.preloadPath(),
              contextIsolation: true,
              sandbox: true,
              nodeIntegration: false,
              nodeIntegrationInSubFrames: true,
            },
            autoHideMenuBar: true,
          },
        };
      }
      return { action: 'deny' };
    });

    // Wire UA spoofing + tab routing onto managed popups.
    wc.on('did-create-window', (popup) => {
      const pwc = popup.webContents;
      // Popups run the page preload (OAuth flows keep window.opener), so they
      // get the same Stream Mode protections, frame guard included.
      this.guard(pwc);
      pwc.setUserAgent(getUaForUrl(pwc.getURL() || 'about:blank', pwc.id));
      pwc.on('will-navigate', (_e, url) => {
        if (isGoogleAuthDomain(url, pwc.id)) setInGoogleAuthFlow(pwc.id, true);
        pwc.setUserAgent(getUaForUrl(url, pwc.id));
      });
      pwc.setWindowOpenHandler(({ url, disposition }) => {
        if (disposition === 'foreground-tab' || disposition === 'background-tab') {
          this.create(url, { activate: disposition !== 'background-tab' });
          return { action: 'deny' };
        }
        return { action: 'allow' };
      });
    });

    wc.on('will-navigate', (_event, url) => {
      if (isGoogleAuthDomain(url, wc.id)) setInGoogleAuthFlow(wc.id, true);
      wc.setUserAgent(getUaForUrl(url, wc.id));
    });

    wc.on('did-navigate', (_e, url) => {
      if (isGoogleAuthDomain(url, wc.id)) {
        setInGoogleAuthFlow(wc.id, true);
      } else if (!isAnyGoogleDomain(url)) {
        setInGoogleAuthFlow(wc.id, false);
      }
      wc.setUserAgent(getUaForUrl(url, wc.id));
    });

    // Catch-all curtain for page-initiated navigations (link clicks, form
    // POSTs, JS redirects, back/forward, reloads). We do NOT preventDefault:
    // the navigation (and its POST body) proceeds untouched; the old document
    // keeps compositing until the new one commits, and the renderer shroud
    // guarantees no unmasked frame regardless of timing.
    const wcNav = wc as WebContents & {
      on(
        event: 'did-start-navigation',
        listener: (
          e: Electron.Event,
          url: string,
          isInPlace: boolean,
          isMainFrame: boolean,
        ) => void,
      ): void;
    };
    wcNav.on('did-start-navigation', (_e, url, isInPlace, isMainFrame) => {
      if (!isMainFrame || isInPlace) return;
      if (!this.streamOn() || isInternalUrl(url)) return;
      // Only curtain the VISIBLE tab. Background tabs rely on the renderer
      // shroud (zero leak) and have no flicker to hide; curtaining them would
      // needlessly expand the overlay over the active tab.
      if (this.activeId !== tab.id) return;
      if (this.curtain.isActive(tab.id)) return;
      void this.curtain.raise(tab.id, tab.view, 'screenshot');
    });

    // Failed loads / crashes drop the curtain (error page will cover instead).
    wc.on('did-fail-load', (_e, code, _desc, _url, isMainFrame) => {
      if (isMainFrame && code !== -3) this.curtain.drop(tab.id);
    });
    wc.on('render-process-gone', () => this.curtain.drop(tab.id));

    // Apply the host's persisted zoom once the document is ready.
    wc.on('did-finish-load', () => this.applyPersistedZoom(tab));
    wc.on('zoom-changed', (_e, direction) => {
      // Ctrl+wheel zoom (Chromium-native): mirror into state + persist.
      const cur = tab.getZoomFactor();
      const next = Math.min(5, Math.max(0.25, direction === 'in' ? cur * 1.1 : cur / 1.1));
      tab.setZoomFactor(next);
      this.persistZoom(tab.host(), next);
    });

    // HTML5 video fullscreen → hide chrome, tab fills the window.
    wc.on('enter-html-full-screen', () => this.setHtmlFullscreen(true));
    wc.on('leave-html-full-screen', () => this.setHtmlFullscreen(false));

    // Find results → forward to the chrome UI find bar.
    wc.on('found-in-page', (_e, result) => {
      this.emit('found-in-page', {
        tabId: tab.id,
        activeMatchOrdinal: result.activeMatchOrdinal,
        matches: result.matches,
      });
    });

    // Hover link preview (masked in main before it reaches the status view).
    wc.on('update-target-url', (_e, url) => {
      this.emit('update-target-url', { tabId: tab.id, url });
    });

    // Right-click page menu, rendered by the chrome UI (React, themed),
    // not a native popup. Click coordinates are relative to the tab view;
    // translate to window coordinates for the full-window chromeView.
    wc.on('context-menu', (_e, params) => {
      this.emit('page-context-menu', {
        wc,
        params,
        windowX: params.x,
        windowY: params.y + this.chromeBounds.top,
      });
    });
  }

  private emitList(): void {
    this.emit('tabs-changed', this.listState());
  }
}
