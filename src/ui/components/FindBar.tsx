import React, { useEffect, useRef, useState } from 'react';
import { ChevronUp, ChevronDown, X } from 'lucide-react';
import { voksa } from '../lib/bridge';
import { useTabsStore } from '../stores/tabsStore';
import { useT } from '../lib/i18n';

/**
 * Find-in-page bar. Opened via the MENU_CMD 'find' command (Ctrl+F). Lives
 * inside the toolbar block so it grows chromeBounds.top (page shifts down)
 * rather than relying on overlay expansion; keeps the page fully interactive.
 */
export function FindBar({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): React.ReactElement | null {
  const t = useT();
  const activeId = useTabsStore((s) => s.tabs.find((t) => t.isActive)?.id ?? null);
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<{ active: number; matches: number }>({ active: 0, matches: 0 });
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    return voksa.find.onResult((r) => {
      if (r.tabId === activeId) setResult({ active: r.activeMatchOrdinal, matches: r.matches });
    });
  }, [activeId]);

  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
      inputRef.current?.select();
    } else {
      setQuery('');
      setResult({ active: 0, matches: 0 });
    }
  }, [open]);

  const runFind = (forward: boolean) => {
    if (!activeId || !query) return;
    void voksa.find.start(activeId, query, forward, false);
  };

  useEffect(() => {
    if (!open || !activeId) return;
    if (!query) {
      void voksa.find.stop(activeId);
      setResult({ active: 0, matches: 0 });
      return;
    }
    const t = setTimeout(() => runFind(true), 120);
    return () => clearTimeout(t);
  }, [query, open, activeId]);

  const close = () => {
    if (activeId) void voksa.find.stop(activeId);
    onClose();
  };

  if (!open) return null;

  return (
    <div className="flex items-center gap-1 px-2 h-11 border-b border-border bg-bg no-drag">
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            runFind(!e.shiftKey);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            close();
          }
        }}
        placeholder={t('Rechercher dans la page')}
        className="flex-1 max-w-[280px] h-8 px-3 rounded-lg bg-bg-elevated border border-border text-[13px] outline-none focus:border-accent/50"
        spellCheck={false}
      />
      <span className="text-[12px] text-fg-subtle tabular-nums px-2 min-w-[64px]">
        {query ? `${result.matches ? result.active : 0}/${result.matches}` : ''}
      </span>
      <button
        onClick={() => runFind(false)}
        className="p-1.5 rounded-lg text-fg-muted hover:text-fg hover:bg-bg-hover"
        title={t('Précédent (Maj+Entrée)')}
      >
        <ChevronUp size={16} />
      </button>
      <button
        onClick={() => runFind(true)}
        className="p-1.5 rounded-lg text-fg-muted hover:text-fg hover:bg-bg-hover"
        title={t('Suivant (Entrée)')}
      >
        <ChevronDown size={16} />
      </button>
      <button
        onClick={close}
        className="p-1.5 rounded-lg text-fg-muted hover:text-fg hover:bg-bg-hover"
        title={t('Fermer (Échap)')}
      >
        <X size={16} />
      </button>
    </div>
  );
}
