import { app, ipcMain, Menu, nativeTheme, Notification, session, shell, webContents } from 'electron';
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import os from 'node:os';
import { buildApplicationMenu } from '../menu';
import { t } from '../i18n';
import { IPC } from '../../shared/ipcChannels';
import type {
  AppSettings,
  ChromeBounds,
  ClearBrowsingDataOptions,
  PrintExecuteOptions,
  PrintPreviewOptions,
  Suggestion,
} from '../../shared/types';
import { sameMaskingConfig, type StreamModeConfig } from '../../shared/streamConfig';
import { buildSearchUrl } from '../../shared/searchEngines';
import { currentEngines, defaultEngine } from '../search/engines';
import { isUrlLike, normalizeInput } from '../../shared/urlUtils';
import { getPreconnect } from '../perf/PreconnectController';
import type { AppWindow } from '../window';
import {
  allWindows,
  focusedWindow,
  isChromeViewContents,
  openNewWindow,
  windowFromChrome,
  windowFromPageContents,
} from '../windows';
import { getStreamMode } from '../stream-mode/StreamModeController';
import { installPermissionHandlers } from '../stream-mode/permissions';
import {
  allowPendingCertException,
  clearCertExceptions,
  installNetGuards,
} from '../netGuards';
import { isDefaultBrowser } from '../defaultBrowser';
import { detectSources, runImport, type ImportSelection } from '../import/importer';
import { getPanic } from '../stream-mode/panic';
import { getCaptureHandshake } from '../stream-mode/captureHandshake';
import { runPreflight } from '../../shared/preflight';
import { DownloadManager } from '../downloads/DownloadManager';
import { UpdateController } from '../updates';
import {
  listHistory,
  searchHistory,
  listTopSites,
  deleteHistoryEntry,
  clearHistory,
  deleteHistorySince,
} from '../storage/history';
import {
  listBookmarks,
  addBookmark,
  removeBookmark,
  updateBookmark,
  searchBookmarks,
  findBookmarkByUrl,
  listFolders,
  addFolder,
  renameFolder,
  removeFolder,
  moveFolder,
  moveBookmarkToFolder,
  reorderMixed,
} from '../storage/bookmarks';
import type { MixedItemRef } from '../../shared/bookmarkOrdering';
import { getSettings, setSettings } from '../storage/settings';
import { fetchSearchSuggestions } from '../search/suggestEngine';
import {
  listExtensions,
  reorderExtensions,
  uninstallExtensionById,
} from '../extensions/manager';

/**
 * All ipcMain registrations live here and are performed ONCE at boot
 * (registerIpcHandlers): Electron throws on duplicated ipcMain.handle
 * channels, so nothing per-window may be registered in this function.
 * Window-scoped calls resolve their target from the SENDER through the
 * live-window registry:
 *   - voksa.* calls come from a chromeView -> windowFromChrome(event.sender)
 *   - page preload messages come from a tab/popup -> windowFromPageContents
 * Per-window event pushes (tabs-changed, find results, window state...) are
 * wired by wireWindowIpc, called once for EACH window created.
 */

/** Target window of a chrome-UI invoke; null when the window is gone. */
function senderWindow(e: IpcMainInvokeEvent | IpcMainEvent): AppWindow | null {
  return windowFromChrome(e.sender);
}

/** Guarded send to one chromeView. */
function sendToChrome(win: AppWindow, channel: string, ...args: unknown[]): void {
  const wc = win.chromeView.webContents;
  if (!wc.isDestroyed()) wc.send(channel, ...args);
}

/** Guarded send to EVERY window's chromeView (global data: bookmarks...). */
function broadcastToChromes(channel: string, ...args: unknown[]): void {
  for (const win of allWindows()) sendToChrome(win, channel, ...args);
}

/**
 * OS toast when an update finished downloading. The in-app dot on the burger
 * button only reaches a user who looks at the window; this reaches one who
 * does not. Clicking it restarts into the new version. Best-effort by design:
 * a platform without notification support (or a failed Windows toast) must
 * never break the update flow, which works fine without any toast at all.
 */
function notifyUpdateReady(version: string | undefined, install: () => void): void {
  try {
    if (!Notification.isSupported()) return;
    const toast = new Notification({
      title: version
        ? t('Voksa {version} est prête', { version })
        : t('Une mise à jour de Voksa est prête'),
      body: t('Redémarrez pour installer la nouvelle version.'),
      silent: false,
    });
    toast.on('click', () => {
      const win = focusedWindow();
      if (win && !win.window.isDestroyed()) win.window.focus();
      install();
    });
    // win32 only: a toast can fail (no AppUserModelID, notifications off).
    toast.on('failed', (_e, error) => {
      console.warn('[updates] notification failed:', error);
    });
    toast.show();
  } catch (err) {
    console.warn('[updates] could not show the update notification:', err);
  }
}

export function registerIpcHandlers(): void {
  const stream = getStreamMode();

  // Stream config broadcasts: reach every chrome UI AND every frame of every
  // tab (subframes run their own masker under nodeIntegrationInSubFrames).
  let prevStreamConfig = stream.getConfig();
  stream.on('config-changed', (config: StreamModeConfig) => {
    const maskingChanged = !sameMaskingConfig(prevStreamConfig, config);
    prevStreamConfig = config;
    // Can fire after teardown: a recorder-watcher poll in flight at quit
    // completes late; allWindows() filters destroyed windows and sends are
    // guarded, so a late event is a no-op instead of a crash.
    const wins = allWindows();
    for (const win of wins) {
      // Stream just went live while a status bubble may be on screen.
      if (config.enabled) win.statusView.hide({ immediate: true });
      sendToChrome(win, IPC.STREAM_CONFIG_CHANGED, config);
    }
    // Cosmetic-only change (accent color): the chrome UIs above are the only
    // consumers. Page maskers never read it, so skip the per-frame push and
    // spare a full re-sweep of every page on each color-picker step.
    if (!maskingChanged) return;
    const chromeIds = new Set(wins.map((w) => w.chromeView.webContents.id));
    for (const wc of webContents.getAllWebContents()) {
      if (chromeIds.has(wc.id)) continue;
      try {
        for (const frame of wc.mainFrame.framesInSubtree) {
          frame.send(IPC.STREAM_CONFIG_CHANGED, config);
        }
      } catch {
        try {
          wc.send(IPC.STREAM_CONFIG_CHANGED, config);
        } catch {
          // wc torn down; ignore
        }
      }
    }
  });

  // --- Permissions (Stream OFF prompts, Stream ON hard-denies) -------------
  const pendingPerms = new Map<string, (r: { allow: boolean; remember: boolean }) => void>();
  let permReqId = 0;
  ipcMain.on(IPC.PERMISSION_RESPOND, (_e, payload: { id: string; allow: boolean; remember: boolean }) => {
    const resolve = pendingPerms.get(payload?.id);
    if (resolve) {
      pendingPerms.delete(payload.id);
      resolve({ allow: !!payload.allow, remember: !!payload.remember });
    }
  });
  installPermissionHandlers(session.defaultSession, {
    getStreamConfig: () => stream.getConfig(),
    isChromeContents: (wc) => isChromeViewContents(wc),
    // DMCA stage 2: a routed tab needs device-label exposure + setSinkId.
    // Resolved through the live-window registry at CHECK time (never captured):
    // the route can be set or cleared at any moment.
    isAudioRouted: (wc) => {
      if (!wc) return false;
      for (const win of allWindows()) {
        const tab = win.tabs.findByWebContents(wc);
        if (tab) return tab.audioRouteLabel != null;
      }
      return false;
    },
    getRemembered: (origin, permission) =>
      getSettings().sitePermissions?.[origin]?.[permission],
    remember: (origin, permission, decision) => {
      const s = getSettings();
      const sp = { ...(s.sitePermissions ?? {}) };
      sp[origin] = { ...(sp[origin] ?? {}), [permission]: decision };
      setSettings({ sitePermissions: sp });
    },
    promptUser: (req, requester) =>
      new Promise((resolve) => {
        // Prompt in the window that hosts the requesting page; a page whose
        // window is already gone gets an automatic deny.
        const target = (requester && windowFromPageContents(requester)) ?? focusedWindow();
        if (!target) {
          resolve({ allow: false, remember: false });
          return;
        }
        const id = `perm-${permReqId++}`;
        pendingPerms.set(id, resolve);
        sendToChrome(target, IPC.PERMISSION_REQUEST, {
          id,
          origin: req.origin,
          permission: req.permission,
        });
        setTimeout(() => {
          if (pendingPerms.has(id)) {
            pendingPerms.delete(id);
            resolve({ allow: false, remember: false });
          }
        }, 30000);
      }),
  });

  // --- Network guards (HTTP auth dialog + TLS interstitial) ----------------
  // App-wide events, registered once like the permission handlers above.
  installNetGuards((win, channel, payload) => sendToChrome(win, channel, payload));

  // --- Tabs -----------------------------------------------------------------
  ipcMain.handle(IPC.TAB_CREATE, (e, url?: string) => {
    const win = senderWindow(e);
    if (!win) return null;
    return win.tabs.create(url).id;
  });
  ipcMain.handle(IPC.TAB_CLOSE, (e, id: string) => senderWindow(e)?.tabs.close(id));
  ipcMain.handle(IPC.TAB_ACTIVATE, (e, id: string) => senderWindow(e)?.tabs.setActive(id));
  ipcMain.handle(IPC.TAB_REORDER, (e, ids: string[]) => senderWindow(e)?.tabs.reorder(ids));
  // `engine` is the tab-to-search override: the address bar is in keyword mode
  // ("duckduckgo.com" + Space), so `url` is a QUERY for that engine, not an
  // address. Main still builds every search URL: the renderer only names the
  // engine it was told to use. Anything unknown falls back to plain input
  // handling, so a hostile sender cannot inject a URL through this door.
  ipcMain.handle(IPC.TAB_NAVIGATE, (e, id: string, url: string, engine?: string) => {
    const engines = currentEngines();
    const named = engine ? engines.find((def) => def.id === engine) : undefined;
    const target = named ? buildSearchUrl(named, url.trim()) : url;
    senderWindow(e)?.tabs.navigate(id, target);
  });
  ipcMain.handle(IPC.TAB_BACK, (e, id: string) => senderWindow(e)?.tabs.back(id));
  ipcMain.handle(IPC.TAB_FORWARD, (e, id: string) => senderWindow(e)?.tabs.forward(id));
  ipcMain.handle(IPC.TAB_RELOAD, (e, id: string) => senderWindow(e)?.tabs.reload(id));
  // TLS interstitial "continue anyway": promote the pending certificate
  // exception for the host the user actually SAW in the interstitial (the
  // failed URL's host, never a parameter from the renderer), then retry the
  // navigation. Returns false when nothing was pending: the caller must not
  // pretend an exception was granted.
  ipcMain.handle(IPC.TAB_TLS_PROCEED, (e, id: string) => {
    const win = senderWindow(e);
    const failed = win?.tabs.errorOf(id)?.url;
    if (!win || !failed) return false;
    let host = '';
    try {
      host = new URL(failed).host;
    } catch {
      return false;
    }
    if (!host || !allowPendingCertException(host)) return false;
    void win.tabs.reload(id);
    return true;
  });
  ipcMain.handle(IPC.TAB_STOP, (e, id: string) => senderWindow(e)?.tabs.stop(id));
  ipcMain.handle(IPC.TAB_LIST, (e) => senderWindow(e)?.tabs.listState() ?? []);
  ipcMain.handle(IPC.TAB_REOPEN_CLOSED, (e) => senderWindow(e)?.tabs.reopenClosed());
  ipcMain.handle(IPC.TAB_MUTE, (e, id: string, muted?: boolean) =>
    senderWindow(e)?.tabs.setMuted(id, muted),
  );
  ipcMain.handle(IPC.TAB_DUPLICATE, (e, id: string) => senderWindow(e)?.tabs.duplicate(id));
  ipcMain.handle(IPC.TAB_DISCARD, (e, id: string) => senderWindow(e)?.tabs.discard(id) ?? false);
  ipcMain.handle(IPC.TAB_SET_PINNED, (e, id: string, pinned: boolean) =>
    senderWindow(e)?.tabs.setPinned(id, !!pinned),
  );
  ipcMain.handle(IPC.TAB_ALLOW_STREAM_AUDIO, (e, id: string) =>
    senderWindow(e)?.tabs.allowStreamAudio(id),
  );
  // DMCA stage 2: route a tab's audio to a chosen output device (by LABEL,
  // null = system default). See shared/audioRouting.ts for why labels.
  ipcMain.handle(IPC.AUDIO_ROUTE_SET, (e, id: string, label: string | null) =>
    senderWindow(e)?.tabs.setAudioRoute(
      String(id),
      typeof label === 'string' && label.length > 0 ? label : null,
    ),
  );
  // Synchronous route read for the page preload's document-start re-arm.
  // returnValue MUST always be set, whatever happens: a sendSync with no
  // returnValue hangs the calling renderer.
  ipcMain.on(IPC.AUDIO_ROUTE_GET_SYNC, (event) => {
    let label: string | null = null;
    try {
      const win = windowFromPageContents(event.sender);
      label = win?.tabs.findByWebContents(event.sender)?.audioRouteLabel ?? null;
    } catch {
      label = null;
    }
    event.returnValue = label;
  });
  // Main-frame resolve verdict. matched:false = the chosen device no longer
  // exists (labels present, label absent): clear the route so the UI stops
  // claiming a routing that is not applied (fail-visible, never silent). The
  // verdict carries the LABEL it judged: a stale in-flight verdict about a
  // previous label must not clear the route the user just changed to.
  ipcMain.on(
    IPC.AUDIO_ROUTE_STATUS,
    (event, payload: { matched?: boolean; label?: string } | undefined) => {
      try {
        if (event.senderFrame && event.senderFrame.parent !== null) return; // subframe
      } catch {
        return; // frame already disposed
      }
      const win = windowFromPageContents(event.sender);
      const tab = win?.tabs.findByWebContents(event.sender);
      if (!win || !tab) return;
      if (
        payload?.matched === false &&
        tab.audioRouteLabel != null &&
        payload.label === tab.audioRouteLabel
      ) {
        console.warn(
          `[audio-route] output device "${tab.audioRouteLabel}" not resolvable in this tab; falling back to system default`,
        );
        win.tabs.setAudioRoute(tab.id, null);
      }
    },
  );
  ipcMain.handle(IPC.TAB_CLOSE_OTHERS, (e, id: string) => senderWindow(e)?.tabs.closeOthers(id));
  ipcMain.handle(IPC.TAB_CLOSE_RIGHT, (e, id: string) => senderWindow(e)?.tabs.closeRight(id));

  // --- Find in page ---------------------------------------------------------
  ipcMain.handle(
    IPC.FIND_START,
    (e, id: string, text: string, forward: boolean, matchCase: boolean) =>
      senderWindow(e)?.tabs.findInPage(id, text, forward, matchCase),
  );
  ipcMain.handle(IPC.FIND_STOP, (e, id: string) => senderWindow(e)?.tabs.stopFind(id));

  // --- Zoom -----------------------------------------------------------------
  ipcMain.handle(IPC.ZOOM_ADJUST, (e, id: string, delta: number) =>
    senderWindow(e)?.tabs.adjustZoom(id, delta),
  );
  ipcMain.handle(IPC.ZOOM_RESET, (e, id: string) => senderWindow(e)?.tabs.resetZoom(id));

  // --- Printing (preview dialog in the chrome UI) ----------------------------
  ipcMain.handle(IPC.PRINT_LIST_PRINTERS, (e, tabId: string) =>
    senderWindow(e)?.printing.listPrinters(tabId) ?? [],
  );
  ipcMain.handle(IPC.PRINT_PREVIEW, (e, tabId: string, opts: PrintPreviewOptions) =>
    senderWindow(e)?.printing.preview(tabId, opts) ?? null,
  );
  ipcMain.handle(IPC.PRINT_EXECUTE, (e, tabId: string, opts: PrintExecuteOptions) =>
    senderWindow(e)?.printing.execute(tabId, opts) ?? false,
  );

  // --- Auto-update (GitHub Releases) -----------------------------------------
  const updates = new UpdateController();
  // Edge-detect the transition into 'ready': the controller re-broadcasts on
  // EVERY event, download-progress ticks included, so a naive check would fire
  // one toast per percent. 'ready' means the new version is already downloaded
  // and only waits for a restart.
  let wasReady = updates.getState().phase === 'ready';
  updates.onStateChanged((state) => {
    broadcastToChromes(IPC.UPDATES_STATE_CHANGED, state);
    const isReady = state.phase === 'ready';
    if (isReady && !wasReady) notifyUpdateReady(state.availableVersion, () => updates.install());
    wasReady = isReady;
  });
  ipcMain.handle(IPC.UPDATES_GET_STATE, () => updates.getState());
  ipcMain.handle(IPC.UPDATES_CHECK, () => updates.check());
  ipcMain.handle(IPC.UPDATES_INSTALL, () => updates.install());
  updates.scheduleChecks();

  // --- Page context menu (rendered in the chrome UI) -------------------------
  ipcMain.handle(
    IPC.PAGE_MENU_ACTION,
    (e, token: number, action: string, arg?: number | string) =>
      senderWindow(e)?.pageMenu.handleAction(token, action, arg),
  );

  // --- Downloads ------------------------------------------------------------
  // Session-scoped singleton: will-download covers every window's tabs, and
  // progress updates fan out to every chrome UI.
  const downloads = new DownloadManager(
    session.defaultSession,
    (items) => broadcastToChromes(IPC.DOWNLOADS_CHANGED, items),
    (webContentsId) => {
      // A download aborts the navigation: drop that tab's curtain immediately
      // instead of freezing until the safety timeout, whichever window owns it.
      for (const win of allWindows()) {
        const host = win.tabs.getAll().find((t) => t.view?.webContents.id === webContentsId);
        if (host) {
          win.curtain.drop(host.id);
          return;
        }
      }
    },
  );
  ipcMain.handle(IPC.DOWNLOADS_LIST, () => downloads.getAll());
  ipcMain.handle(IPC.DOWNLOAD_OPEN, (_e, id: string) => downloads.openFile(id));
  ipcMain.handle(IPC.DOWNLOAD_OPEN_FOLDER, (_e, id: string) => downloads.openFolder(id));
  ipcMain.handle(IPC.DOWNLOAD_CANCEL, (_e, id: string) => downloads.cancel(id));
  ipcMain.handle(IPC.DOWNLOAD_PAUSE, (_e, id: string) => downloads.pause(id));
  ipcMain.handle(IPC.DOWNLOAD_RESUME, (_e, id: string) => downloads.resume(id));
  ipcMain.handle(IPC.DOWNLOAD_REMOVE, (_e, id: string) => downloads.remove(id));
  ipcMain.handle(IPC.DOWNLOAD_CLEAR, () => downloads.clearCompleted());

  // --- Window layout ----------------------------------------------------------
  ipcMain.handle(IPC.TAB_SET_CHROME_BOUNDS, (e, bounds: ChromeBounds) => {
    senderWindow(e)?.updateChromeBounds(bounds);
  });
  ipcMain.handle(IPC.CHROME_SET_OVERLAY, (e, open: boolean) => {
    // With the chromeView transparent below the toolbar, expansion alone is
    // enough; the live tab view keeps rendering behind the menu. No need
    // to capture a screenshot.
    senderWindow(e)?.setOverlayMode(open);
  });

  // --- History --------------------------------------------------------------
  ipcMain.handle(IPC.HISTORY_LIST, (_e, limit?: number, offset?: number) =>
    listHistory(limit ?? 200, offset ?? 0),
  );
  ipcMain.handle(IPC.HISTORY_SEARCH, (_e, query: string, limit?: number) =>
    searchHistory(query, limit ?? 8),
  );
  ipcMain.handle(IPC.HISTORY_TOP_SITES, (_e, limit?: number) => listTopSites(limit ?? 8));
  ipcMain.handle(IPC.HISTORY_DELETE, (_e, id: string) => deleteHistoryEntry(id));
  ipcMain.handle(IPC.HISTORY_CLEAR, () => clearHistory());

  // --- Bookmarks ------------------------------------------------------------
  ipcMain.handle(IPC.BOOKMARKS_LIST, () => listBookmarks());
  ipcMain.handle(IPC.BOOKMARKS_FOLDERS_LIST, () => listFolders());
  // One atomic snapshot of both tables per mutation, to EVERY window: the
  // UI never renders a bookmark whose folder it hasn't heard of yet.
  const broadcastBookmarks = () => {
    broadcastToChromes(IPC.BOOKMARKS_CHANGED, {
      bookmarks: listBookmarks(),
      folders: listFolders(),
    });
  };

  // --- Browser-data import ---------------------------------------------------
  ipcMain.handle(IPC.IMPORT_SOURCES, () => detectSources());
  ipcMain.handle(IPC.IMPORT_RUN, (_e, selection: ImportSelection) => {
    const result = runImport(selection);
    // The import writes straight into the stores; every window must repaint
    // its bookmark surfaces (the history page queries on mount).
    if (result.ok && result.bookmarksImported > 0) broadcastBookmarks();
    return result;
  });

  ipcMain.handle(
    IPC.BOOKMARKS_ADD,
    (
      _e,
      payload: { url: string; title: string; faviconUrl: string | null; folderId?: string | null },
    ) => {
      const created = addBookmark(
        payload.url,
        payload.title,
        payload.faviconUrl,
        payload.folderId ?? null,
      );
      broadcastBookmarks();
      return created;
    },
  );
  ipcMain.handle(IPC.BOOKMARKS_REMOVE, (_e, id: string) => {
    removeBookmark(id);
    broadcastBookmarks();
  });
  ipcMain.handle(
    IPC.BOOKMARKS_UPDATE,
    (_e, id: string, patch: Parameters<typeof updateBookmark>[1]) => {
      // A folder change is a positional MOVE (append into the target's mixed
      // sequence), not a raw column write that could collide positions.
      const { folderId, ...rest } = patch;
      if (folderId !== undefined) moveBookmarkToFolder(id, folderId);
      updateBookmark(id, rest);
      broadcastBookmarks();
    },
  );
  ipcMain.handle(IPC.BOOKMARKS_MOVE, (_e, id: string, folderId: string | null) => {
    moveBookmarkToFolder(id, folderId);
    broadcastBookmarks();
  });
  ipcMain.handle(
    IPC.BOOKMARKS_REORDER_MIXED,
    (_e, container: string | null, items: MixedItemRef[]) => {
      reorderMixed(container ?? null, items);
      broadcastBookmarks();
    },
  );
  ipcMain.handle(IPC.BOOKMARKS_FOLDER_ADD, (_e, name: string, parentId?: string | null) => {
    const created = addFolder(name, parentId ?? null);
    broadcastBookmarks();
    return created;
  });
  ipcMain.handle(IPC.BOOKMARKS_FOLDER_RENAME, (_e, id: string, name: string) => {
    renameFolder(id, name);
    broadcastBookmarks();
  });
  ipcMain.handle(IPC.BOOKMARKS_FOLDER_REMOVE, (_e, id: string) => {
    removeFolder(id);
    broadcastBookmarks();
  });
  ipcMain.handle(IPC.BOOKMARKS_FOLDER_MOVE, (_e, id: string, parentId: string | null) => {
    moveFolder(id, parentId ?? null);
    broadcastBookmarks();
  });
  ipcMain.handle(IPC.BOOKMARKS_FIND_BY_URL, (_e, url: string) => findBookmarkByUrl(url));

  // --- Settings -------------------------------------------------------------
  ipcMain.handle(IPC.SETTINGS_GET, () => getSettings());
  ipcMain.handle(IPC.SETTINGS_UPDATE, (_e, patch: Partial<AppSettings>) => {
    // StreamModeController is the ONE writer of streamMode config. Strip any
    // streamMode field so this generic path can't create a second writer that
    // silently diverges from the controller's state.
    const { streamMode: _ignored, ...safe } = patch;
    const before = getSettings().language;
    const next = setSettings(safe);
    // Native menu labels are resolved at build time: rebuild on language
    // change so the menu follows without an app restart.
    if (next.language !== before) {
      Menu.setApplicationMenu(buildApplicationMenu(() => focusedWindow()));
    }
    // The panic hotkey follows its settings live (rebind, enable/disable).
    getPanic().syncRegistration();
    broadcastToChromes(IPC.SETTINGS_CHANGED, next);
    return next;
  });

  // --- Stream mode ----------------------------------------------------------
  // Panic controller: subscribes to stream toggles for its lazy hotkey
  // registration. A singleton like the rest of this block (CLAUDE.md 4.9).
  getPanic().init();
  ipcMain.handle(IPC.STREAM_PANIC, () => getPanic().toggle());

  // Capture Handshake: own the display-media picker so a shared Voksa surface
  // is masked before its first frame. Installed once (defaultSession global).
  getCaptureHandshake().install();
  ipcMain.on(IPC.CAPTURE_PICKER_PICK, (_e, payload: { pickId: string; sourceId: string | null }) => {
    getCaptureHandshake().resolvePick(payload?.pickId, payload?.sourceId ?? null);
  });
  // Debug-only: exercise the handshake without Chromium's getDisplayMedia
  // (which does not reach setDisplayMediaRequestHandler under CDP). Inert in
  // production: returns null unless the debug CDP port is set (smoke/debug).
  ipcMain.handle(IPC.CAPTURE_SIMULATE, async (e) => {
    if (!process.env.VOKSA_DEBUG_PORT) return null;
    const win = senderWindow(e);
    const requester = win?.tabs.getActive()?.view?.webContents ?? null;
    return getCaptureHandshake().simulateRequest(requester);
  });

  ipcMain.handle(IPC.STREAM_GET_CONFIG, () => stream.getConfig());
  // Synchronous config read for the page preload's document-start shroud
  // decision (must resolve before the first paint, no async round-trip).
  // Bundles the hostname so hostname-masking works on the very first sweep.
  ipcMain.on(IPC.STREAM_GET_CONFIG_SYNC, (event) => {
    event.returnValue = { config: stream.getConfig(), hostname: os.hostname() };
  });
  ipcMain.handle(IPC.STREAM_UPDATE_CONFIG, (_e, patch: Partial<StreamModeConfig>) =>
    stream.update(patch),
  );
  ipcMain.handle(IPC.STREAM_TOGGLE, () => stream.toggle());

  // Go-Live Preflight: scan the SENDER window's tabs for viewer-facing risks,
  // using the exact mask config the page masker uses (a finding here is what
  // Stream Mode would mask). The pure scanner lives in shared/preflight.ts.
  ipcMain.handle(IPC.PREFLIGHT_RUN, (e) => {
    const win = senderWindow(e);
    if (!win) return { findings: [], scanned: 0 };
    const cfg = stream.getConfig();
    const flags = {
      maskIPv4: cfg.maskIPv4,
      maskIPv6: cfg.maskIPv6,
      maskEmails: cfg.maskEmails,
      maskPhones: cfg.maskPhones,
      maskInternalHostnames: cfg.maskInternalHostnames,
    };
    const tabs = win.tabs.getAll().map((t) => ({
      id: t.id,
      title: t.title,
      url: t.url,
      isAudible: t.isAudible,
      isActive: win.tabs.isActiveTab(t.id),
      isInternal: t.isInternal,
    }));
    return runPreflight(tabs, flags, os.hostname(), cfg.customMasks);
  });

  // Doc-nonce protocol: a new document started masking / finished its initial
  // sweep. Pair/drop the tab's curtain by matching nonce (ignores stale readies
  // from the previous page). The sender is a page webContents: resolve its
  // window through the registry.
  ipcMain.on(IPC.STREAM_DOC_START, (event, payload: { nonce?: string }) => {
    const win = windowFromPageContents(event.sender);
    const host = win?.tabs.findByWebContents(event.sender);
    if (win && host && payload?.nonce) win.curtain.onDocStart(host.id, payload.nonce);
  });
  ipcMain.on(IPC.STREAM_READY, (event, payload: { nonce?: string } | undefined) => {
    const win = windowFromPageContents(event.sender);
    const host = win?.tabs.findByWebContents(event.sender);
    if (win && host) {
      win.curtain.onReady(host.id, payload?.nonce ?? null);
      // Capture Handshake waits on this: a tab that just finished masking
      // under a freshly-armed stream is safe to hand to a screen share.
      getCaptureHandshake().notifyMaskerReady(win.window.id);
    }
  });

  // Frame guard (electron/electron#34727): a frame that got our preload
  // announces itself here at document-start, and a frame that gated its iframe
  // elements asks for a fresh coverage verdict. Both are routed to the guard of
  // the sending webContents (tab or managed popup) in whichever window owns
  // it; the sender FRAME is what identifies the document, so it must be passed
  // through untouched.
  ipcMain.on(IPC.STREAM_FRAME_ALIVE, (event) => {
    windowFromPageContents(event.sender)?.tabs.handleFrameAlive(event.sender, event.senderFrame);
  });
  ipcMain.on(IPC.STREAM_FRAME_GATE, (event, payload: { seq?: number } | undefined) => {
    windowFromPageContents(event.sender)?.tabs.handleFrameGate(
      event.sender,
      event.senderFrame,
      Number(payload?.seq ?? 0),
    );
  });

  // The chrome UI confirmed the curtain backdrop is painted (decode-acked).
  ipcMain.on(IPC.CURTAIN_READY, (e, payload: { tabId?: string; token?: number }) => {
    if (payload && typeof payload.tabId === 'string' && typeof payload.token === 'number') {
      senderWindow(e)?.curtain.ackFromUi(payload.tabId, payload.token);
    }
  });

  // --- Suggestions ----------------------------------------------------------
  //
  // Each keystroke in the address bar triggers this handler via an 80 ms
  // debounce in the React side. To avoid a pile-up of stale network calls
  // when the user types fast, we keep one AbortController per address bar
  // (per sender webContents: each window types independently) and abort its
  // previous fetch as soon as a new query comes in.
  const inflightAborts = new Map<number, AbortController>();

  ipcMain.handle(
    IPC.SUGGESTIONS_QUERY,
    async (e, query: string, engineOverride?: string): Promise<Suggestion[]> => {
    const trimmed = query.trim();
    if (!trimmed) return [];

    // Cancel any previous in-flight suggestion fetch from this window.
    inflightAborts.get(e.sender.id)?.abort();
    const abortController = new AbortController();
    inflightAborts.set(e.sender.id, abortController);
    // Drop our own entry once this query settles, so a closed window leaves
    // nothing behind (webContents ids are never reused: a stale entry would
    // be unreachable garbage for the rest of the process life).
    const releaseAbort = () => {
      if (inflightAborts.get(e.sender.id) === abortController) {
        inflightAborts.delete(e.sender.id);
      }
    };

    try {
      // Tab-to-search: the address bar is in keyword mode, so `query` is terms
      // for THAT engine, never an address. Chrome makes this an exclusive mode
      // (no history, no bookmarks): the user named the engine, they want the
      // engine. The mode is state the renderer holds, never inferred from the
      // text here (see findEngineByKeyword).
      const engines = currentEngines();
      const named = engineOverride
        ? engines.find((def) => def.id === engineOverride)
        : undefined;
      const keywordMode = Boolean(named);
      const engine = named ?? defaultEngine();

      const looksLikeUrl = !keywordMode && isUrlLike(trimmed);

      // Local DB lookups are synchronous (cheap, always included). Exception:
      // while streaming with hideHistory on, browsing habits must never
      // surface in the dropdown, so the history source is skipped entirely.
      const streamCfg = stream.getConfig();
      const hist =
        keywordMode || (streamCfg.enabled && streamCfg.hideHistory)
          ? []
          : searchHistory(trimmed, 4);
      const marks = keywordMode ? [] : searchBookmarks(trimmed, 3);

      // Network-bound engine autocomplete. Skip when the query already looks
      // like a URL: autocompleting "github.com/anthro" is not useful and
      // leaks the partial URL to the search engine unnecessarily.
      const engineTerms = looksLikeUrl
        ? []
        : await fetchSearchSuggestions(engine, trimmed, abortController.signal);

      // If this invocation was cancelled mid-flight, bail early without
      // returning half-baked data to the renderer.
      if (abortController.signal.aborted) return [];

      const out: Suggestion[] = [];

      // 1. The literal query the user typed (either as a URL to visit or a
      //    search). Always first: it's what Enter is primed to do. The URL is
      //    built by normalizeInput, the one funnel navigation itself uses, so
      //    the suggestion and the Enter key can never disagree.
      if (looksLikeUrl) {
        out.push({
          kind: 'url',
          label: t('Aller à {query}', { query: trimmed }),
          url: normalizeInput(trimmed, defaultEngine()),
        });
      } else if (keywordMode) {
        out.push({
          kind: 'search',
          label: t('Rechercher « {query} » sur {engine}', {
            query: trimmed,
            engine: engine.name,
          }),
          url: buildSearchUrl(engine, trimmed),
        });
      } else {
        out.push({
          kind: 'search',
          label: t('Rechercher « {query} »', { query: trimmed }),
          url: buildSearchUrl(engine, trimmed),
        });
      }

      // 2. Engine-suggested queries (from whichever engine is targeted).
      const queryLower = trimmed.toLowerCase();
      for (const term of engineTerms) {
        if (out.length >= 9) break;
        // Skip the engine echoing back the user's exact text; we already
        // surfaced it as entry #1.
        if (term.toLowerCase() === queryLower) continue;
        out.push({
          kind: 'search',
          label: term,
          url: buildSearchUrl(engine, term),
        });
      }

      // 3. Matching history entries.
      for (const h of hist) {
        out.push({
          kind: 'history',
          label: h.title || h.url,
          url: h.url,
          subtitle: h.url,
        });
      }

      // 4. Matching bookmarks.
      for (const b of marks) {
        out.push({
          kind: 'bookmark',
          label: b.title || b.url,
          url: b.url,
          subtitle: b.url,
        });
      }

      // De-dupe by URL while preserving insertion order (first-seen wins).
      const seen = new Set<string>();
      const suggestions = out.filter((s) => {
        if (seen.has(s.url)) return false;
        seen.add(s.url);
        return true;
      });

      // Warm what Enter is most likely to open, but only origins we KNOW exist:
      // a history or bookmark hit is somewhere the user has actually been.
      //
      // Not suggestions[0]: that entry is always the literal text being typed,
      // and a domain typed character by character is a different origin at every
      // keystroke ("example.c", "example.co", "example.com"). Warming those
      // sprays NXDOMAIN lookups, hands the DNS resolver a keystroke-by-keystroke
      // picture of what is being typed, and burns the rate budget that the hover
      // path -- the one genuinely strong signal -- depends on.
      //
      // Computed on the FINAL list, so an origin dropped by the Stream Mode
      // history filter is never warmed either: what the user asked us not to
      // use, we do not use.
      const preconnect = getPreconnect();
      const known = suggestions.find((s) => s.kind === 'history' || s.kind === 'bookmark');
      if (known) preconnect.hint(known.url, 'resolve');
      // The search engine itself: pressing Enter on a query is the single most
      // frequent thing anyone does in an address bar.
      if (!looksLikeUrl) preconnect.hint(buildSearchUrl(engine, ''), 'preconnect');

      return suggestions;
    } finally {
      releaseAbort();
    }
    },
  );

  // --- App misc -------------------------------------------------------------
  ipcMain.handle(IPC.APP_GET_HOSTNAME, () => os.hostname());
  ipcMain.handle(IPC.APP_OPEN_EXTERNAL, (_e, url: string) => {
    if (/^https?:\/\//i.test(url)) {
      void shell.openExternal(url);
      return true;
    }
    return false;
  });
  // Sync the native window backgrounds to the resolved theme so navigating to
  // a dark site (or opening a new tab) never flashes white. The theme is app
  // global: apply to every window; each chrome UI re-sends it on load, so a
  // window created later converges immediately.
  ipcMain.handle(IPC.APP_SET_THEME, (_e, theme: 'light' | 'dark') => {
    const color = theme === 'dark' ? '#16171b' : '#f8f9fb';
    for (const win of allWindows()) {
      try {
        win.window.setBackgroundColor(color);
      } catch {
        // ignore
      }
      win.statusView.setTheme(theme);
    }
    // Remaining NATIVE surfaces (extension-icon context menus, dialogs)
    // must follow the app theme too, not the OS one.
    try {
      nativeTheme.themeSource = theme;
    } catch {
      // ignore
    }
  });
  ipcMain.handle(
    IPC.APP_CLEAR_BROWSING_DATA,
    async (_e, opts: ClearBrowsingDataOptions) => {
      // Time-aware stores honor `since`; Chromium's stores don't expose
      // per-entry timestamps, so cookies/cache/site storage clear whole.
      if (opts.history) {
        try {
          if (opts.since === null) clearHistory();
          else deleteHistorySince(opts.since);
        } catch {
          // ignore
        }
      }
      if (opts.downloads) downloads.clearHistory(opts.since);
      if (opts.sitePermissions) setSettings({ sitePermissions: {} });
      if (opts.zoomLevels) setSettings({ zoomLevels: {} });
      if (opts.sitePermissions || opts.zoomLevels) {
        broadcastToChromes(IPC.SETTINGS_CHANGED, getSettings());
      }

      // 'websql' left the union with Electron 43 (WebSQL is gone from
      // Chromium); 'filesystem' (File System API buckets) joined the site
      // storage sweep instead: it IS site data a user expects wiped.
      const storages: ('cookies' | 'localstorage' | 'indexdb' | 'filesystem' | 'serviceworkers' | 'cachestorage')[] =
        [];
      if (opts.cookies) storages.push('cookies');
      if (opts.siteStorage)
        storages.push('localstorage', 'indexdb', 'filesystem', 'serviceworkers', 'cachestorage');
      try {
        if (opts.cache) await session.defaultSession.clearCache();
        if (storages.length) await session.defaultSession.clearStorageData({ storages });
      } catch {
        // ignore
      }
      // The warmed-origin map is a record of what the user hovered and typed:
      // wiping browsing data must wipe it too, or "clear my data" would be a
      // half-truth held in main-process memory. Unconditional, whichever boxes
      // were ticked: it was gated on cache/cookies/history, so clearing only
      // site data (or permissions, or downloads) left the record standing, and
      // the gate bought nothing -- dropping a small in-memory map costs nothing
      // and there is no box under which keeping it would be the right answer.
      getPreconnect().clear();
      // Same reasoning for session TLS exceptions: hosts the user clicked
      // through are a record of where they went, and a stale exception is a
      // standing risk. Unconditional.
      clearCertExceptions();
    },
  );
  // --- Default browser -------------------------------------------------------
  // The truthful check lives in defaultBrowser.ts. On Windows it reads the
  // UserChoice ProgId (what actually opens links on Windows 10+), NEVER
  // app.isDefaultProtocolClient: that API checks the legacy registration the
  // setter writes, so it answers yes to its own echo (lived, v0.5.0).
  const defaultBrowserState = async () => ({
    packaged: app.isPackaged,
    isDefault: await isDefaultBrowser(),
  });
  ipcMain.handle(IPC.APP_DEFAULT_BROWSER_STATE, () => defaultBrowserState());
  ipcMain.handle(IPC.APP_SET_DEFAULT_BROWSER, async () => {
    if (!app.isPackaged) return defaultBrowserState();
    if (process.platform === 'win32') {
      // Windows 10+ forbids claiming a default programmatically (association
      // hashes): the supported flow, the one Chrome and Firefox use, is to be
      // REGISTERED (installer.nsh) and send the user to Settings to pick.
      await shell.openExternal('ms-settings:defaultapps');
    } else {
      // macOS prompts the user for confirmation; Linux goes through
      // xdg-settings. Both are the sanctioned path.
      app.setAsDefaultProtocolClient('http');
      app.setAsDefaultProtocolClient('https');
    }
    return defaultBrowserState();
  });

  ipcMain.handle(IPC.APP_OPEN_DEVTOOLS, (e) => {
    // BrowserWindow.getFocusedWindow() is always null for a BaseWindow, so
    // target the active tab of the SENDER's window directly (falls back to
    // that window's chrome UI when there is no external page).
    const win = senderWindow(e);
    if (!win) return;
    const active = win.tabs.getActive();
    const wc =
      active && !active.isInternal && active.view
        ? active.view.webContents
        : win.chromeView.webContents;
    wc.openDevTools({ mode: 'detach' });
  });

  // --- Extensions -----------------------------------------------------------
  const broadcastExtensions = () => {
    broadcastToChromes(IPC.EXTENSIONS_CHANGED, listExtensions());
  };

  // session.extensions emits these events every time an extension is
  // loaded (including at boot when electron-chrome-web-store re-loads
  // previously installed extensions) or removed.
  const extSession = session.defaultSession.extensions;
  if (extSession) {
    extSession.on('extension-loaded', () => broadcastExtensions());
    extSession.on('extension-unloaded', () => broadcastExtensions());
  }

  ipcMain.handle(IPC.EXTENSIONS_LIST, () => listExtensions());
  ipcMain.handle(IPC.EXTENSIONS_UNINSTALL, async (_e, id: string) => {
    await uninstallExtensionById(id);
    broadcastExtensions();
  });
  ipcMain.handle(IPC.EXTENSIONS_REORDER, (_e, ids: string[]) => {
    reorderExtensions(ids);
    broadcastExtensions();
  });

  // --- Window controls ------------------------------------------------------
  ipcMain.handle(IPC.WINDOW_NEW, async () => {
    await openNewWindow();
  });
  ipcMain.handle(IPC.WINDOW_MINIMIZE, (e) => senderWindow(e)?.window.minimize());
  ipcMain.handle(IPC.WINDOW_MAXIMIZE, (e) => {
    const win = senderWindow(e)?.window;
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.handle(IPC.WINDOW_CLOSE, (e) => senderWindow(e)?.window.close());
  ipcMain.handle(IPC.WINDOW_STATE, (e) => {
    const win = senderWindow(e)?.window;
    return {
      maximized: win?.isMaximized() ?? false,
      minimized: win?.isMinimized() ?? false,
      fullscreen: win?.isFullScreen() ?? false,
    };
  });
}

/**
 * Per-window push wiring: everything a window's chrome UI must hear about
 * its OWN tabs and window. Called once for each window created; every
 * listener lives on that window's TabManager / BaseWindow, so it dies with
 * the window (no global listener accumulates).
 */
export function wireWindowIpc(win: AppWindow): void {
  const { tabs, chromeView } = win;
  const stream = getStreamMode();

  const pushTabs = () => {
    // Tabs also change during window teardown (each destroyed webContents is
    // relayed back into TabManager.close); the chromeView may already be gone.
    sendToChrome(win, IPC.TAB_UPDATED, tabs.listState());
  };
  tabs.on('tabs-changed', pushTabs);

  tabs.on('found-in-page', (result) => {
    sendToChrome(win, IPC.FIND_RESULT, result);
  });

  // --- Hover status URL (native bubble) -------------------------------------
  // While streaming, NOTHING is pushed to the bubble AND nothing is warmed: the
  // hovered URL never leaves the main process at all, which is strictly stronger
  // than masking it. (PreconnectController enforces the second half itself, so
  // the guarantee does not depend on the order of these two lines.)
  tabs.on('update-target-url', (payload: { tabId: string; url: string }) => {
    // Hovering a link is the strongest signal a browser gets that a navigation
    // is coming: that is where a connection is worth warming.
    if (payload.url) getPreconnect().hint(payload.url, 'preconnect');

    if (stream.getConfig().enabled) {
      win.statusView.hide({ immediate: true });
      return;
    }
    if (payload.url) win.statusView.show(payload.url);
    else win.statusView.hide();
  });

  const pushWindowState = () => {
    sendToChrome(win, IPC.WINDOW_STATE_CHANGED, {
      maximized: win.window.isMaximized(),
      minimized: win.window.isMinimized(),
      fullscreen: win.window.isFullScreen(),
    });
  };
  win.window.on('maximize', pushWindowState);
  win.window.on('unmaximize', pushWindowState);
  win.window.on('enter-full-screen', pushWindowState);
  win.window.on('leave-full-screen', pushWindowState);
  win.window.on('minimize', pushWindowState);
  win.window.on('restore', pushWindowState);

  // Initial push of data once this window's UI is ready.
  chromeView.webContents.once('did-finish-load', () => {
    pushTabs();
    sendToChrome(win, IPC.STREAM_CONFIG_CHANGED, stream.getConfig());
    sendToChrome(win, IPC.EXTENSIONS_CHANGED, listExtensions());
  });
}
