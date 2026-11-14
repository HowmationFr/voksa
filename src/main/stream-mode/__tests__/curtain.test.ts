import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebContentsView } from 'electron';
import { CurtainController, type OverlayController } from '../curtain';
import { IPC } from '../../../shared/ipcChannels';
import { PANIC_CURTAIN_ID } from '../../../shared/panicCurtain';

// Keep in sync with the constants in curtain.ts.
const SAFETY_TIMEOUT_MS = 6000;
const UI_ACK_TIMEOUT_MS = 600;
const CAPTURE_TIMEOUT_MS = 300;
const PANIC_RESEND_MS = 100;
const PANIC_MAX_RESENDS = 50;

type SentMessage = {
  channel: string;
  payload: { tabId: string; token?: number; backdrop?: string | null };
};

/**
 * Stand-ins for the two collaborators window.ts wires in: the chromeView
 * (receives CURTAIN_SET / CURTAIN_CLEAR and acks the backdrop paint) and the
 * overlay refcount. The fake overlay mirrors the real expandRequests Set in
 * window.ts (acquire adds the key, release deletes it, expanded iff the set is
 * non-empty) so tests can assert the acquire/release BALANCE, not just call
 * counts. By default the fake chrome UI acks the paint synchronously, like the
 * real UI does one frame later.
 */
function createHarness() {
  const sent: SentMessage[] = [];
  const expandRequests = new Set<string>();
  const acquire = vi.fn((key: string) => {
    expandRequests.add(key);
  });
  const release = vi.fn((key: string) => {
    expandRequests.delete(key);
  });
  const overlay: OverlayController = { acquire, release };
  let autoAck = true;

  const listeners = new Map<string, () => void>();
  const chromeView = {
    webContents: {
      send: (channel: string, payload: SentMessage['payload']) => {
        sent.push({ channel, payload });
        if (autoAck && channel === IPC.CURTAIN_SET && payload.token != null) {
          controller.ackFromUi(payload.tabId, payload.token);
        }
      },
      on: (event: string, listener: () => void) => {
        listeners.set(event, listener);
      },
    },
  } as unknown as WebContentsView;

  const controller = new CurtainController(chromeView, overlay);

  return {
    controller,
    sent,
    acquire,
    release,
    isExpanded: () => expandRequests.size > 0,
    setAutoAck: (v: boolean) => {
      autoAck = v;
    },
    /** The chrome UI document (re)loaded: a fresh page with an empty store. */
    finishUiLoad: () => listeners.get('did-finish-load')?.(),
    messages: (channel: string) => sent.filter((m) => m.channel === channel),
  };
}

/** A tab view whose capturePage can succeed, return an empty image, or throw. */
function fakeTabView(opts: { dataURL?: string; empty?: boolean; failCapture?: boolean } = {}) {
  const capturePage = vi.fn(() => {
    if (opts.failCapture) return Promise.reject(new Error('capture failed mid-navigation'));
    return Promise.resolve({
      isEmpty: () => opts.empty === true,
      toDataURL: () => opts.dataURL ?? 'data:image/png;base64,frame',
    });
  });
  const view = { webContents: { capturePage } } as unknown as WebContentsView;
  return { view, capturePage };
}

describe('CurtainController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('raise / drop protocol', () => {
    it('paints a screenshot backdrop in the chromeView and acquires the overlay key', async () => {
      const h = createHarness();
      const tab = fakeTabView({ dataURL: 'data:image/png;base64,masked-frame' });

      await h.controller.raise('tab-1', tab.view, 'screenshot');

      const sets = h.messages(IPC.CURTAIN_SET);
      expect(sets).toHaveLength(1);
      expect(sets[0].payload.tabId).toBe('tab-1');
      expect(sets[0].payload.backdrop).toBe('data:image/png;base64,masked-frame');
      expect(typeof sets[0].payload.token).toBe('number');
      expect(h.acquire).toHaveBeenCalledWith('curtain:tab-1');
      expect(h.release).not.toHaveBeenCalled();
      expect(h.controller.isActive('tab-1')).toBe(true);
      expect(h.isExpanded()).toBe(true);
    });

    it('a solid backdrop sends backdrop null and never touches the tab view', async () => {
      const h = createHarness();
      const tab = fakeTabView();

      await h.controller.raise('tab-1', tab.view, 'solid');

      expect(tab.capturePage).not.toHaveBeenCalled();
      expect(h.messages(IPC.CURTAIN_SET)[0].payload.backdrop).toBeNull();
      expect(h.controller.isActive('tab-1')).toBe(true);
    });

    it('falls back to a solid panel when capturePage fails or returns an empty image', async () => {
      for (const opts of [{ failCapture: true }, { empty: true }]) {
        const h = createHarness();
        await h.controller.raise('tab-1', fakeTabView(opts).view, 'screenshot');
        expect(h.messages(IPC.CURTAIN_SET)[0].payload.backdrop).toBeNull();
        expect(h.controller.isActive('tab-1')).toBe(true);
      }
    });

    it('drop clears the backdrop and releases the overlay key exactly once', async () => {
      const h = createHarness();
      await h.controller.raise('tab-1', fakeTabView().view, 'screenshot');

      h.controller.drop('tab-1');

      expect(h.messages(IPC.CURTAIN_CLEAR)).toEqual([
        { channel: IPC.CURTAIN_CLEAR, payload: { tabId: 'tab-1' } },
      ]);
      expect(h.release).toHaveBeenCalledTimes(1);
      expect(h.release).toHaveBeenCalledWith('curtain:tab-1');
      expect(h.controller.isActive('tab-1')).toBe(false);
      expect(h.isExpanded()).toBe(false);

      // A second drop (or one for an unknown tab) is a no-op.
      h.controller.drop('tab-1');
      h.controller.drop('never-raised');
      expect(h.messages(IPC.CURTAIN_CLEAR)).toHaveLength(1);
      expect(h.release).toHaveBeenCalledTimes(1);
    });

    it('resolves raise even if the UI never acks the paint (ack timeout)', async () => {
      const h = createHarness();
      h.setAutoAck(false);

      const pending = h.controller.raise('tab-1', fakeTabView().view, 'solid');
      await vi.advanceTimersByTimeAsync(UI_ACK_TIMEOUT_MS);
      await pending;

      expect(h.controller.isActive('tab-1')).toBe(true);
    });

    it('a screenshot that never settles cannot hold the navigation: solid panel after the bound', async () => {
      // capturePage has no timeout of its own; the caller's load waits on raise().
      const h = createHarness();
      const view = {
        webContents: { capturePage: vi.fn(() => new Promise(() => {})) },
      } as unknown as WebContentsView;
      let resolved = false;

      const pending = h.controller.raise('tab-1', view, 'screenshot').then(() => {
        resolved = true;
      });
      // The tab is curtained (and its fail-to-blank armed) while the capture runs.
      expect(h.controller.isActive('tab-1')).toBe(true);
      await vi.advanceTimersByTimeAsync(CAPTURE_TIMEOUT_MS);
      await pending;

      expect(resolved).toBe(true);
      expect(h.messages(IPC.CURTAIN_SET)[0].payload.backdrop).toBeNull();
      expect(h.isExpanded()).toBe(true);
    });

    it('a curtain dropped during the screenshot is never painted (no stale curtain)', async () => {
      const h = createHarness();
      let finishCapture!: (image: unknown) => void;
      const view = {
        webContents: {
          capturePage: vi.fn(
            () =>
              new Promise((resolve) => {
                finishCapture = resolve;
              }),
          ),
        },
      } as unknown as WebContentsView;

      const pending = h.controller.raise('tab-1', view, 'screenshot');
      // The new document became ready (or the tab closed) before the capture came back.
      h.controller.onReady('tab-1', null);
      finishCapture({ isEmpty: () => false, toDataURL: () => 'data:image/png;base64,late' });
      await pending;

      expect(h.messages(IPC.CURTAIN_SET)).toHaveLength(0);
      expect(h.controller.isActive('tab-1')).toBe(false);
      expect(h.isExpanded()).toBe(false);
    });
  });

  describe('in-flight raise window (ack still pending)', () => {
    // The record is registered SYNCHRONOUSLY at raise(), BEFORE the UI ack is
    // awaited: so every tab-scoped signal (ready, drop, tab-closed) that lands
    // during the window applies immediately instead of being lost. This is the
    // fix for the hung-curtain race: a drop() arriving in this window (panic
    // double-press, fast re-navigation) used to no-op and leave the curtain up
    // until the 6s fail-to-blank. If a change reverts the ordering, these
    // tests catch it.

    /** Start a solid raise with auto-ack off; raise() runs synchronously up to
     * the ack await, so CURTAIN_SET is already in `sent` when this returns. */
    function startPendingRaise(h: ReturnType<typeof createHarness>, tabId: string) {
      h.setAutoAck(false);
      const pending = h.controller.raise(tabId, fakeTabView().view, 'solid');
      const token = h.messages(IPC.CURTAIN_SET)[0]?.payload.token;
      if (token == null) throw new Error('raise did not send CURTAIN_SET synchronously');
      return { pending, ack: () => h.controller.ackFromUi(tabId, token) };
    }

    it('the record exists during the window: the tab is already active and keyed', async () => {
      const h = createHarness();
      const { pending, ack } = startPendingRaise(h, 'tab-1');
      expect(h.acquire).toHaveBeenCalledWith('curtain:tab-1');
      expect(h.isExpanded()).toBe(true);
      // The record is registered before the await, unlike the old behaviour.
      expect(h.controller.isActive('tab-1')).toBe(true);
      ack();
      await pending;
      expect(h.controller.isActive('tab-1')).toBe(true);
    });

    it('a matching ready arriving during the window drops the curtain', async () => {
      const h = createHarness();
      const { pending, ack } = startPendingRaise(h, 'tab-1');

      // The doc pairing and its ready both land before the ack, and both take
      // effect: the record is present to pair and to clear.
      h.controller.onDocStart('tab-1', 'doc-A');
      h.controller.onReady('tab-1', 'doc-A');
      expect(h.controller.isActive('tab-1')).toBe(false);
      expect(h.messages(IPC.CURTAIN_CLEAR)).toHaveLength(1);
      expect(h.release).toHaveBeenCalledWith('curtain:tab-1');
      expect(h.isExpanded()).toBe(false);

      // The ack still resolves raise() harmlessly; nothing re-materializes.
      ack();
      await pending;
      expect(h.controller.isActive('tab-1')).toBe(false);
      expect(h.messages(IPC.CURTAIN_CLEAR)).toHaveLength(1);
    });

    it('drop() during the window clears immediately (the hung-curtain race fix)', async () => {
      const h = createHarness();
      const { pending, ack } = startPendingRaise(h, 'tab-1');

      // Force-drop (panic double-press, stream toggled off) during the window:
      // the record is there, so it clears at once instead of hanging.
      h.controller.drop('tab-1');
      expect(h.messages(IPC.CURTAIN_CLEAR)).toHaveLength(1);
      expect(h.release).toHaveBeenCalledWith('curtain:tab-1');
      expect(h.isExpanded()).toBe(false);
      expect(h.controller.isActive('tab-1')).toBe(false);

      ack();
      await pending;
      // The curtain does NOT come back after the late ack.
      expect(h.controller.isActive('tab-1')).toBe(false);
      expect(h.messages(IPC.CURTAIN_CLEAR)).toHaveLength(1);
      expect(h.isExpanded()).toBe(false);
    });

    it('handleTabClosed() during the window releases the key immediately', async () => {
      const h = createHarness();
      const { pending, ack } = startPendingRaise(h, 'tab-1');

      h.controller.handleTabClosed('tab-1');
      expect(h.messages(IPC.CURTAIN_CLEAR).map((m) => m.payload.tabId)).toEqual(['tab-1']);
      expect(h.release).toHaveBeenCalledWith('curtain:tab-1');
      expect(h.isExpanded()).toBe(false);

      ack();
      await pending;
      expect(h.controller.isActive('tab-1')).toBe(false);
      expect(h.isExpanded()).toBe(false);
    });

    it('the safety timer set at raise() still fires when nothing else clears', async () => {
      const h = createHarness();
      const { pending, ack } = startPendingRaise(h, 'tab-1');
      ack();
      await pending;
      // No ready, no drop: the fail-to-blank backstop still holds.
      expect(h.controller.isActive('tab-1')).toBe(true);
      vi.advanceTimersByTime(SAFETY_TIMEOUT_MS);
      expect(h.controller.isActive('tab-1')).toBe(false);
      expect(h.messages(IPC.CURTAIN_CLEAR)).toHaveLength(1);
      expect(h.release).toHaveBeenCalledWith('curtain:tab-1');
    });
  });

  describe('doc-nonce pairing', () => {
    it('a ready with a STALE nonce must NOT drop the curtain; the matching one must', async () => {
      const h = createHarness();
      await h.controller.raise('tab-1', fakeTabView().view, 'screenshot');
      h.controller.onDocStart('tab-1', 'doc-new');

      // Late ready from the PREVIOUS document: the curtain stays up.
      h.controller.onReady('tab-1', 'doc-old');
      expect(h.controller.isActive('tab-1')).toBe(true);
      expect(h.messages(IPC.CURTAIN_CLEAR)).toHaveLength(0);
      expect(h.release).not.toHaveBeenCalled();

      // Ready from the document the curtain was raised for: drop.
      h.controller.onReady('tab-1', 'doc-new');
      expect(h.controller.isActive('tab-1')).toBe(false);
      expect(h.messages(IPC.CURTAIN_CLEAR)).toHaveLength(1);
      expect(h.release).toHaveBeenCalledWith('curtain:tab-1');
    });

    it('only the FIRST doc-start is paired; a later doc cannot re-pair the curtain', async () => {
      const h = createHarness();
      await h.controller.raise('tab-1', fakeTabView().view, 'solid');
      h.controller.onDocStart('tab-1', 'doc-A');
      h.controller.onDocStart('tab-1', 'doc-B');

      h.controller.onReady('tab-1', 'doc-B');
      expect(h.controller.isActive('tab-1')).toBe(true);

      h.controller.onReady('tab-1', 'doc-A');
      expect(h.controller.isActive('tab-1')).toBe(false);
    });

    it('an unpaired curtain (no doc-start yet) drops on any ready, incl. a null nonce', async () => {
      const h = createHarness();
      await h.controller.raise('tab-1', fakeTabView().view, 'solid');

      // Instant same-doc masking: no doc-start was ever paired.
      h.controller.onReady('tab-1', null);
      expect(h.controller.isActive('tab-1')).toBe(false);
    });

    it('a ready before any raise is a harmless no-op', () => {
      const h = createHarness();
      h.controller.onReady('tab-1', 'doc-A');
      expect(h.sent).toHaveLength(0);
      expect(h.release).not.toHaveBeenCalled();
    });
  });

  describe('safety timeout', () => {
    it('fails to blank at 6s: clears the backdrop and releases the key, never reveals', async () => {
      const h = createHarness();
      await h.controller.raise('tab-1', fakeTabView().view, 'screenshot');
      h.controller.onDocStart('tab-1', 'doc-A');

      vi.advanceTimersByTime(SAFETY_TIMEOUT_MS - 1);
      expect(h.controller.isActive('tab-1')).toBe(true);
      expect(h.messages(IPC.CURTAIN_CLEAR)).toHaveLength(0);

      vi.advanceTimersByTime(1);
      expect(h.controller.isActive('tab-1')).toBe(false);
      expect(h.messages(IPC.CURTAIN_CLEAR)).toEqual([
        { channel: IPC.CURTAIN_CLEAR, payload: { tabId: 'tab-1' } },
      ]);
      expect(h.release).toHaveBeenCalledTimes(1);
      expect(h.release).toHaveBeenCalledWith('curtain:tab-1');
      // The whole conversation is exactly one SET then one CLEAR: there is no
      // "reveal" message in the protocol, so the timeout can only blank (the
      // renderer shroud keeps the page hidden), never expose a frame.
      expect(h.sent.map((m) => m.channel)).toEqual([IPC.CURTAIN_SET, IPC.CURTAIN_CLEAR]);

      // A late ready for the timed-out document is a no-op (no double clear).
      h.controller.onReady('tab-1', 'doc-A');
      expect(h.sent).toHaveLength(2);
      expect(h.release).toHaveBeenCalledTimes(1);
    });

    it('re-raising resets the safety window: the old timer cannot kill the new curtain', async () => {
      const h = createHarness();
      const tab = fakeTabView();
      await h.controller.raise('tab-1', tab.view, 'solid');

      vi.advanceTimersByTime(3000);
      await h.controller.raise('tab-1', tab.view, 'solid');

      // The first curtain's 6s deadline passes: the replacement must survive.
      vi.advanceTimersByTime(3000);
      expect(h.controller.isActive('tab-1')).toBe(true);
      expect(h.messages(IPC.CURTAIN_CLEAR)).toHaveLength(0);

      // The replacement's own deadline still fires.
      vi.advanceTimersByTime(3000);
      expect(h.controller.isActive('tab-1')).toBe(false);
      expect(h.messages(IPC.CURTAIN_CLEAR)).toHaveLength(1);
      expect(h.release).toHaveBeenCalledTimes(1);
      // Two acquires for the same key + one release still end collapsed: this
      // pins the Set-backed semantics of window.ts expandRequests. A future
      // refcount implementation would break here (count would stay at 1) and
      // must rebalance raise/clear before landing.
      expect(h.isExpanded()).toBe(false);
    });
  });

  describe('drop-all (stream toggle-OFF path)', () => {
    it('dropping every tab (as TabManager does on config-changed) clears all curtains and keys', async () => {
      const h = createHarness();
      await h.controller.raise('tab-1', fakeTabView().view, 'screenshot');
      await h.controller.raise('tab-2', fakeTabView().view, 'solid');
      expect(h.controller.isActive('tab-1')).toBe(true);
      expect(h.controller.isActive('tab-2')).toBe(true);
      expect(h.isExpanded()).toBe(true);

      // TabManager loops over its tabs on toggle-OFF; a tab without a curtain
      // must be a safe no-op inside that loop.
      for (const id of ['tab-1', 'tab-2', 'tab-3']) h.controller.drop(id);

      expect(h.controller.isActive('tab-1')).toBe(false);
      expect(h.controller.isActive('tab-2')).toBe(false);
      expect(h.messages(IPC.CURTAIN_CLEAR).map((m) => m.payload.tabId)).toEqual([
        'tab-1',
        'tab-2',
      ]);
      expect(h.release).toHaveBeenCalledTimes(2);
      expect(h.release).toHaveBeenCalledWith('curtain:tab-1');
      expect(h.release).toHaveBeenCalledWith('curtain:tab-2');
      // Semantic balance: once every curtain is cleared, the chrome must be
      // collapsed again (no curtain key left in the expand set).
      expect(h.isExpanded()).toBe(false);
    });
  });

  describe('per-tab scoping', () => {
    it('a ready for tab X never drops tab Y', async () => {
      const h = createHarness();
      await h.controller.raise('tab-x', fakeTabView().view, 'screenshot');
      await h.controller.raise('tab-y', fakeTabView().view, 'screenshot');
      h.controller.onDocStart('tab-x', 'nonce-x');
      h.controller.onDocStart('tab-y', 'nonce-y');

      h.controller.onReady('tab-x', 'nonce-x');
      expect(h.controller.isActive('tab-x')).toBe(false);
      expect(h.controller.isActive('tab-y')).toBe(true);
      expect(h.messages(IPC.CURTAIN_CLEAR).map((m) => m.payload.tabId)).toEqual(['tab-x']);

      // X's nonce arriving under Y's tab id is stale for Y: still up.
      h.controller.onReady('tab-y', 'nonce-x');
      expect(h.controller.isActive('tab-y')).toBe(true);

      h.controller.onReady('tab-y', 'nonce-y');
      expect(h.controller.isActive('tab-y')).toBe(false);
    });

    it('closing a curtained tab releases its overlay key (chrome cannot stay expanded)', async () => {
      const h = createHarness();
      await h.controller.raise('tab-1', fakeTabView().view, 'solid');

      h.controller.handleTabClosed('tab-1');

      expect(h.controller.isActive('tab-1')).toBe(false);
      expect(h.release).toHaveBeenCalledWith('curtain:tab-1');
    });
  });

  // The panic cover is NOT a navigation curtain. A navigation curtain is
  // cosmetic and built to lift by itself (ready, failed load, 6s fail-to-blank)
  // because a renderer shroud holds the page behind it. Panic covers pages that
  // are already painted, with no shroud: every one of those exits would put
  // the very thing the user panicked about back on screen. Lived: panic used
  // to raise ordinary curtains, which dropped after 6s with Stream Mode on,
  // and within milliseconds when panic itself armed it (the arming sweep sends
  // a ready).
  describe('panic cover', () => {
    const panicSets = (h: ReturnType<typeof createHarness>) =>
      h.messages(IPC.CURTAIN_SET).filter((m) => m.payload.tabId === PANIC_CURTAIN_ID);
    const panicClears = (h: ReturnType<typeof createHarness>) =>
      h.messages(IPC.CURTAIN_CLEAR).filter((m) => m.payload.tabId === PANIC_CURTAIN_ID);

    it('covers the window with a solid panel and expands the chrome over the page', () => {
      const h = createHarness();

      h.controller.setPanic(true);

      expect(h.controller.isPanic()).toBe(true);
      expect(panicSets(h)).toHaveLength(1);
      // Solid, never a screenshot: the current frame is what must disappear.
      expect(panicSets(h)[0].payload.backdrop).toBeNull();
      expect(h.isExpanded()).toBe(true);
    });

    it('no timer ever lifts it', () => {
      const h = createHarness();
      h.controller.setPanic(true);

      vi.advanceTimersByTime(SAFETY_TIMEOUT_MS * 20);

      expect(h.controller.isPanic()).toBe(true);
      expect(panicClears(h)).toHaveLength(0);
      expect(h.isExpanded()).toBe(true);
    });

    it('a ready from a tab lifts nothing (panic arming Stream Mode makes every tab send one)', () => {
      const h = createHarness();
      h.controller.setPanic(true);

      h.controller.onDocStart('tab-1', 'nonce-1');
      h.controller.onReady('tab-1', 'nonce-1');
      h.controller.onReady('tab-2', null);

      expect(h.controller.isPanic()).toBe(true);
      expect(panicClears(h)).toHaveLength(0);
      expect(h.isExpanded()).toBe(true);
    });

    it('survives everything that lifts a navigation curtain raised under it', async () => {
      const h = createHarness();
      h.controller.setPanic(true);
      await h.controller.raise('tab-1', fakeTabView().view, 'screenshot');
      await h.controller.raise('tab-2', fakeTabView().view, 'solid');
      await h.controller.raise('tab-3', fakeTabView().view, 'solid');

      h.controller.onReady('tab-1', null); // masker ready
      h.controller.drop('tab-2'); // failed load, crash, stream toggled off
      h.controller.handleTabClosed('tab-3'); // tab closed
      vi.advanceTimersByTime(SAFETY_TIMEOUT_MS + 1); // and the fail-to-blank timer

      for (const id of ['tab-1', 'tab-2', 'tab-3']) expect(h.controller.isActive(id)).toBe(false);
      expect(h.controller.isPanic()).toBe(true);
      expect(panicClears(h)).toHaveLength(0);
      // The navigation keys are all released; the panic key alone keeps the
      // chrome expanded.
      expect(h.isExpanded()).toBe(true);
    });

    it('lifts only when panic is released, once, and gives the overlay back', () => {
      const h = createHarness();
      h.controller.setPanic(true);
      h.controller.setPanic(true); // a second press of "cover" is not a second cover

      h.controller.setPanic(false);
      h.controller.setPanic(false);

      expect(h.controller.isPanic()).toBe(false);
      expect(panicSets(h)).toHaveLength(1);
      expect(panicClears(h)).toHaveLength(1);
      expect(h.isExpanded()).toBe(false);
    });

    it('releasing panic leaves a navigation curtain that is still up alone', async () => {
      const h = createHarness();
      await h.controller.raise('tab-1', fakeTabView().view, 'solid');
      h.controller.setPanic(true);

      h.controller.setPanic(false);

      expect(h.controller.isActive('tab-1')).toBe(true);
      expect(h.isExpanded()).toBe(true);
      h.controller.onReady('tab-1', null);
      expect(h.isExpanded()).toBe(false);
    });

    it('is sent again until the chrome UI acknowledges it (a UI still booting has no listener)', () => {
      const h = createHarness();
      h.setAutoAck(false);

      h.controller.setPanic(true);
      vi.advanceTimersByTime(PANIC_RESEND_MS * 3);

      const sets = panicSets(h);
      expect(sets.length).toBe(4);
      // Same token every time: it is one cover, repeated, not four.
      expect(new Set(sets.map((m) => m.payload.token)).size).toBe(1);

      h.controller.ackFromUi(PANIC_CURTAIN_ID, sets[0].payload.token!);
      vi.advanceTimersByTime(PANIC_RESEND_MS * 5);
      expect(panicSets(h)).toHaveLength(4);
      expect(h.controller.isPanic()).toBe(true);
    });

    it('an ack for another cover does not stop the resend', () => {
      const h = createHarness();
      h.setAutoAck(false);
      h.controller.setPanic(true);

      h.controller.ackFromUi(PANIC_CURTAIN_ID, 999_999);
      vi.advanceTimersByTime(PANIC_RESEND_MS);

      expect(panicSets(h)).toHaveLength(2);
    });

    it('gives up repeating after 5s, and the cover stays up all the same', () => {
      // A minimized window cannot acknowledge (the ack rides on a frame) but
      // already holds the cover in its state: repeating forever is pointless.
      const h = createHarness();
      h.setAutoAck(false);
      h.controller.setPanic(true);

      vi.advanceTimersByTime(PANIC_RESEND_MS * PANIC_MAX_RESENDS * 4);

      expect(panicSets(h)).toHaveLength(1 + PANIC_MAX_RESENDS);
      expect(h.controller.isPanic()).toBe(true);
      expect(panicClears(h)).toHaveLength(0);
      expect(h.isExpanded()).toBe(true);
    });

    it('a new panic repeats afresh after an earlier one gave up', () => {
      const h = createHarness();
      h.setAutoAck(false);
      h.controller.setPanic(true);
      vi.advanceTimersByTime(PANIC_RESEND_MS * PANIC_MAX_RESENDS * 2);
      h.controller.setPanic(false);
      const before = panicSets(h).length;

      h.controller.setPanic(true);
      vi.advanceTimersByTime(PANIC_RESEND_MS * 3);

      expect(panicSets(h).length - before).toBe(4);
    });

    it('stops resending the moment panic is released', () => {
      const h = createHarness();
      h.setAutoAck(false);
      h.controller.setPanic(true);

      h.controller.setPanic(false);
      vi.advanceTimersByTime(PANIC_RESEND_MS * 5);

      expect(panicSets(h)).toHaveLength(1);
      expect(panicClears(h)).toHaveLength(1);
    });

    // A navigation curtain's screenshot is the frame of the page being left.
    // Under panic that frame is exactly what must not be seen, and the
    // backdrop would be what shows the moment panic is released.
    describe('no screenshot backdrop may outlive it', () => {
      const tabSets = (h: ReturnType<typeof createHarness>, tabId: string) =>
        h.messages(IPC.CURTAIN_SET).filter((m) => m.payload.tabId === tabId);

      it('a navigation curtain raised under panic is solid, and takes no screenshot', async () => {
        const h = createHarness();
        const tab = fakeTabView({ dataURL: 'data:image/png;base64,the-panicked-about-frame' });
        h.controller.setPanic(true);

        await h.controller.raise('tab-1', tab.view, 'screenshot');

        expect(tab.capturePage).not.toHaveBeenCalled();
        expect(tabSets(h, 'tab-1').map((m) => m.payload.backdrop)).toEqual([null]);
      });

      it('a screenshot still being taken when panic starts is thrown away', async () => {
        const h = createHarness();
        const tab = fakeTabView({ dataURL: 'data:image/png;base64,the-panicked-about-frame' });

        const raising = h.controller.raise('tab-1', tab.view, 'screenshot');
        h.controller.setPanic(true);
        await raising;

        expect(tab.capturePage).toHaveBeenCalledTimes(1);
        expect(tabSets(h, 'tab-1').every((m) => m.payload.backdrop === null)).toBe(true);
      });

      it('a screenshot curtain already painted is turned solid when panic starts', async () => {
        const h = createHarness();
        const tab = fakeTabView({ dataURL: 'data:image/png;base64,the-panicked-about-frame' });
        await h.controller.raise('tab-1', tab.view, 'screenshot');
        const painted = tabSets(h, 'tab-1');
        expect(painted[0].payload.backdrop).toBe('data:image/png;base64,the-panicked-about-frame');

        h.controller.setPanic(true);

        const after = tabSets(h, 'tab-1');
        expect(after).toHaveLength(2);
        expect(after[1].payload.backdrop).toBeNull();
        // The same curtain, repainted: its token (and so its ready/clear
        // pairing) is untouched.
        expect(after[1].payload.token).toBe(painted[0].payload.token);
        expect(h.controller.isActive('tab-1')).toBe(true);
      });
    });

    describe('a chrome UI that reloads under panic', () => {
      it('gets the cover again: its store came back empty', () => {
        const h = createHarness();
        h.controller.setPanic(true);
        expect(panicSets(h)).toHaveLength(1);

        h.finishUiLoad();

        expect(panicSets(h)).toHaveLength(2);
        expect(h.controller.isPanic()).toBe(true);
      });

      it('gets a fresh repeat budget, even after the first one ran out', () => {
        const h = createHarness();
        h.setAutoAck(false);
        h.controller.setPanic(true);
        vi.advanceTimersByTime(PANIC_RESEND_MS * PANIC_MAX_RESENDS * 2);
        const spent = panicSets(h).length;

        h.finishUiLoad();
        vi.advanceTimersByTime(PANIC_RESEND_MS * 3);

        expect(panicSets(h).length - spent).toBe(4);
      });

      it('gets nothing when panic is not up', () => {
        const h = createHarness();

        h.finishUiLoad();
        h.controller.setPanic(true);
        h.controller.setPanic(false);
        h.finishUiLoad();

        expect(panicSets(h)).toHaveLength(1);
      });
    });
  });
});
