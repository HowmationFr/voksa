import path from 'node:path';
import { app } from 'electron';

/**
 * The page preload: frame liveness (frame guard), the Stream Mode L0 shroud and
 * L1 masker, the webdriver patch. Every surface that can paint web or extension
 * content must run it, or Stream Mode has nothing to mask with.
 */
export function pagePreloadPath(): string {
  return path.join(app.getAppPath(), 'dist-electron', 'preload', 'page.js');
}

/**
 * Session preload that hands the page preload to extension action popups,
 * which electron-chrome-extensions creates without one (see
 * src/preload/extensionPopup.ts).
 */
export function extensionPopupPreloadPath(): string {
  return path.join(app.getAppPath(), 'dist-electron', 'preload', 'extensionPopup.js');
}

/**
 * webPreferences of every page window that is NOT a tab: window.open popups at
 * ANY depth (OAuth / SSO keep window.opener) and chrome.windows.create popups.
 * Same protection as Tab.createView, and the same reasons:
 *  - the page preload in the main frame AND every subframe
 *    (nodeIntegrationInSubFrames), so the shroud and masker run everywhere and
 *    the frame guard can tell protected frames from preload-less ones;
 *  - `sandbox: true` like the tabs. Not only hardening: Electron 45 (#52472)
 *    puts a child whose sandbox state differs from its opener's in another
 *    process, so opener and child must agree for window.opener flows to keep
 *    working the way they do between two tabs;
 *  - `plugins: true` so a popup landing on a PDF renders it instead of
 *    downloading it.
 * The preload is never inherited from the opener (Electron only carries over a
 * handful of security flags), so every level of a popup chain must be handed
 * these explicitly.
 */
export function popupWebPreferences(): Electron.WebPreferences {
  return {
    preload: pagePreloadPath(),
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: true,
    plugins: true,
  };
}
