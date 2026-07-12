import React, { useEffect, useRef } from 'react';
import type { TabState } from '../../../shared/types';
import { voksa } from '../../lib/bridge';
import { useT } from '../../lib/i18n';

type Props = {
  tab: TabState;
  x: number;
  y: number;
  onClose: () => void;
};

export function TabContextMenu({ tab, x, y, onClose }: Props): React.ReactElement {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const item = (label: string, fn: () => void, danger = false) => (
    <button
      onClick={() => {
        fn();
        onClose();
      }}
      className={`w-full text-left px-3 h-8 text-[13px] rounded-md ${
        danger ? 'text-danger hover:bg-danger/10' : 'text-fg hover:bg-bg-hover'
      }`}
    >
      {label}
    </button>
  );

  return (
    <div
      ref={ref}
      className="fixed z-[60] w-56 py-1 bg-bg-elevated border border-border rounded-xl shadow-light-strong animate-scale-in"
      style={{ left: Math.min(x, window.innerWidth - 232), top: y }}
    >
      {item(t('Recharger'), () => void voksa.tabs.reload(tab.id))}
      {item(t('Dupliquer'), () => void voksa.tabs.duplicate(tab.id))}
      {item(tab.isMuted ? t('Réactiver le son') : t('Couper le son'), () =>
        void voksa.tabs.mute(tab.id),
      )}
      {/* Memory Saver, on demand. Hidden where discard() would refuse anyway
          (the visible tab, an internal page, an already dormant tab): a dead
          menu entry is worse than no entry. */}
      {!tab.isActive &&
        !tab.isInternal &&
        !tab.isDiscarded &&
        item(t('Mettre en veille (libérer la mémoire)'), () => void voksa.tabs.discard(tab.id))}
      <div className="my-1 h-px bg-border mx-2" />
      {item(t('Rouvrir l’onglet fermé'), () => void voksa.tabs.reopenClosed())}
      <div className="my-1 h-px bg-border mx-2" />
      {item(t('Fermer les autres onglets'), () => void voksa.tabs.closeOthers(tab.id))}
      {item(t('Fermer les onglets à droite'), () => void voksa.tabs.closeRight(tab.id))}
      {item(t('Fermer'), () => void voksa.tabs.close(tab.id), true)}
    </div>
  );
}
