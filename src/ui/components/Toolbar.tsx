import React, { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, Download, Home, MoreVertical, RotateCw, Shield, X } from 'lucide-react';
import { AddressBar } from './AddressBar/AddressBar';
import { ExtensionActions } from './ExtensionActions';
import { useTabsStore } from '../stores/tabsStore';
import { useStreamStore } from '../stores/streamStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useUpdateReady } from '../stores/updatesStore';
import { voksa } from '../lib/bridge';
import type { DownloadItem } from '../../shared/types';
import { shortcut } from '../lib/platform';
import { useT } from '../lib/i18n';

type Props = {
  onOpenMenu: () => void;
  onSuggestionsVisibleChange?: (visible: boolean) => void;
  onSiteSettingsOpenChange?: (open: boolean) => void;
  focusSignal?: number;
  bookmarkSignal?: number;
};

export function Toolbar({
  onOpenMenu,
  onSuggestionsVisibleChange,
  onSiteSettingsOpenChange,
  focusSignal,
  bookmarkSignal,
}: Props): React.ReactElement {
  const t = useT();
  const active = useTabsStore((s) => s.tabs.find((t) => t.isActive) ?? null);
  const stream = useStreamStore((s) => s.config);
  const homepage = useSettingsStore((s) => s.settings.homepage);
  const updateReady = useUpdateReady();
  const [downloads, setDownloads] = useState<DownloadItem[]>([]);

  useEffect(() => {
    void voksa.downloads.list().then(setDownloads);
    return voksa.downloads.onChanged(setDownloads);
  }, []);

  const activeDownloads = downloads.filter((d) => d.state === 'progressing' || d.state === 'paused');

  const canBack = !!active && active.canGoBack;
  const canFwd = !!active && active.canGoForward;
  const isLoading = !!active && active.isLoading;
  const zoom = active?.zoomPercent ?? 100;

  const onBack = () => active && void voksa.tabs.back(active.id);
  const onFwd = () => active && void voksa.tabs.forward(active.id);
  const onReload = () =>
    active && (isLoading ? void voksa.tabs.stop(active.id) : void voksa.tabs.reload(active.id));
  const onHome = () => active && void voksa.tabs.navigate(active.id, homepage || 'voksa://newtab');

  const openStreamPage = () => void voksa.tabs.create('voksa://stream');
  const onToggleStream = (e: React.MouseEvent) => {
    if (e.altKey || e.shiftKey) {
      openStreamPage();
      return;
    }
    void voksa.stream.toggle();
  };

  return (
    <div className="flex items-center gap-1 h-12 px-2 no-drag">
      <IconButton disabled={!canBack} onClick={onBack} title={t('Précédent (Alt+←)')}>
        <ArrowLeft size={18} />
      </IconButton>
      <IconButton disabled={!canFwd} onClick={onFwd} title={t('Suivant (Alt+→)')}>
        <ArrowRight size={18} />
      </IconButton>
      <IconButton
        onClick={onReload}
        title={isLoading ? t('Arrêter') : t('Recharger ({shortcut})', { shortcut: shortcut('R') })}
      >
        {isLoading ? <X size={18} /> : <RotateCw size={18} />}
      </IconButton>
      <IconButton onClick={onHome} title={t('Accueil')}>
        <Home size={18} />
      </IconButton>

      <div className="flex-1 mx-2">
        <AddressBar
          onSuggestionsVisibleChange={onSuggestionsVisibleChange}
          onSiteSettingsOpenChange={onSiteSettingsOpenChange}
          focusSignal={focusSignal}
          bookmarkSignal={bookmarkSignal}
        />
      </div>

      {active && !active.isInternal && zoom !== 100 && (
        <button
          onClick={() => void voksa.zoom.reset(active.id)}
          title={t('Réinitialiser le zoom')}
          className="px-2 h-7 rounded-lg text-[12px] text-fg-muted hover:text-fg hover:bg-bg-hover no-drag tabular-nums"
        >
          {zoom}%
        </button>
      )}

      <ExtensionActions />

      <button
        onClick={() => void voksa.tabs.create('voksa://downloads')}
        title={t('Téléchargements ({shortcut})', { shortcut: shortcut('J') })}
        className="relative flex items-center justify-center w-9 h-9 rounded-lg text-fg-muted hover:text-fg hover:bg-bg-hover no-drag"
      >
        <Download size={18} />
        {activeDownloads.length > 0 && (
          <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-accent" />
        )}
      </button>

      <button
        onClick={onToggleStream}
        onContextMenu={(e) => {
          e.preventDefault();
          openStreamPage();
        }}
        aria-label={stream.enabled ? t('Mode Stream actif') : t('Activer le Mode Stream')}
        className={`flex items-center justify-center w-9 h-9 rounded-lg transition-colors no-drag ${
          stream.enabled
            ? 'bg-stream/15 text-stream border border-stream/30'
            : 'text-fg-muted hover:text-fg hover:bg-bg-hover border border-transparent'
        }`}
        title={
          stream.enabled
            ? t('Mode Stream actif : clic pour désactiver, Alt+clic pour les paramètres')
            : t('Activer le Mode Stream ({shortcut})', { shortcut: shortcut('Shift+S') })
        }
      >
        <Shield size={16} />
      </button>

      {/* Raw button (not IconButton): it needs `relative` to anchor the update
          dot, same treatment the downloads button already got. */}
      <button
        onClick={onOpenMenu}
        title={updateReady ? t('Menu : une mise à jour est prête') : t('Menu')}
        className="relative flex items-center justify-center w-9 h-9 rounded-lg text-fg-muted hover:text-fg hover:bg-bg-hover transition-colors no-drag"
      >
        <MoreVertical size={18} />
        {updateReady && (
          <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-accent" />
        )}
      </button>
    </div>
  );
}

function IconButton({
  children,
  onClick,
  disabled,
  title,
}: React.PropsWithChildren<{
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
}>): React.ReactElement {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="p-2 rounded-lg text-fg-muted hover:text-fg hover:bg-bg-hover disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-fg-muted transition-colors no-drag"
    >
      {children}
    </button>
  );
}
