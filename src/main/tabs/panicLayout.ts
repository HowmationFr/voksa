/**
 * The two layout decisions the panic cover takes part in, kept pure (no
 * electron import) so they are unit-tested: TabManager itself needs a live
 * Electron to run.
 */
export type LayoutState = {
  /** The tab in front, if any. */
  activeTabId: string | null;
  /** The tab whose PAGE is in HTML fullscreen (a video), if any. */
  fullscreenTabId: string | null;
  /** The panic cover is up. */
  panic: boolean;
};

/**
 * Should the window use the fullscreen layout (the tab fills it, the chrome
 * view is hidden)? Only for the tab that asked, only while it is in front,
 * and never under panic: the chrome view is what paints the cover.
 *
 * Tied to the TAB on purpose. A window-level flag outlives the tab that set it
 * (closed, or left by a click on another one), and would then hide the chrome
 * over a page that never asked for fullscreen, with no Escape to get out.
 */
export function fullscreenLayoutActive(state: LayoutState): boolean {
  return !state.panic && state.fullscreenTabId !== null && state.fullscreenTabId === state.activeTabId;
}

/**
 * Is this tab's view laid out on screen? The active tab's, except under panic
 * where NO page view is: the cover then hides nothing but the window
 * background, so a chrome UI that has not painted it yet (minimized, booting,
 * reloading) cannot show a page through for even one frame.
 */
export function tabOnScreen(tabId: string, state: LayoutState): boolean {
  return !state.panic && tabId === state.activeTabId;
}
