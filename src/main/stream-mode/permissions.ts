import type { Session, WebContents } from 'electron';
import type { StreamModeConfig } from '../../shared/streamConfig';
import type { PermissionDecision } from '../../shared/types';

export type PermissionRequest = {
  origin: string;
  permission: string;
};

export type PermissionDeps = {
  getStreamConfig: () => StreamModeConfig;
  /** chromeView / internal pages are always allowed (their own clipboard etc.). */
  isChromeContents: (wc: WebContents | null) => boolean;
  getRemembered: (origin: string, permission: string) => PermissionDecision | undefined;
  remember: (origin: string, permission: string, decision: PermissionDecision) => void;
  /**
   * Ask the user. The requesting webContents is passed alongside so the
   * prompt can be routed to the window that actually hosts the page.
   */
  promptUser: (
    req: PermissionRequest,
    requester: WebContents | null,
  ) => Promise<{ allow: boolean; remember: boolean }>;
};

// Hard-denied whenever Stream Mode is ON (a streamer must never leak these).
// hid/serial/usb only ever reach the check handler; 'bluetooth' is in neither
// Electron union today and would fall to default-deny anyway. Exported so
// tests can pin the decision matrix.
export const STREAM_HARD_DENY = new Set([
  'display-capture',
  'notifications',
  'clipboard-read',
  'idle-detection',
  'pointerLock',
  'keyboardLock',
  'hid',
  'serial',
  'usb',
  'bluetooth',
  'midi',
  'midiSysex',
  'speaker-selection',
  'window-management',
]);
export const STREAM_ALLOW = new Set(['fullscreen', 'clipboard-sanitized-write']);

function safeOrigin(url: string | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

export function installPermissionHandlers(session: Session, deps: PermissionDeps): void {
  session.setPermissionRequestHandler((wc, permission, callback, details) => {
    // The chrome UI (and internal pages) are trusted.
    if (deps.isChromeContents(wc)) {
      callback(true);
      return;
    }

    const cfg = deps.getStreamConfig();

    if (cfg.enabled) {
      if (permission === 'media') {
        const types = (details as { mediaTypes?: string[] } | undefined)?.mediaTypes ?? [];
        const wantsVideo = types.includes('video');
        const wantsAudio = types.includes('audio');
        const blocked =
          (wantsVideo && cfg.denyCamera) ||
          (wantsAudio && cfg.denyMicrophone) ||
          (!wantsVideo && !wantsAudio && (cfg.denyCamera || cfg.denyMicrophone));
        callback(!blocked);
        return;
      }
      if (permission === 'geolocation') {
        callback(!cfg.denyGeolocation);
        return;
      }
      if (STREAM_ALLOW.has(permission)) {
        callback(true);
        return;
      }
      // Everything else (incl. the hard-deny list) is refused while streaming.
      callback(false);
      return;
    }

    // Stream Mode OFF → remembered decision or prompt the user.
    const origin = safeOrigin(
      (details as { requestingUrl?: string } | undefined)?.requestingUrl ??
        (wc ? wc.getURL() : ''),
    );
    const remembered = deps.getRemembered(origin, permission);
    if (remembered === 'allow') {
      callback(true);
      return;
    }
    if (remembered === 'deny') {
      callback(false);
      return;
    }
    void deps
      .promptUser({ origin, permission }, wc)
      .then((res) => {
        if (res.remember && origin) {
          deps.remember(origin, permission, res.allow ? 'allow' : 'deny');
        }
        callback(res.allow);
      })
      .catch(() => callback(false));
  });

  session.setPermissionCheckHandler((wc, permission, origin) => {
    if (deps.isChromeContents(wc)) return true;
    const cfg = deps.getStreamConfig();
    if (cfg.enabled) {
      if (permission === 'media') return !(cfg.denyCamera || cfg.denyMicrophone);
      if (permission === 'geolocation') return !cfg.denyGeolocation;
      if (STREAM_ALLOW.has(permission)) return true;
      if (STREAM_HARD_DENY.has(permission)) return false;
      return false;
    }
    // Electron passes the requesting origin as an origin URL, usually WITH a
    // trailing slash ('https://site.example/'), while remembered decisions are
    // keyed by URL.origin (slash-less). Normalize before the lookup, falling
    // back to the raw string when unparsable.
    const originKey = safeOrigin(origin) || (origin ?? '');
    const remembered = deps.getRemembered(originKey, permission);
    if (remembered === 'deny') return false;
    // Permissive checks when not streaming: capability reporting only; the
    // actual sensitive grant still flows through the prompting request handler.
    return true;
  });
}
