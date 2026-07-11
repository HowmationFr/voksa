import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type IpcChannel } from '../shared/ipcChannels';
import type {
  AppSettings,
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

export function buildVoksaApi() {
  return {
    tabs: {
      create: (url?: string): Promise<string> => ipcRenderer.invoke(IPC.TAB_CREATE, url),
      close: (id: string) => ipcRenderer.invoke(IPC.TAB_CLOSE, id),
      activate: (id: string) => ipcRenderer.invoke(IPC.TAB_ACTIVATE, id),
      reorder: (ids: string[]) => ipcRenderer.invoke(IPC.TAB_REORDER, ids),
      navigate: (id: string, url: string) => ipcRenderer.invoke(IPC.TAB_NAVIGATE, id, url),
      back: (id: string) => ipcRenderer.invoke(IPC.TAB_BACK, id),
      forward: (id: string) => ipcRenderer.invoke(IPC.TAB_FORWARD, id),
      reload: (id: string) => ipcRenderer.invoke(IPC.TAB_RELOAD, id),
      stop: (id: string) => ipcRenderer.invoke(IPC.TAB_STOP, id),
      list: (): Promise<TabState[]> => ipcRenderer.invoke(IPC.TAB_LIST),
      reopenClosed: () => ipcRenderer.invoke(IPC.TAB_REOPEN_CLOSED),
      mute: (id: string, muted?: boolean) => ipcRenderer.invoke(IPC.TAB_MUTE, id, muted),
      duplicate: (id: string) => ipcRenderer.invoke(IPC.TAB_DUPLICATE, id),
      closeOthers: (id: string) => ipcRenderer.invoke(IPC.TAB_CLOSE_OTHERS, id),
      closeRight: (id: string) => ipcRenderer.invoke(IPC.TAB_CLOSE_RIGHT, id),
      setChromeBounds: (bounds: ChromeBounds) =>
        ipcRenderer.invoke(IPC.TAB_SET_CHROME_BOUNDS, bounds),
      setOverlayMode: (open: boolean) => ipcRenderer.invoke(IPC.CHROME_SET_OVERLAY, open),
      onUpdate: (handler: (tabs: TabState[]) => void): Unsubscribe =>
        on<TabState[]>(IPC.TAB_UPDATED, handler),
    },
    find: {
      start: (id: string, text: string, forward: boolean, matchCase: boolean) =>
        ipcRenderer.invoke(IPC.FIND_START, id, text, forward, matchCase),
      stop: (id: string) => ipcRenderer.invoke(IPC.FIND_STOP, id),
      onResult: (
        handler: (r: { tabId: string; activeMatchOrdinal: number; matches: number }) => void,
      ): Unsubscribe =>
        on<{ tabId: string; activeMatchOrdinal: number; matches: number }>(IPC.FIND_RESULT, handler),
    },
    zoom: {
      adjust: (id: string, delta: number) => ipcRenderer.invoke(IPC.ZOOM_ADJUST, id, delta),
      reset: (id: string) => ipcRenderer.invoke(IPC.ZOOM_RESET, id),
    },
    downloads: {
      list: (): Promise<DownloadItem[]> => ipcRenderer.invoke(IPC.DOWNLOADS_LIST),
      open: (id: string) => ipcRenderer.invoke(IPC.DOWNLOAD_OPEN, id),
      openFolder: (id: string) => ipcRenderer.invoke(IPC.DOWNLOAD_OPEN_FOLDER, id),
      cancel: (id: string) => ipcRenderer.invoke(IPC.DOWNLOAD_CANCEL, id),
      pause: (id: string) => ipcRenderer.invoke(IPC.DOWNLOAD_PAUSE, id),
      resume: (id: string) => ipcRenderer.invoke(IPC.DOWNLOAD_RESUME, id),
      remove: (id: string) => ipcRenderer.invoke(IPC.DOWNLOAD_REMOVE, id),
      clear: () => ipcRenderer.invoke(IPC.DOWNLOAD_CLEAR),
      onChanged: (handler: (items: DownloadItem[]) => void): Unsubscribe =>
        on<DownloadItem[]>(IPC.DOWNLOADS_CHANGED, handler),
    },
    history: {
      list: (limit?: number, offset?: number): Promise<HistoryEntry[]> =>
        ipcRenderer.invoke(IPC.HISTORY_LIST, limit, offset),
      search: (query: string, limit?: number): Promise<HistoryEntry[]> =>
        ipcRenderer.invoke(IPC.HISTORY_SEARCH, query, limit),
      topSites: (limit?: number): Promise<HistoryEntry[]> =>
        ipcRenderer.invoke(IPC.HISTORY_TOP_SITES, limit),
      delete: (id: string) => ipcRenderer.invoke(IPC.HISTORY_DELETE, id),
      clear: () => ipcRenderer.invoke(IPC.HISTORY_CLEAR),
    },
    bookmarks: {
      list: (): Promise<Bookmark[]> => ipcRenderer.invoke(IPC.BOOKMARKS_LIST),
      listFolders: (): Promise<BookmarkFolder[]> =>
        ipcRenderer.invoke(IPC.BOOKMARKS_FOLDERS_LIST),
      add: (payload: {
        url: string;
        title: string;
        faviconUrl: string | null;
        folderId?: string | null;
      }): Promise<Bookmark> => ipcRenderer.invoke(IPC.BOOKMARKS_ADD, payload),
      remove: (id: string) => ipcRenderer.invoke(IPC.BOOKMARKS_REMOVE, id),
      update: (id: string, patch: Partial<Omit<Bookmark, 'id'>>) =>
        ipcRenderer.invoke(IPC.BOOKMARKS_UPDATE, id, patch),
      move: (id: string, folderId: string | null) =>
        ipcRenderer.invoke(IPC.BOOKMARKS_MOVE, id, folderId),
      reorderMixed: (container: string | null, items: MixedItemRef[]) =>
        ipcRenderer.invoke(IPC.BOOKMARKS_REORDER_MIXED, container, items),
      addFolder: (name: string, parentId?: string | null): Promise<BookmarkFolder> =>
        ipcRenderer.invoke(IPC.BOOKMARKS_FOLDER_ADD, name, parentId ?? null),
      renameFolder: (id: string, name: string) =>
        ipcRenderer.invoke(IPC.BOOKMARKS_FOLDER_RENAME, id, name),
      removeFolder: (id: string) => ipcRenderer.invoke(IPC.BOOKMARKS_FOLDER_REMOVE, id),
      moveFolder: (id: string, parentId: string | null) =>
        ipcRenderer.invoke(IPC.BOOKMARKS_FOLDER_MOVE, id, parentId),
      findByUrl: (url: string): Promise<Bookmark | null> =>
        ipcRenderer.invoke(IPC.BOOKMARKS_FIND_BY_URL, url),
      onChanged: (handler: (payload: BookmarksChangedPayload) => void): Unsubscribe =>
        on<BookmarksChangedPayload>(IPC.BOOKMARKS_CHANGED, handler),
    },
    settings: {
      get: (): Promise<AppSettings> => ipcRenderer.invoke(IPC.SETTINGS_GET),
      update: (patch: Partial<AppSettings>): Promise<AppSettings> =>
        ipcRenderer.invoke(IPC.SETTINGS_UPDATE, patch),
      onChanged: (handler: (settings: AppSettings) => void): Unsubscribe =>
        on<AppSettings>(IPC.SETTINGS_CHANGED, handler),
    },
    stream: {
      get: (): Promise<StreamModeConfig> => ipcRenderer.invoke(IPC.STREAM_GET_CONFIG),
      update: (patch: Partial<StreamModeConfig>): Promise<StreamModeConfig> =>
        ipcRenderer.invoke(IPC.STREAM_UPDATE_CONFIG, patch),
      toggle: (): Promise<StreamModeConfig> => ipcRenderer.invoke(IPC.STREAM_TOGGLE),
      onChanged: (handler: (config: StreamModeConfig) => void): Unsubscribe =>
        on<StreamModeConfig>(IPC.STREAM_CONFIG_CHANGED, handler),
    },
    suggestions: {
      query: (q: string): Promise<Suggestion[]> => ipcRenderer.invoke(IPC.SUGGESTIONS_QUERY, q),
    },
    pageMenu: {
      onShow: (handler: (payload: PageMenuPayload) => void): Unsubscribe =>
        on<PageMenuPayload>(IPC.PAGE_MENU_SHOW, handler),
      onClose: (handler: () => void): Unsubscribe => on<void>(IPC.PAGE_MENU_CLOSE, handler),
      action: (token: number, action: string, arg?: number | string) =>
        ipcRenderer.invoke(IPC.PAGE_MENU_ACTION, token, action, arg),
    },
    updates: {
      getState: (): Promise<UpdateState> => ipcRenderer.invoke(IPC.UPDATES_GET_STATE),
      check: (): Promise<UpdateState> => ipcRenderer.invoke(IPC.UPDATES_CHECK),
      install: (): Promise<void> => ipcRenderer.invoke(IPC.UPDATES_INSTALL),
      onChanged: (handler: (state: UpdateState) => void): Unsubscribe =>
        on<UpdateState>(IPC.UPDATES_STATE_CHANGED, handler),
    },
    print: {
      printers: (tabId: string): Promise<PrinterInfo[]> =>
        ipcRenderer.invoke(IPC.PRINT_LIST_PRINTERS, tabId),
      preview: (tabId: string, opts: PrintPreviewOptions): Promise<string | null> =>
        ipcRenderer.invoke(IPC.PRINT_PREVIEW, tabId, opts),
      execute: (tabId: string, opts: PrintExecuteOptions): Promise<PrintExecuteResult> =>
        ipcRenderer.invoke(IPC.PRINT_EXECUTE, tabId, opts),
    },
    extensions: {
      list: (): Promise<ExtensionInfo[]> => ipcRenderer.invoke(IPC.EXTENSIONS_LIST),
      uninstall: (id: string): Promise<void> =>
        ipcRenderer.invoke(IPC.EXTENSIONS_UNINSTALL, id),
      reorder: (ids: string[]): Promise<void> =>
        ipcRenderer.invoke(IPC.EXTENSIONS_REORDER, ids),
      onChanged: (handler: (list: ExtensionInfo[]) => void): Unsubscribe =>
        on<ExtensionInfo[]>(IPC.EXTENSIONS_CHANGED, handler),
    },
    app: {
      openDevTools: () => ipcRenderer.invoke(IPC.APP_OPEN_DEVTOOLS),
      openExternal: (url: string) => ipcRenderer.invoke(IPC.APP_OPEN_EXTERNAL, url),
      getHostname: (): Promise<string> => ipcRenderer.invoke(IPC.APP_GET_HOSTNAME),
      setTheme: (theme: 'light' | 'dark') => ipcRenderer.invoke(IPC.APP_SET_THEME, theme),
      clearBrowsingData: (opts: ClearBrowsingDataOptions) =>
        ipcRenderer.invoke(IPC.APP_CLEAR_BROWSING_DATA, opts),
    },
    window: {
      /** Open a brand-new browser window (fresh tab, cascaded position). */
      openNew: (): Promise<void> => ipcRenderer.invoke(IPC.WINDOW_NEW),
      minimize: () => ipcRenderer.invoke(IPC.WINDOW_MINIMIZE),
      maximize: () => ipcRenderer.invoke(IPC.WINDOW_MAXIMIZE),
      close: () => ipcRenderer.invoke(IPC.WINDOW_CLOSE),
      getState: (): Promise<{ maximized: boolean; minimized: boolean; fullscreen: boolean }> =>
        ipcRenderer.invoke(IPC.WINDOW_STATE),
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
