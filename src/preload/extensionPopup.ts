import { ipcRenderer } from 'electron';
import { IPC } from '../shared/ipcChannels';

/**
 * Session preload (registered on the tabs' session by
 * main/extensions/webstore.ts): the page preload for extension ACTION POPUPS.
 *
 * electron-chrome-extensions opens those popups in a BrowserWindow of its own
 * (PopupView) whose webPreferences carry no preload, and Electron offers no way
 * to give an existing webContents one. Session preloads do reach it (the
 * library's own chrome.* preload is one), so this script runs in every frame of
 * every webContents of the session and steps aside everywhere but there:
 *  - only a TOP-LEVEL chrome-extension:// document qualifies. Both checks are
 *    local (no IPC), so web frames pay the parse and nothing else. Since
 *    Electron 45 a chrome-extension:// frame only gets session or window
 *    preloads when it is top-level (or DevTools-hosted) anyway;
 *  - main then confirms the webContents really is one of the library's action
 *    popups. Every other surface that can show an extension page (tabs,
 *    window.open popups, chrome.windows.create popups) runs page.js as its OWN
 *    preload, and a second copy would double every listener and masker.
 * The verdict is synchronous on purpose: the shroud decision must be taken
 * before the first paint, exactly like page.ts's own config read.
 *
 * Fail-closed backstop: main never SHOWS such a popup under Stream Mode until
 * its document announced the page preload (stream-mode/extensionPopupGate.ts),
 * so a popup this script fails to reach stays invisible on stream, never raw.
 */
function wanted(): boolean {
  try {
    if (window.top !== window.self) return false;
    if (window.location.protocol !== 'chrome-extension:') return false;
    return ipcRenderer.sendSync(IPC.STREAM_EXT_POPUP_PRELOAD_SYNC) === true;
  } catch {
    return false;
  }
}

if (wanted()) {
  // require(), not import: imports are hoisted and would run the whole page
  // preload in every frame. esbuild bundles ./page as a lazily initialised
  // module, so its top-level code (the very same as the tabs' preload) runs
  // right here, synchronously at document-start, or not at all.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('./page');
}
