import React, { useEffect, useState } from 'react';
import { Folder, FolderPen, FolderPlus, Globe, Trash2 } from 'lucide-react';
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
import { useTabsStore } from '../../stores/tabsStore';
import { useMaskedText } from '../../lib/masking';
import { MaskedText } from '../MaskedText';
import { askConfirm } from '../ui/ConfirmDialog';
import { BookmarkContextMenu } from './BookmarkContextMenu';
import { BookmarkEditDialog } from './BookmarkEditDialog';
import { ContextMenuItem, ContextMenuSeparator, ContextMenuShell } from './ContextMenuShell';
import { FolderDropdown, type AnchorRect } from './FolderDropdown';
import { FolderNameDialog } from './FolderNameDialog';

type Props = {
  onOverlayCountChange?: (count: number) => void;
};

type DropZone = 'before' | 'after' | 'into';

type FolderDialogState =
  | { mode: 'create'; parentId: string | null }
  | { mode: 'rename'; folder: BookmarkFolder };

export function BookmarkBar({ onOverlayCountChange }: Props): React.ReactElement {
  const t = useT();
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [folders, setFolders] = useState<BookmarkFolder[]>([]);
  const active = useTabsStore((s) => s.tabs.find((t) => t.isActive) ?? null);
  const [contextMenu, setContextMenu] = useState<{
    bookmark: Bookmark;
    x: number;
    y: number;
  } | null>(null);
  const [folderContextMenu, setFolderContextMenu] = useState<{
    folder: BookmarkFolder;
    x: number;
    y: number;
  } | null>(null);
  const [barContextMenu, setBarContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [editing, setEditing] = useState<Bookmark | null>(null);
  const [folderDialog, setFolderDialog] = useState<FolderDialogState | null>(null);
  const [openFolder, setOpenFolder] = useState<{ folderId: string; anchor: AnchorRect } | null>(
    null,
  );

  useEffect(() => {
    void Promise.all([voksa.bookmarks.list(), voksa.bookmarks.listFolders()]).then(([b, f]) => {
      setBookmarks(b);
      setFolders(f);
    });
    const unsub = voksa.bookmarks.onChanged(({ bookmarks: b, folders: f }) => {
      setBookmarks(b);
      setFolders(f);
    });
    return unsub;
  }, []);

  // A deleted/renamed folder invalidates the open dropdown target.
  useEffect(() => {
    if (openFolder && !folders.some((f) => f.id === openFolder.folderId)) setOpenFolder(null);
  }, [folders, openFolder]);

  // Report our overlay count to the parent Chrome component so it can drive
  // the chromeView expansion centrally (§4.8). The open folder dropdown MUST
  // count too: it renders below the toolbar band and would otherwise be
  // clipped by the collapsed chromeView.
  useEffect(() => {
    const count =
      (contextMenu !== null ? 1 : 0) +
      (folderContextMenu !== null ? 1 : 0) +
      (barContextMenu !== null ? 1 : 0) +
      (editing !== null ? 1 : 0) +
      (folderDialog !== null ? 1 : 0) +
      (openFolder !== null ? 1 : 0);
    onOverlayCountChange?.(count);
  }, [contextMenu, folderContextMenu, barContextMenu, editing, folderDialog, openFolder, onOverlayCountChange]);

  // Escape closes the whole dropdown cascade.
  useEffect(() => {
    if (!openFolder) return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenFolder(null);
    };
    document.addEventListener('keydown', onEsc);
    return () => document.removeEventListener('keydown', onEsc);
  }, [openFolder]);

  const rootItems = mergeContainerItems(bookmarks, folders, null);

  const handleNavigate = (url: string, newTab: boolean) => {
    if (newTab) void voksa.tabs.create(url);
    else if (active) void voksa.tabs.navigate(active.id, url);
  };

  const handleDelete = async (b: Bookmark) => {
    await voksa.bookmarks.remove(b.id);
    setContextMenu(null);
  };

  const handleEdit = (b: Bookmark) => {
    setEditing(b);
    setContextMenu(null);
  };

  const handleSaveEdit = async (patch: { title: string; url: string; folderId: string | null }) => {
    if (!editing) return;
    await voksa.bookmarks.update(editing.id, patch);
    setEditing(null);
  };

  const handleOpenInNewTab = (b: Bookmark) => {
    void voksa.tabs.create(b.url);
    setContextMenu(null);
  };

  const handleDeleteFolder = async (folder: BookmarkFolder) => {
    setFolderContextMenu(null);
    // Title deliberately omits the folder name: a name can match a custom
    // Stream mask and the confirm dialog renders its strings raw.
    const ok = await askConfirm({
      title: t('Supprimer ce dossier ?'),
      message: t('Les favoris et sous-dossiers qu’il contient remonteront à la racine.'),
      confirmLabel: t('Supprimer'),
      danger: true,
    });
    if (ok) await voksa.bookmarks.removeFolder(folder.id);
  };

  const toggleFolderDropdown = (folder: BookmarkFolder, chipRect: DOMRect) => {
    setOpenFolder((cur) =>
      cur?.folderId === folder.id
        ? null
        : {
            folderId: folder.id,
            anchor: {
              left: chipRect.left,
              top: chipRect.top,
              right: chipRect.right,
              bottom: chipRect.bottom,
            },
          },
    );
  };

  // --- Drag & drop (mixed: bookmarks + folders, root level of the bar) ------
  const [dragged, setDragged] = useState<MixedItemRef | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; zone: DropZone } | null>(null);

  const handleDragStart = (e: React.DragEvent, item: BarItem) => {
    const ref = barItemRef(item);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData(ref.kind === 'bookmark' ? 'text/voksa-bookmark' : 'text/voksa-folder', ref.id);
    setDragged(ref);
  };

  const handleDragOver = (e: React.DragEvent, item: BarItem) => {
    const targetId = barItemId(item);
    if (!dragged || dragged.id === targetId) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    // Folders accept "drop INTO" on their middle half; everything else is
    // an insert-before/after positional drop.
    let zone: DropZone;
    if (item.kind === 'folder' && ratio >= 0.25 && ratio <= 0.75) zone = 'into';
    else zone = ratio < 0.5 ? 'before' : 'after';
    setDropTarget({ id: targetId, zone });
  };

  const handleDragEnd = () => {
    setDragged(null);
    setDropTarget(null);
  };

  const handleDrop = (e: React.DragEvent, item: BarItem) => {
    e.preventDefault();
    e.stopPropagation();
    const targetId = barItemId(item);
    const draggedRef = dragged;
    const zone = dropTarget?.id === targetId ? dropTarget.zone : null;
    handleDragEnd();
    if (!draggedRef || draggedRef.id === targetId || !zone) return;

    if (zone === 'into' && item.kind === 'folder') {
      if (draggedRef.kind === 'bookmark') void voksa.bookmarks.move(draggedRef.id, item.folder.id);
      // Cycle-guarded in main: dropping a folder onto its own subtree no-ops.
      else void voksa.bookmarks.moveFolder(draggedRef.id, item.folder.id);
      return;
    }

    const targetIdx = rootItems.findIndex((it) => barItemId(it) === targetId);
    if (targetIdx === -1) return;
    const insertIdx = zone === 'before' ? targetIdx : targetIdx + 1;
    const draggedIdx = rootItems.findIndex((it) => barItemId(it) === draggedRef.id);
    const without = rootItems.filter((it) => barItemId(it) !== draggedRef.id);
    // Adjust for the removed item when it sat before the insertion point.
    const adjusted = draggedIdx !== -1 && draggedIdx < targetIdx ? insertIdx - 1 : insertIdx;
    const reordered: MixedItemRef[] = [
      ...without.slice(0, adjusted).map(barItemRef),
      draggedRef,
      ...without.slice(adjusted).map(barItemRef),
    ];
    void voksa.bookmarks.reorderMixed(null, reordered);
  };

  const handleBarContextMenu = (e: React.MouseEvent) => {
    if (e.target !== e.currentTarget) return;
    e.preventDefault();
    setBarContextMenu({ x: e.clientX, y: e.clientY });
  };

  // Drop on the bar's empty space → move to the root, appended at the end.
  // This is the "drag it back out of a folder" path: a row dragged from a
  // dropdown lands here (or on a chip via the handlers above; reorderMixed
  // re-parents foreign items to the target container in both cases).
  const handleBarDragOver = (e: React.DragEvent) => {
    if (!dragged || e.defaultPrevented) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };
  const handleBarDrop = (e: React.DragEvent) => {
    if (e.defaultPrevented) return;
    e.preventDefault();
    const cur = dragged;
    handleDragEnd();
    if (!cur) return;
    if (cur.kind === 'bookmark') void voksa.bookmarks.move(cur.id, null);
    else void voksa.bookmarks.moveFolder(cur.id, null);
  };

  return (
    <>
      <div
        className="flex items-center gap-0.5 h-9 px-2 border-t border-border overflow-x-auto no-scrollbar"
        onDragEnd={handleDragEnd}
        onDragOver={handleBarDragOver}
        onDrop={handleBarDrop}
        onContextMenu={handleBarContextMenu}
      >
        {rootItems.length === 0 && (
          <span className="px-1 text-[12px] text-fg-subtle pointer-events-none select-none">
            {t('Cliquez sur l’icône signet pour ajouter vos premiers favoris ; clic droit pour créer un dossier.')}
          </span>
        )}
        {rootItems.map((item) =>
          item.kind === 'bookmark' ? (
            <BookmarkChip
              key={barItemId(item)}
              bookmark={item.bookmark}
              isDragging={dragged?.id === item.bookmark.id}
              dropIndicator={dropTarget?.id === item.bookmark.id ? dropTarget.zone : null}
              onOpen={(e) =>
                handleNavigate(item.bookmark.url, e.button === 1 || e.metaKey || e.ctrlKey)
              }
              onContextMenu={(e) => {
                e.preventDefault();
                setContextMenu({ bookmark: item.bookmark, x: e.clientX, y: e.clientY });
              }}
              onDragStart={(e) => handleDragStart(e, item)}
              onDragOver={(e) => handleDragOver(e, item)}
              onDrop={(e) => handleDrop(e, item)}
            />
          ) : (
            <FolderChip
              key={barItemId(item)}
              folder={item.folder}
              isOpen={openFolder?.folderId === item.folder.id}
              isDragging={dragged?.id === item.folder.id}
              dropIndicator={dropTarget?.id === item.folder.id ? dropTarget.zone : null}
              onToggle={(rect) => toggleFolderDropdown(item.folder, rect)}
              onHoverWhileOpen={(rect) => {
                // Chrome behavior: with a dropdown already open, gliding over
                // a sibling folder switches to it without another click.
                if (openFolder && openFolder.folderId !== item.folder.id) {
                  toggleFolderDropdown(item.folder, rect);
                }
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setFolderContextMenu({ folder: item.folder, x: e.clientX, y: e.clientY });
              }}
              onDragStart={(e) => handleDragStart(e, item)}
              onDragOver={(e) => handleDragOver(e, item)}
              onDrop={(e) => handleDrop(e, item)}
            />
          ),
        )}
      </div>

      {openFolder && (
        <>
          {/* Click-outside catcher, under the dropdown panels (z-50). While a
              drag is in flight it must NOT eat dragover/drop events; the bar
              chips underneath are legitimate targets for "drag out of folder". */}
          <div
            className={`fixed inset-0 z-40 ${dragged ? 'pointer-events-none' : ''}`}
            onClick={() => setOpenFolder(null)}
          />
          <FolderDropdown
            folderId={openFolder.folderId}
            anchor={openFolder.anchor}
            depth={0}
            bookmarks={bookmarks}
            folders={folders}
            preferLeft={false}
            dragged={dragged}
            onDragStateChange={setDragged}
            onNavigate={handleNavigate}
            onCloseAll={() => setOpenFolder(null)}
            onBookmarkContextMenu={(e, b) => {
              e.preventDefault();
              setContextMenu({ bookmark: b, x: e.clientX, y: e.clientY });
            }}
            onFolderContextMenu={(e, f) => {
              e.preventDefault();
              setFolderContextMenu({ folder: f, x: e.clientX, y: e.clientY });
            }}
          />
        </>
      )}

      {contextMenu && (
        <BookmarkContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          bookmark={contextMenu.bookmark}
          onClose={() => setContextMenu(null)}
          onEdit={handleEdit}
          onDelete={handleDelete}
          onOpenInNewTab={handleOpenInNewTab}
        />
      )}

      {folderContextMenu && (
        <ContextMenuShell
          x={folderContextMenu.x}
          y={folderContextMenu.y}
          onClose={() => setFolderContextMenu(null)}
        >
          <ContextMenuItem
            icon={FolderPlus}
            label={t('Nouveau sous-dossier')}
            onClick={() => {
              setFolderDialog({ mode: 'create', parentId: folderContextMenu.folder.id });
              setFolderContextMenu(null);
            }}
          />
          <ContextMenuItem
            icon={FolderPen}
            label={t('Renommer')}
            onClick={() => {
              setFolderDialog({ mode: 'rename', folder: folderContextMenu.folder });
              setFolderContextMenu(null);
            }}
          />
          <ContextMenuSeparator />
          <ContextMenuItem
            icon={Trash2}
            label={t('Supprimer')}
            onClick={() => void handleDeleteFolder(folderContextMenu.folder)}
            danger
          />
        </ContextMenuShell>
      )}

      {barContextMenu && (
        <ContextMenuShell
          x={barContextMenu.x}
          y={barContextMenu.y}
          onClose={() => setBarContextMenu(null)}
        >
          <ContextMenuItem
            icon={FolderPlus}
            label={t('Nouveau dossier')}
            onClick={() => {
              setFolderDialog({ mode: 'create', parentId: null });
              setBarContextMenu(null);
            }}
          />
        </ContextMenuShell>
      )}

      {editing && (
        <BookmarkEditDialog
          bookmark={editing}
          folders={folders}
          onClose={() => setEditing(null)}
          onSave={handleSaveEdit}
        />
      )}

      {folderDialog && (
        <FolderNameDialog
          title={folderDialog.mode === 'create' ? t('Nouveau dossier') : t('Renommer le dossier')}
          initialName={folderDialog.mode === 'rename' ? folderDialog.folder.name : ''}
          onClose={() => setFolderDialog(null)}
          onSave={async (name) => {
            if (folderDialog.mode === 'create') await voksa.bookmarks.addFolder(name, folderDialog.parentId);
            else await voksa.bookmarks.renameFolder(folderDialog.folder.id, name);
            setFolderDialog(null);
          }}
        />
      )}
    </>
  );
}

function dropIndicatorEdges(zone: DropZone | null): React.ReactNode {
  return (
    <>
      {zone === 'before' && (
        <div className="absolute left-0 top-1 bottom-1 w-0.5 bg-accent rounded-full" />
      )}
      {zone === 'after' && (
        <div className="absolute right-0 top-1 bottom-1 w-0.5 bg-accent rounded-full" />
      )}
    </>
  );
}

function BookmarkChip({
  bookmark,
  onOpen,
  onContextMenu,
  isDragging,
  dropIndicator,
  onDragStart,
  onDragOver,
  onDrop,
}: {
  bookmark: Bookmark;
  onOpen: (e: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  isDragging: boolean;
  dropIndicator: DropZone | null;
  onDragStart: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
}): React.ReactElement {
  const maskedUrl = useMaskedText(bookmark.url);
  return (
    <div className="relative flex-shrink-0">
      {dropIndicatorEdges(dropIndicator)}
      <button
        draggable
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDrop={onDrop}
        onClick={onOpen}
        onAuxClick={(e) => e.button === 1 && onOpen(e)}
        onContextMenu={onContextMenu}
        className={`flex items-center gap-1.5 px-2 h-7 rounded-md hover:bg-bg-hover text-fg-muted hover:text-fg text-[12px] max-w-[180px] transition-opacity ${
          isDragging ? 'opacity-40' : ''
        }`}
        title={maskedUrl}
      >
        {bookmark.faviconUrl ? (
          <img
            src={bookmark.faviconUrl}
            alt=""
            className="w-3.5 h-3.5 rounded-sm"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = 'none';
            }}
          />
        ) : (
          <Globe size={12} />
        )}
        <span className="truncate">
          <MaskedText text={bookmark.title || bookmark.url} />
        </span>
      </button>
    </div>
  );
}

function FolderChip({
  folder,
  isOpen,
  isDragging,
  dropIndicator,
  onToggle,
  onHoverWhileOpen,
  onContextMenu,
  onDragStart,
  onDragOver,
  onDrop,
}: {
  folder: BookmarkFolder;
  isOpen: boolean;
  isDragging: boolean;
  dropIndicator: DropZone | null;
  onToggle: (chipRect: DOMRect) => void;
  onHoverWhileOpen: (chipRect: DOMRect) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
}): React.ReactElement {
  return (
    <div className="relative flex-shrink-0">
      {dropIndicatorEdges(dropIndicator)}
      <button
        draggable
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDrop={onDrop}
        onClick={(e) => onToggle((e.currentTarget as HTMLElement).getBoundingClientRect())}
        onMouseEnter={(e) => onHoverWhileOpen((e.currentTarget as HTMLElement).getBoundingClientRect())}
        onContextMenu={onContextMenu}
        className={`flex items-center gap-1.5 px-2 h-7 rounded-md text-[12px] max-w-[180px] transition-opacity ${
          isOpen ? 'bg-bg-active text-fg' : 'hover:bg-bg-hover text-fg-muted hover:text-fg'
        } ${isDragging ? 'opacity-40' : ''} ${
          dropIndicator === 'into' ? 'bg-accent/15 ring-1 ring-accent' : ''
        }`}
      >
        <Folder size={12} className="flex-shrink-0" />
        <span className="truncate">
          <MaskedText text={folder.name} />
        </span>
      </button>
    </div>
  );
}
