import path from 'node:path';
import fs from 'node:fs';
import { app, BaseWindow, WebContentsView, screen } from 'electron';
import { TabManager } from './tabs/TabManager';
import { computeChromeViewBounds } from './tabs/bounds';
import { CurtainController, type OverlayController } from './stream-mode/curtain';
import { StatusViewController } from './statusView';
import { PageMenuController } from './pageContextMenu';
import { PrintController } from './printing';
import type { SessionWindow } from './storage/session';
import type { ChromeBounds } from '../shared/types';

export type AppWindow = {
  window: BaseWindow;
  chromeView: WebContentsView;
  tabs: TabManager;
  curtain: CurtainController;
  statusView: StatusViewController;
  pageMenu: PageMenuController;
  printing: PrintController;
  updateChromeBounds: (bounds: ChromeBounds) => void;
  setOverlayMode: (open: boolean) => void;
  /**
   * Load the chrome UI, then open what the startup plan says. Call AFTER
   * registerIpcHandlers: the page preload reads the stream config
   * synchronously at document-start.
   */
  bootstrap: (opts: BootstrapOptions) => Promise<void>;
};

/** What a window opens with. `saved` only ever supplies geometry + the closed stack, unless the plan says 'restore'. */
export type BootstrapOptions = {
  saved?: SessionWindow | null;
  open:
    | { kind: 'restore' }
    | { kind: 'urls'; urls: string[] }
    | { kind: 'url'; url: string }
    | { kind: 'newtab' };
};

/**
 * Runtime window icon. Windows/macOS embed the icon in the exe/bundle, but
 * on Linux the window/taskbar icon comes from this option; the PNG is
 * shipped inside the asar (electron-builder `files`) so the path resolves
 * in production too.
 */
function resolveWindowIcon(): string | undefined {
  const candidate = path.join(app.getAppPath(), 'resources', 'icon.png');
  return fs.existsSync(candidate) ? candidate : undefined;
}

/** Clamp restored window bounds to a currently-connected display. */
export function boundsAreVisible(bounds: { x: number; y: number; width: number; height: number }): boolean {
  try {
    const displays = screen.getAllDisplays();
    return displays.some((d) => {
      const wa = d.workArea;
      return (
        bounds.x < wa.x + wa.width &&
        bounds.x + bounds.width > wa.x &&
        bounds.y < wa.y + wa.height &&
        bounds.y + bounds.height > wa.y
      );
    });
  } catch {
    return false;
  }
}

export async function createAppWindow(userAgent: string): Promise<AppWindow> {
  const window = new BaseWindow({
    width: 1440,
    height: 900,
    minWidth: 760,
    minHeight: 480,
    frame: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    trafficLightPosition: process.platform === 'darwin' ? { x: 14, y: 14 } : undefined,
    backgroundColor: '#fafbfc',
    icon: resolveWindowIcon(),
    show: false,
  });

  const chromeView = new WebContentsView({
    webPreferences: {
      preload: path.join(app.getAppPath(), 'dist-electron', 'preload', 'ui.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Chromium's built-in PDF viewer (used by the print-preview iframe)
      // is implemented as a plugin; without this, blob: PDFs download
      // instead of rendering.
      plugins: true,
    },
  });
  chromeView.setBackgroundColor('#00000000');

  let currentChromeBounds: ChromeBounds = { top: 88, bottom: 0, left: 0, right: 0 };

  // Overlay expansion is a refcounted set of demands (CLAUDE.md §4.3/§4.8):
  //   'ui'            : menus / internal pages / suggestions (Chrome.tsx)
  //   'curtain:<id>'  : a Stream Mode curtain over a tab
  // The chromeView expands to full-window iff the set is non-empty. This ends
  // the two-writers war where a curtain drop could collapse an open menu.
  const expandRequests = new Set<string>();
  const isExpanded = () => expandRequests.size > 0;

  const computeCurrentChromeRect = (): Electron.Rectangle => {
    if (isExpanded()) {
      const [w, h] = window.getContentSize();
      return { x: 0, y: 0, width: w, height: h };
    }
    return computeChromeViewBounds(window, currentChromeBounds);
  };

  // Status bubble joins the tree BEFORE the chromeView so the initial
  // z-order is [statusView, chromeView]: curtains/menus painted by the
  // chromeView always cover the bubble.
  const statusView = new StatusViewController(window);
  statusView.attach();

  chromeView.setBounds(computeCurrentChromeRect());
  window.contentView.addChildView(chromeView);

  const applyChromeBounds = () => {
    // Reachable during teardown: a curtain still up at quit is cleared by the
    // tab-destruction relay (TabManager.close -> curtain.handleTabClosed ->
    // overlay.release), and getContentSize()/setBounds throw on a destroyed
    // window. The window is only ever destroyed at quit, so this guard cannot
    // affect normal use.
    if (window.isDestroyed()) return;
    // ONLY resize, never remove+re-add the chromeView (that destroys native
    // focus and would blur the address bar). See CLAUDE.md §4.3.
    chromeView.setBounds(computeCurrentChromeRect());
  };

  const overlay: OverlayController = {
    acquire: (key) => {
      const was = isExpanded();
      expandRequests.add(key);
      if (!was) applyChromeBounds();
    },
    release: (key) => {
      const was = isExpanded();
      expandRequests.delete(key);
      if (was && !isExpanded()) applyChromeBounds();
    },
  };
  // Back-compat entry point used by the UI (CHROME_SET_OVERLAY).
  const setOverlayMode = (open: boolean) => {
    if (open) overlay.acquire('ui');
    else overlay.release('ui');
  };

  const curtain = new CurtainController(chromeView, overlay);
  const tabs = new TabManager(window, userAgent, curtain);
  tabs.setChromeBounds(currentChromeBounds);

  // Window-owned controllers: page context menus paint in THIS window's
  // chromeView, print targets resolve through THIS window's tabs.
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
  const printing = new PrintController(tabs);

  const updateChromeBounds = (bounds: ChromeBounds) => {
    currentChromeBounds = bounds;
    applyChromeBounds();
    tabs.setChromeBounds(bounds);
  };

  window.on('resize', () => {
    applyChromeBounds();
    statusView.handleResize();
  });
  window.on('enter-full-screen', applyChromeBounds);
  window.on('leave-full-screen', applyChromeBounds);
  window.on('closed', () => {
    statusView.destroy();
    // A BaseWindow does not destroy its child views' webContents on close:
    // without this, a closed window's chrome UI would keep living (and its
    // CDP target with it) until the whole app quits.
    try {
      chromeView.webContents.close();
    } catch {
      // already gone
    }
  });

  tabs.on('active-tab-changed', () => {
    // Keep [tabs, statusView, chromeView]: re-stack the status bubble first
    // (its own remove+add; the chromeView code below stays untouched,
    // CLAUDE.md §4.3), and drop any bubble left over from the previous tab.
    statusView.restack();
    try {
      window.contentView.removeChildView(chromeView);
    } catch {
      // ignore
    }
    window.contentView.addChildView(chromeView);
    applyChromeBounds();
    statusView.hide({ immediate: true });
  });

  // HTML5 video fullscreen: hide the chrome entirely so the video covers the
  // whole window; restore it on leave.
  tabs.on('html-fullscreen', (on: boolean) => {
    if (window.isDestroyed()) return;
    chromeView.setVisible(!on);
    statusView.setSuspended(on);
  });

  const bootstrap = async ({ saved = null, open }: BootstrapOptions) => {
    // Restore window geometry before the first paint to avoid a resize flash.
    // Geometry comes back in EVERY startup mode: Chrome remembers the size of
    // your window even when it does not reopen your tabs.
    if (saved?.windowBounds && boundsAreVisible(saved.windowBounds)) {
      window.setBounds(saved.windowBounds);
    }

    const devServer = process.env.VITE_DEV_SERVER;
    if (devServer) {
      await chromeView.webContents.loadURL(`${devServer}/?chrome=1`);
      chromeView.webContents.openDevTools({ mode: 'detach' });
    } else {
      await chromeView.webContents.loadFile(
        path.join(app.getAppPath(), 'dist-ui', 'index.html'),
        { query: { chrome: '1' } },
      );
    }

    if (saved?.maximized) window.maximize();
    window.show();

    if (open.kind === 'restore' && saved && tabs.restore(saved)) return;

    // Not restoring the tabs, but the "recently closed" stack still comes back:
    // Ctrl+Shift+T is a separate promise from session restore.
    tabs.adoptClosedStack(saved?.closedStack);
    if (open.kind === 'urls') tabs.openStartupUrls(open.urls);
    else tabs.create(open.kind === 'url' ? open.url : undefined);
  };

  return {
    window,
    chromeView,
    tabs,
    curtain,
    statusView,
    pageMenu,
    printing,
    updateChromeBounds,
    setOverlayMode,
    bootstrap,
  };
}
