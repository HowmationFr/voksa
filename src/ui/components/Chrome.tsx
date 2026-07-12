import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { TabBar } from './TabBar/TabBar';
import { Toolbar } from './Toolbar';
import { BookmarkBar } from './BookmarkBar/BookmarkBar';
import { Menu } from './Menu/Menu';
import { FindBar } from './FindBar';
import { InternalPage, type Slug } from './pages/InternalPage';
import { ErrorPage } from './pages/ErrorPage';
import { PageContextMenu } from './PageContextMenu';
import { PrintDialog } from './PrintDialog';
import { PermissionPrompt } from './PermissionPrompt';
import type { PageMenuPayload } from '../../shared/types';
import { ConfirmDialogHost } from './ui/ConfirmDialog';
import { voksa } from '../lib/bridge';
import { useSettingsStore } from '../stores/settingsStore';
import { useTabsStore } from '../stores/tabsStore';
import { useStreamStore } from '../stores/streamStore';
import { useCurtainStore } from '../stores/curtainStore';
import { buildStreamColorCss } from '../../shared/streamColor';

function internalSlugForUrl(url: string): Slug | null {
  if (!url.startsWith('voksa://')) return null;
  const slug = url.slice('voksa://'.length).replace(/\/+$/, '');
  if (slug === '' || slug === 'newtab') return 'newtab';
  if (slug === 'history') return 'history';
  if (slug === 'bookmarks') return 'bookmarks';
  if (slug === 'settings') return 'settings';
  if (slug === 'stream') return 'stream';
  if (slug === 'downloads') return 'downloads';
  if (slug === 'extensions') return 'extensions';
  if (slug === 'credits') return 'credits';
  return 'newtab';
}

export function Chrome(): React.ReactElement {
  const toolbarRef = useRef<HTMLDivElement>(null);
  const showBookmarkBar = useSettingsStore((s) => s.settings.showBookmarkBar);
  const [menuOpen, setMenuOpen] = useState(false);
  const [bookmarkOverlayCount, setBookmarkOverlayCount] = useState(0);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [siteSettingsOpen, setSiteSettingsOpen] = useState(false);
  const [permissionOpen, setPermissionOpen] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [focusAddressSignal, setFocusAddressSignal] = useState(0);
  const [bookmarkSignal, setBookmarkSignal] = useState(0);
  const [pageMenu, setPageMenu] = useState<PageMenuPayload | null>(null);
  const [printTabId, setPrintTabId] = useState<string | null>(null);

  const activeTab = useTabsStore((s) => s.tabs.find((t) => t.isActive) ?? null);
  // Menu commands arrive on a listener registered once; read the active tab
  // through a ref so 'print' targets the CURRENT tab, not a stale closure.
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;
  const streamEnabled = useStreamStore((s) => s.config.enabled);
  const streamColor = useStreamStore((s) => s.config.color);
  // User-picked Stream Mode accent: overrides the --stream* tokens of
  // globals.css for the whole chrome document. Null (default color or invalid
  // value) keeps the hand-tuned default palette untouched. Rendered later in
  // document order than the bundled stylesheet, so its :root/:root.dark
  // blocks win in their respective themes.
  const streamColorCss = useMemo(() => buildStreamColorCss(streamColor), [streamColor]);
  const curtain = useCurtainStore((s) =>
    activeTab ? (s.curtains.get(activeTab.id) ?? null) : null,
  );

  const internalSlug = useMemo(
    () => (activeTab ? internalSlugForUrl(activeTab.url) : null),
    [activeTab?.url],
  );
  const activeError = activeTab?.error ?? null;

  const anyOverlayOpen =
    menuOpen ||
    bookmarkOverlayCount > 0 ||
    suggestionsOpen ||
    siteSettingsOpen ||
    permissionOpen ||
    pageMenu !== null ||
    printTabId !== null;
  const chromeExpanded = anyOverlayOpen || internalSlug !== null || activeError !== null;

  useEffect(() => {
    void voksa.tabs.setOverlayMode(chromeExpanded);
  }, [chromeExpanded]);

  // Menu → renderer command bus (single source of truth = menu accelerators).
  useEffect(() => {
    return voksa.menu.onCommand((command) => {
      if (command === 'find') setFindOpen(true);
      else if (command === 'focus-address') setFocusAddressSignal((n) => n + 1);
      else if (command === 'bookmark-current') setBookmarkSignal((n) => n + 1);
      else if (command === 'print') {
        const tab = activeTabRef.current;
        if (tab && !tab.isInternal) setPrintTabId(tab.id);
      }
    });
  }, []);

  // Page right-click menu, pushed by the main process with the click params.
  useEffect(() => {
    return voksa.pageMenu.onShow(setPageMenu);
  }, []);
  // Escape lands on the PAGE webContents (keyboard focus never moves to the
  // chrome UI on right-click), so main relays it as an explicit close push.
  useEffect(() => {
    return voksa.pageMenu.onClose(() => setPageMenu(null));
  }, []);
  // A stale menu / print preview must not survive a tab switch or navigation.
  useEffect(() => {
    setPageMenu(null);
  }, [activeTab?.id, activeTab?.url]);
  useEffect(() => {
    setPrintTabId(null);
  }, [activeTab?.id]);

  useLayoutEffect(() => {
    const el = toolbarRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const h = el.getBoundingClientRect().height;
      void voksa.tabs.setChromeBounds({ top: Math.ceil(h), bottom: 0, left: 0, right: 0 });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [showBookmarkBar, findOpen]);

  const curtainVisible = curtain !== null;

  return (
    <div className="relative flex flex-col h-screen w-screen">
      {streamColorCss !== null && <style>{streamColorCss}</style>}
      {/* Stream Mode active indicator: a single accent bar across the very top
          of the window, so the state is unmistakable at a glance while live.
          Deliberately NOT a full-perimeter ring: framing the whole window read
          as a UI border rather than a status signal. */}
      {streamEnabled && (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-20 h-[3px] bg-gradient-to-r from-stream/70 via-stream to-stream/70" />
      )}
      <div ref={toolbarRef} className="flex-shrink-0 bg-bg border-b border-border">
        <TabBar />
        <Toolbar
          onOpenMenu={() => setMenuOpen(true)}
          onSuggestionsVisibleChange={setSuggestionsOpen}
          onSiteSettingsOpenChange={setSiteSettingsOpen}
          focusSignal={focusAddressSignal}
          bookmarkSignal={bookmarkSignal}
        />
        {showBookmarkBar && <BookmarkBar onOverlayCountChange={setBookmarkOverlayCount} />}
        <FindBar open={findOpen} onClose={() => setFindOpen(false)} />
      </div>

      <div className="flex-1 min-h-0 relative">
        {curtainVisible && (
          <div data-testid="curtain" className="absolute inset-0">
            {curtain?.backdrop ? (
              <img
                src={curtain.backdrop}
                alt=""
                draggable={false}
                className="absolute inset-0 w-full h-full object-cover object-top pointer-events-none select-none"
              />
            ) : (
              <div className="absolute inset-0 bg-bg pointer-events-none" />
            )}
          </div>
        )}
        {!curtainVisible && activeError && activeTab && (
          <div className="absolute inset-0 bg-bg">
            <ErrorPage error={activeError} tabId={activeTab.id} />
          </div>
        )}
        {!curtainVisible && !activeError && internalSlug && (
          <div className="absolute inset-0 overflow-y-auto bg-bg">
            <InternalPage slug={internalSlug} />
          </div>
        )}
        {!internalSlug && !curtainVisible && !activeError && anyOverlayOpen && (
          <div className="absolute inset-0 bg-black/30 animate-fade-in pointer-events-none" />
        )}
      </div>

      {menuOpen && (
        <Menu
          onClose={() => setMenuOpen(false)}
          onOpenFind={() => setFindOpen(true)}
          onOpenPrint={() => {
            const tab = activeTabRef.current;
            if (tab && !tab.isInternal) setPrintTabId(tab.id);
          }}
        />
      )}
      {/* Keyed by token: a second PAGE_MENU_SHOW while open (keyboard menu
          key) must remount, not update in place; otherwise flyout state
          survives with anchors from the previous menu position. */}
      {pageMenu && (
        <PageContextMenu key={pageMenu.token} payload={pageMenu} onClose={() => setPageMenu(null)} />
      )}
      {printTabId && <PrintDialog tabId={printTabId} onClose={() => setPrintTabId(null)} />}
      <PermissionPrompt onOpenChange={setPermissionOpen} />
      <ConfirmDialogHost />
    </div>
  );
}
