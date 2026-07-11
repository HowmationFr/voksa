import React, { useEffect } from 'react';
import {
  BookOpen,
  Clock,
  Download,
  Minus,
  Plus,
  Printer,
  Puzzle,
  Search,
  Settings,
  Shield,
  Terminal,
} from 'lucide-react';
import { voksa } from '../../lib/bridge';
import { useSettingsStore } from '../../stores/settingsStore';
import { useStreamStore } from '../../stores/streamStore';
import { useTabsStore } from '../../stores/tabsStore';
import { DEVTOOLS_SHORTCUT, shortcut } from '../../lib/platform';
import { useT } from '../../lib/i18n';

type Props = { onClose: () => void; onOpenFind: () => void; onOpenPrint: () => void };

export function Menu({ onClose, onOpenFind, onOpenPrint }: Props): React.ReactElement {
  const settings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.update);
  const stream = useStreamStore((s) => s.config);
  const toggleStream = useStreamStore((s) => s.toggle);
  const activeTab = useTabsStore((s) => s.tabs.find((t) => t.isActive) ?? null);
  const t = useT();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const open = (path: string) => {
    onClose();
    void voksa.tabs.create(path);
  };

  const zoom = activeTab?.zoomPercent ?? 100;

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        role="menu"
        className="fixed right-2 top-[86px] w-[288px] bg-bg-elevated border border-border rounded-2xl shadow-float z-50 animate-scale-in overflow-hidden p-1.5"
      >
        <MenuItem icon={Clock} label={t('Historique')} hint={shortcut('H')} onClick={() => open('voksa://history')} />
        <MenuItem
          icon={Download}
          label={t('Téléchargements')}
          hint={shortcut('J')}
          onClick={() => open('voksa://downloads')}
        />
        <MenuItem icon={BookOpen} label={t('Favoris')} hint={shortcut('Shift+O')} onClick={() => open('voksa://bookmarks')} />

        <Divider />

        {/* Zoom row */}
        <div className="flex items-center justify-between px-3 h-9">
          <span className="text-sm text-fg">{t('Zoom')}</span>
          <div className="flex items-center gap-1">
            <RowBtn
              disabled={!activeTab || activeTab.isInternal}
              onClick={() => activeTab && void voksa.zoom.adjust(activeTab.id, -1)}
              title={t('Zoom arrière')}
            >
              <Minus size={14} />
            </RowBtn>
            <button
              onClick={() => activeTab && void voksa.zoom.reset(activeTab.id)}
              className="w-12 text-center text-xs text-fg-muted hover:text-fg tabular-nums"
              title={t('Réinitialiser')}
            >
              {zoom}%
            </button>
            <RowBtn
              disabled={!activeTab || activeTab.isInternal}
              onClick={() => activeTab && void voksa.zoom.adjust(activeTab.id, 1)}
              title={t('Zoom avant')}
            >
              <Plus size={14} />
            </RowBtn>
          </div>
        </div>

        <MenuItem
          icon={Search}
          label={t('Rechercher dans la page')}
          hint={shortcut('F')}
          onClick={() => {
            onClose();
            onOpenFind();
          }}
        />
        <MenuItem
          icon={Printer}
          label={t('Imprimer…')}
          hint={shortcut('P')}
          disabled={!activeTab || activeTab.isInternal}
          onClick={() => {
            onOpenPrint();
            onClose();
          }}
        />

        <Divider />

        <MenuItem
          icon={Shield}
          label={stream.enabled ? t('Mode Stream : activé') : t('Mode Stream : désactivé')}
          onClick={() => {
            void toggleStream();
            onClose();
          }}
          accent={stream.enabled}
        />
        <MenuItem icon={Shield} label={t('Paramètres du Mode Stream')} onClick={() => open('voksa://stream')} />

        <Divider />

        <MenuItem icon={Puzzle} label={t('Extensions')} onClick={() => open('voksa://extensions')} />
        <MenuItem icon={Settings} label={t('Paramètres')} onClick={() => open('voksa://settings')} />
        <MenuItem
          icon={Terminal}
          label={t('Outils de développement')}
          hint={DEVTOOLS_SHORTCUT}
          onClick={() => {
            void voksa.app.openDevTools();
            onClose();
          }}
        />

        <Divider />

        <div className="flex items-center justify-between px-3 h-9">
          <span className="text-sm text-fg">{t('Barre de favoris')}</span>
          <button
            className="toggle-switch"
            data-on={settings.showBookmarkBar}
            onClick={() => void updateSettings({ showBookmarkBar: !settings.showBookmarkBar })}
            aria-label={t('Afficher la barre de favoris')}
          />
        </div>
      </div>
    </>
  );
}

function Divider(): React.ReactElement {
  return <div className="my-1.5 h-px bg-border mx-2" />;
}

function RowBtn({
  children,
  onClick,
  disabled,
  title,
}: React.PropsWithChildren<{ onClick: () => void; disabled?: boolean; title: string }>): React.ReactElement {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="w-7 h-7 rounded-lg flex items-center justify-center text-fg-muted hover:text-fg hover:bg-bg-hover disabled:opacity-30"
    >
      {children}
    </button>
  );
}

function MenuItem({
  icon: Icon,
  label,
  hint,
  onClick,
  disabled,
  accent,
}: {
  icon: React.ComponentType<{ size?: number | string; className?: string }>;
  label: string;
  hint?: string;
  onClick?: () => void;
  disabled?: boolean;
  accent?: boolean;
}): React.ReactElement {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      className={`w-full flex items-center gap-3 px-3 h-9 rounded-lg text-sm transition-colors ${
        disabled
          ? 'text-fg-subtle cursor-not-allowed'
          : accent
            ? 'text-stream hover:bg-stream/10'
            : 'text-fg hover:bg-bg-hover'
      }`}
    >
      <Icon size={16} className={`flex-shrink-0 ${accent ? 'text-stream' : 'text-fg-muted'}`} />
      <span className="flex-1 text-left">{label}</span>
      {hint && <span className="text-2xs text-fg-subtle tabular-nums">{hint}</span>}
    </button>
  );
}
