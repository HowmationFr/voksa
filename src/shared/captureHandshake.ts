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

/**
 * A user pick bound to ONE requesting webContents. Since Electron 45 every
 * screen-capture request reaches setPermissionRequestHandler first, as
 * 'display-capture': the permission-time gate issues the ticket, and the
 * display-media handler (getDisplayMedia only) consumes it and delivers
 * exactly this source.
 */
export type CaptureTicket = {
  requesterId: number;
  /**
   * The request's securityOrigin, raw. The permission details and the
   * display-media request carry the same string (MediaStreamRequest's origin,
   * 'file:///' included), so equality needs no URL parsing.
   */
  securityOrigin: string;
  sourceId: string;
  name: string;
  consumed: boolean;
};

/**
 * Whether a display-media request from `requesterId` / `securityOrigin` may
 * take this ticket: same webContents, same origin, not taken yet. An empty
 * origin never matches (fail closed).
 */
export function ticketMatches(
  ticket: CaptureTicket | undefined,
  requesterId: number | null,
  securityOrigin: string | null | undefined,
): ticket is CaptureTicket {
  if (!ticket || ticket.consumed || requesterId === null) return false;
  if (ticket.requesterId !== requesterId) return false;
  return !!securityOrigin && securityOrigin === ticket.securityOrigin;
}

/**
 * Grant a gated display-capture permission and report which Chromium path
 * took it. For getDisplayMedia, Electron 45 runs the display-media handler
 * SYNCHRONOUSLY inside the permission callback (OnPermissionResponse ->
 * MediaAccessAllowed -> ChooseDisplayMediaDevice -> JS handler; observed on
 * Windows, asserted cross-platform by the smoke). The legacy
 * getUserMedia({chromeMediaSource}) path never calls it: HandleUserMediaRequest
 * builds the device straight from the page's own source id, the whole desktop
 * when it names none. So "the handler did not run during grant(true)" means
 * the page is now capturing a source IT chose, not the user's pick.
 */
export function grantAndClassify(
  grant: (allowed: boolean) => void,
  displayHandlerRan: () => boolean,
): 'display-media' | 'legacy-getusermedia' {
  grant(true);
  return displayHandlerRan() ? 'display-media' : 'legacy-getusermedia';
}
