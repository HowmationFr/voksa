import { create } from 'zustand';
import { DEFAULT_STREAM_CONFIG, type StreamModeConfig } from '../../shared/streamConfig';
import { voksa } from '../lib/bridge';

type StreamState = {
  config: StreamModeConfig;
  setConfig: (c: StreamModeConfig) => void;
  toggle: () => Promise<void>;
  update: (patch: Partial<StreamModeConfig>) => Promise<void>;
};

export const useStreamStore = create<StreamState>((set) => ({
  config: DEFAULT_STREAM_CONFIG,
  setConfig: (config) => set({ config }),
  toggle: async () => {
    const next = await voksa.stream.toggle();
    set({ config: next });
  },
  update: async (patch) => {
    const next = await voksa.stream.update(patch);
    set({ config: next });
  },
}));

export function initStreamBridge(): () => void {
  void voksa.stream.get().then((cfg) => useStreamStore.getState().setConfig(cfg));
  const unsub = voksa.stream.onChanged((cfg) => useStreamStore.getState().setConfig(cfg));
  return unsub;
}
