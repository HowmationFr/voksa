import React from 'react';
import { ArrowDown, ArrowUp, Puzzle, Trash2 } from 'lucide-react';
import { useExtensionsStore } from '../../stores/extensionsStore';
import { voksa } from '../../lib/bridge';
import { askConfirm } from '../ui/ConfirmDialog';
import type { ExtensionInfo } from '../../../shared/types';
import { useT } from '../../lib/i18n';

export function ExtensionsSection(): React.ReactElement {
  const t = useT();
  const extensions = useExtensionsStore((s) => s.extensions);

  const move = (id: string, delta: number) => {
    const ids = extensions.map((e) => e.id);
    const idx = ids.indexOf(id);
    if (idx === -1) return;
    const target = idx + delta;
    if (target < 0 || target >= ids.length) return;
    const next = [...ids];
    [next[idx], next[target]] = [next[target], next[idx]];
    void voksa.extensions.reorder(next);
  };

  const remove = async (ext: ExtensionInfo) => {
    const ok = await askConfirm({
      title: t('Désinstaller « {name} » ?', { name: ext.name }),
      confirmLabel: t('Désinstaller'),
      danger: true,
    });
    if (!ok) return;
    void voksa.extensions.uninstall(ext.id);
  };

  if (extensions.length === 0) {
    return (
      <div className="bg-bg-elevated border border-border rounded-xl px-4 py-6 text-center">
        <Puzzle size={22} className="text-fg-subtle mx-auto mb-2" />
        <p className="text-[13px] text-fg-muted">
          {t('Aucune extension installée. Rendez-vous sur')}{' '}
          <button
            type="button"
            onClick={() => {
              void voksa.tabs.create('https://chromewebstore.google.com');
            }}
            className="text-accent hover:underline"
          >
            chromewebstore.google.com
          </button>{' '}
          {t('pour en ajouter.')}
        </p>
      </div>
    );
  }

  return (
    <div className="bg-bg-elevated border border-border rounded-xl divide-y divide-border overflow-hidden">
      {extensions.map((ext, i) => (
        <div key={ext.id} className="flex items-center gap-3 px-4 py-3">
          <div className="w-8 h-8 flex-shrink-0 flex items-center justify-center">
            {ext.iconUrl ? (
              <img
                src={ext.iconUrl}
                alt=""
                className="w-7 h-7 rounded"
                onError={(e) => {
                  (e.currentTarget as HTMLImageElement).style.display = 'none';
                }}
              />
            ) : (
              <Puzzle size={18} className="text-fg-muted" />
            )}
          </div>

          <div className="flex-1 min-w-0">
            <div className="text-[13px] font-medium text-fg truncate">{ext.name}</div>
            <div className="text-[11px] text-fg-muted truncate">
              {ext.description || t('Version {version}', { version: ext.version })}
            </div>
          </div>

          <div className="flex items-center gap-1 flex-shrink-0">
            <button
              type="button"
              onClick={() => move(ext.id, -1)}
              disabled={i === 0}
              title={t('Monter')}
              className="p-1.5 rounded text-fg-muted hover:text-fg hover:bg-bg-hover disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-fg-muted"
            >
              <ArrowUp size={14} />
            </button>
            <button
              type="button"
              onClick={() => move(ext.id, 1)}
              disabled={i === extensions.length - 1}
              title={t('Descendre')}
              className="p-1.5 rounded text-fg-muted hover:text-fg hover:bg-bg-hover disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-fg-muted"
            >
              <ArrowDown size={14} />
            </button>
            <button
              type="button"
              onClick={() => void remove(ext)}
              title={t('Désinstaller')}
              className="p-1.5 rounded text-fg-muted hover:text-stream hover:bg-stream/10"
            >
              <Trash2 size={14} />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
