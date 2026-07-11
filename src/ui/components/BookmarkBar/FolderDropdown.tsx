import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronRight, Folder, Globe } from 'lucide-react';
import type { Bookmark, BookmarkFolder } from '../../../shared/types';
import {
  barItemId,
  barItemRef,
  mergeContainerItems,
  type BarItem,
  type MixedItemRef,
} from '../../../shared/bookmarkOrdering';
import { voksa } from '../../lib/bridge';
import { useT } from '../../lib/i18n';
import { MaskedText } from '../MaskedText';
import { useMaskedText } from '../../lib/masking';

export type AnchorRect = { left: number; top: number; right: number; bottom: number };

type RowDropZone = 'above' | 'below' | 'into';

type Props = {
  folderId: string;
  /** Level 0: the folder chip's rect. Level n: the parent row's rect. */
  anchor: AnchorRect;
  depth: number;
  bookmarks: Bookmark[];
  folders: BookmarkFolder[];
  /** Once a level flips to the left, the whole descendant chain opens left. */
  preferLeft: boolean;
  /** Drag state shared with BookmarkBar so drags cross panel↔bar freely. */
  dragged: MixedItemRef | null;
  onDragStateChange: (ref: MixedItemRef | null) => void;
  onNavigate: (url: string, newTab: boolean) => void;
  onCloseAll: () => void;
  onBookmarkContextMenu: (e: React.MouseEvent, b: Bookmark) => void;
  onFolderContextMenu: (e: React.MouseEvent, f: BookmarkFolder) => void;
};

const PANEL_WIDTH = 240;
const HOVER_OPEN_DELAY_MS = 150;

/**
 * One level of the Chrome-style cascading folder menu. Renders its items
 * and, on hover/click of a subfolder row, recursively mounts the next
 * level anchored to that row. Dismissal (click-outside overlay + Escape)
 * is owned by BookmarkBar, which also reports the open state into the
 * chrome overlay refcount; without that the panel would be clipped to
 * the collapsed chromeView band.
 *
 * Rows are drag sources AND drop targets: reorder within the folder
 * (above/below), move into a subfolder (middle of a folder row), or drag
 * a row out to the bookmark bar (the bar's own handlers take over there).
 */
export function FolderDropdown({
  folderId,
  anchor,
  depth,
  bookmarks,
  folders,
  preferLeft,
  dragged,
  onDragStateChange,
  onNavigate,
  onCloseAll,
  onBookmarkContextMenu,
  onFolderContextMenu,
}: Props): React.ReactElement {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const items = mergeContainerItems(bookmarks, folders, folderId);

  const initialLeft = depth === 0 ? anchor.left : preferLeft ? anchor.left - PANEL_WIDTH - 2 : anchor.right + 2;
  const initialTop = depth === 0 ? anchor.bottom + 4 : anchor.top - 4;
  const [pos, setPos] = useState({ left: initialLeft, top: initialTop });
  const [flippedLeft, setFlippedLeft] = useState(preferLeft);

  // Double-rAF: wait for the chromeView expansion (level 0 mounts in the
  // same tick that flips the overlay refcount) and for our own measured
  // size, then clamp vertically and flip horizontally if we'd overflow.
  // offsetWidth/offsetHeight, not getBoundingClientRect: the latter is
  // transform-inclusive and under-measures during our own scale-in.
  useLayoutEffect(() => {
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        const el = ref.current;
        if (!el) return;
        const w = el.offsetWidth;
        const h = el.offsetHeight;
        let left = depth === 0 ? anchor.left : preferLeft ? anchor.left - w - 2 : anchor.right + 2;
        let flipped = preferLeft;
        if (!flipped && left + w > window.innerWidth - 4) {
          left = depth === 0 ? window.innerWidth - w - 4 : anchor.left - w - 2;
          flipped = depth !== 0;
        }
        left = Math.max(4, left);
        const top = Math.max(
          4,
          Math.min(depth === 0 ? anchor.bottom + 4 : anchor.top - 4, window.innerHeight - h - 4),
        );
        setPos({ left, top });
        setFlippedLeft(flipped);
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      if (raf2) cancelAnimationFrame(raf2);
    };
  }, [anchor.left, anchor.right, anchor.top, anchor.bottom, depth, preferLeft, items.length]);

  const [openChild, setOpenChild] = useState<{ id: string; rect: AnchorRect } | null>(null);
  const hoverTimer = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
    };
  }, []);

  const scheduleOpen = (id: string, rect: AnchorRect) => {
    if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => setOpenChild({ id, rect }), HOVER_OPEN_DELAY_MS);
  };
  const cancelScheduledOpen = () => {
    if (hoverTimer.current !== null) {
      window.clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  };

  // --- Drag & drop within this panel ----------------------------------------
  const [dropTarget, setDropTarget] = useState<{ id: string; zone: RowDropZone } | null>(null);

  const handleRowDragStart = (e: React.DragEvent, item: BarItem) => {
    const itemRef = barItemRef(item);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData(
      itemRef.kind === 'bookmark' ? 'text/voksa-bookmark' : 'text/voksa-folder',
      itemRef.id,
    );
    onDragStateChange(itemRef);
  };

  const handleRowDragOver = (e: React.DragEvent, item: BarItem) => {
    const targetId = barItemId(item);
    if (!dragged || dragged.id === targetId) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const ratio = (e.clientY - rect.top) / rect.height;
    let zone: RowDropZone;
    if (item.kind === 'folder' && ratio >= 0.3 && ratio <= 0.7) zone = 'into';
    else zone = ratio < 0.5 ? 'above' : 'below';
    setDropTarget({ id: targetId, zone });
  };

  const handleRowDrop = (e: React.DragEvent, item: BarItem) => {
    e.preventDefault();
    e.stopPropagation();
    const targetId = barItemId(item);
    const cur = dragged;
    const zone = dropTarget?.id === targetId ? dropTarget.zone : null;
    setDropTarget(null);
    onDragStateChange(null);
    if (!cur || cur.id === targetId || !zone) return;

    if (zone === 'into' && item.kind === 'folder') {
      if (cur.kind === 'bookmark') void voksa.bookmarks.move(cur.id, item.folder.id);
      // Cycle-guarded in main: dropping a folder onto its own subtree no-ops.
      else void voksa.bookmarks.moveFolder(cur.id, item.folder.id);
      return;
    }

    // Positional insert into THIS panel's container. reorderMixed reassigns
    // the container on every item, so a row dragged in from another folder
    // (or from the bar) lands here at the right spot in one call.
    const targetIdx = items.findIndex((it) => barItemId(it) === targetId);
    if (targetIdx === -1) return;
    const insertIdx = zone === 'above' ? targetIdx : targetIdx + 1;
    const draggedIdx = items.findIndex((it) => barItemId(it) === cur.id);
    const without = items.filter((it) => barItemId(it) !== cur.id);
    const adjusted = draggedIdx !== -1 && draggedIdx < targetIdx ? insertIdx - 1 : insertIdx;
    const reordered: MixedItemRef[] = [
      ...without.slice(0, adjusted).map(barItemRef),
      cur,
      ...without.slice(adjusted).map(barItemRef),
    ];
    void voksa.bookmarks.reorderMixed(folderId, reordered);
  };

  // Drop on the panel's empty space (e.g. an empty folder) → append here.
  const handlePanelDragOver = (e: React.DragEvent) => {
    if (!dragged || e.defaultPrevented) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };
  const handlePanelDrop = (e: React.DragEvent) => {
    if (e.defaultPrevented) return;
    e.preventDefault();
    const cur = dragged;
    setDropTarget(null);
    onDragStateChange(null);
    if (!cur) return;
    if (cur.kind === 'bookmark') void voksa.bookmarks.move(cur.id, folderId);
    else void voksa.bookmarks.moveFolder(cur.id, folderId);
  };

  const openChildFolder = openChild ? (folders.find((f) => f.id === openChild.id) ?? null) : null;

  return (
    <>
      <div
        ref={ref}
        style={{ position: 'fixed', left: pos.left, top: pos.top, width: PANEL_WIDTH }}
        className="z-50 max-h-[60vh] overflow-y-auto bg-bg-elevated border border-border rounded-lg shadow-light-strong py-1 animate-scale-in"
        onDragOver={handlePanelDragOver}
        onDrop={handlePanelDrop}
        onDragEnd={() => {
          setDropTarget(null);
          onDragStateChange(null);
        }}
      >
        {items.length === 0 && (
          <div className="px-3 h-9 flex items-center text-[12px] text-fg-subtle select-none">{t('(vide)')}</div>
        )}
        {items.map((item) => {
          const id = barItemId(item);
          const zone = dropTarget?.id === id ? dropTarget.zone : null;
          return item.kind === 'folder' ? (
            <div key={id} className="relative">
              {zone === 'above' && (
                <div className="absolute left-2 right-2 top-0 h-0.5 bg-accent rounded-full z-10" />
              )}
              {zone === 'below' && (
                <div className="absolute left-2 right-2 bottom-0 h-0.5 bg-accent rounded-full z-10" />
              )}
              <button
                draggable
                onDragStart={(e) => handleRowDragStart(e, item)}
                onDragOver={(e) => handleRowDragOver(e, item)}
                onDrop={(e) => handleRowDrop(e, item)}
                onClick={(e) => {
                  cancelScheduledOpen();
                  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  setOpenChild((cur) =>
                    cur?.id === item.folder.id
                      ? null
                      : { id: item.folder.id, rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } },
                  );
                }}
                onMouseEnter={(e) => {
                  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  scheduleOpen(item.folder.id, { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom });
                }}
                onMouseLeave={cancelScheduledOpen}
                onContextMenu={(e) => onFolderContextMenu(e, item.folder)}
                className={`w-full flex items-center gap-2.5 px-3 h-9 text-[13px] text-fg hover:bg-bg-hover ${
                  openChild?.id === item.folder.id ? 'bg-bg-hover' : ''
                } ${dragged?.id === id ? 'opacity-40' : ''} ${
                  zone === 'into' ? 'bg-accent/15 ring-1 ring-inset ring-accent' : ''
                }`}
              >
                <Folder size={14} className="flex-shrink-0 text-fg-muted" />
                <span className="flex-1 min-w-0 truncate text-left">
                  <MaskedText text={item.folder.name} />
                </span>
                <ChevronRight size={13} className="flex-shrink-0 text-fg-subtle" />
              </button>
            </div>
          ) : (
            <div key={id} className="relative">
              {zone === 'above' && (
                <div className="absolute left-2 right-2 top-0 h-0.5 bg-accent rounded-full z-10" />
              )}
              {zone === 'below' && (
                <div className="absolute left-2 right-2 bottom-0 h-0.5 bg-accent rounded-full z-10" />
              )}
              <BookmarkRow
                bookmark={item.bookmark}
                isDragging={dragged?.id === id}
                onDragStart={(e) => handleRowDragStart(e, item)}
                onDragOver={(e) => handleRowDragOver(e, item)}
                onDrop={(e) => handleRowDrop(e, item)}
                onMouseEnter={cancelScheduledOpen}
                onNavigate={onNavigate}
                onCloseAll={onCloseAll}
                onContextMenu={(e) => onBookmarkContextMenu(e, item.bookmark)}
              />
            </div>
          );
        })}
      </div>

      {openChild && openChildFolder && (
        <FolderDropdown
          folderId={openChild.id}
          anchor={openChild.rect}
          depth={depth + 1}
          bookmarks={bookmarks}
          folders={folders}
          preferLeft={flippedLeft}
          dragged={dragged}
          onDragStateChange={onDragStateChange}
          onNavigate={onNavigate}
          onCloseAll={onCloseAll}
          onBookmarkContextMenu={onBookmarkContextMenu}
          onFolderContextMenu={onFolderContextMenu}
        />
      )}
    </>
  );
}

function BookmarkRow({
  bookmark,
  isDragging,
  onDragStart,
  onDragOver,
  onDrop,
  onMouseEnter,
  onNavigate,
  onCloseAll,
  onContextMenu,
}: {
  bookmark: Bookmark;
  isDragging: boolean;
  onDragStart: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  onMouseEnter: () => void;
  onNavigate: (url: string, newTab: boolean) => void;
  onCloseAll: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}): React.ReactElement {
  const maskedUrl = useMaskedText(bookmark.url);
  const open = (e: React.MouseEvent) => {
    onNavigate(bookmark.url, e.button === 1 || e.metaKey || e.ctrlKey);
    onCloseAll();
  };
  return (
    <button
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onClick={open}
      onAuxClick={(e) => e.button === 1 && open(e)}
      onMouseEnter={onMouseEnter}
      onContextMenu={onContextMenu}
      className={`w-full flex items-center gap-2.5 px-3 h-9 text-[13px] text-fg hover:bg-bg-hover ${
        isDragging ? 'opacity-40' : ''
      }`}
      title={maskedUrl}
    >
      {bookmark.faviconUrl ? (
        <img
          src={bookmark.faviconUrl}
          alt=""
          className="w-3.5 h-3.5 rounded-sm flex-shrink-0"
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).style.display = 'none';
          }}
        />
      ) : (
        <Globe size={13} className="flex-shrink-0 text-fg-muted" />
      )}
      <span className="flex-1 min-w-0 truncate text-left">
        <MaskedText text={bookmark.title || bookmark.url} />
      </span>
    </button>
  );
}
