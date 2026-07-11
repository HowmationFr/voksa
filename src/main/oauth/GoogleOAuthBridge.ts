import { BrowserWindow, type WebContents, session as electronSession } from 'electron';
import { t } from '../i18n';

/**
 * Google aggressively detects embedded browser frameworks via a combination
 * of signals (TLS fingerprint, embedded-context flags, missing UI chrome
 * heuristics, JS environment probes). A pure UA spoof is not enough: the
 * user still sees "ce navigateur ou cette application ne sont peut-être pas
 * sécurisés".
 *
 * Empirically, Google accepts a login flow opened in a **dedicated top-level
 * `BrowserWindow`** with minimal Electron customizations. The window:
 *   - Has a native frame (looks like a real Chrome popup).
 *   - Has no parent window and no preloads that touch navigator.
 *   - Shares the app's persistent cookie jar (so the login propagates back
 *     to the originating tab once complete).
 *   - Closes automatically when the URL leaves accounts.google.com,
 *     reloading the calling tab to pick up the new session cookies.
 *
 * This pattern is used by several Electron-based browsers (Polypane, SigmaOS
 * in some flows, Arc's side-login feature) and is by far the most reliable
 * way to sign in to Google services from within an Electron app without
 * bouncing the user to the system browser.
 */

const GOOGLE_HOSTS = new Set([
  'accounts.google.com',
  'accounts.youtube.com',
  'accounts.google.fr',
  'accounts.google.co.uk',
]);

export function isGoogleLoginUrl(url: string): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    if (GOOGLE_HOSTS.has(u.hostname)) return true;
    if (u.hostname === 'www.google.com' && /^\/(accounts|signin)/i.test(u.pathname)) return true;
  } catch {
    return false;
  }
  return false;
}

/**
 * Open the given Google login URL in a fresh, naked BrowserWindow that
 * shares the main partition for cookies. Returns a promise that resolves
 * once the login flow completes (URL leaves Google) or the window is
 * closed by the user.
 */
export async function openGoogleLoginPopup(
  url: string,
  userAgent: string,
  originTab: WebContents,
): Promise<void> {
  const popup = new BrowserWindow({
    width: 520,
    height: 680,
    autoHideMenuBar: true,
    useContentSize: true,
    // No parent: Google prefers independent windows.
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Share the main session so cookies flow back to the origin tab.
      partition: 'persist:main',
      session: electronSession.fromPartition('persist:main'),
      // No preload: we don't want to inject anything that might be sniffed.
    },
    backgroundColor: '#ffffff',
    title: t('Connexion Google'),
  });

  popup.webContents.setUserAgent(userAgent);

  // Any nested popup Google might try to spawn (e.g. for password manager)
  // stays inside this same window by default; cleaner UX than extra popups.
  popup.webContents.setWindowOpenHandler(({ url: childUrl }) => {
    if (isGoogleLoginUrl(childUrl)) return { action: 'allow' };
    return { action: 'deny' };
  });

  try {
    await popup.loadURL(url);
  } catch {
    // ignore load errors; popup may still recover
  }

  return new Promise<void>((resolve) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      try {
        if (!popup.isDestroyed() && !originTab.isDestroyed()) {
          originTab.reload();
        }
      } catch {
        // ignore
      }
      if (!popup.isDestroyed()) {
        popup.close();
      }
      resolve();
    };

    popup.webContents.on('did-navigate', (_e, navUrl) => {
      if (!isGoogleLoginUrl(navUrl) && /^https?:/.test(navUrl)) {
        // User navigated off Google → login presumably completed.
        settle();
      }
    });

    popup.on('closed', () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    });
  });
}
