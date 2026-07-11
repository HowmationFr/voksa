import React, { useEffect, useMemo, useState } from 'react';
import { Clock, Globe, Search, Trash2 } from 'lucide-react';
import type { HistoryEntry } from '../../../shared/types';
import { voksa } from '../../lib/bridge';
import { useTabsStore } from '../../stores/tabsStore';
import { askConfirm } from '../ui/ConfirmDialog';
import { MaskedText } from '../MaskedText';
import { useLocaleTag, useT } from '../../lib/i18n';

export function HistoryPage(): React.ReactElement {
  const t = useT();
  const locale = useLocaleTag();
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [query, setQuery] = useState('');
  const activeTabId = useTabsStore((s) => s.tabs.find((t) => t.isActive)?.id ?? null);

  const openLink = (url: string, e: React.MouseEvent) => {
    if (e.button === 1 || e.metaKey || e.ctrlKey) void voksa.tabs.create(url);
    else if (activeTabId) void voksa.tabs.navigate(activeTabId, url);
  };

  const refresh = () => {
    const q = query.trim();
    if (q) void voksa.history.search(q, 300).then(setEntries);
    else void voksa.history.list(500).then(setEntries);
  };

  useEffect(() => {
    const t = setTimeout(refresh, query ? 150 : 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const grouped = useMemo(() => groupByDay(entries, locale, t), [entries, locale, t]);

  const onDelete = async (id: string) => {
    await voksa.history.delete(id);
    refresh();
  };

  const onClear = async () => {
    const ok = await askConfirm({
      title: t('Effacer tout l’historique ?'),
      message: t('Toutes les pages visitées seront supprimées définitivement.'),
      confirmLabel: t('Effacer'),
      danger: true,
    });
    if (!ok) return;
    await voksa.history.clear();
    refresh();
  };

  return (
    <div className="bg-bg text-fg min-h-full">
      <div className="max-w-3xl mx-auto px-6 py-10">
        <div className="flex items-center justify-between mb-7">
          <h1 className="flex items-center gap-3 text-xl font-semibold">
            <Clock size={20} className="text-accent" />
            {t('Historique')}
          </h1>
          <button
            onClick={() => void onClear()}
            className="flex items-center gap-2 px-3 h-9 rounded-lg text-danger hover:bg-danger/10 text-sm transition-colors"
          >
            <Trash2 size={14} />
            {t('Tout effacer')}
          </button>
        </div>

        <div className="relative mb-6">
          <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-fg-subtle" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('Rechercher dans l’historique')}
            className="w-full h-11 pl-11 pr-4 rounded-xl bg-bg-inset border border-border focus:border-accent/60 focus:bg-bg-elevated focus:outline-none text-sm transition-colors"
          />
        </div>

        {grouped.length === 0 && (
          <div className="py-24 text-center text-fg-subtle text-sm">
            {query ? t('Aucune entrée ne correspond.') : t('Aucune page dans l’historique.')}
          </div>
        )}

        {grouped.map((group) => (
          <div key={group.day} className="mb-7">
            <h2 className="text-2xs font-semibold text-fg-subtle uppercase tracking-[0.08em] mb-2 px-1">
              {group.day}
            </h2>
            <div className="bg-bg-elevated border border-border rounded-xl overflow-hidden">
              {group.items.map((e) => (
                <div
                  key={e.id}
                  className="flex items-center gap-3 px-4 py-2.5 border-b border-border last:border-b-0 hover:bg-bg-hover group"
                >
                  <div className="w-5 h-5 flex-shrink-0 flex items-center justify-center">
                    {e.faviconUrl ? (
                      <img src={e.faviconUrl} alt="" className="w-4 h-4 rounded-sm" />
                    ) : (
                      <Globe size={14} className="text-fg-subtle" />
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={(ev) => openLink(e.url, ev)}
                    onAuxClick={(ev) => ev.button === 1 && openLink(e.url, ev)}
                    className="flex-1 min-w-0 flex items-baseline gap-3 text-left"
                    title={e.url}
                  >
                    <span className="truncate text-sm text-fg max-w-[340px]">
                      <MaskedText text={e.title || e.url} />
                    </span>
                    <span className="truncate text-xs text-fg-subtle flex-1">
                      <MaskedText text={e.url} />
                    </span>
                  </button>
                  <span className="flex-shrink-0 text-2xs text-fg-subtle tabular-nums">
                    {new Date(e.visitedAt).toLocaleTimeString(locale, {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                  <button
                    onClick={() => void onDelete(e.id)}
                    className="flex-shrink-0 p-1.5 rounded-md opacity-0 group-hover:opacity-100 text-fg-muted hover:text-danger hover:bg-danger/10"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function groupByDay(
  entries: HistoryEntry[],
  locale: string,
  t: (source: string) => string,
): { day: string; items: HistoryEntry[] }[] {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterday = today - 86_400_000;
  const groups = new Map<string, HistoryEntry[]>();
  const labelFor = (ts: number) => {
    if (ts >= today) return t('Aujourd’hui');
    if (ts >= yesterday) return t('Hier');
    return new Date(ts).toLocaleDateString(locale, {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    });
  };
  for (const e of entries) {
    const key = labelFor(e.visitedAt);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(e);
  }
  return [...groups.entries()].map(([day, items]) => ({ day, items }));
}
