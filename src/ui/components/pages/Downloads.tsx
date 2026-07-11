import React, { useEffect, useState } from 'react';
import { Download, Folder, X, Pause, Play, RotateCcw, Trash2, FileDown } from 'lucide-react';
import { voksa } from '../../lib/bridge';
import type { DownloadItem } from '../../../shared/types';
import { useT } from '../../lib/i18n';

function formatBytes(n: number, t: (source: string) => string): string {
  if (!n) return `0 ${t('o')}`;
  const units = ['o', 'Ko', 'Mo', 'Go'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${t(units[i])}`;
}

export function DownloadsPage(): React.ReactElement {
  const t = useT();
  const [items, setItems] = useState<DownloadItem[]>([]);

  useEffect(() => {
    void voksa.downloads.list().then(setItems);
    return voksa.downloads.onChanged(setItems);
  }, []);

  return (
    <div className="max-w-3xl mx-auto px-6 py-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-fg flex items-center gap-2">
          <Download size={20} /> {t('Téléchargements')}
        </h1>
        {items.length > 0 && (
          <button
            onClick={() => void voksa.downloads.clear()}
            className="text-[13px] text-fg-muted hover:text-fg flex items-center gap-1.5"
          >
            <Trash2 size={14} /> {t('Effacer la liste')}
          </button>
        )}
      </div>

      {items.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 text-fg-subtle">
          <FileDown size={40} className="mb-3 opacity-40" />
          <p className="text-[13px]">{t('Aucun téléchargement')}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {items.map((d) => {
            const pct = d.totalBytes > 0 ? Math.round((d.receivedBytes / d.totalBytes) * 100) : 0;
            const inProgress = d.state === 'progressing' || d.state === 'paused';
            return (
              <div
                key={d.id}
                className="flex items-center gap-3 p-3 rounded-xl border border-border bg-bg-elevated"
              >
                <div className="flex-shrink-0 w-9 h-9 rounded-lg bg-bg-hover flex items-center justify-center text-fg-muted">
                  <FileDown size={18} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-medium text-fg truncate">{d.filename}</div>
                  <div className="text-[12px] text-fg-subtle truncate">
                    {d.state === 'completed'
                      ? formatBytes(d.receivedBytes, t)
                      : d.state === 'cancelled'
                        ? t('Annulé')
                        : d.state === 'interrupted'
                          ? t('Interrompu')
                          : `${formatBytes(d.receivedBytes, t)} / ${formatBytes(d.totalBytes, t)} · ${pct}%`}
                  </div>
                  {inProgress && (
                    <div className="mt-1.5 h-1 rounded-full bg-bg-hover overflow-hidden">
                      <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
                    </div>
                  )}
                </div>
                <div className="flex-shrink-0 flex items-center gap-1">
                  {inProgress ? (
                    <>
                      {d.paused ? (
                        <IconBtn title={t('Reprendre')} onClick={() => void voksa.downloads.resume(d.id)}>
                          <Play size={15} />
                        </IconBtn>
                      ) : (
                        <IconBtn title={t('Pause')} onClick={() => void voksa.downloads.pause(d.id)}>
                          <Pause size={15} />
                        </IconBtn>
                      )}
                      <IconBtn title={t('Annuler')} onClick={() => void voksa.downloads.cancel(d.id)}>
                        <X size={15} />
                      </IconBtn>
                    </>
                  ) : d.state === 'completed' ? (
                    <>
                      <IconBtn title={t('Ouvrir')} onClick={() => void voksa.downloads.open(d.id)}>
                        <Play size={15} />
                      </IconBtn>
                      <IconBtn title={t('Dossier')} onClick={() => void voksa.downloads.openFolder(d.id)}>
                        <Folder size={15} />
                      </IconBtn>
                      <IconBtn title={t('Retirer')} onClick={() => void voksa.downloads.remove(d.id)}>
                        <Trash2 size={15} />
                      </IconBtn>
                    </>
                  ) : (
                    <IconBtn title={t('Retirer')} onClick={() => void voksa.downloads.remove(d.id)}>
                      <RotateCcw size={15} />
                    </IconBtn>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function IconBtn({
  children,
  onClick,
  title,
}: React.PropsWithChildren<{ onClick: () => void; title: string }>): React.ReactElement {
  return (
    <button
      onClick={onClick}
      title={title}
      className="p-1.5 rounded-lg text-fg-muted hover:text-fg hover:bg-bg-hover"
    >
      {children}
    </button>
  );
}
