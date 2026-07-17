import React, { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { TabItem } from './TabItem';
import { TabContextMenu } from './TabContextMenu';
import { useTabsStore } from '../../stores/tabsStore';
import { voksa } from '../../lib/bridge';
import { WindowControls } from '../WindowControls';
import { shortcut } from '../../lib/platform';
import { useT } from '../../lib/i18n';

const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);

type Props = {
  /**
   * Overlay refcount hook (CLAUDE.md 4.8): the context menu extends well
   * below the toolbar block, so the chromeView must expand while it is open
   * or everything past the first rows is clipped (and clicks land on the
   * page). Threaded to Chrome.tsx; TabBar never calls setOverlayMode itself.
   */
  onMenuOpenChange?: (open: boolean) => void;
};

export function TabBar({ onMenuOpenChange }: Props): React.ReactElement {
  const t = useT();
  const tabs = useTabsStore((s) => s.tabs);

  // --- Drag-and-drop state (tab reorder) ------------------------------------
  // We track which tab is being dragged and which tab the pointer is hovering
  // over. TabItem draws the insertion indicator based on `dropTarget`.
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<
    { id: string; side: 'left' | 'right' } | null
  >(null);
  // Only the tab ID is stored: the menu resolves the LIVE TabState at every
  // render, so its checkmarks and labels track TAB_UPDATED pushes instead of
  // freezing the right-click snapshot. A closed tab dissolves the menu.
  const [ctxMenu, setCtxMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const ctxTab = ctxMenu ? (tabs.find((tb) => tb.id === ctxMenu.id) ?? null) : null;

  useEffect(() => {
    if (ctxMenu && !ctxTab) setCtxMenu(null);
  }, [ctxMenu, ctxTab]);
  useEffect(() => {
    onMenuOpenChange?.(ctxMenu !== null);
  }, [ctxMenu, onMenuOpenChange]);

  const onTabDragStart = (e: React.DragEvent, id: string) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/voksa-tab', id);
    setDragId(id);
  };

  const onTabDragOver = (e: React.DragEvent, id: string) => {
    if (!dragId || dragId === id) return;
    // A drag never crosses the pinned-cluster boundary: main would clamp the
    // order anyway (the invariant is structural there), so the indicator must
    // not promise a drop that will be snapped back.
    const dragged = tabs.find((t) => t.id === dragId);
    const target = tabs.find((t) => t.id === id);
    if (!dragged || !target || dragged.pinned !== target.pinned) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const side: 'left' | 'right' =
      e.clientX < rect.left + rect.width / 2 ? 'left' : 'right';
    setDropTarget({ id, side });
  };

  const onTabDragEnd = () => {
    setDragId(null);
    setDropTarget(null);
  };

  const onTabDrop = (e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    const draggedId = e.dataTransfer.getData('text/voksa-tab');
    if (!draggedId || draggedId === targetId) {
      onTabDragEnd();
      return;
    }
    const targetIdx = tabs.findIndex((t) => t.id === targetId);
    const draggedOriginalIdx = tabs.findIndex((t) => t.id === draggedId);
    const dragged = tabs.find((t) => t.id === draggedId);
    if (!dragged || targetIdx === -1 || draggedOriginalIdx === -1) {
      onTabDragEnd();
      return;
    }
    const side = dropTarget?.id === targetId ? dropTarget.side : 'right';
    const insertIdx = side === 'left' ? targetIdx : targetIdx + 1;
    const withoutDragged = tabs.filter((t) => t.id !== draggedId);
    const adjusted = draggedOriginalIdx < targetIdx ? insertIdx - 1 : insertIdx;
    const reordered = [
      ...withoutDragged.slice(0, adjusted),
      dragged,
      ...withoutDragged.slice(adjusted),
    ];
    void voksa.tabs.reorder(reordered.map((t) => t.id));
    onTabDragEnd();
  };

  return (
    // The outer bar is a window drag region. The tabs container IS ALSO a
    // drag region (no `no-drag` class here): individual TabItems and the
    // + button carry `no-drag` on themselves, so the empty gap between the
    // last tab and the right edge (plus any strip below the overflow when
    // tabs are few) is grabbable to move the window. On macOS the 84px
    // left stub is reserved for the native traffic lights (x:14, ~52px wide)
    // plus a small breathing gap before the first tab.
    <div className="flex items-center h-11 pt-1.5 drag-region" onDragEnd={onTabDragEnd}>
      {isMac && <div className="w-[84px] flex-shrink-0" />}
      <div className="flex flex-1 items-center gap-1 min-w-0 px-2">
        {tabs.map((tab) => (
          <TabItem
            key={tab.id}
            tab={tab}
            isDragging={dragId === tab.id}
            dropIndicator={dropTarget?.id === tab.id ? dropTarget.side : null}
            onDragStart={(e) => onTabDragStart(e, tab.id)}
            onDragOver={(e) => onTabDragOver(e, tab.id)}
            onDrop={(e) => onTabDrop(e, tab.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              setCtxMenu({ id: tab.id, x: e.clientX, y: e.clientY });
            }}
          />
        ))}
        <button
          aria-label={t('Nouvel onglet')}
          className="no-drag flex-shrink-0 self-center w-7 h-7 rounded-lg flex items-center justify-center text-fg-muted hover:text-fg hover:bg-bg-hover transition-colors"
          title={t('Nouvel onglet ({shortcut})', { shortcut: shortcut('T') })}
          onClick={() => void voksa.tabs.create()}
        >
          <Plus size={16} />
        </button>
      </div>
      <WindowControls />
      {ctxMenu && ctxTab && (
        <TabContextMenu
          tab={ctxTab}
          x={ctxMenu.x}
          y={ctxMenu.y}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </div>
  );
}
