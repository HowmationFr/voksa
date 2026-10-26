import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow, WebFrameMain } from 'electron';
import { DEFAULT_STREAM_CONFIG, type StreamModeConfig } from '../../../shared/streamConfig';

// A stand-in for the stream controller singleton: the gate only reads the
// config and listens to 'config-changed'.
const stream = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter: Emitter } = require('node:events') as typeof import('node:events');
  const emitter = new Emitter() as InstanceType<typeof Emitter> & {
    config: StreamModeConfig | null;
    getConfig(): StreamModeConfig;
    set(patch: Partial<StreamModeConfig>): void;
  };
  emitter.config = null;
  emitter.getConfig = () => ({ ...emitter.config! });
  emitter.set = (patch) => {
    emitter.config = { ...emitter.config!, ...patch };
    emitter.emit('config-changed', emitter.getConfig());
  };
  return emitter;
});
vi.mock('../StreamModeController', () => ({ getStreamMode: () => stream }));

import { ExtensionPopupGate } from '../extensionPopupGate';

type FakeFrame = { processId: number; frameToken: string; parent: unknown; isDestroyed: () => boolean };

function frame(token: string, parent: unknown = null): FakeFrame {
  return { processId: 7, frameToken: token, parent, isDestroyed: () => false };
}

/**
 * The slice of a BrowserWindow the gate touches. `show` is the native method
 * the gate wraps; `bypassShow()` makes the window visible WITHOUT going
 * through show(), like a library that switched to showInactive() would.
 */
function fakePopup() {
  const winEvents = new EventEmitter();
  const wcEvents = new EventEmitter();
  const state = { visible: false, destroyed: false, mainFrame: frame('doc-1') };
  const nativeShow = vi.fn(() => {
    state.visible = true;
    winEvents.emit('show');
  });
  const destroy = vi.fn(() => {
    if (state.destroyed) return;
    state.destroyed = true;
    state.visible = false;
    wcEvents.emit('destroyed');
  });
  const win = {
    show: nativeShow,
    isVisible: () => state.visible,
    isDestroyed: () => state.destroyed,
    destroy,
    on: (e: string, h: (...a: unknown[]) => void) => winEvents.on(e, h),
    off: (e: string, h: (...a: unknown[]) => void) => winEvents.off(e, h),
    webContents: {
      get mainFrame() {
        return state.mainFrame;
      },
      on: (e: string, h: (...a: unknown[]) => void) => wcEvents.on(e, h),
      off: (e: string, h: (...a: unknown[]) => void) => wcEvents.off(e, h),
      once: (e: string, h: (...a: unknown[]) => void) => wcEvents.once(e, h),
    },
  };
  return {
    win: win as unknown as BrowserWindow,
    nativeShow,
    destroy,
    state,
    /** The library's call: browserWindow.show(). */
    libraryShow: () => (win as unknown as BrowserWindow).show(),
    bypassShow: () => {
      state.visible = true;
      winEvents.emit('show');
    },
    /** A cross-document navigation of the main frame, committing `token`. */
    navigate: (token: string, sameDocument = false) => {
      wcEvents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: sameDocument });
      if (!sameDocument) state.mainFrame = frame(token);
    },
  };
}

const asFrame = (f: FakeFrame) => f as unknown as WebFrameMain;

beforeEach(() => {
  stream.removeAllListeners();
  stream.config = { ...DEFAULT_STREAM_CONFIG, enabled: false };
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('ExtensionPopupGate: stream OFF', () => {
  it("lets the library's show() straight through", () => {
    const p = fakePopup();
    new ExtensionPopupGate(p.win);
    p.libraryShow();
    expect(p.nativeShow).toHaveBeenCalledTimes(1);
    expect(p.destroy).not.toHaveBeenCalled();
  });
});

describe('ExtensionPopupGate: stream ON', () => {
  beforeEach(() => {
    stream.config = { ...DEFAULT_STREAM_CONFIG, enabled: true };
  });

  it('holds show() until the MAIN frame announced the page preload', () => {
    const p = fakePopup();
    const gate = new ExtensionPopupGate(p.win);
    p.libraryShow();
    expect(p.nativeShow).not.toHaveBeenCalled();
    // A subframe proves nothing about the document on screen.
    gate.onFrameAlive(asFrame(frame('sub-1', p.state.mainFrame)));
    expect(p.nativeShow).not.toHaveBeenCalled();
    gate.onFrameAlive(asFrame(p.state.mainFrame));
    expect(p.nativeShow).toHaveBeenCalledTimes(1);
    expect(p.destroy).not.toHaveBeenCalled();
  });

  it('shows at once when the proof arrived before the library asked', () => {
    const p = fakePopup();
    const gate = new ExtensionPopupGate(p.win);
    gate.onFrameAlive(asFrame(p.state.mainFrame));
    p.libraryShow();
    expect(p.nativeShow).toHaveBeenCalledTimes(1);
  });

  it('never lets a proof vouch for the next document, even on a reused frame token', () => {
    const p = fakePopup();
    const gate = new ExtensionPopupGate(p.win);
    gate.onFrameAlive(asFrame(p.state.mainFrame));
    p.navigate('doc-1'); // same token, new document
    p.libraryShow();
    expect(p.nativeShow).not.toHaveBeenCalled();
    p.navigate('doc-2');
    gate.onFrameAlive(asFrame(p.state.mainFrame));
    expect(p.nativeShow).toHaveBeenCalledTimes(1);
  });

  it('keeps the proof across a same-document navigation', () => {
    const p = fakePopup();
    const gate = new ExtensionPopupGate(p.win);
    gate.onFrameAlive(asFrame(p.state.mainFrame));
    p.navigate('doc-1', true);
    p.libraryShow();
    expect(p.nativeShow).toHaveBeenCalledTimes(1);
  });

  it('destroys a popup that became visible through a path that bypassed show()', () => {
    const p = fakePopup();
    new ExtensionPopupGate(p.win);
    p.bypassShow();
    expect(p.destroy).toHaveBeenCalledTimes(1);
  });

  it('leaves a proven popup alone when it shows through another path', () => {
    const p = fakePopup();
    const gate = new ExtensionPopupGate(p.win);
    gate.onFrameAlive(asFrame(p.state.mainFrame));
    p.bypassShow();
    expect(p.destroy).not.toHaveBeenCalled();
  });

  it('releases a held show when Stream Mode turns off', () => {
    const p = fakePopup();
    new ExtensionPopupGate(p.win);
    p.libraryShow();
    expect(p.nativeShow).not.toHaveBeenCalled();
    stream.set({ enabled: false });
    expect(p.nativeShow).toHaveBeenCalledTimes(1);
  });
});

describe('ExtensionPopupGate: Stream Mode turning ON over a visible popup', () => {
  it('destroys it when its document never proved the page preload', () => {
    const p = fakePopup();
    new ExtensionPopupGate(p.win);
    p.libraryShow();
    expect(p.state.visible).toBe(true);
    stream.set({ enabled: true });
    expect(p.destroy).toHaveBeenCalledTimes(1);
  });

  it('keeps it when its document runs the page preload (it re-masks itself)', () => {
    const p = fakePopup();
    const gate = new ExtensionPopupGate(p.win);
    gate.onFrameAlive(asFrame(p.state.mainFrame));
    p.libraryShow();
    stream.set({ enabled: true });
    expect(p.destroy).not.toHaveBeenCalled();
  });

  it('leaves it alone when Stream Mode turns on with every mask off', () => {
    const p = fakePopup();
    new ExtensionPopupGate(p.win);
    p.libraryShow();
    // Enabled but with every mask off: nothing would be masked anyway, so the
    // popup is not a leak by Stream Mode's own definition.
    stream.set({
      enabled: true,
      maskIPv4: false,
      maskIPv6: false,
      maskEmails: false,
      maskPhones: false,
      maskMacAddresses: false,
      maskInternalHostnames: false,
      customMasks: [],
    });
    expect(p.destroy).not.toHaveBeenCalled();
  });
});

describe('ExtensionPopupGate: lifecycle', () => {
  it('unsubscribes from the stream controller and reports disposal when the popup dies', () => {
    const p = fakePopup();
    const onDisposed = vi.fn();
    new ExtensionPopupGate(p.win, onDisposed);
    expect(stream.listenerCount('config-changed')).toBe(1);
    p.win.destroy();
    expect(stream.listenerCount('config-changed')).toBe(0);
    expect(onDisposed).toHaveBeenCalledTimes(1);
  });
});
