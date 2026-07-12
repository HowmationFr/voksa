import { useCallback } from 'react';
import { useTabsStore } from '../stores/tabsStore';
import { voksa } from './bridge';

/**
 * Navigate the tab the user is looking at. Internal pages live in the chrome
 * UI, not in the tab's webContents, so they have no browser history of their
 * own: moving between voksa:// pages is always an explicit navigate, never a
 * back/forward.
 */
export function useNavigateActiveTab(): (url: string) => void {
  const activeTabId = useTabsStore((s) => s.tabs.find((tab) => tab.isActive)?.id ?? null);
  return useCallback(
    (url: string) => {
      if (activeTabId) void voksa.tabs.navigate(activeTabId, url);
    },
    [activeTabId],
  );
}
