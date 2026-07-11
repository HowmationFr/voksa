import type { WebContents } from 'electron';
import type { AppWindow } from './window';

/**
 * Live-window registry. Every AppWindow registers here at creation and
 * unregisters on 'closed'; everything that used to reach for THE window
 * singleton (IPC handlers, menu, extensions runtime, second-instance) now
 * resolves its target through this module instead:
 *   - chrome-originated IPC  -> windowFromChrome(event.sender)
 *   - page-originated IPC    -> windowFromPageContents(event.sender)
 *   - menu / app events      -> focusedWindow()
 * No import cycle: this module only imports the AppWindow TYPE; the actual
 * window constructor is injected by index.ts via setWindowFactory.
 */

const registry = new Map<number, AppWindow>();
let lastFocusedId: number | null = null;
let factory: ((url?: string) => Promise<AppWindow>) | null = null;

export function registerWindow(win: AppWindow): void {
  registry.set(win.window.id, win);
  // Focus tracking feeds focusedWindow(); the listener dies with the window.
  win.window.on('focus', () => {
    lastFocusedId = win.window.id;
  });
}

export function unregisterWindow(windowId: number): void {
  registry.delete(windowId);
  if (lastFocusedId === windowId) lastFocusedId = null;
}

export function allWindows(): AppWindow[] {
  return [...registry.values()].filter((w) => !w.window.isDestroyed());
}

export function windowCount(): number {
  return allWindows().length;
}

export function windowById(windowId: number): AppWindow | null {
  const w = registry.get(windowId);
  return w && !w.window.isDestroyed() ? w : null;
}

/**
 * The window that should receive an app-level action (menu accelerator,
 * second launch, popup routing): the last OS-focused live window, falling
 * back to the most recently created one.
 */
export function focusedWindow(): AppWindow | null {
  if (lastFocusedId !== null) {
    const w = windowById(lastFocusedId);
    if (w) return w;
  }
  const all = allWindows();
  return all.length > 0 ? all[all.length - 1] : null;
}

/** The window whose chromeView hosts this webContents (voksa.* senders). */
export function windowFromChrome(sender: WebContents): AppWindow | null {
  for (const w of allWindows()) {
    if (w.chromeView.webContents.id === sender.id) return w;
  }
  return null;
}

/** The window owning this page webContents (tab or managed popup). */
export function windowFromPageContents(sender: WebContents): AppWindow | null {
  for (const w of allWindows()) {
    if (w.tabs.ownsWebContents(sender.id)) return w;
  }
  return null;
}

/** True when this webContents is one of the chrome UIs (trusted surface). */
export function isChromeViewContents(wc: WebContents | null): boolean {
  return wc !== null && windowFromChrome(wc) !== null;
}

/**
 * index.ts injects the real window constructor at boot; menu items,
 * chrome.windows.create and the WINDOW_NEW IPC all go through here.
 */
export function setWindowFactory(fn: (url?: string) => Promise<AppWindow>): void {
  factory = fn;
}

export async function openNewWindow(url?: string): Promise<AppWindow | null> {
  if (!factory) return null;
  return factory(url);
}
