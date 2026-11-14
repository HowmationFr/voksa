import { useEffect } from 'react';
import { voksa } from './bridge';

/** True for a drag that carries OS files, as opposed to a tab or a bookmark. */
function carriesFiles(e: DragEvent): boolean {
  const types = e.dataTransfer?.types;
  return !!types && Array.from(types).includes('Files');
}

/**
 * Files dragged from the OS onto the chrome UI (tab strip, toolbar, internal
 * pages) open in new tabs.
 *
 * Window-level and keyed on the drag's TYPE: the reordering drags of this UI
 * (tabs, bookmarks, extension icons) carry their own `text/voksa-*` types and
 * never 'Files', so the two can never be confused. Main opens only existing
 * files of a passive type (see shared/localFiles.ts); anything else dropped
 * here opens nothing.
 *
 * CAPTURE phase, and the drop stops here: the bookmark chips and rows call
 * stopPropagation() on every drop they see, theirs or not, so a bubbling
 * listener would never hear about a file dropped on one of them while the
 * cursor had promised a copy.
 *
 * Over a web page the chrome UI only covers the toolbar strip: a drop on the
 * page itself lands in the tab, which handles it on its own.
 */
export function useFileDrop(): void {
  useEffect(() => {
    const onDragOver = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      // Without this the drop is refused and 'drop' never fires.
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const onDrop = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length > 0) void voksa.files.openDropped(files).catch(() => undefined);
    };
    window.addEventListener('dragover', onDragOver, true);
    window.addEventListener('drop', onDrop, true);
    return () => {
      window.removeEventListener('dragover', onDragOver, true);
      window.removeEventListener('drop', onDrop, true);
    };
  }, []);
}
