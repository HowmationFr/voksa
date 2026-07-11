import { create } from 'zustand';
import type { TabState } from '../../shared/types';
import { voksa } from '../lib/bridge';

type TabsState = {
  tabs: TabState[];
  setTabs: (tabs: TabState[]) => void;
  getActive: () => TabState | null;
};

export const useTabsStore = create<TabsState>((set, get) => ({
  tabs: [],
  setTabs: (tabs) => set({ tabs }),
  getActive: () => get().tabs.find((t) => t.isActive) ?? null,
}));

export function initTabsBridge(): () => void {
  void voksa.tabs.list().then((tabs) => useTabsStore.getState().setTabs(tabs));
  const unsub = voksa.tabs.onUpdate((tabs) => useTabsStore.getState().setTabs(tabs));
  return unsub;
}
