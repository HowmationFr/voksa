import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import type { Bookmark, BookmarkFolder } from '../../../shared/types';
import { flattenFolderTree } from '../../../shared/bookmarkOrdering';
import { useT } from '../../lib/i18n';

type Props = {
  bookmark: Bookmark;
  folders: BookmarkFolder[];
  onClose: () => void;
  onSave: (patch: { title: string; url: string; folderId: string | null }) => void;
};

export function BookmarkEditDialog({
  bookmark,
  folders,
  onClose,
  onSave,
}: Props): React.ReactElement {
  const t = useT();
  const [title, setTitle] = useState(bookmark.title || '');
  const [url, setUrl] = useState(bookmark.url);
  const [folderId, setFolderId] = useState<string>(bookmark.folderId ?? '');

  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onEsc);
    return () => document.removeEventListener('keydown', onEsc);
  }, [onClose]);

  const urlValid = /^(https?|voksa|file|chrome):\/\//i.test(url.trim()) || /^[\w-]+\.[\w-]+/.test(url.trim());
  const folderTree = flattenFolderTree(folders);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!urlValid) return;
    onSave({ title: title.trim(), url: url.trim(), folderId: folderId || null });
  };

  return (
    <>
      <div className="fixed inset-0 bg-black/40 z-[9998] animate-fade-in" onClick={onClose} />
      <div className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[420px] bg-bg-elevated border border-border rounded-2xl shadow-float z-[9999] animate-scale-in overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-base font-semibold">{t('Modifier le favori')}</h2>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-bg-hover text-fg-muted">
            <X size={16} />
          </button>
        </div>
        <form onSubmit={submit} className="p-5 space-y-4">
          <div>
            <label className="block text-xs font-medium text-fg-muted mb-1.5">{t('Titre')}</label>
            <input
              autoFocus
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full h-10 px-3 rounded-lg bg-bg-inset border border-border focus:border-accent focus:outline-none text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-fg-muted mb-1.5">{t('URL')}</label>
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              className={`w-full h-10 px-3 rounded-lg bg-bg-inset border focus:outline-none text-sm font-mono ${
                url.trim() && !urlValid ? 'border-danger' : 'border-border focus:border-accent'
              }`}
            />
            {url.trim() && !urlValid && (
              <p className="text-2xs text-danger mt-1">{t('URL invalide')}</p>
            )}
          </div>
          <div>
            <label className="block text-xs font-medium text-fg-muted mb-1.5">{t('Dossier')}</label>
            <select
              value={folderId}
              onChange={(e) => setFolderId(e.target.value)}
              className="w-full h-10 px-3 rounded-lg bg-bg-inset border border-border focus:border-accent focus:outline-none text-sm cursor-pointer"
            >
              <option value="">{t('Barre de favoris')}</option>
              {folderTree.map((f) => (
                <option key={f.id} value={f.id}>
                  {/* <option> can't be styled; indent with NBSPs. */}
                  {'  '.repeat(f.depth) + f.name}
                </option>
              ))}
            </select>
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
              disabled={!urlValid}
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
