import { ipcMain, Menu, nativeTheme, session, shell, webContents } from 'electron';
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
import type { AppWindow } from '../window';
import { getStreamMode } from '../stream-mode/StreamModeController';
import { installPermissionHandlers } from '../stream-mode/permissions';
import { DownloadManager } from '../downloads/DownloadManager';
import { PageMenuController } from '../pageContextMenu';
import { PrintController } from '../printing';
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

export function registerIpcHandlers(appWindow: AppWindow): void {
  const { tabs, chromeView, curtain } = appWindow;
  const stream = getStreamMode();

  const pushTabs = () => {
    // Tabs also change during window teardown (each destroyed webContents is
    // relayed back into TabManager.close); the chromeView may already be gone.
    if (!chromeView.webContents.isDestroyed()) {
      chromeView.webContents.send(IPC.TAB_UPDATED, tabs.listState());
    }
  };
  tabs.on('tabs-changed', pushTabs);

  // Stream config broadcasts: reach the chrome UI AND every frame of every
  // tab (subframes run their own masker under nodeIntegrationInSubFrames).
  let prevStreamConfig = stream.getConfig();
  stream.on('config-changed', (config: StreamModeConfig) => {
    const maskingChanged = !sameMaskingConfig(prevStreamConfig, config);
    prevStreamConfig = config;
    // Can fire after teardown: a recorder-watcher poll in flight at quit
    // completes late and flips the config against a destroyed chromeView.
    if (chromeView.webContents.isDestroyed()) return;
    // Stream just went live while a status bubble may be on screen.
    if (config.enabled) appWindow.statusView.hide({ immediate: true });
    chromeView.webContents.send(IPC.STREAM_CONFIG_CHANGED, config);
    // Cosmetic-only change (accent color): the chrome UI above is the only
    // consumer. Page maskers never read it, so skip the per-frame push and
    // spare a full re-sweep of every page on each color-picker step.
    if (!maskingChanged) return;
    for (const wc of webContents.getAllWebContents()) {
      if (wc.id === chromeView.webContents.id) continue;
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
    isChromeContents: (wc) => !!wc && wc.id === chromeView.webContents.id,
    getRemembered: (origin, permission) =>
      getSettings().sitePermissions?.[origin]?.[permission],
    remember: (origin, permission, decision) => {
      const s = getSettings();
      const sp = { ...(s.sitePermissions ?? {}) };
      sp[origin] = { ...(sp[origin] ?? {}), [permission]: decision };
      setSettings({ sitePermissions: sp });
    },
    promptUser: (req) =>
      new Promise((resolve) => {
        const id = `perm-${permReqId++}`;
        pendingPerms.set(id, resolve);
        chromeView.webContents.send(IPC.PERMISSION_REQUEST, {
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

  // --- Tabs -----------------------------------------------------------------
  ipcMain.handle(IPC.TAB_CREATE, (_e, url?: string) => {
    const tab = tabs.create(url);
    return tab.id;
  });
  ipcMain.handle(IPC.TAB_CLOSE, (_e, id: string) => tabs.close(id));
  ipcMain.handle(IPC.TAB_ACTIVATE, (_e, id: string) => tabs.setActive(id));
  ipcMain.handle(IPC.TAB_REORDER, (_e, ids: string[]) => tabs.reorder(ids));
  ipcMain.handle(IPC.TAB_NAVIGATE, (_e, id: string, url: string) => tabs.navigate(id, url));
  ipcMain.handle(IPC.TAB_BACK, (_e, id: string) => tabs.back(id));
  ipcMain.handle(IPC.TAB_FORWARD, (_e, id: string) => tabs.forward(id));
  ipcMain.handle(IPC.TAB_RELOAD, (_e, id: string) => tabs.reload(id));
  ipcMain.handle(IPC.TAB_STOP, (_e, id: string) => tabs.stop(id));
  ipcMain.handle(IPC.TAB_LIST, () => tabs.listState());
  ipcMain.handle(IPC.TAB_REOPEN_CLOSED, () => tabs.reopenClosed());
  ipcMain.handle(IPC.TAB_MUTE, (_e, id: string, muted?: boolean) => tabs.setMuted(id, muted));
  ipcMain.handle(IPC.TAB_DUPLICATE, (_e, id: string) => tabs.duplicate(id));
  ipcMain.handle(IPC.TAB_CLOSE_OTHERS, (_e, id: string) => tabs.closeOthers(id));
  ipcMain.handle(IPC.TAB_CLOSE_RIGHT, (_e, id: string) => tabs.closeRight(id));

  // --- Find in page ---------------------------------------------------------
  ipcMain.handle(
    IPC.FIND_START,
    (_e, id: string, text: string, forward: boolean, matchCase: boolean) =>
      tabs.findInPage(id, text, forward, matchCase),
  );
  ipcMain.handle(IPC.FIND_STOP, (_e, id: string) => tabs.stopFind(id));
  tabs.on('found-in-page', (result) => {
    if (!chromeView.webContents.isDestroyed()) {
      chromeView.webContents.send(IPC.FIND_RESULT, result);
    }
  });

  // --- Zoom -----------------------------------------------------------------
  ipcMain.handle(IPC.ZOOM_ADJUST, (_e, id: string, delta: number) => tabs.adjustZoom(id, delta));
  ipcMain.handle(IPC.ZOOM_RESET, (_e, id: string) => tabs.resetZoom(id));

  // --- Printing (preview dialog in the chrome UI) ----------------------------
  const printing = new PrintController(tabs);
  ipcMain.handle(IPC.PRINT_LIST_PRINTERS, (_e, tabId: string) => printing.listPrinters(tabId));
  ipcMain.handle(IPC.PRINT_PREVIEW, (_e, tabId: string, opts: PrintPreviewOptions) =>
    printing.preview(tabId, opts),
  );
  ipcMain.handle(IPC.PRINT_EXECUTE, (_e, tabId: string, opts: PrintExecuteOptions) =>
    printing.execute(tabId, opts),
  );

  // --- Auto-update (GitHub Releases) -----------------------------------------
  const updates = new UpdateController();
  updates.onStateChanged((state) => {
    if (!chromeView.webContents.isDestroyed()) {
      chromeView.webContents.send(IPC.UPDATES_STATE_CHANGED, state);
    }
  });
  ipcMain.handle(IPC.UPDATES_GET_STATE, () => updates.getState());
  ipcMain.handle(IPC.UPDATES_CHECK, () => updates.check());
  ipcMain.handle(IPC.UPDATES_INSTALL, () => updates.install());
  updates.scheduleStartupCheck();

  // --- Page context menu (rendered in the chrome UI) -------------------------
  const pageMenu = new PageMenuController(chromeView, tabs);
  tabs.on(
    'page-context-menu',
    (p: {
      wc: Electron.WebContents;
      params: Electron.ContextMenuParams;
      windowX: number;
      windowY: number;
    }) => {
      pageMenu.show(p.wc, p.params, p.windowX, p.windowY);
    },
  );
  ipcMain.handle(
    IPC.PAGE_MENU_ACTION,
    (_e, token: number, action: string, arg?: number | string) =>
      pageMenu.handleAction(token, action, arg),
  );

  // --- Hover status URL (native bubble) -------------------------------------
  // While streaming, NOTHING is pushed: the hovered URL never leaves the
  // main process, which is strictly stronger than masking it.
  tabs.on('update-target-url', (payload: { tabId: string; url: string }) => {
    if (stream.getConfig().enabled) {
      appWindow.statusView.hide({ immediate: true });
      return;
    }
    if (payload.url) appWindow.statusView.show(payload.url);
    else appWindow.statusView.hide();
  });

  // --- Downloads ------------------------------------------------------------
  const downloads = new DownloadManager(
    session.defaultSession,
    // Downloads live on the session and outlive the window: progress ticks of
    // an in-flight download keep firing during and after teardown.
    (items) => {
      if (!chromeView.webContents.isDestroyed()) {
        chromeView.webContents.send(IPC.DOWNLOADS_CHANGED, items);
      }
    },
    (webContentsId) => {
      // A download aborts the navigation: drop that tab's curtain immediately
      // instead of freezing until the safety timeout.
      const host = tabs.getAll().find((t) => t.view.webContents.id === webContentsId);
      if (host) curtain.drop(host.id);
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
  ipcMain.handle(IPC.TAB_SET_CHROME_BOUNDS, (_e, bounds: ChromeBounds) => {
    appWindow.updateChromeBounds(bounds);
  });
  ipcMain.handle(IPC.CHROME_SET_OVERLAY, (_e, open: boolean) => {
    // With the chromeView transparent below the toolbar, expansion alone is
    // enough; the live tab view keeps rendering behind the menu. No need
    // to capture a screenshot.
    appWindow.setOverlayMode(open);
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
  // One atomic snapshot of both tables per mutation: the UI never renders
  // a bookmark whose folder it hasn't heard of yet.
  const broadcastBookmarks = () => {
    chromeView.webContents.send(IPC.BOOKMARKS_CHANGED, {
      bookmarks: listBookmarks(),
      folders: listFolders(),
    });
  };

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
      Menu.setApplicationMenu(buildApplicationMenu(() => appWindow));
    }
    chromeView.webContents.send(IPC.SETTINGS_CHANGED, next);
    return next;
  });

  // --- Stream mode ----------------------------------------------------------
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

  // Doc-nonce protocol: a new document started masking / finished its initial
  // sweep. Pair/drop the tab's curtain by matching nonce (ignores stale readies
  // from the previous page).
  ipcMain.on(IPC.STREAM_DOC_START, (event, payload: { nonce?: string }) => {
    const host = tabs.getAll().find((t) => t.view.webContents.id === event.sender.id);
    if (host && payload?.nonce) curtain.onDocStart(host.id, payload.nonce);
  });
  ipcMain.on(IPC.STREAM_READY, (event, payload: { nonce?: string } | undefined) => {
    const host = tabs.getAll().find((t) => t.view.webContents.id === event.sender.id);
    if (host) curtain.onReady(host.id, payload?.nonce ?? null);
  });

  // Frame guard (electron/electron#34727): a frame that got our preload
  // announces itself here at document-start, and a frame that gated its iframe
  // elements asks for a fresh coverage verdict. Both are routed to the guard of
  // the sending webContents (tab or managed popup); the sender FRAME is what
  // identifies the document, so it must be passed through untouched.
  ipcMain.on(IPC.STREAM_FRAME_ALIVE, (event) => {
    tabs.handleFrameAlive(event.sender, event.senderFrame);
  });
  ipcMain.on(IPC.STREAM_FRAME_GATE, (event, payload: { seq?: number } | undefined) => {
    tabs.handleFrameGate(event.sender, event.senderFrame, Number(payload?.seq ?? 0));
  });

  // The chrome UI confirmed the curtain backdrop is painted (decode-acked).
  ipcMain.on(IPC.CURTAIN_READY, (_e, payload: { tabId?: string; token?: number }) => {
    if (payload && typeof payload.tabId === 'string' && typeof payload.token === 'number') {
      curtain.ackFromUi(payload.tabId, payload.token);
    }
  });

  // --- Suggestions ----------------------------------------------------------
  //
  // Each keystroke in the address bar triggers this handler via an 80 ms
  // debounce in the React side. To avoid a pile-up of stale network calls
  // when the user types fast, we keep a single AbortController per
  // invocation and abort the previous one as soon as a new query comes in.
  let inflightAbort: AbortController | null = null;

  const ENGINE_SEARCH_URLS: Record<AppSettings['searchEngine'], string> = {
    google: 'https://www.google.com/search?q=',
    duckduckgo: 'https://duckduckgo.com/?q=',
    startpage: 'https://www.startpage.com/do/search?q=',
    brave: 'https://search.brave.com/search?q=',
  };

  ipcMain.handle(IPC.SUGGESTIONS_QUERY, async (_e, query: string): Promise<Suggestion[]> => {
    const trimmed = query.trim();
    if (!trimmed) return [];

    // Cancel any previous in-flight suggestion fetch.
    inflightAbort?.abort();
    const abortController = new AbortController();
    inflightAbort = abortController;

    const settings = getSettings();
    const engine = settings.searchEngine;
    const searchUrlPrefix = ENGINE_SEARCH_URLS[engine];

    const isUrlLike =
      /^https?:\/\//i.test(trimmed) ||
      /^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(trimmed) ||
      trimmed === 'localhost';

    // Local DB lookups are synchronous (cheap, always included). Exception:
    // while streaming with hideHistory on, browsing habits must never
    // surface in the dropdown, so the history source is skipped entirely.
    const streamCfg = stream.getConfig();
    const hist =
      streamCfg.enabled && streamCfg.hideHistory ? [] : searchHistory(trimmed, 4);
    const marks = searchBookmarks(trimmed, 3);

    // Network-bound engine autocomplete. Skip when the query already looks
    // like a URL: autocompleting "github.com/anthro" is not useful and
    // leaks the partial URL to the search engine unnecessarily.
    const engineTerms = isUrlLike
      ? []
      : await fetchSearchSuggestions(engine, trimmed, abortController.signal);

    // If this invocation was cancelled mid-flight, bail early without
    // returning half-baked data to the renderer.
    if (abortController.signal.aborted) return [];

    const out: Suggestion[] = [];

    // 1. The literal query the user typed (either as a URL to visit or a
    //    search). Always first: it's what Enter is primed to do.
    if (isUrlLike) {
      out.push({
        kind: 'url',
        label: t('Aller à {query}', { query: trimmed }),
        url: /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`,
      });
    } else {
      out.push({
        kind: 'search',
        label: t('Rechercher « {query} »', { query: trimmed }),
        url: searchUrlPrefix + encodeURIComponent(trimmed),
      });
    }

    // 2. Engine-suggested queries (Google / DDG / Brave).
    const queryLower = trimmed.toLowerCase();
    for (const term of engineTerms) {
      if (out.length >= 9) break;
      // Skip the engine echoing back the user's exact text; we already
      // surfaced it as entry #1.
      if (term.toLowerCase() === queryLower) continue;
      out.push({
        kind: 'search',
        label: term,
        url: searchUrlPrefix + encodeURIComponent(term),
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
    return out.filter((s) => {
      if (seen.has(s.url)) return false;
      seen.add(s.url);
      return true;
    });
  });

  // --- App misc -------------------------------------------------------------
  ipcMain.handle(IPC.APP_GET_HOSTNAME, () => os.hostname());
  ipcMain.handle(IPC.APP_OPEN_EXTERNAL, (_e, url: string) => {
    if (/^https?:\/\//i.test(url)) {
      void shell.openExternal(url);
      return true;
    }
    return false;
  });
  // Sync the native window background to the resolved theme so navigating to
  // a dark site (or opening a new tab) never flashes white.
  ipcMain.handle(IPC.APP_SET_THEME, (_e, theme: 'light' | 'dark') => {
    const color = theme === 'dark' ? '#16171b' : '#f8f9fb';
    try {
      appWindow.window.setBackgroundColor(color);
    } catch {
      // ignore
    }
    appWindow.statusView.setTheme(theme);
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
        chromeView.webContents.send(IPC.SETTINGS_CHANGED, getSettings());
      }

      const storages: ('cookies' | 'localstorage' | 'indexdb' | 'websql' | 'serviceworkers' | 'cachestorage')[] =
        [];
      if (opts.cookies) storages.push('cookies');
      if (opts.siteStorage)
        storages.push('localstorage', 'indexdb', 'websql', 'serviceworkers', 'cachestorage');
      try {
        if (opts.cache) await session.defaultSession.clearCache();
        if (storages.length) await session.defaultSession.clearStorageData({ storages });
      } catch {
        // ignore
      }
    },
  );
  ipcMain.handle(IPC.APP_OPEN_DEVTOOLS, () => {
    // BrowserWindow.getFocusedWindow() is always null for a BaseWindow, so
    // target the active tab's webContents directly (falls back to the chrome
    // UI when there is no external page).
    const active = tabs.getActive();
    const wc = active && !active.isInternal ? active.view.webContents : chromeView.webContents;
    wc.openDevTools({ mode: 'detach' });
  });

  // --- Extensions -----------------------------------------------------------
  const broadcastExtensions = () => {
    chromeView.webContents.send(IPC.EXTENSIONS_CHANGED, listExtensions());
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
  const win = appWindow.window;

  const pushWindowState = () => {
    chromeView.webContents.send(IPC.WINDOW_STATE_CHANGED, {
      maximized: win.isMaximized(),
      minimized: win.isMinimized(),
      fullscreen: win.isFullScreen(),
    });
  };
  win.on('maximize', pushWindowState);
  win.on('unmaximize', pushWindowState);
  win.on('enter-full-screen', pushWindowState);
  win.on('leave-full-screen', pushWindowState);
  win.on('minimize', pushWindowState);
  win.on('restore', pushWindowState);

  ipcMain.handle(IPC.WINDOW_MINIMIZE, () => win.minimize());
  ipcMain.handle(IPC.WINDOW_MAXIMIZE, () => {
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.handle(IPC.WINDOW_CLOSE, () => win.close());
  ipcMain.handle(IPC.WINDOW_STATE, () => ({
    maximized: win.isMaximized(),
    minimized: win.isMinimized(),
    fullscreen: win.isFullScreen(),
  }));

  ipcMain.handle(IPC.BOOKMARKS_FIND_BY_URL, (_e, url: string) => findBookmarkByUrl(url));

  // Initial push of data once the UI is ready
  chromeView.webContents.once('did-finish-load', () => {
    pushTabs();
    chromeView.webContents.send(IPC.STREAM_CONFIG_CHANGED, stream.getConfig());
    broadcastExtensions();
  });
}
