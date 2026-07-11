import { create } from 'zustand';
import { voksa } from '../lib/bridge';

type CurtainEntry = { token: number; backdrop: string | null };

type CurtainState = {
  curtains: Map<string, CurtainEntry>;
  setCurtain: (tabId: string, token: number, backdrop: string | null) => void;
  clearCurtain: (tabId: string) => void;
};

export const useCurtainStore = create<CurtainState>((set) => ({
  curtains: new Map(),
  setCurtain: (tabId, token, backdrop) =>
    set((s) => {
      const next = new Map(s.curtains);
      next.set(tabId, { token, backdrop });
      return { curtains: next };
    }),
  clearCurtain: (tabId) =>
    set((s) => {
      if (!s.curtains.has(tabId)) return s;
      const next = new Map(s.curtains);
      next.delete(tabId);
      return { curtains: next };
    }),
}));

/**
 * Wire the per-tab curtain backdrop channel. On set, we decode the screenshot
 * BEFORE committing state + acking, then wait two animation frames, so main
 * only proceeds once the backdrop has actually hit the compositor (kills the
 * decode-race flash).
 */
export function initCurtainBridge(): () => void {
  const offSet = voksa.curtain.onSet(async ({ tabId, token, backdrop }) => {
    if (backdrop) {
      try {
        const img = new Image();
        img.src = backdrop;
        await img.decode();
      } catch {
        // decode can reject for tiny/blank images; proceed anyway
      }
    }
    useCurtainStore.getState().setCurtain(tabId, token, backdrop);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => voksa.curtain.ack(tabId, token));
    });
  });
  const offClear = voksa.curtain.onClear(({ tabId }) => {
    useCurtainStore.getState().clearCurtain(tabId);
  });
  return () => {
    offSet();
    offClear();
  };
}
