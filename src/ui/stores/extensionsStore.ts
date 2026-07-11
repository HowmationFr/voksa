import { create } from 'zustand';
import type { ExtensionInfo } from '../../shared/types';
import { voksa } from '../lib/bridge';

type ExtensionsState = {
  extensions: ExtensionInfo[];
  setExtensions: (list: ExtensionInfo[]) => void;
};

export const useExtensionsStore = create<ExtensionsState>((set) => ({
  extensions: [],
  setExtensions: (extensions) => set({ extensions }),
}));

export function initExtensionsBridge(): () => void {
  void voksa.extensions.list().then((list) => useExtensionsStore.getState().setExtensions(list));
  const unsub = voksa.extensions.onChanged((list) =>
    useExtensionsStore.getState().setExtensions(list),
  );
  return unsub;
}
