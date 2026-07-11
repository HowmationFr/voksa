/**
 * Pure geometry for the native hover-status bubble (no electron imports;
 * unit-testable under vitest). The bubble is a tiny WebContentsView pinned
 * to a bottom corner of the window, Chrome-style.
 */

export const STATUS_BUBBLE_HEIGHT = 24;

/** Extra margin around the bubble rect used for the cursor-dodge test. */
const DODGE_INFLATE = 32;

/** Minimum bubble width so very short URLs still read as a bubble. */
const MIN_WIDTH = 60;

/**
 * Estimate the pixel width needed to render `text` at 12px system-ui
 * (~6.4 px/char average) plus horizontal padding. The in-bubble CSS
 * ellipsis absorbs any estimation error; the estimate only has to be
 * roughly right so the bubble hugs its content.
 */
export function estimateStatusWidth(text: string, maxWidth: number): number {
  const estimated = Math.ceil(text.length * 6.4) + 18;
  return Math.min(maxWidth, Math.max(MIN_WIDTH, estimated));
}

export type StatusSide = 'left' | 'right';

export type StatusRect = { x: number; y: number; width: number; height: number };

function inflated(r: StatusRect, by: number): StatusRect {
  return { x: r.x - by, y: r.y - by, width: r.width + by * 2, height: r.height + by * 2 };
}

function contains(r: StatusRect, p: { x: number; y: number }): boolean {
  return p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
}

/**
 * Compute where the bubble should sit. Bottom-left by default; if the
 * cursor is near that spot the bubble flips to bottom-right (Chrome's
 * dodge). Keeping the bubble away from the cursor is what prevents the
 * hover → bubble-under-mouse → hover-lost → hide → re-hover flicker loop:
 * the view would swallow mouse events inside its rect.
 */
export function computeStatusRect(
  win: { width: number; height: number },
  textWidth: number,
  cursorLocal: { x: number; y: number } | null,
): { bounds: StatusRect; side: StatusSide } {
  const width = Math.min(textWidth, Math.max(MIN_WIDTH, Math.floor(win.width * 0.5)));
  const y = Math.max(0, win.height - STATUS_BUBBLE_HEIGHT);
  const leftRect: StatusRect = { x: 0, y, width, height: STATUS_BUBBLE_HEIGHT };
  const rightRect: StatusRect = {
    x: Math.max(0, win.width - width),
    y,
    width,
    height: STATUS_BUBBLE_HEIGHT,
  };

  if (cursorLocal && contains(inflated(leftRect, DODGE_INFLATE), cursorLocal)) {
    if (!contains(inflated(rightRect, DODGE_INFLATE), cursorLocal)) {
      return { bounds: rightRect, side: 'right' };
    }
    // Window too narrow to dodge at all; accept the left spot.
  }
  return { bounds: leftRect, side: 'left' };
}
