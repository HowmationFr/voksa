/**
 * Per-tab audio output routing, isolated-world side (DMCA stage 2). Runs in
 * EVERY frame carrying the page preload (nodeIntegrationInSubFrames), because
 * deviceIds are hashed per origin: each frame must resolve the stored device
 * LABEL against its OWN enumeration (see shared/audioRouting.ts).
 *
 * Division of labor:
 *  - attached <audio>/<video> elements are routed from HERE: the DOM is
 *    shared across worlds, so calling el.setSinkId() on the isolated-world
 *    wrapper routes the real element. Open shadow roots are swept AND
 *    observed (a MutationObserver on `document` never sees mutations inside
 *    a shadow tree, so each discovered root gets the observer attached);
 *  - detached `new Audio()` and page AudioContexts are unreachable from any
 *    isolated world: they are covered by the main-world patch
 *    (shared/audioRouting.buildAudioRoutePatch), installed LAZILY on the
 *    first routing of the document so an unrouted tab has zero main-world
 *    footprint.
 *
 * Assumed limitations, stated rather than papered over:
 *  - enabling routing on an ALREADY loaded document does not reach
 *    AudioContexts created (or detached elements played) before that moment;
 *    a reload (patch present from document-start) covers them;
 *  - a detached `document.createElement('audio')` with the autoplay
 *    attribute never crosses any of our hooks (the `new Audio()` ctor and
 *    play() are wrapped, internal autoplay is not);
 *  - CROSS-ORIGIN iframes cannot resolve any label: Blink's permissions
 *    policy blanks enumerateDevices labels/ids for them (verified against
 *    this Electron), whatever our permission handlers say. Their audio stays
 *    on the system default. Under Stream Mode the stage-1 guard still mutes
 *    audible background tabs.
 *
 * Fail-visible: when the MAIN frame's enumeration succeeds but the label is
 * absent (device unplugged), it reports matched:false and main CLEARS the
 * route: the UI must never claim a routing that is not applied. A document
 * that cannot enumerate AT ALL (insecure context: plain http) reports
 * nothing and keeps the stored route: it applies again on the next capable
 * document, instead of being silently erased by a transit through one page.
 */
import {
  buildAudioRouteApply,
  buildAudioRoutePatch,
  matchOutputByLabel,
  type MediaDeviceLike,
} from '../shared/audioRouting';

export type AudioRouteHost = {
  /** Run code in THIS frame's main world (webFrame.executeJavaScript). */
  execMainWorld: (code: string) => Promise<unknown>;
  /**
   * Verdict of a non-null apply, with the label it judged (main ignores a
   * verdict about a label that is no longer the tab's route: an in-flight
   * stale verdict must not clear a route the user just changed).
   */
  reportStatus: (matched: boolean, label: string) => void;
};

export type AudioRouter = {
  apply: (label: string | null) => Promise<void>;
  /**
   * Fire the main-world patch NOW, without awaiting anything. Called at
   * document-start when the tab is already routed: executeJavaScript calls
   * are queued in order, so the patch (constructor wraps) lands before any
   * page script can create an AudioContext, exactly like the webdriver patch.
   */
  preinstall: () => void;
};

/**
 * Open-shadow-root inclusive sweep for media elements. Depth-capped.
 * `onShadowRoot` fires for every open root encountered, so the caller can
 * attach its MutationObserver there (document-level observation does not
 * cross shadow boundaries).
 */
function collectMedia(
  root: ParentNode,
  out: HTMLMediaElement[],
  depth: number,
  onShadowRoot?: (sr: ShadowRoot) => void,
): void {
  try {
    root.querySelectorAll('audio,video').forEach((el) => out.push(el as HTMLMediaElement));
    if (depth >= 4) return;
    root.querySelectorAll('*').forEach((el) => {
      const sr = (el as Element).shadowRoot;
      if (sr) {
        onShadowRoot?.(sr);
        collectMedia(sr, out, depth + 1, onShadowRoot);
      }
    });
  } catch {
    // detached / hostile DOM: routing is best-effort here
  }
}

export function installAudioRouter(host: AudioRouteHost): AudioRouter {
  // Random, unbranded main-world handle: regenerated per document, never a
  // recognizable name (the stream API stays invisible; this one is at least
  // anonymous). Math.random is fine here (renderer world, not a secret).
  const handle = `__ar_${Math.random().toString(36).slice(2, 10)}`;
  let patched = false;
  let currentLabel: string | null = null;
  let currentSink: string | null = null;
  let generation = 0;
  let observer: MutationObserver | null = null;
  let observedShadows = new WeakSet<ShadowRoot>();

  const routeElement = (el: HTMLMediaElement, sinkId: string): void => {
    try {
      if (typeof el.setSinkId === 'function' && el.sinkId !== sinkId) {
        void el.setSinkId(sinkId).catch(() => undefined);
      }
    } catch {
      // ignore: a failed element keeps the default sink
    }
  };

  /** Attach the shared observer to a shadow root (once per root). */
  const observeShadowRoot = (sr: ShadowRoot): void => {
    if (!observer || observedShadows.has(sr)) return;
    observedShadows.add(sr);
    try {
      observer.observe(sr, { childList: true, subtree: true });
    } catch {
      // ignore
    }
  };

  const sweepAttached = (sinkId: string): void => {
    const found: HTMLMediaElement[] = [];
    collectMedia(document, found, 0, observeShadowRoot);
    for (const el of found) routeElement(el, sinkId);
  };

  // Route media elements as the parser / page inserts them: play()-wrapping
  // alone would miss autoplay elements (their playback starts internally,
  // never through a JS play() call). Only ever connected while routed; also
  // attached to every discovered open shadow root, since a document-level
  // observer never reports mutations inside shadow trees.
  const ensureObserver = (): void => {
    if (observer) return;
    observer = new MutationObserver((mutations) => {
      const sink = currentSink;
      if (sink == null) return;
      for (const m of mutations) {
        m.addedNodes.forEach((node) => {
          if (!(node instanceof Element)) return;
          if (node instanceof HTMLMediaElement) routeElement(node, sink);
          const found: HTMLMediaElement[] = [];
          collectMedia(node, found, 0, observeShadowRoot);
          for (const el of found) routeElement(el, sink);
        });
      }
    });
    try {
      observer.observe(document, { childList: true, subtree: true });
    } catch {
      observer = null;
    }
  };

  const dropObserver = (): void => {
    observer?.disconnect();
    observer = null;
    observedShadows = new WeakSet<ShadowRoot>();
  };

  async function apply(label: string | null): Promise<void> {
    const gen = ++generation;
    currentLabel = label;

    if (label == null) {
      currentSink = null;
      dropObserver();
      if (patched) {
        try {
          await host.execMainWorld(buildAudioRouteApply(handle, null));
        } catch {
          // ignore
        }
        // A newer apply took over while we awaited: it owns the state now.
        if (gen !== generation) return;
      }
      // Reset attached elements to the system default ('' = default sink).
      const found: HTMLMediaElement[] = [];
      collectMedia(document, found, 0);
      for (const el of found) {
        try {
          if (typeof el.setSinkId === 'function' && el.sinkId !== '') {
            void el.setSinkId('').catch(() => undefined);
          }
        } catch {
          // ignore
        }
      }
      return;
    }

    // This DOCUMENT cannot enumerate at all (insecure context): keep the
    // stored route silent instead of reporting matched:false, which would
    // permanently erase the user's choice because of one http transit.
    if (!window.isSecureContext || !navigator.mediaDevices?.enumerateDevices) {
      return;
    }

    let devices: MediaDeviceLike[] = [];
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      devices = list.map((d) => ({ deviceId: d.deviceId, kind: d.kind, label: d.label }));
    } catch {
      devices = [];
    }
    // A newer apply superseded this one while we awaited the enumeration.
    if (gen !== generation) return;

    const sinkId = matchOutputByLabel(devices, label);
    if (sinkId == null) {
      host.reportStatus(false, label);
      return;
    }

    currentSink = sinkId;
    if (!patched) {
      try {
        await host.execMainWorld(buildAudioRoutePatch(handle));
        patched = true;
      } catch {
        // main-world patch unavailable: attached elements are still routed below
      }
      if (gen !== generation) return;
    }
    try {
      await host.execMainWorld(buildAudioRouteApply(handle, sinkId));
    } catch {
      // ignore
    }
    // The await above may have let a newer apply (or a reset) run to
    // completion: sweeping with OUR sink now would resurrect a dead route.
    if (gen !== generation) return;
    ensureObserver();
    sweepAttached(sinkId);
    host.reportStatus(true, label);
  }

  const preinstall = (): void => {
    if (patched) return;
    patched = true;
    host.execMainWorld(buildAudioRoutePatch(handle)).catch(() => {
      // If even the patch cannot run, apply() still routes attached elements.
    });
  };

  // Device set changed (unplug/replug): re-resolve the label. A vanished
  // device reports matched:false and main clears the route (fail-visible).
  try {
    navigator.mediaDevices?.addEventListener('devicechange', () => {
      if (currentLabel != null) void apply(currentLabel);
    });
  } catch {
    // mediaDevices unavailable (insecure context): apply() keeps the route
  }

  return { apply, preinstall };
}
