import { BrowserWindow, dialog } from 'electron';
import type { BaseWindow, ContextMenuParams, MenuItem, Session, WebContents } from 'electron';
import {
  focusedWindow,
  openNewWindow,
  windowById,
  windowFromPageContents,
} from '../windows';
import { t } from '../i18n';

/**
 * Chrome Web Store + Chrome extension runtime integration.
 *
 * Both packages come from Samuel Maddock's `electron-browser-shell` project:
 *   - `electron-chrome-extensions` provides the runtime APIs (chrome.runtime,
 *     chrome.tabs, chrome.management, extension popups, browser actions…)
 *     that a Chrome extension expects. Without it, chromewebstore.google.com
 *     detects the browser as "not a valid Chrome build" and shows
 *     "Élément actuellement indisponible" on every extension page.
 *   - `electron-chrome-web-store` hooks into the webstore UI to turn
 *     "Add to Chrome" buttons into real CRX downloads that get installed
 *     into the session via `session.loadExtension`.
 *
 * Both run on the SAME session as the tabs; this is essential. If the
 * extensions runtime is registered on `defaultSession` but tabs run on
 * `persist:main`, the webstore page (which lives in a tab) has no access
 * to the chrome.* APIs and can't install anything.
 *
 * The chrome.tabs / chrome.windows surface resolves its target window through
 * the live-window registry (src/main/windows.ts): the library passes a
 * windowId (or we fall back to the focused window), so extensions work across
 * every window. The library forbids two instances per session, so
 * setupChromeWebStore runs ONCE at boot (index.ts), BEFORE any window is
 * created, so both libraries' session preloads are registered in time.
 *
 * The `electron-chrome-extensions` library is dual-licensed (GPL-3.0 or
 * Patron). We go with `GPL-3.0` here since this project is personal/OSS;
 * switch to 'Patron-License-2020-11-19' if you acquire that license.
 */

type ExtensionsRuntime = {
  addTab: (wc: WebContents, window: BaseWindow) => void;
  removeTab: (wc: WebContents) => void;
  selectTab: (wc: WebContents) => void;
  getContextMenuItems: (wc: WebContents, params: ContextMenuParams) => MenuItem[];
};

let runtime: ExtensionsRuntime | null = null;

// Loose local shapes for the chrome.* detail objects. The library types them
// via @types/chrome, which we deliberately keep out of the main-process
// tsconfig; method-parameter bivariance makes these narrower shapes valid.
type TabCreateDetails = { url?: string; active?: boolean; windowId?: number };
type WindowCreateDetails = {
  url?: string | string[];
  type?: string;
  width?: number;
  height?: number;
};
type PermissionsRequest = { permissions?: string[]; origins?: string[] };

export async function setupChromeWebStore(session: Session): Promise<void> {
  // 1. Chrome extension runtime (chrome.* APIs, popup host, action bar).
  try {
    const extMod = await import('electron-chrome-extensions');
    // handleCRXProtocol registers the crx:// scheme used by the extension
    // icon popups (<browser-action-list>).
    if (typeof extMod.ElectronChromeExtensions?.handleCRXProtocol === 'function') {
      try {
        extMod.ElectronChromeExtensions.handleCRXProtocol(session);
      } catch {
        // already registered on this session; fine
      }
    }

    const Ctor = extMod.ElectronChromeExtensions;
    if (Ctor) {
      const instance = new Ctor({
        license: 'GPL-3.0',
        session,
        createTab: async (details: TabCreateDetails) => {
          // chrome.tabs.create: options pages, onboarding tabs, "open in
          // new tab" actions. `active` defaults to true in Chrome. The
          // library fills windowId with its last-focused window when the
          // extension did not name one.
          const target =
            (typeof details.windowId === 'number' ? windowById(details.windowId) : null) ??
            focusedWindow();
          if (!target) throw new Error('no window available for chrome.tabs.create');
          const tab = target.tabs.create(details.url ?? 'voksa://newtab', {
            activate: details.active !== false,
          });
          return [tab.view.webContents, target.window] as [WebContents, BaseWindow];
        },
        selectTab: (wc: WebContents) => {
          const win = windowFromPageContents(wc);
          const tab = win?.tabs.findByWebContents(wc);
          if (win && tab) win.tabs.setActive(tab.id);
        },
        removeTab: (wc: WebContents) => {
          const win = windowFromPageContents(wc);
          const tab = win?.tabs.findByWebContents(wc);
          if (win && tab) win.tabs.close(tab.id);
        },
        createWindow: async (details: WindowCreateDetails) => {
          const url = Array.isArray(details.url) ? details.url[0] : details.url;
          if (details.type === 'popup') {
            // chrome.windows.create({ type: 'popup' }): OAuth flows, small
            // auxiliary windows. A real BrowserWindow on the same session so
            // extension preloads + cookies apply; registered as a tab so
            // chrome.tabs can target it and window.close() round-trips.
            const popup = new BrowserWindow({
              width: details.width ?? 800,
              height: details.height ?? 600,
              webPreferences: {
                session,
                sandbox: true,
                contextIsolation: true,
                nodeIntegration: false,
              },
            });
            runtime?.addTab(popup.webContents, popup);
            if (url) void popup.loadURL(url);
            return popup;
          }
          // 'normal' windows: a real browser window now that Voksa supports
          // several. Fall back to a tab if the factory is not wired yet.
          const created = await openNewWindow(url ?? undefined);
          if (created) return created.window;
          const fallback = focusedWindow();
          if (!fallback) throw new Error('no window available for chrome.windows.create');
          fallback.tabs.create(url ?? 'voksa://newtab');
          return fallback.window;
        },
        removeWindow: (win: BaseWindow) => {
          // The library also relays a window's own 'closed' event here: the
          // BaseWindow may already be destroyed, and every getter (win.id
          // included) throws on a destroyed window. Nothing left to close.
          if (win.isDestroyed()) return;
          // One of our browser windows: close() it gracefully so the session
          // bookkeeping (Chrome-like forget-on-close) runs; library popups
          // are not tracked by the registry and are simply destroyed.
          const managed = windowById(win.id);
          if (managed) {
            managed.window.close();
            return;
          }
          if (!win.isDestroyed()) win.destroy();
        },
        requestPermissions: async (
          extension: { name: string },
          permissions: PermissionsRequest,
        ) => {
          const requested = [
            ...(permissions.permissions ?? []),
            ...(permissions.origins ?? []),
          ];
          const parent = focusedWindow()?.window;
          const opts = {
            type: 'question' as const,
            buttons: [t('Autoriser'), t('Refuser')],
            defaultId: 0,
            cancelId: 1,
            message: t('« {name} » demande des autorisations supplémentaires', {
              name: extension.name,
            }),
            detail: requested.join('\n'),
          };
          const { response } = parent
            ? await dialog.showMessageBox(parent, opts)
            : await dialog.showMessageBox(opts);
          return response === 0;
        },
      });

      runtime = {
        addTab: (wc, win) => instance.addTab(wc, win),
        removeTab: (wc) => instance.removeTab(wc),
        selectTab: (wc) => instance.selectTab(wc),
        getContextMenuItems: (wc, params) => instance.getContextMenuItems(wc, params),
      };
      console.log('[extensions] Chrome extension runtime ready.');
    }
  } catch (err) {
    console.warn('[extensions] Chrome extension runtime unavailable:', err);
  }

  // 2. Chrome Web Store installer (scans the webstore page, intercepts
  // install buttons, downloads CRX, calls session.loadExtension).
  try {
    const wsMod = await import('electron-chrome-web-store');
    const installer = wsMod.installChromeWebStore ?? (wsMod as { setup?: unknown }).setup;
    if (typeof installer === 'function') {
      await (installer as (opts: { session: Session }) => Promise<void>)({ session });
      console.log('[extensions] Chrome Web Store ready on session.');
    } else {
      console.warn('[extensions] installChromeWebStore not found in module.');
    }
  } catch (err) {
    console.warn('[extensions] Chrome Web Store unavailable:', err);
  }
}

/**
 * Register a newly-created tab with the extensions runtime. Called by
 * TabManager right after it creates a Tab so the extensions APIs see it.
 */
export function registerTabWithExtensions(wc: WebContents, window: BaseWindow): void {
  runtime?.addTab(wc, window);
}

export function unregisterTabFromExtensions(wc: WebContents): void {
  runtime?.removeTab(wc);
}

export function notifyTabSelected(wc: WebContents): void {
  runtime?.selectTab(wc);
}

/**
 * Menu items registered by extensions via chrome.contextMenus for this
 * click. Empty when the runtime is unavailable or the extension registered
 * nothing matching the clicked context.
 */
export function getExtensionContextMenuItems(
  wc: WebContents,
  params: ContextMenuParams,
): MenuItem[] {
  try {
    return runtime?.getContextMenuItems(wc, params) ?? [];
  } catch {
    return [];
  }
}
