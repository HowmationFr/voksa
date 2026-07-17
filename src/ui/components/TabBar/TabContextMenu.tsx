import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Volume2 } from 'lucide-react';
import type { TabState } from '../../../shared/types';
import { routableOutputs, type AudioOutputChoice } from '../../../shared/audioRouting';
import { voksa } from '../../lib/bridge';
import { useT } from '../../lib/i18n';
import { MaskedText } from '../MaskedText';

type Props = {
  tab: TabState;
  x: number;
  y: number;
  onClose: () => void;
};

export function TabContextMenu({ tab, x, y, onClose }: Props): React.ReactElement {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  // DMCA stage 2 submenu: expanded inline (a flyout would clip at the window
  // edge). Devices are enumerated on open, in the chrome view (always allowed
  // by the permission carve-out); only LABELS are used, ids are origin-hashed.
  const [audioOpen, setAudioOpen] = useState(false);
  const [outputs, setOutputs] = useState<AudioOutputChoice[] | null>(null);
  // Vertical clamp, measured AFTER the chromeView expanded (double-rAF, same
  // pattern as BookmarkContextMenu): window.innerHeight at right-click time
  // is the collapsed toolbar height, useless for clamping. Re-measured when
  // the audio submenu grows the menu.
  const [top, setTop] = useState(y);
  useEffect(() => {
    let raf1 = 0;
    let raf2 = 0;
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        const h = ref.current?.offsetHeight ?? 0;
        setTop(Math.max(8, Math.min(y, window.innerHeight - h - 8)));
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [y, audioOpen, outputs]);

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

  useEffect(() => {
    if (!audioOpen) return;
    let alive = true;
    const md = navigator.mediaDevices;
    if (!md?.enumerateDevices) {
      setOutputs([]);
      return;
    }
    const refresh = () => {
      void md
        .enumerateDevices()
        .then((list) => {
          if (!alive) return;
          setOutputs(
            routableOutputs(
              list.map((d) => ({ deviceId: d.deviceId, kind: d.kind, label: d.label })),
            ),
          );
        })
        .catch(() => {
          if (alive) setOutputs([]);
        });
    };
    refresh();
    // Unplugging a device while the submenu is open must drop its row (the
    // route itself is cleared by main through the fail-visible status path).
    try {
      md.addEventListener('devicechange', refresh);
    } catch {
      // ignore
    }
    return () => {
      alive = false;
      try {
        md.removeEventListener('devicechange', refresh);
      } catch {
        // ignore
      }
    };
  }, [audioOpen]);

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

  const routeItem = (label: string | null, display: React.ReactNode) => {
    const selected = tab.audioRoute === label;
    return (
      <button
        key={label ?? '__default'}
        onClick={() => {
          void voksa.tabs.setAudioRoute(tab.id, label);
          onClose();
        }}
        className="w-full text-left pl-7 pr-3 h-8 text-[13px] rounded-md text-fg hover:bg-bg-hover flex items-center gap-2"
      >
        <span className="w-3.5 shrink-0 -ml-4">
          {selected && <Check size={13} className="text-accent" />}
        </span>
        <span className="truncate">{display}</span>
      </button>
    );
  };

  return (
    <div
      ref={ref}
      className="fixed z-[60] w-56 py-1 bg-bg-elevated border border-border rounded-xl shadow-light-strong animate-scale-in overflow-y-auto"
      style={{ left: Math.min(x, window.innerWidth - 232), top, maxHeight: 'calc(100vh - 16px)' }}
    >
      {item(t('Recharger'), () => void voksa.tabs.reload(tab.id))}
      {item(t('Dupliquer'), () => void voksa.tabs.duplicate(tab.id))}
      {item(tab.pinned ? t('Désépingler l’onglet') : t('Épingler l’onglet'), () =>
        void voksa.tabs.setPinned(tab.id, !tab.pinned),
      )}
      {item(tab.isMuted ? t('Réactiver le son') : t('Couper le son'), () =>
        void voksa.tabs.mute(tab.id),
      )}
      {/* DMCA stage 2: per-tab audio output. Internal pages render in the
          chrome view and have no page audio to route. */}
      {!tab.isInternal && (
        <>
          <button
            onClick={() => setAudioOpen((v) => !v)}
            className="w-full text-left px-3 h-8 text-[13px] rounded-md text-fg hover:bg-bg-hover flex items-center gap-2"
          >
            <Volume2 size={14} className="text-fg-muted shrink-0" />
            <span className="flex-1">{t('Sortie audio')}</span>
            {audioOpen ? (
              <ChevronDown size={14} className="text-fg-muted" />
            ) : (
              <ChevronRight size={14} className="text-fg-muted" />
            )}
          </button>
          {audioOpen && (
            <div className="max-h-44 overflow-y-auto">
              {routeItem(null, t('Sortie système (par défaut)'))}
              {outputs === null && (
                <div className="pl-7 pr-3 h-8 flex items-center text-[12px] text-fg-subtle">
                  {t('Recherche des périphériques…')}
                </div>
              )}
              {outputs !== null && outputs.length === 0 && (
                <div className="pl-7 pr-3 h-8 flex items-center text-[12px] text-fg-subtle">
                  {t('Aucune autre sortie détectée')}
                </div>
              )}
              {outputs?.map((o) => routeItem(o.label, <MaskedText text={o.label} />))}
            </div>
          )}
        </>
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
