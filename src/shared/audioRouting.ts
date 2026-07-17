/**
 * Per-tab audio output routing (DMCA Audio Guard, stage 2). Pure policy +
 * main-world patch source, shared by the injected router (src/injected/
 * audioRoute.ts) and the chrome UI (device list in the tab context menu).
 *
 * WHY LABELS, NOT DEVICE IDS. Chromium hashes media deviceIds PER ORIGIN (an
 * HMAC of the raw id, the origin and a profile salt), so an id enumerated in
 * the chrome UI is meaningless inside a tab, and an id enumerated on one site
 * is meaningless on the next navigation. The device LABEL is the only stable
 * cross-origin identifier the platform gives us: the user picks a label in
 * our UI, and each frame re-resolves that label against ITS OWN enumeration
 * to obtain the deviceId valid for its origin.
 *
 * Matching is EXACT (same OS-provided string on both sides). No trimming, no
 * case folding: a fuzzy match could route audio to the wrong physical device,
 * which for a streamer is exactly the leak this feature exists to prevent.
 * A label that no longer resolves is reported and the route is CLEARED by
 * main (fail-visible): the UI must never claim a routing that is not applied.
 */

/** The subset of MediaDeviceInfo the policy needs (structured-clone friendly). */
export type MediaDeviceLike = {
  deviceId: string;
  kind: string;
  label: string;
};

export type AudioOutputChoice = {
  deviceId: string;
  label: string;
};

/**
 * Chromium's synthetic audiooutput entries: literal (unhashed) ids standing
 * for "whatever the OS default is". They duplicate a physical device under a
 * decorated label ("Default - Speakers…"), so routing to them would silently
 * follow OS default changes: the opposite of an explicit route. Excluded.
 */
const SYNTHETIC_IDS = new Set(['default', 'communications']);

function isRoutableOutput(d: MediaDeviceLike): boolean {
  return (
    d.kind === 'audiooutput' &&
    typeof d.deviceId === 'string' &&
    d.deviceId.length > 0 &&
    !SYNTHETIC_IDS.has(d.deviceId) &&
    typeof d.label === 'string' &&
    d.label.length > 0
  );
}

/**
 * The outputs a user can route to: physical audiooutput devices with a label.
 * Label-less devices are dropped (no label = no permission-grade exposure =
 * setSinkId would be refused anyway). Duplicate labels keep the FIRST device
 * only: matching by label can never reach the second, and a menu row that can
 * never be honored must not be shown.
 */
export function routableOutputs(devices: readonly MediaDeviceLike[]): AudioOutputChoice[] {
  const out: AudioOutputChoice[] = [];
  const seen = new Set<string>();
  for (const d of devices) {
    if (!isRoutableOutput(d)) continue;
    if (seen.has(d.label)) continue;
    seen.add(d.label);
    out.push({ deviceId: d.deviceId, label: d.label });
  }
  return out;
}

/**
 * Resolve a stored label against a frame's own enumeration. Exact match only;
 * first wins on duplicates (consistent with routableOutputs). Null = the
 * device is gone (or labels are not exposed here): the caller must fall back
 * to the system default AND report it, never guess.
 */
export function matchOutputByLabel(
  devices: readonly MediaDeviceLike[],
  label: string,
): string | null {
  for (const d of devices) {
    if (isRoutableOutput(d) && d.label === label) return d.deviceId;
  }
  return null;
}

/**
 * Main-world patch, built as source text and executed via
 * webFrame.executeJavaScript by the page preload of a ROUTED tab only.
 *
 * Why main world at all: media elements attached to the DOM are reachable
 * from the isolated world (the DOM is shared), but `new Audio()` kept
 * detached and page-created AudioContexts are plain JS objects of the main
 * world; no isolated-world code can ever reach them. The patch wraps the
 * AudioContext constructors (tracking instances) and HTMLMediaElement.play
 * (routing detached elements at play time), and exposes ONE handle: a
 * non-enumerable, randomly named function the preload calls to change the
 * sink. Installed lazily (first routing of the document), so an unrouted tab
 * carries no main-world footprint whatsoever.
 */
export function buildAudioRoutePatch(handle: string): string {
  const H = JSON.stringify(handle);
  return `(() => {
  'use strict';
  var HANDLE = ${H};
  try { if (Object.prototype.hasOwnProperty.call(window, HANDLE)) return; } catch (e) { return; }
  var sink = null;
  var ctxRefs = [];
  var elRefs = [];
  var known = new WeakSet();
  var remember = function (arr, obj) {
    try {
      if (known.has(obj)) return;
      known.add(obj);
      arr.push(new WeakRef(obj));
      if (arr.length > 256) {
        var alive = arr.filter(function (r) { return r.deref() !== undefined; });
        arr.length = 0;
        for (var i = 0; i < alive.length; i += 1) arr.push(alive[i]);
      }
    } catch (e) { /* WeakRef unavailable: skip tracking */ }
  };
  var routeEl = function (el) {
    try {
      if (el && typeof el.setSinkId === 'function' && el.sinkId !== (sink || '')) {
        var p = el.setSinkId(sink || '');
        if (p && typeof p.catch === 'function') p.catch(function () {});
      }
    } catch (e) { /* ignore */ }
  };
  var routeCtx = function (ctx) {
    try {
      if (ctx && typeof ctx.setSinkId === 'function') {
        var p = ctx.setSinkId(sink || '');
        if (p && typeof p.catch === 'function') p.catch(function () {});
      }
    } catch (e) { /* ignore */ }
  };
  var wrapCtor = function (name) {
    try {
      var Orig = window[name];
      if (typeof Orig !== 'function') return;
      window[name] = new Proxy(Orig, {
        construct: function (target, args, newTarget) {
          var ctx = Reflect.construct(target, args, newTarget);
          remember(ctxRefs, ctx);
          if (sink != null) routeCtx(ctx);
          return ctx;
        },
      });
    } catch (e) { /* ignore */ }
  };
  wrapCtor('AudioContext');
  wrapCtor('webkitAudioContext');
  try {
    // Detached-autoplay coverage: "new Audio(src); el.autoplay = true" starts
    // playback through Blink's internal steps, never through the play() wrap
    // below. Remember such elements at construction so a sink change reaches
    // them. (document.createElement('audio') kept detached with autoplay
    // remains uncovered: documented limitation.)
    var OrigAudio = window.Audio;
    if (typeof OrigAudio === 'function') {
      window.Audio = new Proxy(OrigAudio, {
        construct: function (target, args, newTarget) {
          var el = Reflect.construct(target, args, newTarget);
          remember(elRefs, el);
          if (sink != null) routeEl(el);
          return el;
        },
      });
    }
  } catch (e) { /* ignore */ }
  try {
    var origPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function play() {
      // Remember UNCONDITIONALLY (like wrapCtor): an element that plays while
      // the sink is still null (document-start scripts racing the async
      // enumeration) must be reachable when the sink resolves moments later,
      // or it would play on the system default forever while the tab claims
      // routed.
      remember(elRefs, this);
      if (sink != null) routeEl(this);
      return origPlay.apply(this, arguments);
    };
  } catch (e) { /* ignore */ }
  try {
    Object.defineProperty(window, HANDLE, {
      value: function (next) {
        sink = typeof next === 'string' ? next : null;
        for (var i = 0; i < ctxRefs.length; i += 1) { var c = ctxRefs[i].deref(); if (c) routeCtx(c); }
        for (var j = 0; j < elRefs.length; j += 1) { var el = elRefs[j].deref(); if (el) routeEl(el); }
      },
      enumerable: false,
      writable: false,
      configurable: false,
    });
  } catch (e) { /* ignore */ }
})();`;
}

/** The call the preload issues (main world) whenever the sink changes. */
export function buildAudioRouteApply(handle: string, sinkId: string | null): string {
  const H = JSON.stringify(handle);
  const S = JSON.stringify(sinkId);
  return `(() => { try { var f = window[${H}]; if (typeof f === 'function') f(${S}); } catch (e) { /* ignore */ } })();`;
}
