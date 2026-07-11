import { ipcRenderer, webFrame } from 'electron';
import { IPC } from '../shared/ipcChannels';
import type { StreamModeConfig } from '../shared/streamConfig';
import { installStreamMasker, type FramesStatus, type MaskerHost } from '../injected/streamMask';
import { installHoverMasker } from '../injected/hoverMask';

/**
 * Page preload : runs in every frame's isolated world (nodeIntegrationInSub-
 * Frames is on, so this executes in iframes too). Responsibilities:
 *   0. Frame liveness announce (frame guard, see main/stream-mode/frameGuard).
 *   1. navigator.webdriver patch (Google in-app login).
 *   2. Stream Mode Layer 0 "shroud" + Layer 1 masker wiring (see streamMask).
 *   3. Chrome Web Store branding fixup.
 *
 * IMPORTANT: the stream API is NEVER exposed to the main world. It lives only
 * in this isolated preload; the masker runs here and needs only DOM access.
 */

// -- 0. Frame liveness --------------------------------------------------------
// The FIRST thing every frame does, main frame and subframes alike: tell main
// this document HAS a preload (hence the L0 shroud and the L1 masker). Frames
// Electron skipped (electron/electron#34727: a page script read their
// contentWindow before they committed) never send this, which is exactly how
// main tells them apart and rescues them with the fallback masker. Sent
// unconditionally, Stream Mode on or off: liveness must already be known when
// the user toggles Stream Mode ON, or the first frames would race the toggle.
try {
  ipcRenderer.send(IPC.STREAM_FRAME_ALIVE);
} catch {
  // Main not listening yet (impossible post boot-order fix): the frame guard
  // then treats this frame as unprotected and covers it with the fallback.
}

// -- 1. navigator.webdriver patch (main world) -------------------------------
void webFrame.executeJavaScript(
  `(() => {
    try {
      Object.defineProperty(Navigator.prototype, 'webdriver', {
        get: () => undefined,
        configurable: true,
      });
    } catch (e) { /* noop */ }
    try {
      if (!window.chrome) {
        Object.defineProperty(window, 'chrome', {
          value: { runtime: { id: undefined } },
          configurable: true,
        });
      }
    } catch (e) { /* noop */ }
  })();`,
  false,
);

// -- 2. Stream Mode shroud + masker -----------------------------------------
const IS_MAIN_FRAME = window.top === window.self;

// Random per-document nonce so a stale `ready` from the previous page can't
// drop the curtain of the new one. Math.random is fine here (renderer world).
const nonce = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;

// Synchronous config read : MUST resolve before the first paint so the shroud
// decision is made pre-paint. Depends on IPC handlers being registered before
// any tab loads (boot-order fix).
let initialConfig: StreamModeConfig | null = null;
let initialHostname: string | null = null;
try {
  const res = ipcRenderer.sendSync(IPC.STREAM_GET_CONFIG_SYNC) as
    | { config: StreamModeConfig; hostname: string }
    | undefined;
  if (res) {
    initialConfig = res.config;
    initialHostname = res.hostname;
  }
} catch {
  // Handlers not ready (shouldn't happen post boot-order fix) → start disabled.
}

const streamState: { config: StreamModeConfig | null; hostname: string | null } = {
  config: initialConfig,
  hostname: initialHostname,
};
const subscribers = new Set<(c: StreamModeConfig) => void>();

ipcRenderer.on(IPC.STREAM_CONFIG_CHANGED, (_e, config: StreamModeConfig) => {
  streamState.config = config;
  for (const sub of subscribers) {
    try {
      sub(config);
    } catch {
      // ignore
    }
  }
});

let shroudKey: string | null = null;
function beginProtected(): void {
  if (shroudKey == null) {
    try {
      // opacity:0 on <html> composites the whole subtree at 0 alpha : a page
      // cannot reveal a descendant past it (unlike visibility, which a page
      // rule could override). Removed the instant the masker is done.
      shroudKey = webFrame.insertCSS('html{opacity:0!important;transition:none!important}');
    } catch {
      shroudKey = null;
    }
  }
  if (IS_MAIN_FRAME) {
    try {
      ipcRenderer.send(IPC.STREAM_DOC_START, { nonce });
    } catch {
      // ignore
    }
  }
}
function endProtected(): void {
  if (shroudKey != null) {
    try {
      webFrame.removeInsertedCSS(shroudKey);
    } catch {
      // ignore
    }
    shroudKey = null;
  }
  if (IS_MAIN_FRAME) {
    try {
      ipcRenderer.send(IPC.STREAM_READY, { nonce });
    } catch {
      // ignore
    }
  }
}

const host: MaskerHost = {
  getConfig: () => streamState.config,
  getHostname: () => streamState.hostname,
  subscribe: (cb) => {
    subscribers.add(cb);
    return () => subscribers.delete(cb);
  },
  beginProtected,
  endProtected,
  signalGate: (seq: number) => {
    try {
      ipcRenderer.send(IPC.STREAM_FRAME_GATE, { seq });
    } catch {
      // ignore: without an ack the masker simply keeps the iframes hidden
    }
  },
  onFramesStatus: (cb: (status: FramesStatus) => void) => {
    ipcRenderer.on(IPC.STREAM_FRAMES_STATUS, (_e, status: FramesStatus) => cb(status));
  },
};

installStreamMasker(host);
installHoverMasker(host);

// -- 3. Chrome Web Store branding fixup --------------------------------------
if (window.location.hostname === 'chromewebstore.google.com') {
  const APP_NAME = 'Voksa';
  const fixWebstoreBranding = () => {
    for (const button of Array.from(document.querySelectorAll('button'))) {
      const text = button.textContent ?? '';
      if (text.includes(`Google ${APP_NAME}`)) {
        button.innerText = button.innerText.split(`Google ${APP_NAME}`).join(APP_NAME);
      }
    }
  };
  window.addEventListener('DOMContentLoaded', () => {
    fixWebstoreBranding();
    let scheduled = false;
    const observer = new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        fixWebstoreBranding();
      });
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  });
}
