/**
 * Opening local files in tabs: the native "Open file…" dialog (Ctrl+O, the
 * File menu, the burger menu) and paths handed over by the chrome UI (files
 * dropped on the window).
 *
 * Both funnel through openLocalPaths, which opens a path only when
 * main/localFiles.ts vouches for it: an existing regular file of a passive
 * type. The dialog's filters are a convenience for the user, never the check.
 */
import { dialog } from 'electron';
import type { AppWindow } from './window';
import { t } from './i18n';
import { OPENABLE_EXTENSIONS, OPENABLE_IMAGE_EXTENSIONS } from '../shared/localFiles';
import { openableFileUrls } from './localFiles';

/** Windows that already have the dialog up: a second Ctrl+O must not stack another. */
const dialogOpenFor = new Set<number>();

/**
 * Open every openable path in its own tab of `win`. The first one takes the
 * foreground, the others load behind it. Returns how many tabs were opened.
 */
export function openLocalPaths(win: AppWindow, paths: unknown): number {
  if (win.window.isDestroyed()) return 0;
  const urls = openableFileUrls(paths);
  urls.forEach((url, index) => win.tabs.create(url, { activate: index === 0 }));
  return urls.length;
}

/** Ask the user for file(s) with the native dialog, then open them. */
export async function openFilesWithDialog(win: AppWindow): Promise<number> {
  const id = win.window.id;
  if (win.window.isDestroyed() || dialogOpenFor.has(id)) return 0;
  dialogOpenFor.add(id);
  try {
    const { canceled, filePaths } = await dialog.showOpenDialog(win.window, {
      title: t('Ouvrir un fichier'),
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: t('Images'), extensions: [...OPENABLE_IMAGE_EXTENSIONS] },
        { name: t('Fichiers pris en charge'), extensions: [...OPENABLE_EXTENSIONS] },
      ],
    });
    return canceled ? 0 : openLocalPaths(win, filePaths);
  } finally {
    dialogOpenFor.delete(id);
  }
}
