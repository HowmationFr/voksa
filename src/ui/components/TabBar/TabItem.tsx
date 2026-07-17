import React from 'react';
import { Globe, Loader2, Volume2, VolumeX, X } from 'lucide-react';
import type { TabState } from '../../../shared/types';
import { voksa } from '../../lib/bridge';
import { MaskedText } from '../MaskedText';
import { useMaskedText } from '../../lib/masking';
import { shortcut } from '../../lib/platform';
import { useT } from '../../lib/i18n';

type Props = {
  tab: TabState;
  isDragging?: boolean;
  dropIndicator?: 'left' | 'right' | null;
  onDragStart?: (e: React.DragEvent) => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
};

export function TabItem({
  tab,
  isDragging,
  dropIndicator,
  onDragStart,
  onDragOver,
  onDrop,
  onContextMenu,
}: Props): React.ReactElement {
  const t = useT();
  const handleClick = () => void voksa.tabs.activate(tab.id);
  const handleClose = (e: React.MouseEvent) => {
    e.stopPropagation();
    void voksa.tabs.close(tab.id);
  };
  const handleMute = (e: React.MouseEvent) => {
    e.stopPropagation();
    void voksa.tabs.mute(tab.id);
  };
  const handleAuxClick = (e: React.MouseEvent) => {
    if (e.button === 1) {
      e.preventDefault();
      void voksa.tabs.close(tab.id);
    }
  };

  const maskedTitle = useMaskedText(tab.title || tab.url);

  // A pinned tab is a fixed favicon-only tile: no title, no close button
  // (Ctrl+W is a no-op on it too; closing goes through the context menu or a
  // middle-click, both deliberate gestures). The tooltip still carries the
  // masked title, so hovering identifies it.
  if (tab.pinned) {
    return (
      <div className="relative flex-shrink-0 no-drag">
        {dropIndicator === 'left' && (
          <div className="absolute -left-[3px] top-1.5 bottom-1.5 w-[3px] bg-accent rounded-full z-10" />
        )}
        {dropIndicator === 'right' && (
          <div className="absolute -right-[3px] top-1.5 bottom-1.5 w-[3px] bg-accent rounded-full z-10" />
        )}
        <div
          draggable
          data-voksa-pinned-tab
          onDragStart={onDragStart}
          onDragOver={onDragOver}
          onDrop={onDrop}
          onClick={handleClick}
          onAuxClick={handleAuxClick}
          onContextMenu={onContextMenu}
          className={`flex items-center justify-center w-9 h-8 rounded-lg cursor-default select-none transition-colors no-drag border ${
            tab.isActive
              ? 'bg-bg-elevated text-fg shadow-soft border-transparent'
              : 'bg-bg-inset/70 border-border/70 text-fg-muted hover:bg-bg-hover hover:text-fg hover:border-border'
          } ${isDragging ? 'opacity-40' : ''} ${tab.isDiscarded ? 'opacity-60' : ''}`}
          title={maskedTitle}
        >
          {tab.isLoading ? (
            <Loader2 size={13} className="animate-spin text-accent" />
          ) : tab.favicon ? (
            <img
              src={tab.favicon}
              alt=""
              className={`w-4 h-4 rounded-sm ${tab.isDiscarded ? 'grayscale' : ''}`}
              onError={(e) => {
                const img = e.currentTarget as HTMLImageElement;
                img.style.display = 'none';
                img.nextElementSibling?.classList.remove('hidden');
              }}
            />
          ) : null}
          {!tab.isLoading && (
            <Globe size={13} className={`text-fg-subtle ${tab.favicon ? 'hidden' : ''}`} />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex-1 min-w-0 max-w-[220px] no-drag">
      {dropIndicator === 'left' && (
        <div className="absolute -left-[3px] top-1.5 bottom-1.5 w-[3px] bg-accent rounded-full z-10" />
      )}
      {dropIndicator === 'right' && (
        <div className="absolute -right-[3px] top-1.5 bottom-1.5 w-[3px] bg-accent rounded-full z-10" />
      )}
      <div
        draggable
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDrop={onDrop}
        onClick={handleClick}
        onAuxClick={handleAuxClick}
        onContextMenu={onContextMenu}
        className={`group flex items-center gap-2 h-8 pl-2.5 pr-1.5 rounded-lg cursor-default select-none transition-colors no-drag border ${
          tab.isActive
            ? 'bg-bg-elevated text-fg shadow-soft border-transparent'
            : // Inactive tabs need their own visible surface: on the flat bar
              // background they otherwise blend in completely and nothing
              // delimits one tab from the next.
              'bg-bg-inset/70 border-border/70 text-fg-muted hover:bg-bg-hover hover:text-fg hover:border-border'
        } ${isDragging ? 'opacity-40' : ''} ${
          // Memory Saver: a tab whose renderer was freed. Dimmed like Chrome
          // does, so "it reloaded when I came back" is never a surprise.
          tab.isDiscarded ? 'opacity-60' : ''
        }`}
        title={
          tab.isDiscarded
            ? t('{title} (en veille, mémoire libérée)', { title: maskedTitle })
            : maskedTitle
        }
      >
        <div className="flex-shrink-0 w-4 h-4 flex items-center justify-center">
          {tab.isLoading ? (
            <Loader2 size={13} className="animate-spin text-accent" />
          ) : tab.favicon ? (
            <img
              src={tab.favicon}
              alt=""
              className={`w-4 h-4 rounded-sm ${tab.isDiscarded ? 'grayscale' : ''}`}
              onError={(e) => {
                const img = e.currentTarget as HTMLImageElement;
                img.style.display = 'none';
                img.nextElementSibling?.classList.remove('hidden');
              }}
            />
          ) : null}
          {!tab.isLoading && (
            <Globe size={13} className={`text-fg-subtle ${tab.favicon ? 'hidden' : ''}`} />
          )}
        </div>
        <span className="flex-1 truncate text-sm font-medium leading-none">
          <MaskedText text={tab.title || t('Nouvel onglet')} />
        </span>
        {tab.streamMuted ? (
          // DMCA Audio Guard chip: this background tab went audible under
          // Stream Mode and was muted before its sound reached the stream.
          // Clicking is the EXPLICIT allow (per tab, for its lifetime);
          // activating the tab deliberately does not lift it.
          <button
            data-voksa-stream-muted
            onClick={(e) => {
              e.stopPropagation();
              void voksa.tabs.allowStreamAudio(tab.id);
            }}
            className="flex-shrink-0 p-1 rounded-md text-stream hover:bg-stream-muted no-drag"
            title={t('Muté pour le stream : cliquer pour autoriser le son')}
          >
            <VolumeX size={12} />
          </button>
        ) : (
          (tab.isAudible || tab.isMuted) && (
            <button
              onClick={handleMute}
              className="flex-shrink-0 p-1 rounded-md hover:bg-bg-active text-fg-muted no-drag"
              title={tab.isMuted ? t('Réactiver le son') : t('Couper le son')}
            >
              {tab.isMuted ? <VolumeX size={12} /> : <Volume2 size={12} />}
            </button>
          )
        )}
        <button
          onClick={handleClose}
          className={`flex-shrink-0 p-1 rounded-md hover:bg-bg-active transition-opacity no-drag ${
            tab.isActive ? 'opacity-70 hover:opacity-100' : 'opacity-0 group-hover:opacity-100'
          }`}
          title={t('Fermer ({shortcut})', { shortcut: shortcut('W') })}
        >
          <X size={12} />
        </button>
      </div>
    </div>
  );
}
