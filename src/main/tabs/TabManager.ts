import path from 'node:path';
import { EventEmitter } from 'node:events';
import { app, BaseWindow, webContents, type WebContents, type WebFrameMain } from 'electron';
import { Tab, teardownView } from './Tab';
import type { ChromeBounds, TabState } from '../../shared/types';
import type { TabSnapshot } from '../../shared/memorySaver';
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
  /**
   * Revives in flight, by tab id. A Map (not a Set) because a second caller
   * must be able to AWAIT the one already running: a URL typed while the tab
   * is still waking up would otherwise find no webContents and be dropped.
   */
  private readonly reviving = new Map<string, Promise<boolean>>();
  /**
   * Detachers for the webContents listeners wireTab put on each tab's CURRENT
   * webContents. A discard replaces the webContents, so they must come off.
   */
  private readonly tabWcListeners = new Map<string, Array<() => void>>();

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
    const tabWebContentsIds = new Set(
      this.tabs.map((t) => t.view?.webContents.id).filter((id): id is number => id !== undefined),
    );
    for (const tab of [...this.tabs]) {
      const wc = tab.view?.webContents;
      if (wc) {
        try {
          unregisterTabFromExtensions(wc);
        } catch {
          // ignore
        }
      }
      this.unwireTab(tab);
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
      this.tabs.some((t) => t.view?.webContents.id === webContentsId)
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
    // A discarded tab has no frame to screenshot: always a solid panel.
    const kind = tab.view && !isInternalUrl(tab.url) ? 'screenshot' : 'solid';
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
    // A deferLoad tab is born discarded (no webContents at all): it registers
    // with the extension runtime and gets its guard when it materializes.
    if (tab.view) this.attachTabWebContents(tab);
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
    return this.tabs.find((t) => t.view?.webContents.id === wc.id) ?? null;
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
    const wc = tab.view?.webContents;
    if (wc) {
      // Guards hold timers and webContents listeners: drop them with the tab
      // (the guard also self-disposes on 'destroyed', this just does it earlier).
      this.frameGuards.get(wc.id)?.dispose();
      try {
        unregisterTabFromExtensions(wc);
      } catch {
        // ignore
      }
    }
    if (tab.view) {
      try {
        this.window.contentView.removeChildView(tab.view);
      } catch {
        // view might not be attached
      }
    }
    this.unwireTab(tab);
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
    // The Memory Saver's idle clock counts from the moment a tab STOPS being
    // used, not from the moment it was selected. Stamping only the incoming
    // tab would make a tab you sat on for three hours instantly discardable
    // the second you leave it (its lastActiveAt would be three hours old).
    // So stamp the OUTGOING tab too: from here on, it is idle.
    const now = Date.now();
    const leaving = this.tabs.find((t) => t.id === this.activeId);
    if (leaving && leaving.id !== id) leaving.lastActiveAt = now;
    this.activeId = id;
    tab.lastActiveAt = now;
    // A discarded tab (Memory Saver, or a lazily restored session tab) has no
    // webContents at all: rebuild it. Deliberately NOT awaited, so a tab
    // switch never blocks on the curtain ack; reviveTab does the rest in
    // order (curtain, then view, then load).
    if (tab.isDiscarded) {
      void this.reviveTab(tab);
    }
    this.applyActiveBounds();
    this.bringActiveToFront();
    const wc = tab.view?.webContents;
    if (wc) {
      try {
        notifyTabSelected(wc);
      } catch {
        // extensions runtime not available, non-fatal
      }
    }
    this.emitList();
  }

  // --- Memory Saver ---------------------------------------------------------

  /**
   * Free this tab's renderer, keeping the tab itself (url, title, favicon and
   * session history). Returns false when the tab is protected.
   *
   * THE ORDER OF THE STEPS BELOW IS THE FEATURE. electron-chrome-extensions
   * relays every webContents destruction back into TabManager.close(), so a
   * discard that still looks like one of our tabs when the extension runtime
   * hears about it would CLOSE the tab instead of freeing it. The tab must be
   * severed from its webContents (step 4) BEFORE the runtime is told (step 5),
   * and the runtime must be told BEFORE the renderer dies (step 6). This is
   * the same invariant close() already relies on.
   */
  discard(id: string): boolean {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return false;
    // Fail-closed refusals: never the visible tab, never an internal page
    // (it holds no document), never one already freed or mid-revive.
    if (this.isShuttingDown()) return false;
    if (tab.isDiscarded || tab.isInternal) return false;
    if (tab.id === this.activeId) return false;
    if (this.reviving.has(tab.id)) return false;
    const wc = tab.view?.webContents;
    if (!wc || wc.isDestroyed()) return false;

    // 1. Snapshot the session history while the renderer is still alive.
    tab.captureNavigation();

    // 2. Release the curtain record + this window's overlay refcount, or the
    //    chromeView would stay expanded over a tab that no longer exists.
    this.curtain.handleTabClosed(tab.id);

    // 3. Drop the frame guard (keyed by webContents id, timers and listeners).
    this.frameGuards.get(wc.id)?.dispose();

    // 4. Sever the identity: from here on, ownsWebContents()/findByWebContents()
    //    no longer resolve this webContents to a tab, in ANY window. Detaching
    //    the listeners also protects tab.url from the about:blank load below.
    if (tab.view) {
      try {
        this.window.contentView.removeChildView(tab.view);
      } catch {
        // not attached
      }
    }
    this.unwireTab(tab);
    const dying = tab.detachView();

    // 5. Tell the extension runtime. Its removeTab callback resolves the
    //    window from the webContents, which now finds nothing: no close().
    try {
      unregisterTabFromExtensions(wc);
    } catch {
      // ignore
    }

    // 6. Kill the renderer for real. THIS is where the memory comes back.
    if (dying) teardownView(dying);

    this.emitList();
    return true;
  }

  /**
   * Rebuild a discarded tab's webContents and replay its saved history.
   *
   * Stream Mode safety, in order: the curtain goes up FIRST (and is awaited)
   * while the tab still has no view at all, so there is literally no surface
   * at its z-position that could paint; then the view is built, which arms the
   * L0 shroud (the page preload runs at document-start on the replayed
   * navigation) and the L1.5 frame guard BEFORE any document loads. Only then
   * can a pixel exist.
   */
  private async reviveTab(tab: Tab): Promise<void> {
    const materialized = await this.materializeTab(tab);
    if (!materialized) return;
    // Curtain up, shroud armed, guard armed: safe to let a document load.
    // Replaying the saved entries is not a user visit: suppress the history
    // recording for that one navigation.
    tab.beginRestoreNavigation();
    void tab.restoreNavigation();
  }

  /**
   * Rebuild the webContents WITHOUT navigating, curtain first. Returns false
   * when the revive was abandoned (window closing, tab closed or already
   * awake while we awaited the curtain).
   *
   * Split out from reviveTab because an explicit navigation into a dormant tab
   * must materialize it and then load the URL the user asked for, never replay
   * the page it was sleeping on.
   */
  private materializeTab(tab: Tab): Promise<boolean> {
    // Already waking: join it rather than bail, so the caller that follows
    // (an explicit navigation) still finds a webContents when we resolve.
    const inflight = this.reviving.get(tab.id);
    if (inflight) return inflight;
    const run = this.runMaterialize(tab).finally(() => this.reviving.delete(tab.id));
    this.reviving.set(tab.id, run);
    return run;
  }

  private async runMaterialize(tab: Tab): Promise<boolean> {
    if (this.isShuttingDown() || !tab.isDiscarded) return false;

    await this.preRaise(tab, tab.url);

    // The world may have moved while we awaited the curtain ack.
    if (this.isShuttingDown() || !this.tabs.includes(tab) || !tab.isDiscarded) return false;

    tab.createView();
    this.rewireTab(tab);
    this.attachTabWebContents(tab);
    if (tab.view) {
      this.window.contentView.addChildView(tab.view);
      tab.setBounds(tab.getBounds());
    }

    if (this.activeId === tab.id) {
      this.applyActiveBounds();
      this.bringActiveToFront();
      const wc = tab.view?.webContents;
      if (wc) {
        try {
          notifyTabSelected(wc);
        } catch {
          // non-fatal
        }
      }
    }
    this.emitList();
    return true;
  }

  /** Guard + register the tab's CURRENT webContents (creation and revive). */
  private attachTabWebContents(tab: Tab): void {
    const wc = tab.view?.webContents;
    if (!wc) return;
    // The guard must exist before the first document loads, so no frame's
    // liveness announce is missed.
    this.guard(wc);
    try {
      registerTabWithExtensions(wc, this.window);
    } catch (err) {
      console.warn('[tabs] registerTabWithExtensions failed:', err);
    }
  }

  /** Snapshot every tab for the Memory Saver policy (see shared/memorySaver). */
  discardCandidates(): TabSnapshot[] {
    return this.tabs.map((t) => ({
      id: t.id,
      lastActiveAt: t.lastActiveAt,
      isActive: t.id === this.activeId,
      isAudible: t.isAudible,
      isMuted: t.isMuted,
      isInternal: t.isInternal,
      isDiscarded: t.isDiscarded,
      isLoading: t.isLoading,
      hasCurtain: this.curtain.isActive(t.id),
      host: t.host().toLowerCase(),
    }));
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
    // A dormant tab has no webContents to load into: wake it first, and drop
    // the saved history so the revive does not replay the OLD page over the
    // URL the user just asked for.
    if (tab.isDiscarded) await this.wakeForNavigation(tab);
    if (!isInternalUrl(url)) await this.preRaise(tab, url);
    await tab.load(url);
  }

  /**
   * Materialize a dormant tab for an explicit navigation (address bar, Home,
   * reload). The tab must come back EMPTY: its saved session history belongs
   * to the page the user is leaving, and replaying it would overwrite the
   * navigation they just asked for.
   */
  private async wakeForNavigation(tab: Tab): Promise<void> {
    tab.forgetNavigation();
    await this.materializeTab(tab);
  }

  async back(id: string): Promise<void> {
    const tab = this.tabs.find((t) => t.id === id);
    // A discarded tab has no navigation history to walk yet: it comes back
    // (with its history) when it is activated.
    const nav = tab?.view?.webContents.navigationHistory;
    if (!tab || !nav || !nav.canGoBack()) return;
    const target = nav.getEntryAtIndex(nav.getActiveIndex() - 1)?.url;
    await this.preRaise(tab, target);
    tab.back();
  }

  async forward(id: string): Promise<void> {
    const tab = this.tabs.find((t) => t.id === id);
    const nav = tab?.view?.webContents.navigationHistory;
    if (!tab || !nav || !nav.canGoForward()) return;
    const target = nav.getEntryAtIndex(nav.getActiveIndex() + 1)?.url;
    await this.preRaise(tab, target);
    tab.forward();
  }

  async reload(id: string): Promise<void> {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;
    // Reloading a dormant tab IS waking it: rebuild it (replaying its saved
    // history, which is exactly what a reload should show) instead of doing
    // nothing while a Stream Mode curtain hangs for six seconds.
    if (tab.isDiscarded) {
      await this.reviveTab(tab);
      return;
    }
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
    tab.view?.webContents.findInPage(text, { forward, matchCase, findNext: false });
  }

  stopFind(id: string): void {
    const tab = this.tabs.find((t) => t.id === id);
    tab?.view?.webContents.stopFindInPage('clearSelection');
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
      // A discarded tab has no view: nothing to lay out (and nothing painting).
      if (!t.view || t.view.webContents.isDestroyed()) continue;
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
    // Mid-revive the active tab has no view yet; reviveTab re-runs this once
    // the view exists.
    if (!active?.view) return;
    try {
      this.window.contentView.removeChildView(active.view);
    } catch {
      // not attached, that's fine
    }
    this.window.contentView.addChildView(active.view);
    this.emit('active-tab-changed', active);
  }

  /** Tab-object listeners: they survive a discard (the Tab object lives on). */
  private wireTab(tab: Tab): void {
    tab.on('state-changed', () => this.emitList());
    if (tab.view) this.rewireTab(tab);
  }

  /** Take off the webContents listeners of a tab's CURRENT webContents. */
  private unwireTab(tab: Tab): void {
    const offs = this.tabWcListeners.get(tab.id);
    if (!offs) return;
    for (const off of offs) off();
    this.tabWcListeners.delete(tab.id);
  }

  /**
   * Attach every webContents listener to the tab's CURRENT webContents, and
   * remember how to take them off. Called on creation AND on every revive: a
   * discard replaces the webContents, so listeners captured on the old one
   * would all be bound to a corpse.
   */
  private rewireTab(tab: Tab): void {
    const wc = tab.view?.webContents;
    if (!wc) return;
    this.unwireTab(tab);
    const offs: Array<() => void> = [];
    this.tabWcListeners.set(tab.id, offs);
    /** Register a listener and record its detacher. */
    const on = (event: string, handler: (...args: never[]) => void): void => {
      const emitter = wc as unknown as {
        on(e: string, h: (...args: never[]) => void): void;
        removeListener(e: string, h: (...args: never[]) => void): void;
      };
      emitter.on(event, handler);
      offs.push(() => {
        try {
          emitter.removeListener(event, handler);
        } catch {
          // webContents already gone
        }
      });
    };

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
    on('did-create-window', ((popup: Electron.BrowserWindow) => {
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
    }) as (...args: never[]) => void);

    on('will-navigate', ((_event: unknown, url: string) => {
      if (isGoogleAuthDomain(url, wc.id)) setInGoogleAuthFlow(wc.id, true);
      wc.setUserAgent(getUaForUrl(url, wc.id));
    }) as (...args: never[]) => void);

    on('did-navigate', ((_e: unknown, url: string) => {
      if (isGoogleAuthDomain(url, wc.id)) {
        setInGoogleAuthFlow(wc.id, true);
      } else if (!isAnyGoogleDomain(url)) {
        setInGoogleAuthFlow(wc.id, false);
      }
      wc.setUserAgent(getUaForUrl(url, wc.id));
    }) as (...args: never[]) => void);

    // Catch-all curtain for page-initiated navigations (link clicks, form
    // POSTs, JS redirects, back/forward, reloads). We do NOT preventDefault:
    // the navigation (and its POST body) proceeds untouched; the old document
    // keeps compositing until the new one commits, and the renderer shroud
    // guarantees no unmasked frame regardless of timing.
    on('did-start-navigation', ((
      _e: unknown,
      url: string,
      isInPlace: boolean,
      isMainFrame: boolean,
    ) => {
      if (!isMainFrame || isInPlace) return;
      if (!this.streamOn() || isInternalUrl(url)) return;
      // Only curtain the VISIBLE tab. Background tabs rely on the renderer
      // shroud (zero leak) and have no flicker to hide; curtaining them would
      // needlessly expand the overlay over the active tab.
      if (this.activeId !== tab.id) return;
      // A revive already raised a solid curtain: it drops on the replayed
      // document's STREAM_READY. Never raise a second one.
      if (this.curtain.isActive(tab.id)) return;
      void this.curtain.raise(tab.id, tab.view, 'screenshot');
    }) as (...args: never[]) => void);

    // Failed loads / crashes drop the curtain (error page will cover instead).
    on('did-fail-load', ((
      _e: unknown,
      code: number,
      _desc: string,
      _url: string,
      isMainFrame: boolean,
    ) => {
      if (isMainFrame && code !== -3) this.curtain.drop(tab.id);
    }) as (...args: never[]) => void);
    on('render-process-gone', (() => this.curtain.drop(tab.id)) as (...args: never[]) => void);

    // Apply the host's persisted zoom once the document is ready.
    on('did-finish-load', (() => this.applyPersistedZoom(tab)) as (...args: never[]) => void);
    on('zoom-changed', ((_e: unknown, direction: string) => {
      // Ctrl+wheel zoom (Chromium-native): mirror into state + persist.
      const cur = tab.getZoomFactor();
      const next = Math.min(5, Math.max(0.25, direction === 'in' ? cur * 1.1 : cur / 1.1));
      tab.setZoomFactor(next);
      this.persistZoom(tab.host(), next);
    }) as (...args: never[]) => void);

    // HTML5 video fullscreen → hide chrome, tab fills the window.
    on('enter-html-full-screen', (() => this.setHtmlFullscreen(true)) as (...args: never[]) => void);
    on('leave-html-full-screen', (() => this.setHtmlFullscreen(false)) as (...args: never[]) => void);

    // Find results → forward to the chrome UI find bar.
    on('found-in-page', ((
      _e: unknown,
      result: { activeMatchOrdinal: number; matches: number },
    ) => {
      this.emit('found-in-page', {
        tabId: tab.id,
        activeMatchOrdinal: result.activeMatchOrdinal,
        matches: result.matches,
      });
    }) as (...args: never[]) => void);

    // Hover link preview (masked in main before it reaches the status view).
    on('update-target-url', ((_e: unknown, url: string) => {
      this.emit('update-target-url', { tabId: tab.id, url });
    }) as (...args: never[]) => void);

    // Right-click page menu, rendered by the chrome UI (React, themed),
    // not a native popup. Click coordinates are relative to the tab view;
    // translate to window coordinates for the full-window chromeView.
    on('context-menu', ((_e: unknown, params: Electron.ContextMenuParams) => {
      this.emit('page-context-menu', {
        wc,
        params,
        windowX: params.x,
        windowY: params.y + this.chromeBounds.top,
      });
    }) as (...args: never[]) => void);
  }

  private emitList(): void {
    this.emit('tabs-changed', this.listState());
  }
}
