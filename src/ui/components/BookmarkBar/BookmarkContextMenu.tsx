import React from 'react';
import { ExternalLink, Pencil, Trash2 } from 'lucide-react';
import type { Bookmark } from '../../../shared/types';
import { useT } from '../../lib/i18n';
import { ContextMenuItem, ContextMenuSeparator, ContextMenuShell } from './ContextMenuShell';

type Props = {
  x: number;
  y: number;
  bookmark: Bookmark;
  onClose: () => void;
  onEdit: (b: Bookmark) => void;
  onDelete: (b: Bookmark) => void;
  onOpenInNewTab: (b: Bookmark) => void;
};

export function BookmarkContextMenu({
  x,
  y,
  bookmark,
  onClose,
  onEdit,
  onDelete,
  onOpenInNewTab,
}: Props): React.ReactElement {
  const t = useT();
  return (
    <ContextMenuShell x={x} y={y} onClose={onClose}>
      <ContextMenuItem
        icon={ExternalLink}
        label={t('Ouvrir dans un nouvel onglet')}
        onClick={() => onOpenInNewTab(bookmark)}
      />
      <ContextMenuItem icon={Pencil} label={t('Modifier')} onClick={() => onEdit(bookmark)} />
      <ContextMenuSeparator />
      <ContextMenuItem icon={Trash2} label={t('Supprimer')} onClick={() => onDelete(bookmark)} danger />
    </ContextMenuShell>
  );
}
