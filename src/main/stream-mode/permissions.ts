import type { Session, WebContents } from 'electron';
import type { StreamModeConfig } from '../../shared/streamConfig';
import type { PermissionDecision } from '../../shared/types';

export type PermissionRequest = {
  origin: string;
  permission: string;
};

/** What the screen-capture gate needs to know about a 'display-capture' request. */
export type DisplayCaptureRequest = {
  /** URL.origin of the requesting frame: who the picker says is asking. */
  origin: string;
  /** details.securityOrigin, raw: the string the display-media request repeats. */
  securityOrigin: string;
  requestingUrl: string;
  isMainFrame: boolean;
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
  /**
   * Screen-capture gate. Since Electron 45, getDisplayMedia AND the legacy
   * getUserMedia({chromeMediaSource}) path both reach the request handler as
   * 'display-capture' with identical details, and on the legacy path the
   * grant IS the capture (of a source the page chose, the whole desktop when
   * it names none). So the grant is never unconditional: the Capture
   * Handshake shows OUR picker first, binds the pick to this requester and
   * calls `grant` itself (captureHandshake.gatePermission). Calls `grant`
   * exactly once; never used for the chrome UI.
   */
  gateDisplayCapture: (
    requester: WebContents,
    req: DisplayCaptureRequest,
    grant: (allowed: boolean) => void,
  ) => Promise<void>;
};

// Hard-denied whenever Stream Mode is ON (a streamer must never leak these).
// hid/serial/usb only ever reach the check handler; 'bluetooth' is in neither
// Electron union today and would fall to default-deny anyway. Exported so
// tests can pin the decision matrix.
//
// 'display-capture' is NOT in this list (it was, before the Capture
// Handshake): it is gated by OUR picker in both stream states (see the
// display-capture branch below), which is where the real consent lives (a
// user click on one specific source, in OUR ui) and where Voksa surfaces are
// masked before the first frame is delivered. Hard-denying it here killed the
// core use case: sharing a window in Meet WHILE Stream Mode is on.
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

    // Screen / window / tab capture. Electron 45 reports getDisplayMedia AND
    // the legacy getUserMedia({chromeMediaSource}) path here, with identical
    // details, and on the legacy path this grant IS the capture (no picker,
    // the page's own source id, the whole desktop when it names none). So it
    // is never granted outright: the Capture Handshake shows OUR picker now,
    // in both stream states, binds the pick to this requester and only then
    // grants; getDisplayMedia receives exactly that pick. Still one dialog:
    // the picker is the consent (Chrome prompts nothing before its own either).
    // A remembered DENY is honored; a remembered ALLOW never is, every capture
    // needs a fresh pick.
    if (permission === 'display-capture') {
      const d = details as
        { requestingUrl?: string; securityOrigin?: string; isMainFrame?: boolean } | undefined;
      const requestingUrl = d?.requestingUrl ?? (wc ? wc.getURL() : '');
      const origin = safeOrigin(requestingUrl);
      if (!wc || (origin && deps.getRemembered(origin, permission) === 'deny')) {
        callback(false);
        return;
      }
      let answered = false;
      const grant = (allowed: boolean) => {
        if (answered) return;
        answered = true;
        callback(allowed);
      };
      void deps
        .gateDisplayCapture(
          wc,
          {
            origin,
            securityOrigin: d?.securityOrigin ?? '',
            requestingUrl,
            isMainFrame: d?.isMainFrame !== false,
          },
          grant,
        )
        .catch(() => grant(false));
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
        // Electron 45: 'media' is camera/microphone only (screen capture is
        // 'display-capture' above). An empty/missing mediaTypes no longer
        // means a screen share; it stays as the fail-closed default for a
        // device request that arrives without details.
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
    // 'display-capture' reaches this handler too
    // (navigator.permissions.query({name: 'display-capture'})). A check is
    // capability reporting, never a grant: the picker gate in the request
    // handler is the consent. Report it usable in both stream states (a
    // 'denied' while streaming could make a meeting site hide its share
    // button) unless the user blocked the site.
    if (permission === 'display-capture') {
      return deps.getRemembered(safeOrigin(origin) || (origin ?? ''), permission) !== 'deny';
    }
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
    // denies included. 'speaker-selection' gets no carve-out here: setSinkId
    // is gated on the request path. Cost, owned: the routed tab's origins can
    // read AUDIO device labels (fingerprint surface), paid only on tabs the
    // user explicitly routed.
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
