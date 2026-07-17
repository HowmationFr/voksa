export const IPC = {
  // Tabs
  TAB_CREATE: 'tab:create',
  TAB_CLOSE: 'tab:close',
  TAB_ACTIVATE: 'tab:activate',
  TAB_REORDER: 'tab:reorder',
  TAB_NAVIGATE: 'tab:navigate',
  TAB_BACK: 'tab:back',
  TAB_FORWARD: 'tab:forward',
  TAB_RELOAD: 'tab:reload',
  TAB_STOP: 'tab:stop',
  TAB_UPDATED: 'tab:updated',
  TAB_LIST: 'tab:list',
  TAB_SET_CHROME_BOUNDS: 'tab:setChromeBounds',
  TAB_REOPEN_CLOSED: 'tab:reopenClosed',
  TAB_MUTE: 'tab:mute',
  TAB_SET_PINNED: 'tab:setPinned',
  // DMCA Audio Guard: lift a guard-mute for this tab's lifetime (the chip).
  TAB_ALLOW_STREAM_AUDIO: 'tab:allowStreamAudio',
  TAB_DUPLICATE: 'tab:duplicate',
  /** Memory Saver: free this tab's renderer (it reloads when selected again). */
  TAB_DISCARD: 'tab:discard',
  TAB_CLOSE_OTHERS: 'tab:closeOthers',
  TAB_CLOSE_RIGHT: 'tab:closeRight',
  CHROME_SET_OVERLAY: 'chrome:setOverlay',

  // Find in page
  FIND_START: 'find:start',
  FIND_STOP: 'find:stop',
  FIND_RESULT: 'find:result',

  // Zoom
  ZOOM_ADJUST: 'zoom:adjust',
  ZOOM_RESET: 'zoom:reset',

  // Page actions
  PAGE_MENU_SHOW: 'pageMenu:show',
  PAGE_MENU_CLOSE: 'pageMenu:close',
  PAGE_MENU_ACTION: 'pageMenu:action',

  // Printing (preview dialog in the chrome UI)
  PRINT_LIST_PRINTERS: 'print:printers',
  PRINT_PREVIEW: 'print:preview',
  PRINT_EXECUTE: 'print:execute',

  // Auto-update (GitHub Releases via electron-updater)
  UPDATES_GET_STATE: 'updates:getState',
  UPDATES_CHECK: 'updates:check',
  UPDATES_INSTALL: 'updates:install',
  UPDATES_STATE_CHANGED: 'updates:stateChanged',

  // Downloads
  DOWNLOADS_LIST: 'downloads:list',
  DOWNLOADS_CHANGED: 'downloads:changed',
  DOWNLOAD_OPEN: 'download:open',
  DOWNLOAD_OPEN_FOLDER: 'download:openFolder',
  DOWNLOAD_CANCEL: 'download:cancel',
  DOWNLOAD_PAUSE: 'download:pause',
  DOWNLOAD_RESUME: 'download:resume',
  DOWNLOAD_REMOVE: 'download:remove',
  DOWNLOAD_CLEAR: 'download:clear',

  // History
  HISTORY_LIST: 'history:list',
  HISTORY_SEARCH: 'history:search',
  HISTORY_TOP_SITES: 'history:topSites',
  HISTORY_DELETE: 'history:delete',
  HISTORY_CLEAR: 'history:clear',

  // Bookmarks (BOOKMARKS_CHANGED carries { bookmarks, folders })
  BOOKMARKS_LIST: 'bookmarks:list',
  BOOKMARKS_ADD: 'bookmarks:add',
  BOOKMARKS_REMOVE: 'bookmarks:remove',
  BOOKMARKS_UPDATE: 'bookmarks:update',
  BOOKMARKS_MOVE: 'bookmarks:move',
  BOOKMARKS_REORDER_MIXED: 'bookmarks:reorderMixed',
  BOOKMARKS_FIND_BY_URL: 'bookmarks:findByUrl',
  BOOKMARKS_CHANGED: 'bookmarks:changed',
  BOOKMARKS_FOLDERS_LIST: 'bookmarks:foldersList',
  BOOKMARKS_FOLDER_ADD: 'bookmarks:folderAdd',
  BOOKMARKS_FOLDER_RENAME: 'bookmarks:folderRename',
  BOOKMARKS_FOLDER_REMOVE: 'bookmarks:folderRemove',
  BOOKMARKS_FOLDER_MOVE: 'bookmarks:folderMove',

  // Settings
  SETTINGS_GET: 'settings:get',
  SETTINGS_UPDATE: 'settings:update',
  SETTINGS_CHANGED: 'settings:changed',

  // Stream Mode
  STREAM_GET_CONFIG: 'stream:getConfig',
  STREAM_GET_CONFIG_SYNC: 'stream:getConfigSync',
  STREAM_UPDATE_CONFIG: 'stream:updateConfig',
  STREAM_TOGGLE: 'stream:toggle',
  // Panic: curtain + mute every window, arm the stream; second call restores.
  // The system-wide hotkey is just another trigger of the same action.
  STREAM_PANIC: 'stream:panic',
  // Capture Handshake: main pushes the screen-share picker to the chrome UI,
  // the UI answers with the chosen source id (or null = cancelled).
  CAPTURE_PICKER_SHOW: 'stream:capturePickerShow',
  CAPTURE_PICKER_PICK: 'stream:capturePickerPick',
  // Debug-only (smoke): drive the handshake without Chromium's getDisplayMedia,
  // which does not route to setDisplayMediaRequestHandler under CDP.
  CAPTURE_SIMULATE: 'stream:captureSimulate',
  // Go-Live Preflight: scan Voksa's tabs for what a viewer could catch.
  PREFLIGHT_RUN: 'stream:preflightRun',
  STREAM_CONFIG_CHANGED: 'stream:configChanged',
  STREAM_DOC_START: 'stream:docStart',
  STREAM_READY: 'stream:ready',

  // Stream Mode frame guard (unprotected subframes, electron/electron#34727).
  // STREAM_FRAME_ALIVE: every frame announces itself at preload start, so main
  // knows which frames actually got a preload (hence a shroud + masker).
  // STREAM_FRAME_GATE: a frame hid iframe element(s) and asks main to confirm
  // coverage before they may be revealed again.
  // STREAM_FRAMES_STATUS: main's per-tab verdict, pushed to every frame.
  STREAM_FRAME_ALIVE: 'stream:frameAlive',
  STREAM_FRAME_GATE: 'stream:frameGate',
  STREAM_FRAMES_STATUS: 'stream:framesStatus',

  // Per-tab audio output routing (DMCA Audio Guard stage 2). The route is a
  // device LABEL (deviceIds are origin-hashed, see shared/audioRouting.ts):
  // SET stores it on the tab, APPLY pushes it to every frame, GET_SYNC lets a
  // new document re-arm at document-start, STATUS carries the main frame's
  // resolve verdict (matched:false clears the route: fail-visible).
  AUDIO_ROUTE_SET: 'audioRoute:set',
  AUDIO_ROUTE_APPLY: 'audioRoute:apply',
  AUDIO_ROUTE_GET_SYNC: 'audioRoute:getSync',
  AUDIO_ROUTE_STATUS: 'audioRoute:status',

  // Permissions (Stream Mode OFF → prompt)
  PERMISSION_REQUEST: 'permission:request',
  PERMISSION_RESPOND: 'permission:respond',

  // Suggestions
  SUGGESTIONS_QUERY: 'suggestions:query',

  // Extensions
  EXTENSIONS_LIST: 'extensions:list',
  EXTENSIONS_UNINSTALL: 'extensions:uninstall',
  EXTENSIONS_REORDER: 'extensions:reorder',
  EXTENSIONS_CHANGED: 'extensions:changed',

  // Browser-data import (Chrome/Firefox: bookmarks + history, never passwords)
  IMPORT_SOURCES: 'import:sources',
  IMPORT_RUN: 'import:run',

  // App
  // Default browser: state (is Voksa the http/https handler?) and the request
  // to become it (macOS/Linux: direct; Windows: opens ms-settings, the OS
  // does not allow a programmatic claim).
  APP_DEFAULT_BROWSER_STATE: 'app:defaultBrowserState',
  APP_SET_DEFAULT_BROWSER: 'app:setDefaultBrowser',
  APP_OPEN_DEVTOOLS: 'app:openDevtools',
  APP_GET_HOSTNAME: 'app:getHostname',
  APP_OPEN_EXTERNAL: 'app:openExternal',
  APP_SET_THEME: 'app:setTheme',
  APP_CLEAR_BROWSING_DATA: 'app:clearBrowsingData',

  // Window controls
  WINDOW_NEW: 'window:new',
  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_MAXIMIZE: 'window:maximize',
  WINDOW_CLOSE: 'window:close',
  WINDOW_STATE: 'window:state',
  WINDOW_STATE_CHANGED: 'window:stateChanged',

  // HTTP authentication (Basic/Digest/proxy): main pushes a credential
  // request to the owning window's chrome UI, the dialog answers back.
  AUTH_REQUEST: 'auth:request',
  AUTH_RESPOND: 'auth:respond',

  // TLS interstitial: proceed past a certificate error for the failed tab's
  // host (session-scoped exception, never persisted).
  TAB_TLS_PROCEED: 'tabs:tlsProceed',

  // Stream Mode curtain (prevents background flash during navigation)
  CURTAIN_SET: 'curtain:set',
  CURTAIN_READY: 'curtain:ready',
  CURTAIN_CLEAR: 'curtain:clear',

  // Menu → renderer command bus (single source of truth is menu accelerators)
  MENU_CMD: 'menu:cmd',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];
