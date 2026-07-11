import React, { useEffect, useState } from 'react';
import {
  Bookmark as BookmarkIcon,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderPen,
  FolderPlus,
  Globe,
  GripVertical,
  Pencil,
  Trash2,
} from 'lucide-react';
import type { Bookmark, BookmarkFolder } from '../../../shared/types';
import {
  barItemId,
  barItemRef,
  mergeContainerItems,
  type BarItem,
  type MixedItemRef,
} from '../../../shared/bookmarkOrdering';
import { voksa } from '../../lib/bridge';
import { useTabsStore } from '../../stores/tabsStore';
import { MaskedText } from '../MaskedText';
import { useMaskedText } from '../../lib/masking';
import { askConfirm } from '../ui/ConfirmDialog';
import { BookmarkEditDialog } from '../BookmarkBar/BookmarkEditDialog';
import { FolderNameDialog } from '../BookmarkBar/FolderNameDialog';
import { useT } from '../../lib/i18n';

type FolderDialogState =
  | { mode: 'create'; parentId: string | null }
  | { mode: 'rename'; folder: BookmarkFolder };

export function BookmarksPage(): React.ReactElement {
  const t = useT();
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [folders, setFolders] = useState<BookmarkFolder[]>([]);
  const [editing, setEditing] = useState<Bookmark | null>(null);
  const [folderDialog, setFolderDialog] = useState<FolderDialogState | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const activeTabId = useTabsStore((s) => s.tabs.find((t) => t.isActive)?.id ?? null);

  const openLink = (url: string, e: React.MouseEvent) => {
    if (e.button === 1 || e.metaKey || e.ctrlKey) void voksa.tabs.create(url);
    else if (activeTabId) void voksa.tabs.navigate(activeTabId, url);
  };

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

  const toggleCollapsed = (id: string) => {
    setCollapsed((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const onDeleteFolder = async (folder: BookmarkFolder) => {
    const ok = await askConfirm({
      title: t('Supprimer ce dossier ?'),
      message: t('Les favoris et sous-dossiers qu’il contient remonteront à la racine.'),
      confirmLabel: t('Supprimer'),
      danger: true,
    });
    if (ok) await voksa.bookmarks.removeFolder(folder.id);
  };

  // --- Drag & drop reordering (same-container only) --------------------------
  // Cross-container moves go through the edit dialog's folder picker or the
  // bookmark bar's drop-onto-folder; free-form DnD between nested groups is
  // deliberately out of scope here.
  const [dragged, setDragged] = useState<{ ref: MixedItemRef; container: string | null } | null>(
    null,
  );
  const [dropTarget, setDropTarget] = useState<{ id: string; side: 'above' | 'below' } | null>(
    null,
  );

  const handleDragStart = (e: React.DragEvent, item: BarItem, container: string | null) => {
    const ref = barItemRef(item);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData(ref.kind === 'bookmark' ? 'text/voksa-bookmark' : 'text/voksa-folder', ref.id);
    setDragged({ ref, container });
    e.stopPropagation();
  };

  const handleDragOver = (e: React.DragEvent, item: BarItem, container: string | null) => {
    const id = barItemId(item);
    if (!dragged || dragged.ref.id === id || dragged.container !== container) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const side: 'above' | 'below' = e.clientY < rect.top + rect.height / 2 ? 'above' : 'below';
    setDropTarget({ id, side });
  };

  const handleDragEnd = () => {
    setDragged(null);
    setDropTarget(null);
  };

  const handleDrop = (e: React.DragEvent, item: BarItem, container: string | null) => {
    e.preventDefault();
    e.stopPropagation();
    const targetId = barItemId(item);
    const cur = dragged;
    const side = dropTarget?.id === targetId ? dropTarget.side : null;
    handleDragEnd();
    if (!cur || cur.ref.id === targetId || cur.container !== container || !side) return;

    const items = mergeContainerItems(bookmarks, folders, container);
    const targetIdx = items.findIndex((it) => barItemId(it) === targetId);
    if (targetIdx === -1) return;
    const insertIdx = side === 'above' ? targetIdx : targetIdx + 1;
    const draggedIdx = items.findIndex((it) => barItemId(it) === cur.ref.id);
    const without = items.filter((it) => barItemId(it) !== cur.ref.id);
    const adjusted = draggedIdx !== -1 && draggedIdx < targetIdx ? insertIdx - 1 : insertIdx;
    const reordered: MixedItemRef[] = [
      ...without.slice(0, adjusted).map(barItemRef),
      cur.ref,
      ...without.slice(adjusted).map(barItemRef),
    ];
    void voksa.bookmarks.reorderMixed(container, reordered);
  };

  const rootItems = mergeContainerItems(bookmarks, folders, null);

  const renderItems = (container: string | null, depth: number): React.ReactNode => {
    const items = container === null ? rootItems : mergeContainerItems(bookmarks, folders, container);
    return items.map((item) => {
      const id = barItemId(item);
      const indicator = dropTarget?.id === id ? dropTarget.side : null;
      if (item.kind === 'folder') {
        const isCollapsed = collapsed.has(item.folder.id);
        return (
          <React.Fragment key={id}>
            <div
              draggable
              onDragStart={(e) => handleDragStart(e, item, container)}
              onDragOver={(e) => handleDragOver(e, item, container)}
              onDrop={(e) => handleDrop(e, item, container)}
              style={{ paddingLeft: 16 + depth * 24 }}
              className={`relative flex items-center gap-3 pr-4 py-3 border-b border-border last:border-b-0 hover:bg-bg-hover group transition-opacity ${
                dragged?.ref.id === id ? 'opacity-40' : ''
              }`}
            >
              {indicator === 'above' && (
                <div className="absolute left-3 right-3 top-0 h-0.5 bg-accent rounded-full" />
              )}
              {indicator === 'below' && (
                <div className="absolute left-3 right-3 bottom-0 h-0.5 bg-accent rounded-full" />
              )}
              <GripVertical
                size={14}
                className="flex-shrink-0 text-fg-subtle opacity-0 group-hover:opacity-100 cursor-grab active:cursor-grabbing"
              />
              <button
                type="button"
                onClick={() => toggleCollapsed(item.folder.id)}
                className="flex-1 min-w-0 flex items-center gap-2.5 text-left"
              >
                {isCollapsed ? (
                  <ChevronRight size={14} className="flex-shrink-0 text-fg-subtle" />
                ) : (
                  <ChevronDown size={14} className="flex-shrink-0 text-fg-subtle" />
                )}
                <Folder size={15} className="flex-shrink-0 text-fg-muted" />
                <span className="truncate text-sm font-medium text-fg">
                  <MaskedText text={item.folder.name} />
                </span>
              </button>
              <button
                onClick={() => setFolderDialog({ mode: 'create', parentId: item.folder.id })}
                className="flex-shrink-0 p-1.5 rounded-md opacity-0 group-hover:opacity-100 text-fg-muted hover:text-fg hover:bg-bg-active"
                title={t('Nouveau sous-dossier')}
              >
                <FolderPlus size={12} />
              </button>
              <button
                onClick={() => setFolderDialog({ mode: 'rename', folder: item.folder })}
                className="flex-shrink-0 p-1.5 rounded-md opacity-0 group-hover:opacity-100 text-fg-muted hover:text-fg hover:bg-bg-active"
                title={t('Renommer')}
              >
                <FolderPen size={12} />
              </button>
              <button
                onClick={() => void onDeleteFolder(item.folder)}
                className="flex-shrink-0 p-1.5 rounded-md opacity-0 group-hover:opacity-100 text-fg-muted hover:text-danger hover:bg-danger/10"
                title={t('Supprimer')}
              >
                <Trash2 size={12} />
              </button>
            </div>
            {!isCollapsed && renderItems(item.folder.id, depth + 1)}
          </React.Fragment>
        );
      }
      return (
        <BookmarkRow
          key={id}
          bookmark={item.bookmark}
          depth={depth}
          isDragging={dragged?.ref.id === id}
          indicator={indicator}
          onDragStart={(e) => handleDragStart(e, item, container)}
          onDragOver={(e) => handleDragOver(e, item, container)}
          onDrop={(e) => handleDrop(e, item, container)}
          onOpen={openLink}
          onEdit={() => setEditing(item.bookmark)}
          onDelete={() => void voksa.bookmarks.remove(item.bookmark.id)}
        />
      );
    });
  };

  const empty = bookmarks.length === 0 && folders.length === 0;

  return (
    <div className="bg-bg text-fg">
      <div className="max-w-4xl mx-auto px-6 py-10">
        <div className="flex items-center justify-between mb-8">
          <h1 className="flex items-center gap-3 text-2xl font-semibold">
            <BookmarkIcon size={22} className="text-accent" />
            {t('Favoris')}
          </h1>
          <button
            onClick={() => setFolderDialog({ mode: 'create', parentId: null })}
            className="inline-flex items-center gap-1.5 px-3 h-9 rounded-lg border border-border text-[13px] text-fg hover:bg-bg-hover transition-colors"
          >
            <FolderPlus size={14} />
            {t('Nouveau dossier')}
          </button>
        </div>

        {empty ? (
          <div className="py-24 text-center text-fg-subtle">
            {t('Aucun favori pour le moment. Cliquez sur l’icône signet dans la barre d’adresse pour en ajouter.')}
          </div>
        ) : (
          <div
            className="bg-bg-elevated border border-border rounded-xl overflow-hidden"
            onDragEnd={handleDragEnd}
          >
            {renderItems(null, 0)}
          </div>
        )}
      </div>
      {editing && (
        <BookmarkEditDialog
          bookmark={editing}
          folders={folders}
          onClose={() => setEditing(null)}
          onSave={(patch) => {
            void voksa.bookmarks.update(editing.id, patch);
            setEditing(null);
          }}
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
    </div>
  );
}

function BookmarkRow({
  bookmark,
  depth,
  isDragging,
  indicator,
  onDragStart,
  onDragOver,
  onDrop,
  onOpen,
  onEdit,
  onDelete,
}: {
  bookmark: Bookmark;
  depth: number;
  isDragging: boolean;
  indicator: 'above' | 'below' | null;
  onDragStart: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  onOpen: (url: string, e: React.MouseEvent) => void;
  onEdit: () => void;
  onDelete: () => void;
}): React.ReactElement {
  const t = useT();
  const maskedUrl = useMaskedText(bookmark.url);
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      style={{ paddingLeft: 16 + depth * 24 }}
      className={`relative flex items-center gap-3 pr-4 py-3 border-b border-border last:border-b-0 hover:bg-bg-hover group transition-opacity ${
        isDragging ? 'opacity-40' : ''
      }`}
    >
      {indicator === 'above' && (
        <div className="absolute left-3 right-3 top-0 h-0.5 bg-accent rounded-full" />
      )}
      {indicator === 'below' && (
        <div className="absolute left-3 right-3 bottom-0 h-0.5 bg-accent rounded-full" />
      )}
      <GripVertical
        size={14}
        className="flex-shrink-0 text-fg-subtle opacity-0 group-hover:opacity-100 cursor-grab active:cursor-grabbing"
      />
      <div className="w-5 h-5 flex-shrink-0 flex items-center justify-center">
        {bookmark.faviconUrl ? (
          <img
            src={bookmark.faviconUrl}
            alt=""
            className="w-4 h-4 rounded-sm"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = 'none';
            }}
          />
        ) : (
          <Globe size={14} className="text-fg-muted" />
        )}
      </div>
      <button
        type="button"
        onClick={(e) => onOpen(bookmark.url, e)}
        onAuxClick={(e) => e.button === 1 && onOpen(bookmark.url, e)}
        className="flex-1 min-w-0 flex items-baseline gap-3 text-left"
        title={maskedUrl}
      >
        <span className="truncate text-sm text-fg max-w-[340px]">
          <MaskedText text={bookmark.title || bookmark.url} />
        </span>
        <span className="truncate text-xs text-fg-subtle flex-1">
          <MaskedText text={bookmark.url} />
        </span>
      </button>
      <button
        onClick={onEdit}
        className="flex-shrink-0 p-1.5 rounded-md opacity-0 group-hover:opacity-100 text-fg-muted hover:text-fg hover:bg-bg-active"
        title={t('Modifier')}
      >
        <Pencil size={12} />
      </button>
      <button
        onClick={onDelete}
        className="flex-shrink-0 p-1.5 rounded-md opacity-0 group-hover:opacity-100 text-fg-muted hover:text-danger hover:bg-danger/10"
        title={t('Supprimer')}
      >
        <Trash2 size={12} />
      </button>
    </div>
  );
}
