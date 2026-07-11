import type { BaseWindow } from 'electron';
import type { ChromeBounds } from '../../shared/types';

/**
 * Compute the on-screen rectangle for a tab's WebContentsView given the
 * current chrome layout (toolbar + bookmark bar height). The chrome is drawn
 * by the UI view on top of the window, and the tab view fills the rest.
 */
export function computeTabBounds(
  win: BaseWindow,
  chromeBounds: ChromeBounds,
): Electron.Rectangle {
  const [w, h] = win.getContentSize();
  const top = Math.max(0, chromeBounds.top ?? 0);
  return {
    x: 0,
    y: top,
    width: w,
    height: Math.max(0, h - top),
  };
}

export function computeChromeViewBounds(
  win: BaseWindow,
  chromeBounds: ChromeBounds,
): Electron.Rectangle {
  const [w] = win.getContentSize();
  // The chrome view (React UI) only covers the top toolbar/tabs area. Below
  // that, the tab view shows through. Using a precise height prevents the
  // chrome from swallowing clicks destined for the web page.
  const height = Math.max(1, chromeBounds.top ?? 88);
  return { x: 0, y: 0, width: w, height };
}
