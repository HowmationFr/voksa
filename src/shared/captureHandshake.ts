/**
 * Capture Handshake, pure policy bits (tested). The side-effecting parts
 * (desktopCapturer, setDisplayMediaRequestHandler, arming Stream Mode) live in
 * main/stream-mode/captureHandshake.ts.
 */

export type CaptureSourceKind = 'screen' | 'window';

/** A source as the picker UI needs it: id, label, kind, and a SAFE thumbnail. */
export type PickerSource = {
  id: string;
  name: string;
  kind: CaptureSourceKind;
  /** Data URL, or null when the thumbnail was withheld (a Voksa surface). */
  thumbnail: string | null;
  /** True when sharing this source would put a Voksa surface on the stream. */
  containsVoksa: boolean;
};

/**
 * Whether a source thumbnail is safe to paint in OUR picker. A thumbnail is a
 * point-in-time screenshot the OS took before any masking ran, so a thumbnail
 * of a Voksa surface can show a raw email or IP even when Stream Mode is
 * about to be armed. Withhold those unconditionally: the picker shows a
 * neutral tile for Voksa surfaces, the real (masked) content only appears once
 * the capture actually starts. Non-Voksa windows (a game, a Zoom window) keep
 * their thumbnail: nothing of ours is in them.
 */
export function thumbnailIsSafe(containsVoksa: boolean): boolean {
  return !containsVoksa;
}

/**
 * The kind of a desktopCapturer source id. Screen ids are `screen:...`, window
 * ids are `window:...`; anything else is treated as a window (fail toward the
 * stricter window-detection path).
 */
export function sourceKind(id: string): CaptureSourceKind {
  return id.startsWith('screen:') ? 'screen' : 'window';
}

/**
 * Parse the native window handle out of a desktopCapturer window source id
 * (`window:<handle>:<n>`), or null when it is not a parseable window id. Used
 * to match a shared window against Voksa's own native window handles.
 */
export function windowHandleFromSourceId(id: string): string | null {
  if (!id.startsWith('window:')) return null;
  const raw = id.split(':')[1];
  if (!raw) return null;
  // The handle is decimal on Windows/Linux; strip a hex prefix if one ever
  // appears and normalize to a decimal string for comparison.
  const n = raw.startsWith('0x') ? Number.parseInt(raw, 16) : Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? String(n) : null;
}
