import React, { useEffect } from 'react';
import { Chrome } from './components/Chrome';
import { initTabsBridge } from './stores/tabsStore';
import { initStreamBridge } from './stores/streamStore';
import { initSettingsBridge } from './stores/settingsStore';
import { initExtensionsBridge } from './stores/extensionsStore';
import { initCurtainBridge } from './stores/curtainStore';
import { useThemeSync } from './lib/theme';

export function App(): React.ReactElement {
  useThemeSync();

  useEffect(() => {
    const unsubA = initStreamBridge();
    const unsubB = initSettingsBridge();
    const unsubC = initTabsBridge();
    const unsubD = initExtensionsBridge();
    const unsubE = initCurtainBridge();
    return () => {
      unsubA();
      unsubB();
      unsubC();
      unsubD();
      unsubE();
    };
  }, []);

  // Single renderer: the Chrome component owns everything: tabs toolbar,
  // address bar, bookmark bar, and the internal pages (new tab / history /
  // bookmarks / settings) when the active tab points at one of them.
  // Internal pages no longer live in tab WebContentsViews, so there is no
  // more "standalone internal page" rendering path.
  return <Chrome />;
}
