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
  /**
   * DMCA stage 2: true when this webContents is a tab the user routed to a
   * chosen audio output. Such a tab needs (a) the 'media' CHECK to pass so
   * enumerateDevices exposes device labels/ids (Chromium gates both on it),
   * and (b) 'speaker-selection' so setSinkId is honored. The consent is the
   * user's explicit pick in OUR tab menu; prompting the page-level dialog on
   * top of it would be two questions for one gesture. This never grants a
   * media REQUEST (getUserMedia capture keeps its normal prompt/deny path).
   */
  isAudioRouted: (wc: WebContents | null) => boolean;
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
//
// 'display-capture' is NOT in this list (it was, before the Capture
// Handshake): the permission only lets a getDisplayMedia request REACH the
// display-media picker, where the real consent lives (a user click on one
// specific source, in OUR ui) and where Voksa surfaces are masked before the
// first frame is delivered. Hard-denying it here killed the core use case:
// sharing a window in Meet WHILE Stream Mode is on.
export const STREAM_HARD_DENY = new Set([
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

    // Screen sharing: granted at THIS layer in both stream states, because
    // this grant only forwards the request to the display-media picker
    // (Capture Handshake). Consent is the user's click on one source there;
    // an extra permission prompt before the picker would be two dialogs for
    // one question (Chrome prompts nothing here either).
    if (permission === 'display-capture') {
      callback(true);
      return;
    }

    // Audio-routed tab (DMCA stage 2): setSinkId may surface as a
    // 'speaker-selection' request. The user already consented by picking the
    // device in our menu; this must hold under Stream Mode too (routing under
    // stream is the point). Scoped to the routed tab only: everywhere else
    // 'speaker-selection' keeps its hard-deny / prompt path.
    if (permission === 'speaker-selection' && deps.isAudioRouted(wc)) {
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

  session.setPermissionCheckHandler((wc, permission, origin, details) => {
    if (deps.isChromeContents(wc)) return true;
    // NB: 'display-capture' is handled only in the REQUEST handler above (it is
    // not in Electron's check-handler permission union): getDisplayMedia goes
    // through the request path, where the picker provides consent.
    //
    // Audio-routed tab: the 'media' check gates enumerateDevices label/id
    // exposure, without which no frame could ever resolve the chosen label
    // (worst under Stream Mode, where the default denyCamera/denyMicrophone
    // would blank the check). Narrowed by details.mediaType: Chromium checks
    // label exposure PER DEVICE KIND, and routing only ever needs the audio
    // kinds; letting 'video' through would expose webcam labels (and make
    // permissions.query({name:'camera'}) read granted) on origins that never
    // earned it. A CHECK is capability reporting, never a capture grant:
    // getUserMedia still flows through the request handler above, stream
    // denies included. 'speaker-selection' needs no twin here: like
    // display-capture, it is not in Electron's check-handler union (request
    // path only). Cost, owned: the routed tab's origins can read AUDIO device
    // labels (fingerprint surface), paid only on tabs the user explicitly
    // routed.
    if (
      permission === 'media' &&
      (details as { mediaType?: string } | undefined)?.mediaType !== 'video' &&
      deps.isAudioRouted(wc)
    ) {
      return true;
    }
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
