import fs from 'node:fs';
import path from 'node:path';
import { app, webFrameMain, type WebContents, type WebFrameMain } from 'electron';
import { IPC } from '../../shared/ipcChannels';
import { hasAnyMask, type MaskFlags } from '../../shared/maskPatterns';
import type { StreamModeConfig } from '../../shared/streamConfig';
import type { FallbackPayload } from '../../injected/fallbackMask';
import { getStreamMode } from './StreamModeController';

/**
 * Frame guard: the fourth Stream Mode layer, and the only defence against the
 * one frame flavour the other three cannot reach.
 *
 * THE HOLE. electron/electron#34727 (upstream, closed as NOT PLANNED): a frame
 * whose `contentWindow` / `contentDocument` is read by a page script BEFORE it
 * commits its document never gets our preload. No preload means no L0 shroud
 * (preload/page.ts) and no L1 masker (injected/streamMask.ts): under Stream Mode
 * that frame paints raw emails / IPs / phone numbers while the rest of the page
 * is masked. Ad, analytics and widget libraries do this routinely. `sandbox:
 * false` and `session.registerPreloadScript({type:'frame'})` were both measured
 * and neither injects the preload; there is no configuration fix.
 *
 * THE GUARD, per tab (per webContents, popups included):
 *  1. LIVENESS. Every frame that DOES get a preload announces itself on
 *     STREAM_FRAME_ALIVE at preload start (Stream Mode on or off: liveness must
 *     be known before a toggle-ON). Main keys it by (processId, frameToken).
 *  2. COVERAGE. While Stream Mode is on, every committed subframe must be
 *     COVERED: either it announced (it protects itself), or we injected the
 *     fallback masker into it (injected/fallbackMask.ts, main world, via
 *     WebFrameMain.executeJavaScript). A subframe that has not announced GRACE_MS
 *     after committing is deemed preload-less and gets the fallback.
 *  3. GATE. Until every subframe is covered, the renderer-side maskers hide every
 *     iframe ELEMENT synchronously, pre-paint (see the gate in
 *     injected/streamMask.ts). This tab-level verdict is pushed to every frame on
 *     STREAM_FRAMES_STATUS. The renderer gates first and asks second (it bumps a
 *     seq and sends STREAM_FRAME_GATE), and only ungates on a verdict that echoes
 *     a seq at least as recent as its own: an "all covered" computed before main
 *     had even heard of the new frame can therefore never reveal it.
 *
 * The main frame is never gated nor fallback-injected: it always gets its
 * preload (it is the frame the preload is attached to), and if it somehow did
 * not, the curtain covers navigations while the L0 shroud is absent.
 *
 * Everything here fails CLOSED: any doubt (frame still navigating, injection
 * failed, bundle unreadable) leaves the tab "pending", which keeps iframes
 * hidden. The worst case is an invisible iframe, never a leaked frame.
 */

/**
 * Grace between a subframe's commit and the verdict "this frame is preload-less".
 * A healthy frame's preload runs at document-start, i.e. its STREAM_FRAME_ALIVE
 * is already on the wire when `did-frame-navigate` fires in main; one Mojo hop
 * (well under a millisecond) is all it needs. 250 ms is ~2 orders of magnitude
 * of headroom for a loaded machine, and is only ever paid by frames that are
 * genuinely preload-less (healthy ones are covered as soon as they announce).
 * Getting it wrong in the pessimistic direction is harmless anyway: injecting
 * the fallback into a frame that turns out to be healthy only double-masks it,
 * which is idempotent, and restore-on-disable is ownership-checked on both sides.
 */
const GRACE_MS = 250;

/**
 * Settle window after a renderer gate signal (or a subframe navigation start).
 * The frame the renderer just gated may not exist in the browser process yet:
 * its creation and our IPC travel different Mojo pipes, so main must not answer
 * "all covered" from a frame tree that predates it. Holding the verdict at
 * "pending" for 150 ms bounds that skew (a single IPC hop) with a wide margin,
 * and is invisible: the tab's iframes are already hidden during it.
 */
const SETTLE_MS = 150;

/** Kept in sync with HANDLE_KEY in src/injected/fallbackMask.ts. */
const FALLBACK_HANDLE_KEY = 'voksa.fallbackMask';

export type FramesStatus = { pending: boolean; seq: number };

/** Identity of a document in a frame: frameTokens are never reused, routingIds are. */
type FrameKey = string;

function frameKey(frame: WebFrameMain): FrameKey | null {
  try {
    if (frame.isDestroyed()) return null;
    return `${frame.processId}:${frame.frameToken}`;
  } catch {
    return null;
  }
}

/** Frame-tree node id: stable for the whole life of a frame, across documents. */
function frameNode(frame: WebFrameMain): number | null {
  try {
    if (frame.isDestroyed()) return null;
    return frame.frameTreeNodeId;
  } catch {
    return null;
  }
}

/** (processId, routingId): what the webContents frame events speak in. */
function frameIds(frame: WebFrameMain): { processId: number; routingId: number } | null {
  try {
    if (frame.isDestroyed()) return null;
    return { processId: frame.processId, routingId: frame.routingId };
  } catch {
    return null;
  }
}

/** Drop every entry whose key is no longer live (bounds every map/set here). */
function pruneTo<K>(
  target: { keys(): IterableIterator<K>; delete(key: K): boolean },
  live: Set<K>,
): void {
  for (const key of [...target.keys()]) {
    if (!live.has(key)) target.delete(key);
  }
}

function isMaskingActive(config: StreamModeConfig): boolean {
  const flags: MaskFlags = {
    maskIPv4: config.maskIPv4,
    maskIPv6: config.maskIPv6,
    maskEmails: config.maskEmails,
    maskPhones: config.maskPhones,
    maskInternalHostnames: config.maskInternalHostnames,
  };
  return config.enabled && hasAnyMask(flags, config.customMasks);
}

/** A frame with no real document yet: nothing to mask, and no leak to fear. */
function isBlankUrl(url: string): boolean {
  return !url || url === 'about:blank' || url === 'about:srcdoc';
}

let fallbackSource: string | null | undefined;

/** Read the standalone fallback bundle once (see scripts/build-main.mjs). */
function loadFallbackSource(): string | null {
  if (fallbackSource !== undefined) return fallbackSource;
  try {
    fallbackSource = fs.readFileSync(
      path.join(app.getAppPath(), 'dist-electron', 'injected', 'fallbackMask.js'),
      'utf8',
    );
  } catch (err) {
    // Fail closed: with no bundle, no frame is ever covered, so the gate stays
    // up and unprotected frames stay hidden rather than leaking.
    console.warn('[stream] fallback masker bundle unreadable:', err);
    fallbackSource = null;
  }
  return fallbackSource;
}

function buildInjection(source: string, payload: FallbackPayload): string {
  // The bundle installs the handle (idempotently), then we drive it. The
  // trailing `undefined` keeps executeJavaScript's resolved value cloneable.
  return (
    `(() => { try {\n${source}\n} catch (e) {} ` +
    `try { const h = window[Symbol.for(${JSON.stringify(FALLBACK_HANDLE_KEY)})]; ` +
    `if (h) h.update(${JSON.stringify(payload)}); } catch (e) {} })(); undefined;`
  );
}

export class FrameGuard {
  /** Documents that announced a preload (hence shroud + masker). */
  private readonly alive = new Set<FrameKey>();
  /**
   * Documents covered by the fallback masker RUNNING THE CURRENT CONFIG. Cleared
   * on every config change, which re-raises the gate until the re-injection lands.
   */
  private readonly injected = new Set<FrameKey>();
  /**
   * Documents the fallback bundle is installed in, whatever config it runs. This
   * is what a config change (Stream Mode OFF included, where it means "restore
   * the DOM") has to be replayed into, so it must survive `injected.clear()`.
   */
  private readonly installed = new Set<FrameKey>();
  private readonly injecting = new Set<FrameKey>();
  private readonly graceTimers = new Map<FrameKey, NodeJS.Timeout>();
  /** Last gate seq each frame told us about (echoed back in its status). */
  private readonly gateSeq = new Map<FrameKey, number>();
  private readonly lastPush = new Map<FrameKey, string>();
  /** Frames proven preload-less: their NEXT document skips the grace. */
  private readonly preloadLess = new Set<number>();
  /** Frames with a cross-document navigation in flight: never "covered". */
  private readonly navigating = new Set<number>();

  private settleUntil = 0;
  private settleTimer: NodeJS.Timeout | null = null;
  private evalTimer: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(
    private readonly wc: WebContents,
    private readonly onDisposed?: () => void,
  ) {
    wc.on('frame-created', this.handleFrameCreated);
    wc.on('did-start-navigation', this.handleStartNavigation);
    wc.on('did-frame-navigate', this.handleFrameNavigate);
    wc.on('did-fail-load', this.handleFailLoad);
    wc.once('destroyed', this.handleDestroyed);
  }

  // --- inputs from the renderer --------------------------------------------

  /** A frame announced its preload (STREAM_FRAME_ALIVE). */
  onFrameAlive(frame: WebFrameMain | null): void {
    if (this.disposed || !frame) return;
    const key = frameKey(frame);
    if (!key) return;
    this.alive.add(key);
    const node = frameNode(frame);
    // It DOES have a preload after all: a stale "preload-less" verdict would
    // otherwise make us skip the grace on its next document forever.
    if (node != null) this.preloadLess.delete(node);
    this.clearGrace(key);
    this.scheduleEvaluate();
  }

  /** A frame hid iframe element(s) and wants a fresh coverage verdict. */
  onGateSignal(frame: WebFrameMain | null, seq: number): void {
    if (this.disposed || !frame || !Number.isFinite(seq)) return;
    const key = frameKey(frame);
    if (!key) return;
    const previous = this.gateSeq.get(key) ?? 0;
    if (seq > previous) this.gateSeq.set(key, seq);
    // The frame it gated may not have reached the browser process yet: hold the
    // verdict at "pending" until the tree has had time to catch up.
    this.settle();
  }

  // --- inputs from the tab ---------------------------------------------------

  /** Stream Mode config changed (TabManager forwards it to every guard). */
  onConfigChanged(): void {
    if (this.disposed) return;
    // Coverage is config-specific: a fallback masker still running the previous
    // config does NOT cover the new one (a freshly added custom mask would be
    // painted until the re-injection lands). Drop coverage, which re-raises the
    // gate, and let the re-injection re-earn it.
    this.injected.clear();
    this.lastPush.clear();
    // Replay the new config into every fallback we installed. Also the ONLY way
    // Stream Mode OFF reaches them: they have no IPC, so "restore the DOM" is
    // an injection like any other (the payload just carries a disabled config).
    for (const frame of this.frames().subframes) {
      const key = frameKey(frame);
      if (key && this.installed.has(key)) void this.inject(frame, key);
    }
    this.evaluateNow();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const timer of this.graceTimers.values()) clearTimeout(timer);
    this.graceTimers.clear();
    if (this.settleTimer) clearTimeout(this.settleTimer);
    if (this.evalTimer) clearTimeout(this.evalTimer);
    this.settleTimer = null;
    this.evalTimer = null;
    try {
      if (!this.wc.isDestroyed()) {
        this.wc.off('frame-created', this.handleFrameCreated);
        this.wc.off('did-start-navigation', this.handleStartNavigation);
        this.wc.off('did-frame-navigate', this.handleFrameNavigate);
        this.wc.off('did-fail-load', this.handleFailLoad);
        this.wc.off('destroyed', this.handleDestroyed);
      }
    } catch {
      // webContents already gone; nothing to detach
    }
    this.onDisposed?.();
  }

  // --- webContents events ----------------------------------------------------

  /**
   * A frame was created (it may still be an empty document). Deliberately does
   * NOT touch `details.frame`: calling executeJavaScript from this handler is
   * itself a documented trigger of electron/electron#34727, the very bug this
   * guard exists to contain. Discovery happens in evaluate(), off the event.
   */
  private readonly handleFrameCreated = (): void => {
    if (this.disposed) return;
    this.settle();
  };

  private readonly handleStartNavigation = (
    details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
  ): void => {
    if (this.disposed) return;
    if (details.isMainFrame || details.isSameDocument) return;
    const frame = details.frame;
    const node = frame ? frameNode(frame) : null;
    // The document about to commit is unprotected by definition (its preload,
    // if any, has not run yet), so this frame stops being "covered" NOW, before
    // the new document exists. That is what keeps a known preload-less frame
    // gated across its own navigations.
    if (node != null) this.navigating.add(node);
    this.settle();
  };

  private readonly handleFrameNavigate = (
    _event: Electron.Event,
    _url: string,
    _httpResponseCode: number,
    _httpStatusText: string,
    isMainFrame: boolean,
    frameProcessId: number,
    frameRoutingId: number,
  ): void => {
    if (this.disposed) return;
    if (isMainFrame) {
      // Whole tree replaced: stale keys are pruned by evaluate().
      this.scheduleEvaluate();
      return;
    }
    const frame = this.frameFromId(frameProcessId, frameRoutingId);
    if (!frame) {
      this.scheduleEvaluate();
      return;
    }
    const node = frameNode(frame);
    if (node != null) this.navigating.delete(node);
    const key = frameKey(frame);
    if (!key) {
      this.scheduleEvaluate();
      return;
    }
    // A new document in this frame is uncovered until it proves otherwise, even
    // if it reuses the previous document's frame token (same-process reuse):
    // liveness and injections are per DOCUMENT, never per frame. The fallback
    // masker died with the old document, so it is not installed either.
    this.alive.delete(key);
    this.injected.delete(key);
    this.installed.delete(key);
    this.gateSeq.delete(key);
    this.lastPush.delete(key);
    if (node != null && this.preloadLess.has(node)) {
      // Already proven preload-less: no point waiting out the grace again.
      void this.inject(frame, key);
    } else {
      this.startGrace(key, frameProcessId, frameRoutingId);
    }
    this.scheduleEvaluate();
  };

  private readonly handleFailLoad = (
    _event: Electron.Event,
    _errorCode: number,
    _errorDescription: string,
    _validatedURL: string,
    isMainFrame: boolean,
    frameProcessId: number,
    frameRoutingId: number,
  ): void => {
    if (this.disposed || isMainFrame) return;
    const frame = this.frameFromId(frameProcessId, frameRoutingId);
    const node = frame ? frameNode(frame) : null;
    if (node != null) this.navigating.delete(node);
    this.scheduleEvaluate();
  };

  private readonly handleDestroyed = (): void => {
    this.dispose();
  };

  // --- core ------------------------------------------------------------------

  private frameFromId(processId: number, routingId: number): WebFrameMain | null {
    try {
      const frame = webFrameMain.fromId(processId, routingId);
      return frame && !frame.isDestroyed() ? frame : null;
    } catch {
      return null;
    }
  }

  /**
   * The tab's frames, main frame apart. Only SUBFRAMES are guarded (the main
   * frame always gets its preload), but the main frame still takes part in the
   * gate handshake, so both are needed.
   */
  private frames(): { main: WebFrameMain | null; subframes: WebFrameMain[] } {
    if (this.wc.isDestroyed()) return { main: null, subframes: [] };
    try {
      const main = this.wc.mainFrame;
      if (!main) return { main: null, subframes: [] };
      const subframes = main.framesInSubtree.filter((frame) => {
        try {
          return !frame.isDestroyed() && frame.parent !== null && !frame.detached;
        } catch {
          return false;
        }
      });
      return { main, subframes };
    } catch {
      return { main: null, subframes: [] };
    }
  }

  private settle(): void {
    this.settleUntil = Date.now() + SETTLE_MS;
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      this.evaluateNow();
    }, SETTLE_MS);
    this.scheduleEvaluate();
  }

  private scheduleEvaluate(): void {
    if (this.disposed || this.evalTimer) return;
    this.evalTimer = setTimeout(() => {
      this.evalTimer = null;
      this.evaluateNow();
    }, 0);
  }

  private clearGrace(key: FrameKey): void {
    const timer = this.graceTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.graceTimers.delete(key);
    }
  }

  private startGrace(key: FrameKey, processId: number, routingId: number): void {
    this.clearGrace(key);
    this.graceTimers.set(
      key,
      setTimeout(() => {
        this.graceTimers.delete(key);
        if (this.disposed) return;
        if (this.alive.has(key) || this.injected.has(key)) return;
        const frame = this.frameFromId(processId, routingId);
        if (!frame || frameKey(frame) !== key) return;
        const node = frameNode(frame);
        // Still navigating: the document we would inject into is about to be
        // replaced. The commit restarts the grace.
        if (node != null && this.navigating.has(node)) return;
        let url = '';
        try {
          url = frame.url;
        } catch {
          return;
        }
        // Only a real document proves the frame is preload-less: an empty one
        // never runs a preload by design, and its next document may well get one.
        if (node != null && !isBlankUrl(url)) this.preloadLess.add(node);
        void this.inject(frame, key);
      }, GRACE_MS),
    );
  }

  private payload(): FallbackPayload {
    const stream = getStreamMode();
    return { config: stream.getConfig(), hostname: stream.getInternalHostname() };
  }

  /**
   * Install (or refresh) the fallback masker in an unprotected frame. Coverage
   * is only claimed once the code has actually run in the frame, so the gate
   * cannot lift on a promise.
   */
  private async inject(frame: WebFrameMain, key: FrameKey): Promise<void> {
    if (this.disposed || this.injecting.has(key)) return;
    const source = loadFallbackSource();
    if (!source) return;
    this.injecting.add(key);
    try {
      if (frame.isDestroyed()) return;
      await frame.executeJavaScript(buildInjection(source, this.payload()));
      if (this.disposed) return;
      // The frame may have navigated away while the code was in flight; a stale
      // coverage claim would be a leak, so re-check the identity.
      if (frameKey(frame) !== key) return;
      this.installed.add(key);
      this.injected.add(key);
    } catch {
      // Frame destroyed or navigated mid-injection: it stays uncovered, so the
      // gate stays up and the next commit retries.
    } finally {
      this.injecting.delete(key);
      this.scheduleEvaluate();
    }
  }

  private evaluateNow(): void {
    if (this.disposed || this.wc.isDestroyed()) return;
    const active = isMaskingActive(getStreamMode().getConfig());
    const { main, subframes } = this.frames();
    const all = main ? [main, ...subframes] : subframes;

    // Prune everything keyed on a frame/document that no longer exists: frame
    // tokens are never reused, so a key absent from the tree is gone for good,
    // and a stale entry could otherwise vouch for a frame it knows nothing about.
    // The MAIN frame belongs in here: it never needs coverage, but it is the
    // frame that gates the tab's iframes, so its gate seq must survive.
    const liveKeys = new Set<FrameKey>();
    const liveNodes = new Set<number>();
    for (const frame of all) {
      const key = frameKey(frame);
      if (key) liveKeys.add(key);
      const node = frameNode(frame);
      if (node != null) liveNodes.add(node);
    }
    pruneTo(this.alive, liveKeys);
    pruneTo(this.injected, liveKeys);
    pruneTo(this.installed, liveKeys);
    pruneTo(this.gateSeq, liveKeys);
    pruneTo(this.preloadLess, liveNodes);
    pruneTo(this.navigating, liveNodes);
    for (const key of [...this.graceTimers.keys()]) {
      if (!liveKeys.has(key)) this.clearGrace(key);
    }

    let uncovered = 0;
    if (active) {
      for (const frame of subframes) {
        const key = frameKey(frame);
        const ids = frameIds(frame);
        if (!key || !ids) continue;
        const node = frameNode(frame);
        const inFlight = node != null && this.navigating.has(node);
        if (!inFlight && (this.alive.has(key) || this.injected.has(key))) continue;
        uncovered += 1;
        // In flight: the document we would cover is about to be replaced, so
        // wait for the commit (which restarts the grace) and keep the gate up.
        if (inFlight || this.injecting.has(key) || this.graceTimers.has(key)) continue;
        if (node != null && this.preloadLess.has(node)) void this.inject(frame, key);
        else this.startGrace(key, ids.processId, ids.routingId);
      }
    }

    const now = Date.now();
    const settling = now < this.settleUntil;

    // LIVENESS. setTimeout can fire up to a millisecond EARLY (libuv rounds to
    // ms), so the settle timer's own callback can land here with the window not
    // quite expired. It has already cleared itself, and nothing else is
    // guaranteed to fire again: the tab would stay "pending" forever, iframes
    // hidden for the rest of the stream even though every subframe is covered.
    // That is not a leak (we fail closed), but it breaks the page. Re-arm for
    // the remainder whenever the verdict hangs on the window alone. Scheduling
    // an evaluation can never reveal anything early: only the seq echo and the
    // coverage count decide that.
    if (settling && !this.settleTimer) {
      const remaining = Math.max(1, this.settleUntil - now);
      this.settleTimer = setTimeout(() => {
        this.settleTimer = null;
        this.evaluateNow();
      }, remaining);
    }

    this.push(active && (uncovered > 0 || settling), all);
  }

  /** Push the tab-level verdict to every frame of the tab (deduped, per frame). */
  private push(pending: boolean, targets: WebFrameMain[]): void {
    const pushed = new Set<FrameKey>();
    for (const frame of targets) {
      const key = frameKey(frame);
      if (!key) continue;
      pushed.add(key);
      const status: FramesStatus = { pending, seq: this.gateSeq.get(key) ?? 0 };
      const signature = `${status.pending ? 1 : 0}:${status.seq}`;
      if (this.lastPush.get(key) === signature) continue;
      this.lastPush.set(key, signature);
      try {
        frame.send(IPC.STREAM_FRAMES_STATUS, status);
      } catch {
        // Frame gone, or preload-less (no listener): harmless. Coverage for
        // those frames comes from the injected fallback, never from this push.
      }
    }
    pruneTo(this.lastPush, pushed);
  }
}
