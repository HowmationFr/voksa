import { session, type Extension } from 'electron';
import { getSettings, setSettings } from '../storage/settings';
import type { ExtensionInfo } from '../../shared/types';

export type { ExtensionInfo };

function pickIconPath(icon: unknown): string | null {
  if (!icon) return null;
  if (typeof icon === 'string') return icon;
  if (typeof icon !== 'object') return null;
  const entries = Object.entries(icon as Record<string, unknown>).filter(
    (e): e is [string, string] => typeof e[1] === 'string',
  );
  if (entries.length === 0) return null;
  // Prefer a mid-size icon (32px / 24px) for the toolbar; fall back to the
  // largest available if those aren't present.
  const sortedBySize = entries
    .map(([k, v]) => [Number(k), v] as const)
    .filter(([n]) => !Number.isNaN(n))
    .sort((a, b) => a[0] - b[0]);
  if (sortedBySize.length === 0) return entries[0][1];
  const mid = sortedBySize.find(([n]) => n >= 24 && n <= 48);
  if (mid) return mid[1];
  return sortedBySize[sortedBySize.length - 1][1];
}

function extensionToInfo(ext: Extension): ExtensionInfo {
  // `manifest` is typed as `any` by Electron for good reason: it's the
  // extension's unmodified package metadata.
  const manifest = ext.manifest as Record<string, unknown>;
  const action =
    (manifest.action as Record<string, unknown> | undefined) ??
    (manifest.browser_action as Record<string, unknown> | undefined) ??
    undefined;
  const iconPath = action ? pickIconPath(action.default_icon) : null;
  const fallbackIconPath = iconPath ?? pickIconPath(manifest.icons);
  // Use `chrome-extension://` (Chromium's native extension-resource scheme)
  // rather than the library's `crx://` helper scheme. The chrome-extension
  // scheme is registered automatically by Electron as soon as an extension
  // is loaded, and it's treated as a privileged "secure" origin so an
  // `<img src>` in our React UI can actually display the bytes. `crx://`
  // is used internally by electron-chrome-extensions for its own web
  // components (<browser-action-list>), but isn't reliably fetchable by
  // arbitrary pages; icons just came up blank.
  const normalizedPath = fallbackIconPath
    ? fallbackIconPath.replace(/^\/+/, '')
    : null;
  const iconUrl = normalizedPath ? `chrome-extension://${ext.id}/${normalizedPath}` : null;
  const popupPath = action && typeof action.default_popup === 'string' ? action.default_popup : null;
  const popupUrl = popupPath ? `chrome-extension://${ext.id}/${popupPath.replace(/^\/+/, '')}` : null;
  const title =
    (action && typeof action.default_title === 'string' ? action.default_title : null) ??
    ext.name;
  const description = typeof manifest.description === 'string' ? manifest.description : '';

  return {
    id: ext.id,
    name: ext.name,
    version: ext.version,
    description,
    iconUrl,
    popupUrl,
    title,
    hasPopup: !!popupUrl,
    hasAction: !!action,
  };
}

/**
 * List all loaded extensions, applying the user-defined order saved in
 * settings.json. Any extension not in the order list falls to the end.
 */
export function listExtensions(): ExtensionInfo[] {
  const extensions = session.defaultSession.extensions?.getAllExtensions?.() ?? [];
  const infos = extensions.map(extensionToInfo);
  const order = getSettings().extensionOrder ?? [];
  const orderedIds = new Map<string, number>();
  order.forEach((id, i) => orderedIds.set(id, i));
  return infos.sort((a, b) => {
    const ia = orderedIds.has(a.id) ? orderedIds.get(a.id)! : Number.MAX_SAFE_INTEGER;
    const ib = orderedIds.has(b.id) ? orderedIds.get(b.id)! : Number.MAX_SAFE_INTEGER;
    if (ia !== ib) return ia - ib;
    return a.name.localeCompare(b.name);
  });
}

export function reorderExtensions(ids: string[]): void {
  setSettings({ extensionOrder: ids });
}

/**
 * Uninstall an extension. Uses electron-chrome-web-store's `uninstallExtension`
 * (which removes the CRX files on disk AND unloads from the session). If the
 * extension wasn't installed via the web store, we fall back to
 * `session.extensions.removeExtension()`, which unloads it but leaves files
 * around.
 */
export async function uninstallExtensionById(id: string): Promise<void> {
  try {
    const mod = await import('electron-chrome-web-store');
    if (typeof mod.uninstallExtension === 'function') {
      await mod.uninstallExtension(id, { session: session.defaultSession });
      // Remove from our saved order too.
      const order = (getSettings().extensionOrder ?? []).filter((x) => x !== id);
      setSettings({ extensionOrder: order });
      return;
    }
  } catch {
    // fall through to low-level removal
  }
  try {
    session.defaultSession.extensions?.removeExtension?.(id);
  } catch {
    // ignore
  }
  const order = (getSettings().extensionOrder ?? []).filter((x) => x !== id);
  setSettings({ extensionOrder: order });
}

// NOTE: extension action popups are handled by electron-chrome-extensions
// (via the <button is="browser-action"> elements in the chrome UI); the
// hand-rolled popup window that used to live here has been removed.
