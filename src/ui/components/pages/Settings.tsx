import React, { useEffect, useState } from 'react';
import { ChevronRight, Monitor, Moon, Puzzle, RefreshCw, Settings as SettingsIcon, Shield, Sun, Trash2 } from 'lucide-react';
import type { UpdateState } from '../../../shared/types';
import { useSettingsStore } from '../../stores/settingsStore';
import { useStreamStore } from '../../stores/streamStore';
import { useTabsStore } from '../../stores/tabsStore';
import { useExtensionsStore } from '../../stores/extensionsStore';
import { Toggle } from '../ui/Toggle';
import { ClearDataDialog } from '../ClearDataDialog';
import { voksa } from '../../lib/bridge';
import { useT } from '../../lib/i18n';

const ENGINES = [
  { value: 'google', label: 'Google' },
  { value: 'duckduckgo', label: 'DuckDuckGo' },
  { value: 'startpage', label: 'Startpage' },
  { value: 'brave', label: 'Brave Search' },
] as const;

const THEMES = [
  { value: 'light', label: 'Clair', icon: Sun },
  { value: 'dark', label: 'Sombre', icon: Moon },
  { value: 'system', label: 'Système', icon: Monitor },
] as const;

export function SettingsPage(): React.ReactElement {
  const t = useT();
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  const stream = useStreamStore((s) => s.config);
  const extensionCount = useExtensionsStore((s) => s.extensions.length);
  const activeTabId = useTabsStore((s) => s.tabs.find((t) => t.isActive)?.id ?? null);

  const openInternal = (url: string) => {
    if (activeTabId) void voksa.tabs.navigate(activeTabId, url);
  };
  const openStreamPage = () => openInternal('voksa://stream');
  const [clearDataOpen, setClearDataOpen] = useState(false);

  return (
    <div className="bg-bg text-fg min-h-full">
      <div className="max-w-2xl mx-auto px-6 py-10">
        <h1 className="flex items-center gap-3 text-xl font-semibold mb-8">
          <SettingsIcon size={20} className="text-accent" />
          {t('Paramètres')}
        </h1>

        <Section title={t('Apparence')}>
          <Row label={t('Thème')} description={t('Suit le système, ou forcez clair / sombre.')}>
            <div className="flex items-center gap-1 bg-bg-inset rounded-lg p-1">
              {THEMES.map((th) => {
                const Icon = th.icon;
                const activeT = settings.theme === th.value;
                return (
                  <button
                    key={th.value}
                    onClick={() => void update({ theme: th.value })}
                    className={`flex items-center gap-1.5 px-2.5 h-7 rounded-md text-xs transition-colors ${
                      activeT ? 'bg-bg-elevated text-fg shadow-soft' : 'text-fg-muted hover:text-fg'
                    }`}
                  >
                    <Icon size={14} />
                    {t(th.label)}
                  </button>
                );
              })}
            </div>
          </Row>
        </Section>

        <Section title={t('Général')}>
          <Row
            label={t('Langue')}
            description={t('Système suit la langue de votre ordinateur (français ou anglais).')}
          >
            <select
              value={settings.language}
              onChange={(e) =>
                void update({ language: e.target.value as typeof settings.language })
              }
              className="bg-bg-inset border border-border rounded-lg px-3 h-9 text-sm"
            >
              <option value="system">{t('Système')}</option>
              <option value="fr">Français</option>
              <option value="en">English</option>
            </select>
          </Row>

          <Row
            label={t('Moteur de recherche')}
            description={t('Utilisé quand la barre d’adresse ne contient pas une URL.')}
          >
            <select
              value={settings.searchEngine}
              onChange={(e) =>
                void update({ searchEngine: e.target.value as typeof settings.searchEngine })
              }
              className="bg-bg-inset border border-border rounded-lg px-3 h-9 text-sm"
            >
              {ENGINES.map((e) => (
                <option key={e.value} value={e.value}>
                  {e.label}
                </option>
              ))}
            </select>
          </Row>

          <Row label={t('Page d’accueil')} description={t('Ouverte par le bouton Accueil et Alt+Home.')}>
            <input
              value={settings.homepage}
              onChange={(e) => void update({ homepage: e.target.value })}
              placeholder="voksa://newtab"
              className="w-52 bg-bg-inset border border-border rounded-lg px-3 h-9 text-sm outline-none focus:border-accent/60"
            />
          </Row>

          <Row label={t('Barre de favoris')} description={t('Afficher la barre sous la barre d’adresse.')}>
            <Toggle
              checked={settings.showBookmarkBar}
              onChange={(v) => void update({ showBookmarkBar: v })}
            />
          </Row>
        </Section>

        <Section title={t('Confidentialité')}>
          <Row
            label={t('Effacer les données')}
            description={t('Par type (historique, cookies, cache, autorisations…) et par période.')}
          >
            <button
              onClick={() => setClearDataOpen(true)}
              className="flex items-center gap-2 px-3 h-9 rounded-lg text-sm text-danger hover:bg-danger/10 transition-colors"
            >
              <Trash2 size={14} /> {t('Effacer…')}
            </button>
          </Row>
        </Section>

        {clearDataOpen && <ClearDataDialog onClose={() => setClearDataOpen(false)} />}

        <section className="mb-8">
          <SectionTitle>
            <Shield size={15} className={stream.enabled ? 'text-stream' : 'text-fg-muted'} />
            {t('Mode Stream')}
          </SectionTitle>
          <button
            type="button"
            onClick={openStreamPage}
            className="w-full bg-bg-elevated border border-border hover:border-stream/40 rounded-xl p-4 flex items-center gap-4 transition-colors group text-left"
          >
            <div
              className={`flex-shrink-0 flex items-center justify-center w-11 h-11 rounded-xl transition-colors ${
                stream.enabled ? 'bg-stream text-white' : 'bg-stream/10 text-stream'
              }`}
            >
              <Shield size={20} strokeWidth={2.2} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-base font-semibold text-fg">
                  {stream.enabled ? t('Mode Stream actif') : t('Configurer le Mode Stream')}
                </span>
                {stream.customMasks.length > 0 && (
                  <span className="text-xs text-fg-muted">
                    {stream.customMasks.length > 1
                      ? t('· {n} mots-clés', { n: stream.customMasks.length })
                      : t('· {n} mot-clé', { n: stream.customMasks.length })}
                  </span>
                )}
              </div>
              <p className="text-xs text-fg-muted mt-0.5">
                {t('Masquage des IP, emails, champs, permissions + mots-clés personnalisés.')}
              </p>
            </div>
            <ChevronRight
              size={18}
              className="flex-shrink-0 text-fg-subtle group-hover:text-fg group-hover:translate-x-0.5 transition-all"
            />
          </button>
        </section>

        <section className="mb-8">
          <SectionTitle>
            <Puzzle size={15} className="text-fg-muted" />
            {t('Extensions')}
          </SectionTitle>
          <button
            type="button"
            onClick={() => openInternal('voksa://extensions')}
            className="w-full bg-bg-elevated border border-border hover:border-accent/40 rounded-xl p-4 flex items-center gap-4 transition-colors group text-left"
          >
            <div className="flex-shrink-0 flex items-center justify-center w-11 h-11 rounded-xl bg-accent/10 text-accent">
              <Puzzle size={20} strokeWidth={2.2} />
            </div>
            <div className="flex-1 min-w-0">
              <span className="text-base font-semibold text-fg">{t('Gérer les extensions')}</span>
              <p className="text-xs text-fg-muted mt-0.5">
                {extensionCount === 0
                  ? t('Aucune extension installée : installez-en depuis le Chrome Web Store.')
                  : extensionCount > 1
                    ? t('{n} extensions installées · ordre de la barre d’outils, désinstallation.', { n: extensionCount })
                    : t('{n} extension installée · ordre de la barre d’outils, désinstallation.', { n: extensionCount })}
              </p>
            </div>
            <ChevronRight
              size={18}
              className="flex-shrink-0 text-fg-subtle group-hover:text-fg group-hover:translate-x-0.5 transition-all"
            />
          </button>
        </section>

        <UpdatesSection />
      </div>
    </div>
  );
}

/**
 * "À propos" card: current version + manual update check. The state machine
 * lives in the main process (UpdateController); this card only renders the
 * pushed UpdateState and triggers check/install.
 */
function UpdatesSection(): React.ReactElement {
  const t = useT();
  const [state, setState] = useState<UpdateState | null>(null);

  useEffect(() => {
    void voksa.updates.getState().then(setState);
    return voksa.updates.onChanged(setState);
  }, []);

  const busy = state?.phase === 'checking' || state?.phase === 'downloading';

  let statusLine: string | null = null;
  if (state) {
    switch (state.phase) {
      case 'checking':
        statusLine = t('Recherche de mise à jour…');
        break;
      case 'downloading':
        statusLine = t('Téléchargement de la version {version}… {percent}%', {
          version: state.availableVersion ?? '',
          percent: state.percent ?? 0,
        });
        break;
      case 'ready':
        statusLine = t('La version {version} est prête. Elle sera installée au prochain redémarrage.', {
          version: state.availableVersion ?? '',
        });
        break;
      case 'uptodate':
        statusLine = t('Voksa est à jour.');
        break;
      case 'error':
        statusLine = t('La vérification a échoué : {error}', { error: state.error ?? t('erreur inconnue') });
        break;
      case 'unsupported':
        statusLine = t(
          'Mises à jour automatiques indisponibles (version de développement ou installation .deb : mettez à jour via GitHub).',
        );
        break;
      default:
        statusLine = null;
    }
  }

  return (
    <Section
      title={
        <>
          <RefreshCw size={15} className="text-fg-muted" />
          {t('À propos')}
        </>
      }
    >
      <Row
        label={`Voksa ${state?.currentVersion ?? ''}`}
        description={statusLine ?? t('Les mises à jour sont vérifiées au démarrage.')}
      >
        {state?.phase === 'ready' ? (
          <button
            onClick={() => void voksa.updates.install()}
            className="px-3 h-9 rounded-lg text-sm font-medium bg-accent text-white hover:bg-accent-hover transition-colors"
          >
            {t('Redémarrer pour installer')}
          </button>
        ) : state?.phase !== 'unsupported' ? (
          <button
            onClick={() => void voksa.updates.check()}
            disabled={busy}
            className="px-3 h-9 rounded-lg text-sm text-fg hover:bg-bg-hover border border-border transition-colors disabled:opacity-50"
          >
            {busy ? t('Vérification…') : t('Vérifier les mises à jour')}
          </button>
        ) : null}
      </Row>
    </Section>
  );
}

function SectionTitle({ children }: React.PropsWithChildren): React.ReactElement {
  return (
    <h2 className="text-2xs font-semibold text-fg-subtle uppercase tracking-[0.08em] mb-3 flex items-center gap-2">
      {children}
    </h2>
  );
}

function Section({
  title,
  children,
}: React.PropsWithChildren<{ title: React.ReactNode }>): React.ReactElement {
  return (
    <section className="mb-8">
      <SectionTitle>{title}</SectionTitle>
      <div className="bg-bg-elevated border border-border rounded-xl divide-y divide-border overflow-hidden">
        {children}
      </div>
    </section>
  );
}

function Row({
  label,
  description,
  children,
}: React.PropsWithChildren<{ label: string; description?: string }>): React.ReactElement {
  return (
    <div className="flex items-center gap-4 px-4 py-3.5">
      <div className="flex-1 min-w-0">
        <div className="text-sm text-fg">{label}</div>
        {description && <div className="text-xs text-fg-muted mt-0.5 leading-snug">{description}</div>}
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  );
}
