/**
 * Global network guards: HTTP authentication (`app.on('login')`) and TLS
 * certificate errors (`app.on('certificate-error')`).
 *
 * Both events are APP-WIDE, so this module is registered ONCE at boot from
 * registerIpcHandlers, like every other session-global singleton (CLAUDE.md
 * section 4.9). A per-window registration would answer every challenge twice.
 *
 * Trust model for certificates: an exception is a `(host, fingerprint)` pair,
 * held in memory only. It is scoped to the exact certificate the user saw in
 * the interstitial (a cert that changes between the error and the click is NOT
 * trusted), and it never touches disk: restarting Voksa forgets everything,
 * which is the only safe default for a "continue anyway" button.
 */
import { app, ipcMain, type WebContents } from 'electron';
import { IPC } from '../shared/ipcChannels';
import type { AuthRequest } from '../shared/types';
import type { AppWindow } from './window';
import { focusedWindow, windowFromPageContents } from './windows';

type PushToChrome = (win: AppWindow, channel: string, payload: unknown) => void;

/**
 * Long because someone typing a password is slow, but bounded so an abandoned
 * dialog (window closed, user walked away) cannot pin its callback forever:
 * an unanswered challenge resolves as a cancel and the page shows its 401.
 */
const AUTH_TIMEOUT_MS = 120_000;

/**
 * A hostile page can spray subresources at bad-cert hosts; the pending map
 * must not grow without bound. Oldest entries fall off first (Map preserves
 * insertion order); 256 live pending hosts is far beyond any legitimate page.
 */
const MAX_PENDING_CERTS = 256;

// host -> fingerprint of the certificate that MAY be trusted if the user
// clicks through the interstitial for that host.
const pendingCerts = new Map<string, string>();
// host -> fingerprint the user chose to trust, for this app run only.
const allowedCerts = new Map<string, string>();

const pendingAuth = new Map<string, (creds: { username: string; password: string } | null) => void>();
let authReqId = 0;

// The parameter IS handlers.ts's sendToChrome (destroyed-guarded,
// window-routed), injected to avoid an import cycle. It keeps that name so
// the IPC contract test recognizes the call site as a routed push.
export function installNetGuards(sendToChrome: PushToChrome): void {
  ipcMain.on(
    IPC.AUTH_RESPOND,
    (_e, payload: { id: string; username?: string; password?: string; cancel?: boolean }) => {
      const resolve = pendingAuth.get(payload?.id);
      if (!resolve) return;
      pendingAuth.delete(payload.id);
      if (payload.cancel || typeof payload.username !== 'string') {
        resolve(null);
      } else {
        resolve({
          username: payload.username,
          password: typeof payload.password === 'string' ? payload.password : '',
        });
      }
    },
  );

  app.on('login', (event, webContents, _details, authInfo, callback) => {
    // preventDefault MUST be synchronous: without it Electron cancels the
    // authentication as soon as this listener returns.
    event.preventDefault();

    // The request may come from the net module rather than a page (the
    // typing says WebContents but proxy challenges can arrive unattached);
    // fall back to the focused window so proxy auth still gets a dialog.
    const requester = (webContents ?? null) as WebContents | null;
    const target = (requester && windowFromPageContents(requester)) ?? focusedWindow();
    if (!target) {
      callback(); // no window to ask: cancel, the page renders its 401 body
      return;
    }

    const id = `auth-${authReqId++}`;
    pendingAuth.set(id, (creds) => {
      if (creds) callback(creds.username, creds.password);
      else callback();
    });
    sendToChrome(target, IPC.AUTH_REQUEST, {
      id,
      host: authInfo.port ? `${authInfo.host}:${authInfo.port}` : authInfo.host,
      realm: authInfo.realm ?? '',
      isProxy: !!authInfo.isProxy,
    } satisfies AuthRequest);

    setTimeout(() => {
      const resolve = pendingAuth.get(id);
      if (resolve) {
        pendingAuth.delete(id);
        resolve(null);
      }
    }, AUTH_TIMEOUT_MS);
  });

  app.on('certificate-error', (event, _webContents, url, _error, certificate, callback) => {
    let host = '';
    try {
      host = new URL(url).host;
    } catch {
      // unparseable URL: fall through to reject
    }
    if (!host) {
      callback(false);
      return;
    }

    if (allowedCerts.get(host) === certificate.fingerprint) {
      event.preventDefault();
      callback(true);
      return;
    }

    // Remember what COULD be trusted. The navigation still fails (the tab
    // shows the interstitial via did-fail-load); "continue anyway" promotes
    // this exact pair via allowPendingCertException and reloads.
    pendingCerts.set(host, certificate.fingerprint);
    if (pendingCerts.size > MAX_PENDING_CERTS) {
      const oldest = pendingCerts.keys().next().value;
      if (oldest !== undefined) pendingCerts.delete(oldest);
    }
    callback(false);
  });
}

/**
 * Promote the pending certificate for `host` into a session exception.
 * Returns false when nothing is pending (nothing to trust: the caller must
 * not reload as if the exception had been granted).
 */
export function allowPendingCertException(host: string): boolean {
  const fingerprint = pendingCerts.get(host);
  if (!fingerprint) return false;
  pendingCerts.delete(host);
  allowedCerts.set(host, fingerprint);
  return true;
}

/** Session TLS exceptions are browsing data too: wiped with the rest. */
export function clearCertExceptions(): void {
  pendingCerts.clear();
  allowedCerts.clear();
}
