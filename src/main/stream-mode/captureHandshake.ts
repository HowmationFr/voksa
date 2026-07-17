/**
 * Capture Handshake: Voksa's own screen-share picker, wired so that sharing a
 * Voksa surface arms Stream Mode and masks the FIRST shared frame.
 *
 * When a page (Meet, Zoom web, Discord web) calls getDisplayMedia, Chromium
 * would normally show its picker and hand the stream straight over. We install
 * setDisplayMediaRequestHandler (useSystemPicker: false) so the request comes
 * to US instead: we enumerate the sources, show our own picker in the chrome
 * UI, and on selection:
 *   - if the chosen source contains a Voksa surface, arm Stream Mode and WAIT
 *     for the active tab's masker to signal ready before delivering the
 *     stream, so the very first frame the far side receives is masked;
 *   - otherwise (an external app window, a screen with no Voksa on it) deliver
 *     immediately.
 *
 * Two hard rules:
 *   - Source THUMBNAILS are screenshots taken before any masking; a Voksa
 *     thumbnail can show a raw email. Those are withheld from the picker
 *     (shared/captureHandshake.ts thumbnailIsSafe): a neutral tile stands in.
 *   - Everything fails toward PROTECTION. If we cannot prove a shared window is
 *     NOT ours, or source enumeration is uncertain, we arm and wait rather
 *     than deliver raw.
 *
 * Limitation (documented): this only covers captures INITIATED inside Voksa
 * via getDisplayMedia. A desktop OBS / Zoom app grabbing the screen is on the
 * recorderWatcher path (poll → auto Stream Mode), not this one.
 */
import { desktopCapturer, screen, session, webContents, type WebContents } from 'electron';
import { IPC } from '../../shared/ipcChannels';
import {
  sourceKind,
  thumbnailIsSafe,
  windowHandleFromSourceId,
  type PickerSource,
} from '../../shared/captureHandshake';
import { allWindows, focusedWindow, windowFromPageContents } from '../windows';
import type { AppWindow } from '../window';
import { getStreamMode } from './StreamModeController';

const THUMB = { width: 320, height: 180 };
/** Bounded so a wedged masker never hangs a getDisplayMedia call forever;
 * failing to ready in time still delivers, but only AFTER the stream is armed
 * (the sweep is synchronous on the config push, so this is a backstop). */
const MASKER_READY_TIMEOUT_MS = 1500;
/** Long enough for a human to pick; a getDisplayMedia call the user ignores
 * is cancelled rather than left pending. */
const PICKER_TIMEOUT_MS = 60_000;

type PendingPick = {
  resolve: (sourceId: string | null) => void;
  windowId: number;
};

class CaptureHandshakeController {
  private pendingPicks = new Map<string, PendingPick>();
  private readyWaiters = new Map<number, () => void>();
  private nextId = 1;

  install(): void {
    session.defaultSession.setDisplayMediaRequestHandler(
      (request, callback) => {
        // request.frame is a WebFrameMain; map it to its webContents so the
        // window registry can route the picker. fromFrame is the supported
        // bridge (a raw cast would not resolve in windowFromPageContents).
        let requester: WebContents | null = null;
        try {
          requester = request.frame ? (webContents.fromFrame(request.frame) ?? null) : null;
        } catch {
          requester = null;
        }
        void this.handleRequest(requester, callback);
      },
      { useSystemPicker: false },
    );
  }

  /**
   * Debug-only seam (smoke test). getDisplayMedia does not route to a
   * setDisplayMediaRequestHandler under CDP automation in this Electron build,
   * so the E2E cannot enter through the real Chromium edge. This drives the
   * exact same controller path (enumerate -> picker -> arm -> wait -> deliver)
   * from a known requester, and resolves with the delivered source id (or
   * null on cancel). Never wired in production (handlers.ts gates it on
   * VOKSA_DEBUG_PORT).
   */
  simulateRequest(requester: WebContents | null): Promise<string | null> {
    return new Promise((resolve) => {
      this.handleRequest(requester, (streams) => {
        const video = streams.video;
        resolve(video && 'id' in video ? video.id : null);
      });
    });
  }

  /** The chrome UI answered our picker (source id, or null = cancelled). */
  resolvePick(pickId: string, sourceId: string | null): void {
    const pending = this.pendingPicks.get(pickId);
    if (pending) {
      this.pendingPicks.delete(pickId);
      pending.resolve(sourceId);
    }
  }

  /** A tab's masker finished its sweep (routed from the STREAM_READY handler). */
  notifyMaskerReady(windowId: number): void {
    const waiter = this.readyWaiters.get(windowId);
    if (waiter) {
      this.readyWaiters.delete(windowId);
      waiter();
    }
  }

  private async handleRequest(
    requester: WebContents | null,
    callback: (streams: Electron.Streams) => void,
  ): Promise<void> {
    // Route the picker to the window that owns the requesting page, then the
    // focused one, then the only live window (single-window is the common
    // case, and a getDisplayMedia with a live window but no OS focus, e.g.
    // under automation, must still get its picker rather than be denied).
    const live = allWindows();
    const win =
      (requester && windowFromPageContents(requester)) ??
      focusedWindow() ??
      (live.length === 1 ? live[0] : null);
    if (!win) {
      callback({});
      return;
    }

    let sources: Electron.DesktopCapturerSource[];
    try {
      sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: THUMB,
        fetchWindowIcons: false,
      });
    } catch {
      callback({});
      return;
    }

    const voksaHandles = this.voksaWindowHandles();
    const voksaDisplayIds = this.voksaDisplayIds();
    const picker: PickerSource[] = sources.map((s) => {
      const kind = sourceKind(s.id);
      const containsVoksa = this.sourceContainsVoksa(s, kind, voksaHandles, voksaDisplayIds);
      let thumbnail: string | null = null;
      if (thumbnailIsSafe(containsVoksa)) {
        try {
          thumbnail = s.thumbnail.isEmpty() ? null : s.thumbnail.toDataURL();
        } catch {
          thumbnail = null;
        }
      }
      return { id: s.id, name: s.name, kind, thumbnail, containsVoksa };
    });

    const sourceId = await this.promptPicker(win, picker);
    if (!sourceId) {
      callback({}); // cancelled: deny cleanly, no stream
      return;
    }
    const chosen = picker.find((p) => p.id === sourceId);
    if (!chosen) {
      callback({});
      return;
    }

    // The guarantee: a Voksa surface is only delivered once it is masked.
    if (chosen.containsVoksa) {
      const streamWasOn = getStreamMode().isEnabled();
      if (!streamWasOn) getStreamMode().update({ enabled: true });
      await this.waitForMaskerReady(win, streamWasOn);
    }

    callback({ video: { id: sourceId, name: chosen.name } });
  }

  /** Show the picker in the window's chrome UI and await the selection. */
  private promptPicker(win: AppWindow, sources: PickerSource[]): Promise<string | null> {
    return new Promise((resolve) => {
      const pickId = `pick-${this.nextId++}`;
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
        win.chromeView.webContents.send(IPC.CAPTURE_PICKER_SHOW, { pickId, sources });
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

  private voksaWindowHandles(): Set<string> {
    const handles = new Set<string>();
    for (const win of allWindows()) {
      try {
        const buf = win.window.getNativeWindowHandle();
        // The buffer holds the native handle little-endian (HWND on Windows,
        // XID on Linux). Read the low 32 bits: window ids fit there on every
        // platform we ship, and it matches desktopCapturer's decimal handle.
        if (buf.length >= 4) handles.add(String(buf.readUInt32LE(0)));
      } catch {
        // a window with no readable handle simply cannot be matched by handle
      }
    }
    return handles;
  }

  private voksaDisplayIds(): Set<string> {
    const ids = new Set<string>();
    for (const win of allWindows()) {
      try {
        const display = screen.getDisplayMatching(win.window.getBounds());
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
