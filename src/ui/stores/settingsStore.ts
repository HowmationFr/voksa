import { create } from 'zustand';
import { DEFAULT_STREAM_CONFIG } from '../../shared/streamConfig';
import { DEFAULT_MEMORY_SAVER } from '../../shared/memorySaver';
import type { AppSettings } from '../../shared/types';
import { voksa } from '../lib/bridge';

const DEFAULTS: AppSettings = {
  searchEngine: 'google',
  theme: 'system',
  language: 'system',
  homepage: 'voksa://newtab',
  showBookmarkBar: true,
  streamMode: DEFAULT_STREAM_CONFIG,
  extensionOrder: [],
  sitePermissions: {},
  zoomLevels: {},
  memorySaver: DEFAULT_MEMORY_SAVER,
  memorySaverExceptions: [],
};

type SettingsState = {
  settings: AppSettings;
  setSettings: (s: AppSettings) => void;
  update: (patch: Partial<AppSettings>) => Promise<void>;
};

export const useSettingsStore = create<SettingsState>((set) => ({
  settings: DEFAULTS,
  setSettings: (settings) => set({ settings }),
  update: async (patch) => {
    const next = await voksa.settings.update(patch);
    set({ settings: next });
  },
}));

export function initSettingsBridge(): () => void {
  void voksa.settings.get().then((s) => useSettingsStore.getState().setSettings(s));
  const unsub = voksa.settings.onChanged((s) => useSettingsStore.getState().setSettings(s));
  return unsub;
}
