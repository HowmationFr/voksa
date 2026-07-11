import React, { useEffect, useState } from 'react';
import { Globe, Search } from 'lucide-react';
import { voksa } from '../../lib/bridge';
import type { HistoryEntry } from '../../../shared/types';
import { useStreamStore } from '../../stores/streamStore';
import { useTabsStore } from '../../stores/tabsStore';
import { MaskedText } from '../MaskedText';
import { useMaskedText } from '../../lib/masking';
import { useT } from '../../lib/i18n';

export function NewTabPage(): React.ReactElement {
  const t = useT();
  const [topSites, setTopSites] = useState<HistoryEntry[]>([]);
  const [query, setQuery] = useState('');
  const streamEnabled = useStreamStore((s) => s.config.enabled);
  const hideHistory = useStreamStore((s) => s.config.hideHistory);
  const activeTabId = useTabsStore((s) => s.tabs.find((t) => t.isActive)?.id ?? null);

  // While streaming with hideHistory on, browsing habits stay off-screen:
  // no fetch at all, and the effect re-runs on live toggles.
  const hideTopSites = streamEnabled && hideHistory;
  useEffect(() => {
    if (hideTopSites) {
      setTopSites([]);
      return;
    }
    void voksa.history.topSites(12).then(setTopSites);
  }, [hideTopSites]);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim() || !activeTabId) return;
    // Main normalizes with the configured search engine, no local duplication.
    void voksa.tabs.navigate(activeTabId, query.trim());
  };

  const openSite = (url: string, e: React.MouseEvent) => {
    if (e.button === 1 || e.metaKey || e.ctrlKey) void voksa.tabs.create(url);
    else if (activeTabId) void voksa.tabs.navigate(activeTabId, url);
  };

  return (
    <div className="w-full min-h-full bg-bg text-fg">
      <div className="flex flex-col items-center pt-[16vh] px-6 pb-16">
        <div className="text-center mb-9">
          <h1 className="text-2xl font-semibold tracking-tight mb-1.5">
            <span className="text-accent">Voksa</span>
          </h1>
          <p className="text-fg-muted text-sm">
            {streamEnabled
              ? t('Mode Stream actif : votre navigation reste confidentielle.')
              : t('Un navigateur moderne, rapide et respectueux.')}
          </p>
        </div>

        <form onSubmit={onSubmit} className="w-full max-w-xl mb-14">
          <div className="relative group">
            <Search
              size={18}
              className="absolute left-4 top-1/2 -translate-y-1/2 text-fg-subtle pointer-events-none"
            />
            <input
              autoFocus
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('Rechercher ou saisir une URL')}
              className="w-full h-14 pl-12 pr-5 rounded-2xl bg-bg-elevated border border-border text-md shadow-soft focus:border-accent/70 focus:outline-none focus:ring-4 focus:ring-accent/15 transition-all"
            />
          </div>
        </form>

        {topSites.length > 0 && (
          <div className="w-full max-w-2xl">
            <h2 className="text-2xs font-semibold text-fg-subtle mb-4 uppercase tracking-[0.08em] text-center">
              {t('Sites les plus visités')}
            </h2>
            <div className="grid grid-cols-4 sm:grid-cols-6 gap-3">
              {topSites.map((site) => (
                <TopSite key={site.id} site={site} onOpen={openSite} />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function TopSite({
  site,
  onOpen,
}: {
  site: HistoryEntry;
  onOpen: (url: string, e: React.MouseEvent) => void;
}): React.ReactElement {
  let host = site.url;
  try {
    host = new URL(site.url).hostname.replace(/^www\./, '');
  } catch {
    // ignore
  }
  const maskedHost = useMaskedText(host);
  return (
    <button
      type="button"
      onClick={(e) => onOpen(site.url, e)}
      onAuxClick={(e) => e.button === 1 && onOpen(site.url, e)}
      className="flex flex-col items-center gap-2 group p-2 rounded-xl hover:bg-bg-hover transition-colors"
      title={maskedHost}
    >
      <div className="w-12 h-12 rounded-2xl bg-bg-elevated border border-border group-hover:border-border-strong shadow-soft flex items-center justify-center overflow-hidden transition-colors">
        {site.faviconUrl ? (
          <img src={site.faviconUrl} alt="" className="w-6 h-6" />
        ) : (
          <Globe size={18} className="text-fg-subtle" />
        )}
      </div>
      <div className="text-2xs text-fg-muted group-hover:text-fg truncate max-w-full">
        <MaskedText text={host} />
      </div>
    </button>
  );
}
