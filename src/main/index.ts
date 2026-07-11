import path from 'node:path';
import fs from 'node:fs';
import { app, Menu, shell } from 'electron';
import { applyUserAgentOverride } from './ua';
import { createAppWindow, type AppWindow } from './window';
import { registerIpcHandlers } from './ipc/handlers';
import { buildApplicationMenu } from './menu';
import { getStreamMode } from './stream-mode/StreamModeController';
import { RecorderWatcher } from './stream-mode/recorderWatcher';
import { closeDb } from './storage/db';
import { flushSettings } from './storage/settings';
import { saveSession, flushSession } from './storage/session';

// Pin userData explicitly (a productName change must never orphan a profile)
// and migrate profiles created under the pre-rename identities. Runs before
// ANY storage access, so the whole app only ever sees one location.
{
  const appData = app.getPath('appData');
  const target = path.join(appData, 'voksa');
  let userDataDir = target;
  if (!fs.existsSync(target)) {
    // 'howmation-browse' was the pinned dir; 'HowmationBrowse' covers builds
    // that predate the pinning. First match wins.
    for (const legacy of ['howmation-browse', 'HowmationBrowse']) {
      const source = path.join(appData, legacy);
      if (fs.existsSync(source)) {
        try {
          fs.renameSync(source, target);
        } catch {
          // Locked or cross-device: keep using the legacy dir as-is rather
          // than silently starting an empty profile.
          userDataDir = source;
        }
        break;
      }
    }
  }
  app.setPath('userData', userDataDir);
}

// Instantiate the Stream Mode controller before whenReady so its WebRTC
// command-line switch is applied in time.
getStreamMode();

// CRITICAL for Google login: must run before app.whenReady().
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

let appWindow: AppWindow | null = null;

// Harden EVERY webContents at creation. Tab webContents get a richer handler
// in TabManager.wireTab (which runs after this), so this is the default-deny
// backstop for the chrome UI, extension background/popup hosts, and any other
// library-created contents: none may spawn unmanaged native windows or
// navigate to untrusted schemes.
app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url) && appWindow) {
      appWindow.tabs.create(url);
    } else if (/^https?:\/\//i.test(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  contents.on('will-attach-webview', (event) => {
    // We never use <webview>; block any attempt to embed one.
    event.preventDefault();
  });
});

/** Pull an http(s) URL out of a process argv (OS-launched default browser). */
function urlFromArgv(argv: string[]): string | null {
  for (let i = argv.length - 1; i >= 0; i--) {
    const a = argv[i];
    if (/^https?:\/\//i.test(a)) return a;
  }
  return null;
}

function wireSessionPersistence(win: AppWindow): void {
  // serialize() reads window bounds: never run it against a destroyed window
  // (tabs-changed still fires from the teardown relay in edge cases).
  const save = () => {
    if (!win.window.isDestroyed()) saveSession(win.tabs.serialize());
  };
  win.tabs.on('tabs-changed', save);
  win.window.on('resize', save);
  win.window.on('move', save);
  win.window.on('maximize', save);
  win.window.on('unmaximize', save);
  // Flush the freshest full snapshot the moment the window starts closing:
  // the X-close path never reaches before-quit's flushSession (appWindow is
  // nulled first), so a save debounced in the last 500ms would be lost, and
  // during teardown TabManager deliberately stops emitting tabs-changed.
  win.window.on('close', () => {
    saveSession(win.tabs.serialize());
    flushSession();
  });
}

async function createWindow(): Promise<void> {
  const ua = applyUserAgentOverride();
  const win = await createAppWindow(ua);
  appWindow = win;
  // Null the reference as soon as the window is gone. window-all-closed does
  // it too, but that event does not fire while a popup (OAuth, extension)
  // survives the main window: every consumer of appWindow (second-instance,
  // open-url, menu accelerators) would then poke a destroyed BaseWindow.
  win.window.on('closed', () => {
    appWindow = null;
  });
  registerIpcHandlers(win);
  Menu.setApplicationMenu(buildApplicationMenu(() => appWindow));
  wireSessionPersistence(win);
  await win.bootstrap();
}

async function start() {
  await app.whenReady();
  try {
    app.setAsDefaultProtocolClient('http');
    app.setAsDefaultProtocolClient('https');
  } catch {
    // best-effort; not fatal
  }
  await createWindow();
  flushPendingOpenUrl();

  // Recorder detection: OBS & friends running (or launching later) flips
  // Stream Mode ON automatically. Rising-edge only: a manual OFF while the
  // recorder keeps running is respected (see RecorderWatcher).
  const recorderWatcher = new RecorderWatcher((name) => {
    const stream = getStreamMode();
    const cfg = stream.getConfig();
    if (!cfg.autoStreamOnRecorder || cfg.enabled) return;
    console.log(`[stream] recorder detected (${name}): enabling Stream Mode`);
    stream.update({ enabled: true });
  });
  recorderWatcher.start();
  app.on('before-quit', () => recorderWatcher.stop());
}

app.on('second-instance', (_e, argv) => {
  if (appWindow?.window) {
    if (appWindow.window.isMinimized()) appWindow.window.restore();
    appWindow.window.focus();
    const url = urlFromArgv(argv);
    if (url) appWindow.tabs.create(url);
  }
});

// macOS "open with default browser" / dock link clicks. The event can fire
// BEFORE the window exists (cold start via a link click) or while the app is
// alive without a window (darwin keeps running after window-all-closed);
// buffer the URL instead of dropping it.
let pendingOpenUrl: string | null = null;
app.on('open-url', (event, url) => {
  event.preventDefault();
  if (appWindow) appWindow.tabs.create(url);
  else pendingOpenUrl = url;
});

function flushPendingOpenUrl(): void {
  if (pendingOpenUrl && appWindow) {
    appWindow.tabs.create(pendingOpenUrl);
    pendingOpenUrl = null;
  }
}

app.on('window-all-closed', () => {
  // Quit on ALL platforms, macOS included. Recreating the window on
  // 'activate' would rerun registerIpcHandlers, and every ipcMain.handle /
  // singleton listener (stream controller, autoUpdater) would be registered
  // twice: Electron throws on the first duplicated channel. Until handler
  // registration is idempotent, the safe behavior is a clean quit; session
  // restore brings the tabs back on next launch.
  appWindow = null;
  app.quit();
});

app.on('activate', () => {
  // macOS Dock click while the window still exists: just focus it. The
  // no-window case cannot happen anymore (window-all-closed quits).
  if (appWindow?.window && !appWindow.window.isDestroyed()) {
    appWindow.window.focus();
  }
});

app.on('before-quit', () => {
  try {
    if (appWindow) flushSession();
  } catch {
    // ignore
  }
  try {
    flushSettings();
  } catch {
    // ignore
  }
  try {
    closeDb();
  } catch {
    // ignore
  }
});

start().catch((err) => {
  console.error('[main] fatal', err);
  app.quit();
});
