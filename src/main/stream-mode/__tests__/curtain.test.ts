import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebContentsView } from 'electron';
import { CurtainController, type OverlayController } from '../curtain';
import { IPC } from '../../../shared/ipcChannels';

// Keep in sync with the constants in curtain.ts.
const SAFETY_TIMEOUT_MS = 6000;
const UI_ACK_TIMEOUT_MS = 600;

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

  const chromeView = {
    webContents: {
      send: (channel: string, payload: SentMessage['payload']) => {
        sent.push({ channel, payload });
        if (autoAck && channel === IPC.CURTAIN_SET && payload.token != null) {
          controller.ackFromUi(payload.tabId, payload.token);
        }
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
  });

  describe('in-flight raise window (ack still pending)', () => {
    // These tests PIN THE CURRENT semantics of the window between
    // overlay.acquire() and the UI ack: records.get(tabId) is still undefined,
    // so every tab-scoped signal (ready, drop, tab-closed) silently no-ops and
    // the record only materializes once the ack lands. The overlay key
    // acquired at raise() is then held by that materialized record until a
    // LATER signal clears it, with the 6s safety timeout as the guaranteed
    // backstop: the key can be held up to 6s too long, but never leaks
    // permanently. If a change makes these signals apply during the window,
    // update these tests deliberately.

    /** Start a solid raise with auto-ack off; raise() runs synchronously up to
     * the ack await, so CURTAIN_SET is already in `sent` when this returns. */
    function startPendingRaise(h: ReturnType<typeof createHarness>, tabId: string) {
      h.setAutoAck(false);
      const pending = h.controller.raise(tabId, fakeTabView().view, 'solid');
      const token = h.messages(IPC.CURTAIN_SET)[0]?.payload.token;
      if (token == null) throw new Error('raise did not send CURTAIN_SET synchronously');
      return { pending, ack: () => h.controller.ackFromUi(tabId, token) };
    }

    it('a matching ready arriving during the window is lost: the curtain still materializes after the ack', async () => {
      const h = createHarness();
      const { pending, ack } = startPendingRaise(h, 'tab-1');
      expect(h.acquire).toHaveBeenCalledWith('curtain:tab-1');
      expect(h.isExpanded()).toBe(true);
      expect(h.controller.isActive('tab-1')).toBe(false); // no record yet

      // The doc pairing and its ready both land before the ack: both no-op
      // because there is no record to pair or to clear yet.
      h.controller.onDocStart('tab-1', 'doc-A');
      h.controller.onReady('tab-1', 'doc-A');
      expect(h.messages(IPC.CURTAIN_CLEAR)).toHaveLength(0);
      expect(h.release).not.toHaveBeenCalled();

      ack();
      await pending;

      // The early ready was dropped on the floor: the curtain comes up anyway
      // and stays up until its own lifecycle ends. No nonce was paired (the
      // doc-start no-oped too), so a re-sent ready would clear it; the path
      // guaranteed by the protocol is the 6s fail-to-blank safety timeout.
      expect(h.controller.isActive('tab-1')).toBe(true);
      expect(h.isExpanded()).toBe(true);

      vi.advanceTimersByTime(SAFETY_TIMEOUT_MS);
      expect(h.controller.isActive('tab-1')).toBe(false);
      expect(h.messages(IPC.CURTAIN_CLEAR)).toHaveLength(1);
      expect(h.release).toHaveBeenCalledTimes(1);
      expect(h.isExpanded()).toBe(false);
    });

    it('drop() during the window no-ops (no CURTAIN_CLEAR); the curtain materializes after the ack', async () => {
      const h = createHarness();
      const { pending, ack } = startPendingRaise(h, 'tab-1');

      // Force-drop (e.g. stream toggled off) during the in-flight window:
      // there is no record yet, so nothing is cleared and nothing is sent.
      h.controller.drop('tab-1');
      expect(h.messages(IPC.CURTAIN_CLEAR)).toHaveLength(0);
      expect(h.release).not.toHaveBeenCalled();
      expect(h.isExpanded()).toBe(true);

      ack();
      await pending;

      // The drop was lost: the curtain comes up anyway and the overlay key
      // stays held. A later drop/ready would clear it; the safety timeout is
      // the guaranteed backstop, so the key cannot leak forever.
      expect(h.controller.isActive('tab-1')).toBe(true);
      expect(h.isExpanded()).toBe(true);

      vi.advanceTimersByTime(SAFETY_TIMEOUT_MS);
      expect(h.controller.isActive('tab-1')).toBe(false);
      expect(h.messages(IPC.CURTAIN_CLEAR)).toHaveLength(1);
      expect(h.release).toHaveBeenCalledTimes(1);
      expect(h.isExpanded()).toBe(false);
    });

    it('handleTabClosed() during the window no-ops; the ghost curtain holds the key until the safety timeout', async () => {
      const h = createHarness();
      const { pending, ack } = startPendingRaise(h, 'tab-1');

      h.controller.handleTabClosed('tab-1');
      expect(h.messages(IPC.CURTAIN_CLEAR)).toHaveLength(0);
      expect(h.release).not.toHaveBeenCalled();

      ack();
      await pending;

      // A curtain record now exists for a tab that no longer does: the chrome
      // stays expanded for up to 6s, then the safety timeout releases the key
      // and sends a CURTAIN_CLEAR for the dead tab id. Held too long, but not
      // a permanent leak.
      expect(h.controller.isActive('tab-1')).toBe(true);
      expect(h.isExpanded()).toBe(true);

      vi.advanceTimersByTime(SAFETY_TIMEOUT_MS);
      expect(h.controller.isActive('tab-1')).toBe(false);
      expect(h.messages(IPC.CURTAIN_CLEAR).map((m) => m.payload.tabId)).toEqual(['tab-1']);
      expect(h.release).toHaveBeenCalledWith('curtain:tab-1');
      expect(h.isExpanded()).toBe(false);
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
});
