import type { StreamModeConfig } from './streamConfig';
import type { MemorySaverLevel } from './memorySaver';

export type TabError = {
  code: number;
  description: string;
  url: string;
};

export type TabState = {
  id: string;
  /**
   * webContents.id of the tab : the id the Chrome extension runtime uses
   * for chrome.tabs. Passed to <browser-action-list tab=…> so the element
   * targets the active tab explicitly instead of relying on window-focus
   * tracking.
   */
  wcId: number;
  url: string;
  title: string;
  favicon: string | null;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  isCrashed: boolean;
  isActive: boolean;
  isAudible: boolean;
  isMuted: boolean;
  isInternal: boolean;
  /**
   * Memory Saver: the tab has NO webContents at all, its renderer was freed.
   * It keeps its url/title/history and comes back when the user selects it.
   */
  isDiscarded: boolean;
  /** Rounded page zoom, percent (100 = default). */
  zoomPercent: number;
  /** Set when the last main-frame load failed → chrome UI renders an error page. */
  error: TabError | null;
};

export type DownloadState = 'progressing' | 'completed' | 'cancelled' | 'interrupted' | 'paused';

export type DownloadItem = {
  id: string;
  filename: string;
  url: string;
  savePath: string;
  state: DownloadState;
  receivedBytes: number;
  totalBytes: number;
  startedAt: number;
  paused: boolean;
};

export type ChromeBounds = {
  top: number;
  bottom: number;
  left: number;
  right: number;
};

export type HistoryEntry = {
  id: string;
  url: string;
  title: string;
  faviconUrl: string | null;
  visitedAt: number;
};

export type Bookmark = {
  id: string;
  url: string;
  title: string;
  faviconUrl: string | null;
  folderId: string | null;
  position: number;
  addedAt: number;
};

export type BookmarkFolder = {
  id: string;
  name: string;
  /** Parent folder id, or null for a folder living on the bookmark bar. */
  parentId: string | null;
  position: number;
};

/** Payload of BOOKMARKS_CHANGED : one atomic snapshot of both tables. */
export type BookmarksChangedPayload = {
  bookmarks: Bookmark[];
  folders: BookmarkFolder[];
};

export type Suggestion = {
  kind: 'history' | 'bookmark' | 'search' | 'url';
  label: string;
  url: string;
  subtitle?: string;
};

export type PermissionDecision = 'allow' | 'deny';

export type PrinterInfo = { name: string; displayName: string };

/** Electron's margin presets ('printableArea' = minimal printable margins). */
export type PrintMarginType = 'default' | 'none' | 'printableArea';

/** Options that affect page layout : a change re-renders the PDF preview. */
export type PrintPreviewOptions = {
  landscape: boolean;
  marginType: PrintMarginType;
  /** Chrome-style range string ('1-5, 8'); empty = all pages. */
  pageRanges: string;
  printBackground: boolean;
};

export type PrintExecuteOptions = PrintPreviewOptions & {
  /** null = save as PDF instead of a physical printer. */
  deviceName: string | null;
  copies: number;
  color: boolean;
};

export type PrintExecuteResult = { ok: boolean; error?: string };

/**
 * Auto-update state pushed to the settings page. `unsupported` covers dev
 * runs (unpackaged) and install channels without an update path (.deb).
 */
export type UpdateState = {
  currentVersion: string;
  phase:
    | 'idle'
    | 'checking'
    | 'downloading'
    | 'ready'
    | 'uptodate'
    | 'error'
    | 'unsupported';
  availableVersion?: string;
  /** Download progress 0-100, only meaningful while `downloading`. */
  percent?: number;
  error?: string;
};

/** One chrome.contextMenus item contributed by an extension (serialized). */
export type PageMenuExtensionItem = {
  id: string;
  label: string;
  enabled: boolean;
  type: 'normal' | 'separator' | 'submenu';
  children?: PageMenuExtensionItem[];
};

/**
 * Everything the React page context menu needs to render. Actions are sent
 * back as bare identifiers; the main process resolves URLs/coordinates
 * from its own stored copy of the click params, never from the renderer.
 */
export type PageMenuPayload = {
  token: number;
  /** Window coordinates (tab-view offset already applied). */
  x: number;
  y: number;
  linkURL: string;
  srcURL: string;
  mediaType: string;
  isEditable: boolean;
  selectionText: string;
  dictionarySuggestions: string[];
  canGoBack: boolean;
  canGoForward: boolean;
  extensions: PageMenuExtensionItem[];
};

/**
 * Fine-grained "clear browsing data" request. `since` (ms epoch, null = all
 * time) bounds the time-aware stores (history, download history); the other
 * data types have no per-entry timestamps in Chromium and are cleared whole.
 */
export type ClearBrowsingDataOptions = {
  since: number | null;
  history: boolean;
  downloads: boolean;
  cookies: boolean;
  cache: boolean;
  siteStorage: boolean;
  sitePermissions: boolean;
  zoomLevels: boolean;
};

export type AppSettings = {
  searchEngine: 'google' | 'duckduckgo' | 'startpage' | 'brave';
  theme: 'dark' | 'light' | 'system';
  /** UI language; 'system' follows the OS locale (French, else English). */
  language: 'system' | 'fr' | 'en';
  homepage: string;
  showBookmarkBar: boolean;
  streamMode: StreamModeConfig;
  /** Ordered list of extension IDs as the user has arranged them. */
  extensionOrder: string[];
  /** Per-origin remembered permission decisions (Stream Mode OFF prompts). */
  sitePermissions: Record<string, Record<string, PermissionDecision>>;
  /** Per-host persisted zoom levels (Electron zoom-level units). */
  zoomLevels: Record<string, number>;
  /** Chrome-like tab discarding: frees the renderer of inactive tabs. */
  memorySaver: MemorySaverLevel;
  /** Hosts never discarded, even when idle (matched on a dot boundary). */
  memorySaverExceptions: string[];
};

export type ExtensionInfo = {
  id: string;
  name: string;
  version: string;
  description: string;
  iconUrl: string | null;
  popupUrl: string | null;
  title: string;
  hasPopup: boolean;
  hasAction: boolean;
};
