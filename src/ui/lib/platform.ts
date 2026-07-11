/** Renderer-side platform helpers (shared by every shortcut hint/tooltip). */
export const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);

/**
 * Human label for a `CmdOrCtrl+…` accelerator: 'H' → '⌘H' on macOS,
 * 'Ctrl+H' elsewhere ('Shift+' collapses to '⇧' on mac, Chrome-style).
 */
export function shortcut(keys: string): string {
  return isMac ? `⌘${keys.replace(/Shift\+/g, '⇧')}` : `Ctrl+${keys}`;
}

/** DevTools accelerator differs per platform (menu.ts uses Alt+Cmd+I / F12). */
export const DEVTOOLS_SHORTCUT = isMac ? '⌥⌘I' : 'F12';
