import path from 'node:path';
import fs from 'node:fs';
import { app, Menu, session, shell } from 'electron';
import { applyUserAgentOverride } from './ua';
import {
  createAppWindow,
  boundsAreVisible,
  type AppWindow,
  type BootstrapOptions,
} from './window';
import { registerIpcHandlers, wireWindowIpc } from './ipc/handlers';
import { buildApplicationMenu } from './menu';
import { getStreamMode } from './stream-mode/StreamModeController';
import { RecorderWatcher } from './stream-mode/recorderWatcher';
import { getMemorySaver } from './perf/MemorySaverController';
import { setupChromeWebStore } from './extensions/webstore';
import {
  focusedWindow,
  registerWindow,
  setWindowFactory,
  unregisterWindow,
  windowCount,
} from './windows';
import { closeDb } from './storage/db';
import { flushSettings, getSettings } from './storage/settings';
import { resolveLanguage } from '../shared/i18n';
import { pickStartupPlan } from '../shared/startup';
import {
  loadSession,
  updateWindowSnapshot,
  removeWindowSnapshot,
  flushSession,
  beginRestore,
  endRestore,
} from './storage/session';

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

// Chromium PROCESS locale, aligned on Voksa's language setting BEFORE ready:
// extension pages resolve their _locales messages (and navigator.language)
// from it, so without this uBO Lite & friends render in English on a French
// system whatever our own UI shows. 'system' resolves exactly like the UI
// does; the OS locale comes from Intl because app.getLocale() only answers
// after 'ready'. A language change in settings reaches extensions at the
// next launch (our own UI switches live).
try {
  // getPreferredSystemLanguages reads the OS list directly and answers
  // before 'ready'; Intl's ICU default in the main process does NOT follow
  // the OS at this point (observed: 'en' on a French Windows), and
  // app.getLocale()/getSystemLocale() only answer after 'ready'.
  const systemLocale =
    app.getPreferredSystemLanguages()[0] ??
    Intl.DateTimeFormat().resolvedOptions().locale ??
    'en';
  app.commandLine.appendSwitch('lang', resolveLanguage(getSettings().language, systemLocale));
} catch {
  // settings unreadable: keep Chromium's own locale detection
}

// Windows toasts are keyed by AppUserModelID. The NSIS installer writes one
// into the shortcut, but a portable/unpacked run has none and every
// notification would silently no-op; declare it explicitly. Must match
// electron-builder.yml `appId`.
if (process.platform === 'win32') {
  app.setAppUserModelId('com.voksa.app');
}

// The single-instance lock stays even with multi-window support: two
// PROCESSES on one profile would fight over SQLite and the session file.
// A second launch instead opens a new WINDOW in the running instance
// (see 'second-instance' below).
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

/**
 * True from the moment the app decided to quit (menu quit, Cmd+Q, last
 * window closed): windows closing during quit teardown must KEEP their
 * session snapshot, so the whole set is restored at next boot. Only a
 * window closed while OTHERS remain is forgotten (Chrome semantics).
 */
let quitting = false;

/** Chrome UA string, resolved once at boot and shared by every window. */
let chromeUA = '';

/**
 * Set once start() finished its app-global setup AND the first window(s)
 * exist. Events that can fire BEFORE that (second-instance is delivered as
 * soon as the lock is held, i.e. possibly before app.whenReady()) must wait:
 * `new BaseWindow()` throws before 'ready', and a window created before
 * setupChromeWebStore would load tabs without the extension session preloads.
 */
let booted = false;
const pendingLaunchUrls: string[] = [];

// Harden EVERY webContents at creation. Tab webContents get a richer handler
// in TabManager.wireTab (which runs after this), so this is the default-deny
// backstop for the chrome UI, extension background/popup hosts, and any other
// library-created contents: none may spawn unmanaged native windows or
// navigate to untrusted schemes.
app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    const target = focusedWindow();
    if (/^https?:\/\//i.test(url) && target) {
      target.tabs.create(url);
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
  const id = win.window.id;
  // serialize() reads window bounds: never run it against a destroyed window
  // (tabs-changed still fires from the teardown relay in edge cases).
  const save = () => {
    if (!win.window.isDestroyed()) updateWindowSnapshot(id, win.tabs.serialize());
  };
  win.tabs.on('tabs-changed', save);
  win.window.on('resize', save);
  win.window.on('move', save);
  win.window.on('maximize', save);
  win.window.on('unmaximize', save);
  // Flush the freshest full snapshot the moment the window starts closing:
  // the X-close path of the last window never reaches before-quit's
  // flushSession in time for a save debounced in the last 500ms, and during
  // teardown TabManager deliberately stops emitting tabs-changed.
  win.window.on('close', () => {
    updateWindowSnapshot(id, win.tabs.serialize());
    flushSession();
  });
  win.window.on('closed', () => {
    unregisterWindow(id);
    // Balance the TabManager's subscription on the stream controller
    // singleton, or every closed window would leak its whole tab manager.
    win.tabs.dispose();
    // Chrome semantics: closing ONE window among several forgets it; the
    // LAST window (windowCount() is already 0 here) and quit-time teardown
    // keep their snapshots for the next boot.
    if (!quitting && windowCount() > 0) removeWindowSnapshot(id);
  });
}

/**
 * Create, register and boot one browser window.
 *
 * `opts.open` says what it opens: the startup plan at boot ('restore' /
 * 'urls' / 'newtab'), or a single 'url' for a second launch, an OS link or
 * chrome.windows.create. `opts.saved` only ever supplies geometry and the
 * recently-closed stack, unless the plan is 'restore'.
 */
async function createWindow(opts?: BootstrapOptions): Promise<AppWindow> {
  // Resolved BEFORE registering the new window: cascade new windows from the
  // currently focused one so they don't stack pixel-perfectly.
  const previous = focusedWindow();
  const win = await createAppWindow(chromeUA);
  const restoring = opts?.open.kind === 'restore';
  if (!restoring && previous && !previous.window.isDestroyed()) {
    try {
      const b = previous.window.getBounds();
      const cascaded = { x: b.x + 28, y: b.y + 28, width: b.width, height: b.height };
      if (!previous.window.isMaximized() && boundsAreVisible(cascaded)) {
        win.window.setBounds(cascaded);
      }
    } catch {
      // cascade is cosmetic; never fatal
    }
  }
  registerWindow(win);
  wireWindowIpc(win);
  wireSessionPersistence(win);
  await win.bootstrap(opts ?? { open: { kind: 'newtab' } });
  return win;
}

async function start() {
  await app.whenReady();
  // NO setAsDefaultProtocolClient at boot, on ANY platform (removed v0.5.1).
  // Candidacy does not need it: Windows reads the NSIS installer registry
  // (resources/installer.nsh), macOS reads CFBundleURLTypes, Linux reads the
  // .desktop MimeType. And the call itself is harmful at boot: on Windows it
  // writes the legacy registration that made isDefaultProtocolClient answer
  // yes to its own echo (Voksa claimed default while Chrome opened links);
  // on Linux it runs xdg-settings SET, silently stealing the user's default
  // at every launch. Becoming the default is a USER gesture: the settings
  // card button (APP_SET_DEFAULT_BROWSER) is the only caller.

  // App-global singletons, in dependency order and all BEFORE the first
  // window: the UA webRequest hook and the extension runtime register
  // session preloads, and registerIpcHandlers must expose
  // STREAM_GET_CONFIG_SYNC before any tab document loads.
  chromeUA = applyUserAgentOverride();
  registerIpcHandlers();
  await setupChromeWebStore(session.defaultSession);

  // Debug-only seam (smoke): load unpacked test extensions handed over by the
  // harness. The web-store loader only discovers store-installed layouts, so
  // the contract fixture (scripts/fixtures/contract-extension) needs an
  // explicit load. Gated on the CDP debug port like voksa.capture.simulate:
  // inert in production. AFTER setupChromeWebStore, so both libraries'
  // session preloads apply to the fixture's contexts like to any extension.
  if (process.env.VOKSA_DEBUG_PORT && process.env.VOKSA_DEBUG_LOAD_EXTENSION) {
    // Surface extension service worker console output on stdout: an MV3 SW
    // that dies at module evaluation does so SILENTLY (no CDP target, no
    // page-side error); this listener is what lets the smoke and the CI logs
    // see the world it died in.
    session.defaultSession.serviceWorkers.on('console-message', (_e, m) => {
      console.log(`[sw-console:${m.level}] ${String(m.message).slice(0, 500)}`);
    });
    for (const dir of process.env.VOKSA_DEBUG_LOAD_EXTENSION.split(path.delimiter)) {
      if (!dir.trim()) continue;
      try {
        await session.defaultSession.extensions.loadExtension(dir.trim());
      } catch (err) {
        console.warn('[debug] loadExtension failed:', dir, err);
      }
    }
  }

  setWindowFactory((url?: string) =>
    createWindow({ open: url ? { kind: 'url', url } : { kind: 'newtab' } }),
  );
  Menu.setApplicationMenu(buildApplicationMenu(() => focusedWindow()));

  // What opens now is the user's call (Settings > On startup). The session file
  // is READ in every mode: even when the tabs stay closed, it carries the
  // window geometry and the "recently closed" stack. It also keeps being
  // WRITTEN in every mode, so switching back to "continue where you left off"
  // later actually has something to restore.
  //
  // Writes stay frozen until the whole set is back: the snapshot map fills one
  // window at a time, so an intermediate write would erase the windows not yet
  // booted. A window that fails to boot must not take the others down with it
  // either: keep going, and guarantee at least one window.
  const saved = loadSession();
  const plan = pickStartupPlan(getSettings().startupMode, saved, getSettings().startupUrls);
  beginRestore();
  try {
    if (plan.kind === 'restore' && saved) {
      for (const entry of saved.windows) {
        try {
          await createWindow({ saved: entry, open: { kind: 'restore' } });
        } catch (err) {
          console.error('[main] window restore failed, skipping it:', err);
        }
      }
    } else {
      // One window, like Chrome: several windows only ever come back through a
      // session restore. It still inherits the first one's geometry and stack.
      const first = saved?.windows[0] ?? null;
      try {
        await createWindow({
          saved: first,
          open: plan.kind === 'urls' ? { kind: 'urls', urls: plan.urls } : { kind: 'newtab' },
        });
      } catch (err) {
        // Same contract as the restore loop: a window that fails to boot must
        // not skip the "at least one window" guarantee below.
        console.error('[main] startup window failed, falling back to a new tab:', err);
      }
    }
    if (windowCount() === 0) await createWindow({ open: { kind: 'newtab' } });
  } finally {
    endRestore();
  }
  booted = true;
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

  // Memory Saver: frees the renderer of cold background tabs (they reload on
  // return). Started after the windows exist; a sweep with no window is a no-op.
  getMemorySaver().start();
  app.on('before-quit', () => getMemorySaver().stop());
}

app.on('second-instance', (_e, argv) => {
  // A second Voksa launch = a new window in the running instance (Chrome
  // behavior), with the OS-passed URL when there is one. Launches that land
  // before boot completes are queued, never dropped and never allowed to
  // build a window against a not-ready app.
  const url = urlFromArgv(argv) ?? undefined;
  if (!booted) {
    pendingLaunchUrls.push(url ?? '');
    return;
  }
  openLaunchWindow(url);
});

/** New window for a launch request; failures are logged, never unhandled. */
function openLaunchWindow(url?: string): void {
  void createWindow({ open: url ? { kind: 'url', url } : { kind: 'newtab' } })
    .then((win) => {
      if (!win.window.isDestroyed()) win.window.focus();
    })
    .catch((err) => {
      console.error('[main] could not open a window for the second launch:', err);
    });
}

// macOS "open with default browser" / dock link clicks. The event can fire
// BEFORE the window exists (cold start via a link click); buffer the URL
// instead of dropping it.
let pendingOpenUrl: string | null = null;
app.on('open-url', (event, url) => {
  event.preventDefault();
  const target = focusedWindow();
  if (target) target.tabs.create(url);
  else pendingOpenUrl = url;
});

function flushPendingOpenUrl(): void {
  const target = focusedWindow();
  if (pendingOpenUrl && target) {
    target.tabs.create(pendingOpenUrl);
    pendingOpenUrl = null;
  }
  // Second launches that arrived while the app was still booting: each one
  // asked for its own window, and gets it now.
  const queued = pendingLaunchUrls.splice(0, pendingLaunchUrls.length);
  for (const url of queued) openLaunchWindow(url || undefined);
}

app.on('window-all-closed', () => {
  // Quit on ALL platforms, macOS included (existing single-window behavior,
  // kept deliberately): the closing path of the last window preserved its
  // session snapshot, so the next boot restores it.
  app.quit();
});

app.on('activate', () => {
  // macOS Dock click while windows exist: focus the last-focused one. The
  // no-window case cannot happen (window-all-closed quits).
  const target = focusedWindow();
  if (target && !target.window.isDestroyed()) {
    target.window.focus();
  }
});

app.on('before-quit', () => {
  // From here on, closing windows is quit teardown: their session snapshots
  // must survive so the whole set comes back at next boot.
  quitting = true;
  try {
    flushSession();
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
