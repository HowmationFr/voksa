import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { useT } from '../../lib/i18n';

type Props = {
  title: string;
  initialName?: string;
  onClose: () => void;
  onSave: (name: string) => void;
};

/** Create/rename dialog for bookmark folders (same shell as BookmarkEditDialog). */
export function FolderNameDialog({
  title,
  initialName = '',
  onClose,
  onSave,
}: Props): React.ReactElement {
  const t = useT();
  const [name, setName] = useState(initialName);

  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onEsc);
    return () => document.removeEventListener('keydown', onEsc);
  }, [onClose]);

  const valid = name.trim().length > 0;
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    onSave(name.trim());
  };

  return (
    <>
      <div className="fixed inset-0 bg-black/40 z-[9998] animate-fade-in" onClick={onClose} />
      <div className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[380px] bg-bg-elevated border border-border rounded-2xl shadow-float z-[9999] animate-scale-in overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-base font-semibold">{title}</h2>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-bg-hover text-fg-muted">
            <X size={16} />
          </button>
        </div>
        <form onSubmit={submit} className="p-5 space-y-4">
          <div>
            <label className="block text-xs font-medium text-fg-muted mb-1.5">{t('Nom du dossier')}</label>
            <input
              autoFocus
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full h-10 px-3 rounded-lg bg-bg-inset border border-border focus:border-accent focus:outline-none text-sm"
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 h-9 rounded-lg border border-border text-fg hover:bg-bg-hover text-sm"
            >
              {t('Annuler')}
            </button>
            <button
              type="submit"
              disabled={!valid}
              className="px-4 h-9 rounded-lg bg-accent hover:bg-accent-hover text-white text-sm font-medium disabled:opacity-40"
            >
              {t('Enregistrer')}
            </button>
          </div>
        </form>
      </div>
    </>
  );
}
