/**
 * Capture Handshake: Voksa's own screen-share picker, wired so that sharing a
 * Voksa surface arms Stream Mode and masks the FIRST shared frame.
 *
 * When a page (Meet, Zoom web, Discord web) calls getDisplayMedia, Chromium
 * would normally show its picker and hand the stream straight over. Since
 * Electron 45 every screen/window/tab capture request first reaches
 * setPermissionRequestHandler as 'display-capture': getDisplayMedia AND the
 * legacy getUserMedia({chromeMediaSource}) path, with identical details. On the
 * legacy path that grant IS the capture, of a source the page chose (the whole
 * desktop when it names none), with no later hook. So the picker runs at
 * PERMISSION time (gatePermission), for every web-content requester, in both
 * stream states: we enumerate the sources, show our own picker in the chrome
 * UI (cancel = deny), and on selection:
 *   - if the chosen source contains a Voksa surface, arm Stream Mode and WAIT
 *     for the active tab's masker to signal ready BEFORE granting, so the very
 *     first frame the far side receives is masked;
 *   - otherwise (an external app window, a screen with no Voksa on it) grant
 *     immediately;
 *   - the pick is bound to the requester (a ticket), then granted. For
 *     getDisplayMedia our setDisplayMediaRequestHandler (useSystemPicker:
 *     false) runs INSIDE that grant and delivers exactly the ticket's source:
 *     one dialog in total;
 *   - if it did not run, the grant went to the legacy path: fail toward
 *     protection (kill the requesting renderer before the stream reaches it,
 *     arm Stream Mode).
 *
 * Two hard rules:
 *   - Source THUMBNAILS are screenshots taken before any masking; a Voksa
 *     thumbnail can show a raw email. Those are withheld from the picker
 *     (shared/captureHandshake.ts thumbnailIsSafe): a neutral tile stands in.
 *   - Everything fails toward PROTECTION. If we cannot prove a shared window is
 *     NOT ours, or source enumeration is uncertain, we arm and wait rather
 *     than deliver raw.
 *
 * The trusted chrome UI is granted ungated by the permission handler; a
 * getDisplayMedia of its own keeps the in-handler picker (handleRequest).
 *
 * Limitation (documented): this only covers captures INITIATED inside Voksa.
 * A desktop OBS / Zoom app grabbing the screen is on the recorderWatcher path
 * (poll → auto Stream Mode), not this one.
 */
import { randomUUID } from 'node:crypto';
import {
  BaseWindow,
  desktopCapturer,
  screen,
  session,
  webContents,
  type WebContents,
} from 'electron';
import { IPC } from '../../shared/ipcChannels';
import {
  grantAndClassify,
  sourceKind,
  thumbnailIsSafe,
  ticketMatches,
  windowHandleFromSourceId,
  type CaptureTicket,
  type PickerSource,
} from '../../shared/captureHandshake';
import {
  allWindows,
  focusedWindow,
  isChromeViewContents,
  windowFromChrome,
  windowFromPageContents,
} from '../windows';
import type { AppWindow } from '../window';
import type { DisplayCaptureRequest } from './permissions';
import { getStreamMode } from './StreamModeController';

const THUMB = { width: 320, height: 180 };
/** Bounded so a wedged masker never hangs a capture request forever;
 * failing to ready in time still grants, but only AFTER the stream is armed
 * (the sweep is synchronous on the config push, so this is a backstop). */
const MASKER_READY_TIMEOUT_MS = 1500;
/** Long enough for a human to pick; a capture request the user ignores is
 * denied rather than left pending. */
const PICKER_TIMEOUT_MS = 60_000;
/** Source enumeration can fail OR hang on some Linux setups (headless X11
 * without a working capturer, Wayland without an xdg portal): bounded, so the
 * picker still appears (empty) instead of the page waiting forever. */
const GET_SOURCES_TIMEOUT_MS = 5_000;
/** The legacy path needs no user gesture: a page re-asking in a loop after the
 * user said no is refused without a picker from this many cancels on, until
 * it navigates. */
const MAX_CANCELS_BEFORE_BLOCK = 3;

type PendingPick = {
  resolve: (sourceId: string | null) => void;
  windowId: number;
};

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

class CaptureHandshakeController {
  private pendingPicks = new Map<string, PendingPick>();
  private readyWaiters = new Map<number, () => void>();
  /** Picks bound to a requester, alive only for the duration of its grant. */
  private tickets = new Map<number, CaptureTicket>();
  /** Set only while a gated grant(true) runs (synchronous, so never shared). */
  private probe: { ran: boolean } | null = null;
  /** Windows with a picker being prepared or shown (reserved before enumeration). */
  private busyWindows = new Set<number>();
  /** Consecutive cancels per requester, and requesters refused until they navigate. */
  private cancels = new Map<number, number>();
  private blocked = new Set<number>();

  install(): void {
    session.defaultSession.setDisplayMediaRequestHandler(
      (request, callback) => {
        // getDisplayMedia lands here synchronously INSIDE gatePermission's
        // grant: this is how the gate tells it from the legacy path.
        if (this.probe) this.probe.ran = true;
        // request.frame is a WebFrameMain; map it to its webContents so the
        // window registry can route the picker. fromFrame is the supported
        // bridge (a raw cast would not resolve in windowFromPageContents).
        let requester: WebContents | null = null;
        try {
          requester = request.frame ? (webContents.fromFrame(request.frame) ?? null) : null;
        } catch {
          requester = null;
        }
        // Web content only gets here through gatePermission, which holds a
        // ticket for exactly this requester during the grant: deliver the
        // user's pick, nothing else, with no second dialog.
        const ticket = requester ? this.tickets.get(requester.id) : undefined;
        if (ticketMatches(ticket, requester?.id ?? null, request.securityOrigin)) {
          ticket.consumed = true;
          callback({ video: { id: ticket.sourceId, name: ticket.name } });
          return;
        }
        // No ticket: only the trusted chrome UI (granted ungated) may pick
        // here. Anything else did not go through the gate: fail closed.
        if (!requester || !isChromeViewContents(requester)) {
          callback(null);
          return;
        }
        void this.handleRequest(requester, callback);
      },
      { useSystemPicker: false },
    );
  }

  /**
   * Permission-time gate for 'display-capture' (permissions.ts, wired in
   * handlers.ts). Calls `grant` exactly once.
   */
  async gatePermission(
    requester: WebContents,
    req: DisplayCaptureRequest,
    grant: (allowed: boolean) => void,
  ): Promise<void> {
    const refuse = (why: string) => {
      console.log(`[capture] screen capture refused: ${why}`);
      grant(false);
    };
    if (requester.isDestroyed()) return refuse('the requester is gone');
    // Only a surface the user is looking at may raise the picker: the legacy
    // path needs neither user activation nor focus, so without this a
    // background tab could pop a consent dialog at will. A focused surface no
    // window owns (a popup opened by a popup, an extension's
    // chrome.windows.create popup) gets the focused window's picker.
    const owner = windowFromPageContents(requester);
    const win = owner ?? (requester.isFocused() ? focusedWindow() : null);
    if (!win) return refuse('no window owns the requester');
    if (owner && !this.isForeground(owner, requester)) {
      return refuse('requester not in the foreground');
    }
    // One picker per window, never replaced (a second request would swap the
    // dialog the user is answering). Reserved before the (up to 5 s)
    // enumeration, so two concurrent requests cannot both get through.
    if (this.isBusy(win)) return refuse('a picker is already open in this window');
    if (this.blocked.has(requester.id)) return refuse('cancelled too often, until the page navigates');
    this.busyWindows.add(win.window.id);
    let chosen: PickerSource | null;
    try {
      // A popup that asked sits in front of the window whose chrome UI hosts
      // the picker: bring that window up, or the dialog opens unseen.
      if (win.tabs.getActive()?.view?.webContents !== requester) win.window.focus();
      chosen = await this.pickSource(win, req.origin);
    } finally {
      this.busyWindows.delete(win.window.id);
    }
    if (!chosen) {
      // Cancelled or timed out: deny cleanly, no stream.
      this.noteCancel(requester);
      grant(false);
      return;
    }
    this.cancels.delete(requester.id);
    // The guarantee, moved BEFORE the grant: the legacy path starts capturing
    // inside grant(true), so the masking must already be in place.
    if (chosen.containsVoksa) await this.armAndWait(win);
    // A document that left during the picker would have its getDisplayMedia
    // grant dropped by Electron without the handler running, which reads as
    // the legacy path (and would kill whatever the tab shows now): deny.
    if (requester.isDestroyed() || !this.stillRequesting(requester, req)) {
      return refuse('the requesting page navigated away');
    }

    this.tickets.set(requester.id, {
      requesterId: requester.id,
      securityOrigin: req.securityOrigin,
      sourceId: chosen.id,
      name: chosen.name,
      consumed: false,
    });
    const ticket = this.tickets.get(requester.id);
    const probe = { ran: false };
    this.probe = probe;
    let path: ReturnType<typeof grantAndClassify>;
    try {
      path = grantAndClassify(grant, () => probe.ran);
    } finally {
      // Single use: a ticket never outlives its grant (no replay by a later
      // getDisplayMedia from the same tab).
      this.probe = null;
      this.tickets.delete(requester.id);
    }
    if (path === 'legacy-getusermedia') {
      const killed = this.blockLegacyCapture(requester, req);
      console.log(
        killed > 0
          ? '[capture] legacy getUserMedia screen capture blocked: renderer killed'
          : '[capture] legacy getUserMedia screen capture blocked: renderer already gone',
      );
    } else {
      console.log(
        ticket?.consumed
          ? '[capture] getDisplayMedia received the picked source'
          : '[capture] getDisplayMedia refused: no matching pick',
      );
    }
  }

  /**
   * Debug-only seam (smoke test): drives the chrome-UI handler path
   * (enumerate -> picker -> arm -> wait -> deliver) from a known requester,
   * and resolves with the delivered source id (or null on cancel). The web
   * path (gatePermission) is driven for real through getDisplayMedia. Never
   * wired in production (handlers.ts gates it on VOKSA_DEBUG_PORT).
   */
  simulateRequest(requester: WebContents | null): Promise<string | null> {
    return new Promise((resolve) => {
      void this.handleRequest(requester, (streams) => {
        const video = streams?.video;
        resolve(video && 'id' in video ? video.id : null);
      });
    });
  }

  /**
   * The chrome UI answered our picker (source id, or null = cancelled). Only
   * the chrome UI the picker was sent to may answer it: the pick is the
   * consent now.
   */
  resolvePick(pickId: string, sourceId: string | null, sender: WebContents): void {
    const pending = this.pendingPicks.get(pickId);
    if (!pending) return;
    if (windowFromChrome(sender)?.window.id !== pending.windowId) return;
    this.pendingPicks.delete(pickId);
    pending.resolve(sourceId);
  }

  /** A tab's masker finished its sweep (routed from the STREAM_READY handler). */
  notifyMaskerReady(windowId: number): void {
    const waiter = this.readyWaiters.get(windowId);
    if (waiter) {
      this.readyWaiters.delete(windowId);
      waiter();
    }
  }

  /** Chrome-UI getDisplayMedia (trusted, granted ungated): picker in the handler. */
  private async handleRequest(
    requester: WebContents | null,
    callback: (streams: Electron.Streams | null) => void,
  ): Promise<void> {
    // Route the picker to the window that owns the requesting surface, then
    // the focused one, then the only live window (single-window is the common
    // case, and a request with a live window but no OS focus, e.g. under
    // automation, must still get its picker rather than be denied).
    const live = allWindows();
    const win =
      (requester && (windowFromChrome(requester) ?? windowFromPageContents(requester))) ??
      focusedWindow() ??
      (live.length === 1 ? live[0] : null);
    if (!win || this.isBusy(win)) {
      callback(null);
      return;
    }
    this.busyWindows.add(win.window.id);
    let chosen: PickerSource | null;
    try {
      chosen = await this.pickSource(win, '');
    } finally {
      this.busyWindows.delete(win.window.id);
    }
    if (!chosen) {
      // Cancelled: deny cleanly, no stream (null, not {}: Electron throws on
      // a video request answered without a video stream).
      callback(null);
      return;
    }
    // The guarantee: a Voksa surface is only delivered once it is masked.
    if (chosen.containsVoksa) await this.armAndWait(win);
    callback({ video: { id: chosen.id, name: chosen.name } });
  }

  /**
   * The requester is what the user is looking at: the active tab of a window
   * that is on screen, or a focused popup.
   */
  private isForeground(win: AppWindow, requester: WebContents): boolean {
    try {
      const shown = win.window.isVisible() && !win.window.isMinimized();
      return (shown && win.tabs.getActive()?.view?.webContents === requester) || requester.isFocused();
    } catch {
      return false;
    }
  }

  private isBusy(win: AppWindow): boolean {
    if (this.busyWindows.has(win.window.id)) return true;
    for (const pending of this.pendingPicks.values()) {
      if (pending.windowId === win.window.id) return true;
    }
    return false;
  }

  /** Count a cancel; from MAX_CANCELS_BEFORE_BLOCK on, refuse until the page navigates. */
  private noteCancel(requester: WebContents): void {
    const id = requester.id;
    if (!this.cancels.has(id)) {
      const reset = () => {
        this.cancels.delete(id);
        this.blocked.delete(id);
      };
      requester.once('did-navigate', reset);
      requester.once('destroyed', reset);
    }
    const n = (this.cancels.get(id) ?? 0) + 1;
    this.cancels.set(id, n);
    if (n >= MAX_CANCELS_BEFORE_BLOCK) this.blocked.add(id);
  }

  /** The document that asked is still the one shown (main frame, or a subframe of the tab). */
  private stillRequesting(requester: WebContents, req: DisplayCaptureRequest): boolean {
    try {
      if (req.isMainFrame) {
        return req.origin ? originOf(requester.getURL()) === req.origin : requester.getURL() === req.requestingUrl;
      }
      return requester.mainFrame.framesInSubtree.some(
        (f) => f.url === req.requestingUrl || (!!req.origin && originOf(f.url) === req.origin),
      );
    } catch {
      return false;
    }
  }

  /** Enumerate, classify, show OUR picker: the chosen source, or null. */
  private async pickSource(win: AppWindow, origin: string): Promise<PickerSource | null> {
    // Enumeration failure is NOT a silent deny: the picker still opens, empty,
    // so the user sees why sharing has nothing to offer (headless X11, Wayland
    // without portal) instead of the page surfacing a bare NotAllowedError.
    // Cancelling it takes the normal clean-deny path.
    const sources = await this.listSources();

    const voksaHandles = this.voksaWindowHandles();
    const voksaDisplayIds = this.voksaDisplayIds();
    // Read once: the picker itself is on screen, hence on stream when live.
    const streaming = getStreamMode().isEnabled();
    const picker: PickerSource[] = sources.map((s) => {
      const kind = sourceKind(s.id);
      const containsVoksa = this.sourceContainsVoksa(s, kind, voksaHandles, voksaDisplayIds);
      let thumbnail: string | null = null;
      if (thumbnailIsSafe(containsVoksa, streaming)) {
        try {
          thumbnail = s.thumbnail.isEmpty() ? null : s.thumbnail.toDataURL();
        } catch {
          thumbnail = null;
        }
      }
      return { id: s.id, name: s.name, kind, thumbnail, containsVoksa };
    });

    const sourceId = await this.promptPicker(win, picker, origin);
    if (!sourceId) return null;
    // Only an id we offered: the picker answer cannot smuggle another source.
    return picker.find((p) => p.id === sourceId) ?? null;
  }

  private async armAndWait(win: AppWindow): Promise<void> {
    const streamWasOn = getStreamMode().isEnabled();
    if (!streamWasOn) getStreamMode().update({ enabled: true });
    await this.waitForMaskerReady(win, streamWasOn);
  }

  /**
   * The gated grant went to getUserMedia({chromeMediaSource}) (no display-media
   * handler ran): the page is capturing a source IT chose, not the user's
   * pick, and nothing downstream can stop it. No web site depends on this
   * Electron-only path (Chrome rejects it without an extension-issued stream
   * id), so end it: SIGKILL the renderer process(es) that asked, in the same
   * task as the grant so the stream never reaches them, then arm Stream Mode.
   * Not forcefullyCrashRenderer: it skips contents without a view, spares an
   * out-of-process iframe requester, and is asynchronous on Linux.
   * gatePermission denies first when the requesting document already left
   * (Electron would drop a getDisplayMedia grant then, without the handler
   * running); a same-origin navigation in that window is the one false
   * positive left, accepted. Returns how many processes were signalled.
   */
  private blockLegacyCapture(requester: WebContents, req: DisplayCaptureRequest): number {
    let killed = 0;
    const pids = new Set<number>();
    try {
      pids.add(requester.getOSProcessId());
      if (!req.isMainFrame) {
        for (const frame of requester.mainFrame.framesInSubtree) {
          if (frame.url === req.requestingUrl || originOf(frame.url) === req.origin) {
            pids.add(frame.osProcessId);
          }
        }
      }
    } catch {
      // contents or frame tree already gone: nothing left to capture into
    }
    for (const pid of pids) {
      if (pid <= 0 || pid === process.pid) continue;
      try {
        process.kill(pid, 'SIGKILL');
        killed += 1;
      } catch {
        // already dead
      }
    }
    if (!getStreamMode().isEnabled()) getStreamMode().update({ enabled: true });
    return killed;
  }

  /**
   * Bounded, throw-proof source enumeration. Verified failure mode on a
   * headless Linux runner: screen_capturer_x11 cannot initialize its pixel
   * buffer and getSources never yields a usable list; without the bound the
   * page's capture request would hang with no picker and no error.
   */
  private async listSources(): Promise<Electron.DesktopCapturerSource[]> {
    try {
      return await Promise.race([
        desktopCapturer.getSources({
          types: ['screen', 'window'],
          thumbnailSize: THUMB,
          fetchWindowIcons: false,
        }),
        new Promise<Electron.DesktopCapturerSource[]>((resolve) => {
          setTimeout(() => resolve([]), GET_SOURCES_TIMEOUT_MS);
        }),
      ]);
    } catch {
      return [];
    }
  }

  /**
   * Show the picker in the window's chrome UI and await the selection.
   * `origin` names who is asking ('' for the chrome UI itself): the picker is
   * the consent, so it must say to whom.
   */
  private promptPicker(
    win: AppWindow,
    sources: PickerSource[],
    origin: string,
  ): Promise<string | null> {
    return new Promise((resolve) => {
      const pickId = randomUUID();
      let settled = false;
      const done = (sourceId: string | null) => {
        if (settled) return;
        settled = true;
        this.pendingPicks.delete(pickId);
        clearTimeout(timer);
        resolve(sourceId);
      };
      const timer = setTimeout(() => done(null), PICKER_TIMEOUT_MS);
      this.pendingPicks.set(pickId, { resolve: done, windowId: win.window.id });
      try {
        win.chromeView.webContents.send(IPC.CAPTURE_PICKER_SHOW, { pickId, sources, origin });
      } catch {
        done(null);
      }
    });
  }

  /**
   * Wait until the window's active tab reports its masker swept under the new
   * config. When the stream was ALREADY on, the visible content is already
   * masked and there is nothing to wait for. Bounded: the sweep is
   * synchronous on the config push, so the timeout is a backstop, never the
   * normal path, and even on timeout the stream is already armed.
   */
  private waitForMaskerReady(win: AppWindow, streamWasOn: boolean): Promise<void> {
    if (streamWasOn) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        this.readyWaiters.delete(win.window.id);
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, MASKER_READY_TIMEOUT_MS);
      this.readyWaiters.set(win.window.id, finish);
    });
  }

  /**
   * Every Voksa window, not only the registered browser windows: managed
   * popups, extension popups and DevTools are Voksa surfaces too
   * (BaseWindow.getAllWindows covers them all).
   */
  private voksaWindows(): BaseWindow[] {
    try {
      return BaseWindow.getAllWindows().filter((w) => !w.isDestroyed());
    } catch {
      return allWindows().map((w) => w.window);
    }
  }

  private voksaWindowHandles(): Set<string> {
    const handles = new Set<string>();
    for (const win of this.voksaWindows()) {
      try {
        // getMediaSourceId is desktopCapturer's own id format on every
        // platform ('window:<id>:0'). The native handle is not: on macOS it
        // is an NSView*, never the CGWindowID capture sources carry, so a
        // Voksa window was never recognized there.
        const handle = windowHandleFromSourceId(win.getMediaSourceId());
        if (handle) handles.add(handle);
      } catch {
        // a window with no readable id simply cannot be matched by handle
      }
    }
    return handles;
  }

  private voksaDisplayIds(): Set<string> {
    const ids = new Set<string>();
    for (const win of this.voksaWindows()) {
      try {
        const display = screen.getDisplayMatching(win.getBounds());
        ids.add(String(display.id));
      } catch {
        // no display match: handled by the conservative screen default below
      }
    }
    return ids;
  }

  private sourceContainsVoksa(
    source: Electron.DesktopCapturerSource,
    kind: ReturnType<typeof sourceKind>,
    voksaHandles: Set<string>,
    voksaDisplayIds: Set<string>,
  ): boolean {
    if (kind === 'screen') {
      // A screen shows whatever is on it. Arm when a Voksa window is on THIS
      // display; when the display can't be matched (empty set), fail toward
      // protection and treat every screen as possibly showing Voksa.
      if (voksaDisplayIds.size === 0) return true;
      return source.display_id ? voksaDisplayIds.has(String(source.display_id)) : true;
    }
    // Window source: arm only when its native handle matches one of ours.
    // A handle we cannot parse is a window we cannot prove is external, so we
    // fail toward protection and arm.
    const handle = windowHandleFromSourceId(source.id);
    if (handle === null) return true;
    return voksaHandles.has(handle);
  }
}

let instance: CaptureHandshakeController | null = null;

export function getCaptureHandshake(): CaptureHandshakeController {
  if (!instance) instance = new CaptureHandshakeController();
  return instance;
}
