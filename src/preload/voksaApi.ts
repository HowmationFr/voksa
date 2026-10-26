import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type IpcChannel } from '../shared/ipcChannels';
import type {
  AppSettings,
  AuthRequest,
  Bookmark,
  BookmarkFolder,
  BookmarksChangedPayload,
  ChromeBounds,
  ClearBrowsingDataOptions,
  DownloadItem,
  ExtensionInfo,
  HistoryEntry,
  PageMenuPayload,
  PrintExecuteOptions,
  PrintExecuteResult,
  PrinterInfo,
  PrintPreviewOptions,
  Suggestion,
  TabState,
  UpdateState,
} from '../shared/types';
import type { MixedItemRef } from '../shared/bookmarkOrdering';
import type { StreamModeConfig } from '../shared/streamConfig';

type Unsubscribe = () => void;

function on<T>(channel: IpcChannel, handler: (payload: T) => void): Unsubscribe {
  const listener = (_: Electron.IpcRendererEvent, payload: T) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

/**
 * ipcRenderer.invoke that always fails as a rejected promise. Since Electron 45
 * the sandboxed ipcRenderer is native and throws SYNCHRONOUSLY when an argument
 * cannot be serialized or the context is already released (it used to be an
 * async function, so those became rejections). Every bridge method returns a
 * promise; callers' .catch() must keep seeing every failure.
 */
function invoke(channel: IpcChannel, ...args: unknown[]): ReturnType<typeof ipcRenderer.invoke> {
  try {
    return ipcRenderer.invoke(channel, ...args);
  } catch (err) {
    return Promise.reject(err);
  }
}

export function buildVoksaApi() {
  return {
    tabs: {
      create: (url?: string): Promise<string> => invoke(IPC.TAB_CREATE, url),
      close: (id: string) => invoke(IPC.TAB_CLOSE, id),
      activate: (id: string) => invoke(IPC.TAB_ACTIVATE, id),
      reorder: (ids: string[]) => invoke(IPC.TAB_REORDER, ids),
      /** `engine`: tab-to-search override. `url` is then a QUERY for that engine, and MAIN builds the search URL (the renderer never does). */
      navigate: (id: string, url: string, engine?: string) =>
        invoke(IPC.TAB_NAVIGATE, id, url, engine),
      back: (id: string) => invoke(IPC.TAB_BACK, id),
      forward: (id: string) => invoke(IPC.TAB_FORWARD, id),
      reload: (id: string) => invoke(IPC.TAB_RELOAD, id),
      /**
       * TLS interstitial "continue anyway": trust the exact certificate the
       * user saw, for this app run only, then retry. Resolves false when no
       * exception was pending (nothing happens).
       */
      tlsProceed: (id: string): Promise<boolean> => invoke(IPC.TAB_TLS_PROCEED, id),
      stop: (id: string) => invoke(IPC.TAB_STOP, id),
      list: (): Promise<TabState[]> => invoke(IPC.TAB_LIST),
      reopenClosed: () => invoke(IPC.TAB_REOPEN_CLOSED),
      mute: (id: string, muted?: boolean) => invoke(IPC.TAB_MUTE, id, muted),
      /** Pin/unpin: the tab is re-homed at the pinned-cluster boundary by main. */
      setPinned: (id: string, pinned: boolean) =>
        invoke(IPC.TAB_SET_PINNED, id, pinned),
      /** DMCA Audio Guard chip: this tab may play on stream, for its lifetime. */
      allowStreamAudio: (id: string) => invoke(IPC.TAB_ALLOW_STREAM_AUDIO, id),
      /**
       * DMCA stage 2: route this tab's audio to the output device with the
       * given LABEL (null = back to the system default). Labels, not ids:
       * deviceIds are origin-hashed (shared/audioRouting.ts).
       */
      setAudioRoute: (id: string, label: string | null) =>
        invoke(IPC.AUDIO_ROUTE_SET, id, label),
      duplicate: (id: string) => invoke(IPC.TAB_DUPLICATE, id),
      /** Free this tab's renderer. Returns false when the tab is protected. */
      discard: (id: string): Promise<boolean> => invoke(IPC.TAB_DISCARD, id),
      closeOthers: (id: string) => invoke(IPC.TAB_CLOSE_OTHERS, id),
      closeRight: (id: string) => invoke(IPC.TAB_CLOSE_RIGHT, id),
      setChromeBounds: (bounds: ChromeBounds) =>
        invoke(IPC.TAB_SET_CHROME_BOUNDS, bounds),
      setOverlayMode: (open: boolean) => invoke(IPC.CHROME_SET_OVERLAY, open),
      onUpdate: (handler: (tabs: TabState[]) => void): Unsubscribe =>
        on<TabState[]>(IPC.TAB_UPDATED, handler),
    },
    find: {
      start: (id: string, text: string, forward: boolean, matchCase: boolean) =>
        invoke(IPC.FIND_START, id, text, forward, matchCase),
      stop: (id: string) => invoke(IPC.FIND_STOP, id),
      onResult: (
        handler: (r: { tabId: string; activeMatchOrdinal: number; matches: number }) => void,
      ): Unsubscribe =>
        on<{ tabId: string; activeMatchOrdinal: number; matches: number }>(IPC.FIND_RESULT, handler),
    },
    zoom: {
      adjust: (id: string, delta: number) => invoke(IPC.ZOOM_ADJUST, id, delta),
      reset: (id: string) => invoke(IPC.ZOOM_RESET, id),
    },
    downloads: {
      list: (): Promise<DownloadItem[]> => invoke(IPC.DOWNLOADS_LIST),
      open: (id: string) => invoke(IPC.DOWNLOAD_OPEN, id),
      openFolder: (id: string) => invoke(IPC.DOWNLOAD_OPEN_FOLDER, id),
      cancel: (id: string) => invoke(IPC.DOWNLOAD_CANCEL, id),
      pause: (id: string) => invoke(IPC.DOWNLOAD_PAUSE, id),
      resume: (id: string) => invoke(IPC.DOWNLOAD_RESUME, id),
      remove: (id: string) => invoke(IPC.DOWNLOAD_REMOVE, id),
      clear: () => invoke(IPC.DOWNLOAD_CLEAR),
      onChanged: (handler: (items: DownloadItem[]) => void): Unsubscribe =>
        on<DownloadItem[]>(IPC.DOWNLOADS_CHANGED, handler),
    },
    history: {
      list: (limit?: number, offset?: number): Promise<HistoryEntry[]> =>
        invoke(IPC.HISTORY_LIST, limit, offset),
      search: (query: string, limit?: number): Promise<HistoryEntry[]> =>
        invoke(IPC.HISTORY_SEARCH, query, limit),
      topSites: (limit?: number): Promise<HistoryEntry[]> =>
        invoke(IPC.HISTORY_TOP_SITES, limit),
      delete: (id: string) => invoke(IPC.HISTORY_DELETE, id),
      clear: () => invoke(IPC.HISTORY_CLEAR),
    },
    bookmarks: {
      list: (): Promise<Bookmark[]> => invoke(IPC.BOOKMARKS_LIST),
      listFolders: (): Promise<BookmarkFolder[]> =>
        invoke(IPC.BOOKMARKS_FOLDERS_LIST),
      add: (payload: {
        url: string;
        title: string;
        faviconUrl: string | null;
        folderId?: string | null;
      }): Promise<Bookmark> => invoke(IPC.BOOKMARKS_ADD, payload),
      remove: (id: string) => invoke(IPC.BOOKMARKS_REMOVE, id),
      update: (id: string, patch: Partial<Omit<Bookmark, 'id'>>) =>
        invoke(IPC.BOOKMARKS_UPDATE, id, patch),
      move: (id: string, folderId: string | null) =>
        invoke(IPC.BOOKMARKS_MOVE, id, folderId),
      reorderMixed: (container: string | null, items: MixedItemRef[]) =>
        invoke(IPC.BOOKMARKS_REORDER_MIXED, container, items),
      addFolder: (name: string, parentId?: string | null): Promise<BookmarkFolder> =>
        invoke(IPC.BOOKMARKS_FOLDER_ADD, name, parentId ?? null),
      renameFolder: (id: string, name: string) =>
        invoke(IPC.BOOKMARKS_FOLDER_RENAME, id, name),
      removeFolder: (id: string) => invoke(IPC.BOOKMARKS_FOLDER_REMOVE, id),
      moveFolder: (id: string, parentId: string | null) =>
        invoke(IPC.BOOKMARKS_FOLDER_MOVE, id, parentId),
      findByUrl: (url: string): Promise<Bookmark | null> =>
        invoke(IPC.BOOKMARKS_FIND_BY_URL, url),
      onChanged: (handler: (payload: BookmarksChangedPayload) => void): Unsubscribe =>
        on<BookmarksChangedPayload>(IPC.BOOKMARKS_CHANGED, handler),
    },
    settings: {
      get: (): Promise<AppSettings> => invoke(IPC.SETTINGS_GET),
      update: (patch: Partial<AppSettings>): Promise<AppSettings> =>
        invoke(IPC.SETTINGS_UPDATE, patch),
      onChanged: (handler: (settings: AppSettings) => void): Unsubscribe =>
        on<AppSettings>(IPC.SETTINGS_CHANGED, handler),
    },
    stream: {
      get: (): Promise<StreamModeConfig> => invoke(IPC.STREAM_GET_CONFIG),
      update: (patch: Partial<StreamModeConfig>): Promise<StreamModeConfig> =>
        invoke(IPC.STREAM_UPDATE_CONFIG, patch),
      toggle: (): Promise<StreamModeConfig> => invoke(IPC.STREAM_TOGGLE),
      /**
       * Panic: curtain every window + mute everything + arm the stream;
       * second call restores (the stream stays armed on purpose). Same action
       * the system-wide hotkey triggers.
       */
      panic: (): Promise<{ active: boolean }> => invoke(IPC.STREAM_PANIC),
      onChanged: (handler: (config: StreamModeConfig) => void): Unsubscribe =>
        on<StreamModeConfig>(IPC.STREAM_CONFIG_CHANGED, handler),
    },
    capture: {
      /**
       * Main pushes the screen-share picker (our own, not Chromium's). The
       * pick IS the capture consent: `origin` names the requesting site ('' when
       * the chrome UI itself asked).
       */
      onPickerShow: (
        handler: (payload: {
          pickId: string;
          origin: string;
          sources: Array<{
            id: string;
            name: string;
            kind: 'screen' | 'window';
            thumbnail: string | null;
            containsVoksa: boolean;
          }>;
        }) => void,
      ): Unsubscribe =>
        on<{
          pickId: string;
          origin: string;
          sources: Array<{
            id: string;
            name: string;
            kind: 'screen' | 'window';
            thumbnail: string | null;
            containsVoksa: boolean;
          }>;
        }>(IPC.CAPTURE_PICKER_SHOW, handler),
      /** Answer the picker: a chosen source id, or null to cancel the share. */
      pick: (pickId: string, sourceId: string | null) =>
        ipcRenderer.send(IPC.CAPTURE_PICKER_PICK, { pickId, sourceId }),
      /**
       * Debug/test only: drive the chrome-UI picker path of the handshake (the
       * web path is driven for real through getDisplayMedia). Resolves with the
       * delivered source id, or null. No-op (null) in production builds.
       */
      simulate: (): Promise<string | null> => invoke(IPC.CAPTURE_SIMULATE),
    },
    preflight: {
      /** Scan this window's tabs for what a viewer could catch before going live. */
      run: (): Promise<{
        scanned: number;
        findings: Array<
          | { kind: 'sensitive-text'; tabId: string; label: string; where: 'title' | 'url' | 'both' }
          | { kind: 'audible'; tabId: string; label: string }
        >;
      }> => invoke(IPC.PREFLIGHT_RUN),
    },
    suggestions: {
      query: (q: string, engine?: string): Promise<Suggestion[]> =>
        invoke(IPC.SUGGESTIONS_QUERY, q, engine),
    },
    pageMenu: {
      onShow: (handler: (payload: PageMenuPayload) => void): Unsubscribe =>
        on<PageMenuPayload>(IPC.PAGE_MENU_SHOW, handler),
      onClose: (handler: () => void): Unsubscribe => on<void>(IPC.PAGE_MENU_CLOSE, handler),
      action: (token: number, action: string, arg?: number | string) =>
        invoke(IPC.PAGE_MENU_ACTION, token, action, arg),
    },
    updates: {
      getState: (): Promise<UpdateState> => invoke(IPC.UPDATES_GET_STATE),
      check: (): Promise<UpdateState> => invoke(IPC.UPDATES_CHECK),
      install: (): Promise<void> => invoke(IPC.UPDATES_INSTALL),
      onChanged: (handler: (state: UpdateState) => void): Unsubscribe =>
        on<UpdateState>(IPC.UPDATES_STATE_CHANGED, handler),
    },
    print: {
      printers: (tabId: string): Promise<PrinterInfo[]> =>
        invoke(IPC.PRINT_LIST_PRINTERS, tabId),
      preview: (tabId: string, opts: PrintPreviewOptions): Promise<string | null> =>
        invoke(IPC.PRINT_PREVIEW, tabId, opts),
      execute: (tabId: string, opts: PrintExecuteOptions): Promise<PrintExecuteResult> =>
        invoke(IPC.PRINT_EXECUTE, tabId, opts),
    },
    extensions: {
      list: (): Promise<ExtensionInfo[]> => invoke(IPC.EXTENSIONS_LIST),
      uninstall: (id: string): Promise<void> =>
        invoke(IPC.EXTENSIONS_UNINSTALL, id),
      reorder: (ids: string[]): Promise<void> =>
        invoke(IPC.EXTENSIONS_REORDER, ids),
      onChanged: (handler: (list: ExtensionInfo[]) => void): Unsubscribe =>
        on<ExtensionInfo[]>(IPC.EXTENSIONS_CHANGED, handler),
    },
    app: {
      openDevTools: () => invoke(IPC.APP_OPEN_DEVTOOLS),
      openExternal: (url: string) => invoke(IPC.APP_OPEN_EXTERNAL, url),
      getHostname: (): Promise<string> => invoke(IPC.APP_GET_HOSTNAME),
      /** Is Voksa the OS handler for http/https? Always false in dev builds. */
      defaultBrowserState: (): Promise<{ packaged: boolean; isDefault: boolean }> =>
        invoke(IPC.APP_DEFAULT_BROWSER_STATE),
      /**
       * Ask to become the default browser. macOS/Linux register directly (the
       * OS may confirm); Windows opens Settings > Default apps, where the
       * user picks Voksa (no programmatic claim exists there).
       */
      setDefaultBrowser: (): Promise<{ packaged: boolean; isDefault: boolean }> =>
        invoke(IPC.APP_SET_DEFAULT_BROWSER),
      setTheme: (theme: 'light' | 'dark') => invoke(IPC.APP_SET_THEME, theme),
      clearBrowsingData: (opts: ClearBrowsingDataOptions) =>
        invoke(IPC.APP_CLEAR_BROWSING_DATA, opts),
    },
    window: {
      /** Open a brand-new browser window (fresh tab, cascaded position). */
      openNew: (): Promise<void> => invoke(IPC.WINDOW_NEW),
      minimize: () => invoke(IPC.WINDOW_MINIMIZE),
      maximize: () => invoke(IPC.WINDOW_MAXIMIZE),
      close: () => invoke(IPC.WINDOW_CLOSE),
      getState: (): Promise<{ maximized: boolean; minimized: boolean; fullscreen: boolean }> =>
        invoke(IPC.WINDOW_STATE),
      onStateChanged: (
        handler: (state: { maximized: boolean; minimized: boolean; fullscreen: boolean }) => void,
      ): Unsubscribe =>
        on<{ maximized: boolean; minimized: boolean; fullscreen: boolean }>(
          IPC.WINDOW_STATE_CHANGED,
          handler,
        ),
    },
    curtain: {
      onSet: (
        handler: (p: { tabId: string; token: number; backdrop: string | null }) => void,
      ): Unsubscribe =>
        on<{ tabId: string; token: number; backdrop: string | null }>(IPC.CURTAIN_SET, handler),
      onClear: (handler: (p: { tabId: string }) => void): Unsubscribe =>
        on<{ tabId: string }>(IPC.CURTAIN_CLEAR, handler),
      ack: (tabId: string, token: number) =>
        ipcRenderer.send(IPC.CURTAIN_READY, { tabId, token }),
    },
    permissions: {
      onRequest: (
        handler: (req: { id: string; origin: string; permission: string }) => void,
      ): Unsubscribe =>
        on<{ id: string; origin: string; permission: string }>(IPC.PERMISSION_REQUEST, handler),
      respond: (id: string, allow: boolean, remember: boolean) =>
        ipcRenderer.send(IPC.PERMISSION_RESPOND, { id, allow, remember }),
    },
    importData: {
      /** Detected Chrome/Firefox profiles with importable data. */
      sources: (): Promise<
        Array<{
          id: string;
          browser: 'chrome' | 'firefox';
          profileName: string;
          profileDir: string;
          hasBookmarks: boolean;
          hasHistory: boolean;
        }>
      > => invoke(IPC.IMPORT_SOURCES),
      /** Run an import. Bookmarks land in a dedicated folder; passwords never move. */
      run: (selection: {
        sourceId: string;
        bookmarks: boolean;
        history: boolean;
      }): Promise<
        | {
            ok: true;
            bookmarksImported: number;
            bookmarksSkipped: number;
            historyImported: number;
            folderName: string | null;
          }
        | { ok: false; error: 'source-gone' | 'locked' | 'nothing-selected' | 'read-failed' }
      > => invoke(IPC.IMPORT_RUN, selection),
    },
    auth: {
      /** HTTP authentication challenges (Basic/Digest/proxy) for this window. */
      onRequest: (handler: (req: AuthRequest) => void): Unsubscribe =>
        on<AuthRequest>(IPC.AUTH_REQUEST, handler),
      /** Credentials go straight to Chromium's auth callback; never persisted. */
      respond: (id: string, username: string, password: string) =>
        ipcRenderer.send(IPC.AUTH_RESPOND, { id, username, password }),
      cancel: (id: string) => ipcRenderer.send(IPC.AUTH_RESPOND, { id, cancel: true }),
    },
    menu: {
      onCommand: (handler: (cmd: string) => void): Unsubscribe =>
        on<string>(IPC.MENU_CMD, handler),
    },
  };
}

export type VoksaApi = ReturnType<typeof buildVoksaApi>;

/**
 * Expose the full `voksa` API on `window.voksa`. Only call this from trusted
 * contexts (chrome UI preload OR pages whose URL is an internal Voksa
 * endpoint) ; NEVER expose it to arbitrary web content, since the API can
 * create tabs, clear history, modify bookmarks, etc.
 */
export function exposeVoksaApi(): VoksaApi {
  const api = buildVoksaApi();
  try {
    contextBridge.exposeInMainWorld('voksa', api);
  } catch {
    // contextIsolation must be enabled for this to succeed. If it isn't,
    // expose on window directly as a last-ditch fallback (never happens in
    // our normal config).
    (window as unknown as { voksa: VoksaApi }).voksa = api;
  }
  return api;
}
