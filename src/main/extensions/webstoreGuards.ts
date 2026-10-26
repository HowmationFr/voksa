/**
 * Pure checks guarding the Chrome Web Store integration (no electron import,
 * so they are unit-testable).
 *
 * electron-chrome-web-store 0.13.0 shipped two holes, closed by
 * patches/electron-chrome-web-store+0.13.0.patch:
 *   - its origin gate was a PREFIX match, so any
 *     https://chromewebstore.google.com.<anything> host got the installer API;
 *   - page-supplied extension IDs were joined into filesystem paths, so
 *     chrome.management.uninstall('../../Documents') deleted that folder.
 * These helpers are Voksa's own layer on top of the patch (beforeInstall in
 * webstore.ts, uninstallExtensionById in manager.ts): a future library
 * version that drops the patch must not reopen either hole silently.
 */

/** The only origin allowed to drive extension installs. Compared exactly. */
export const WEBSTORE_ORIGIN = 'https://chromewebstore.google.com';

// Chromium extension IDs: 32 characters in a-p (a hex SHA-256 prefix mapped
// onto a-p). Unpacked extensions loaded by Electron use the same alphabet.
const EXTENSION_ID_PATTERN = /^[a-p]{32}$/;

export function isValidExtensionId(id: unknown): id is string {
  return typeof id === 'string' && EXTENSION_ID_PATTERN.test(id);
}

export function isWebStoreOrigin(origin: unknown): boolean {
  return origin === WEBSTORE_ORIGIN;
}

// The install dialog shows page-supplied data: bound it so a hostile or
// broken manifest cannot produce a screen-high native dialog.
const MAX_PERMISSION_LINES = 15;
const MAX_ENTRY_LENGTH = 120;

function clip(value: string): string {
  return value.length > MAX_ENTRY_LENGTH ? `${value.slice(0, MAX_ENTRY_LENGTH - 1)}…` : value;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string' && v.trim() !== '')
    : [];
}

/**
 * What an extension gets at install time, as listed in the confirmation
 * dialog: API permissions, host permissions (MV3) and the hosts its content
 * scripts run on (which grant page access just the same). Optional
 * permissions are requested later and go through requestPermissions.
 * Deduplicated, order preserved, capped: `more` counts what was cut.
 */
export function installPermissionLines(manifest: unknown): { lines: string[]; more: number } {
  const m = manifest && typeof manifest === 'object' ? (manifest as Record<string, unknown>) : {};
  const contentScripts = Array.isArray(m.content_scripts) ? m.content_scripts : [];
  const all = [
    ...strings(m.permissions),
    ...strings(m.host_permissions),
    ...contentScripts.flatMap((cs) =>
      cs && typeof cs === 'object' ? strings((cs as Record<string, unknown>).matches) : [],
    ),
  ];
  const unique = [...new Set(all.map((p) => clip(p.trim())))];
  return {
    lines: unique.slice(0, MAX_PERMISSION_LINES),
    more: Math.max(0, unique.length - MAX_PERMISSION_LINES),
  };
}

/** Display name for the dialog: the store's localized name first. */
export function installDisplayName(localizedName: unknown, manifest: unknown, id: string): string {
  const fromManifest =
    manifest && typeof manifest === 'object'
      ? (manifest as Record<string, unknown>).name
      : undefined;
  for (const candidate of [localizedName, fromManifest]) {
    // __MSG_appName__ is an unresolved i18n placeholder, not a name.
    if (typeof candidate === 'string' && candidate.trim() && !candidate.startsWith('__MSG_')) {
      return clip(candidate.trim());
    }
  }
  return id;
}
