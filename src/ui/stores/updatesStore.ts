import { create } from 'zustand';
import type { UpdateState } from '../../shared/types';
import { voksa } from '../lib/bridge';

/**
 * Auto-update state, shared by the three surfaces that show it: the toolbar
 * dot on the burger button, the menu entry, and the settings About card.
 * Main broadcasts UPDATES_STATE_CHANGED to every window, so each window's
 * store converges on its own.
 */
type UpdatesState = {
  state: UpdateState | null;
  setState: (s: UpdateState) => void;
  check: () => Promise<void>;
  install: () => Promise<void>;
};

export const useUpdatesStore = create<UpdatesState>((set) => ({
  state: null,
  setState: (state) => set({ state }),
  check: async () => {
    const next = await voksa.updates.check();
    set({ state: next });
  },
  install: async () => {
    await voksa.updates.install();
  },
}));

export function initUpdatesBridge(): () => void {
  void voksa.updates.getState().then((s) => useUpdatesStore.getState().setState(s));
  return voksa.updates.onChanged((s) => useUpdatesStore.getState().setState(s));
}

/** The update finished downloading and is waiting for a restart. */
export function useUpdateReady(): boolean {
  return useUpdatesStore((s) => s.state?.phase === 'ready');
}
