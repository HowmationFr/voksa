import React, { useEffect, useMemo, useState } from 'react';
import {
  Bug,
  CheckCircle2,
  ChevronRight,
  ExternalLink,
  Gauge,
  Github,
  Info,
  Monitor,
  Moon,
  Palette,
  Power,
  Puzzle,
  Search as SearchIcon,
  Settings as SettingsIcon,
  Shield,
  ShieldCheck,
  Sun,
  Trash2,
  X,
  Youtube,
} from 'lucide-react';
import {
  getEngine,
  resolveEngines,
  type SearchEngineDef,
} from '../../../shared/searchEngines';
import type { StartupMode } from '../../../shared/startup';
import { useSettingsStore } from '../../stores/settingsStore';
import { useStreamStore } from '../../stores/streamStore';
import { useTabsStore } from '../../stores/tabsStore';
import { useExtensionsStore } from '../../stores/extensionsStore';
import { useUpdatesStore } from '../../stores/updatesStore';
import { Toggle } from '../ui/Toggle';
import { Trans } from '../ui/Trans';
import { ClearDataDialog } from '../ClearDataDialog';
import { voksa } from '../../lib/bridge';
import { useT } from '../../lib/i18n';
import { useNavigateActiveTab } from '../../lib/navigation';
import logoUrl from '../../../../resources/icon.png';

/** The author's channel and the project repository (opened in a Voksa tab). */
const YOUTUBE_URL = 'https://www.youtube.com/@Howmation';
const GITHUB_URL = 'https://github.com/HowmationFr/voksa';
const ISSUES_URL = 'https://github.com/HowmationFr/voksa/issues';

/**
 * The three startup modes. `label` takes the translator as an argument so the
 * French source string stays a LITERAL inside the translation call, which is
 * what the i18n contract test scans for. Storing a pre-translated string here,
 * or a key resolved through a variable, would both need to be registered as an
 * indirection. Neither is worth it.
 */
const STARTUP_CHOICES: Array<{
  mode: StartupMode;
  label: (t: (s: string) => string) => string;
}> = [
  { mode: 'newtab', label: (t) => t('Ouvrir la page « Nouvel onglet »') },
  { mode: 'restore', label: (t) => t('Reprendre là où vous vous étiez arrêté') },
  { mode: 'urls', label: (t) => t('Ouvrir une page ou un ensemble de pages spécifiques') },
];


/**
 * One settings row. `label`/`description` are ALREADY translated: callers pass
 * the RESULT of a t() call with a literal, never the key. That is what lets the
 * search filter match what the user actually reads, in their own language, with
 * no extra plumbing (and it keeps every string a plain literal for the i18n
 * extraction, so no indirection has to be registered).
 */
type Row = {
  key: string;
  label: string;
  description?: string;
  /** Extra search terms that are not on screen (e.g. "RAM" for the memory saver). */
  keywords?: string;
  control: React.ReactNode;
};

type Section = {
  id: string;
  title: string;
  icon: React.ComponentType<{ size?: number | string; className?: string }>;
  rows: Row[];
  /** Full-width card instead of a label/control row (Stream, Extensions...). */
  card?: React.ReactNode;
  /**
   * What the CARD is about. A card is arbitrary JSX, so its text is invisible
   * to the filter: without this, a section made only of a card (Stream Mode,
   * Extensions, About) could never be found by searching for what it contains.
   */
  cardKeywords?: string;
};

function rowMatches(section: Section, row: Row, query: string): boolean {
  const haystack = `${section.title} ${row.label} ${row.description ?? ''} ${row.keywords ?? ''}`;
  return haystack.toLowerCase().includes(query);
}

function cardMatches(section: Section, query: string): boolean {
  const haystack = `${section.title} ${section.cardKeywords ?? ''}`;
  return haystack.toLowerCase().includes(query);
}

export function SettingsPage(): React.ReactElement {
  const t = useT();
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  const stream = useStreamStore((s) => s.config);
  const extensionCount = useExtensionsStore((s) => s.extensions.length);
  const dormantTabs = useTabsStore((s) => s.tabs.filter((t) => t.isDiscarded).length);

  const [clearDataOpen, setClearDataOpen] = useState(false);
  const [engineDialogOpen, setEngineDialogOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeSection, setActiveSection] = useState('appearance');

  const openInternal = useNavigateActiveTab();
  const engines = useMemo(
    () => resolveEngines(settings.customEngines),
    [settings.customEngines],
  );

  const sections: Section[] = [
    {
      id: 'appearance',
      title: t('Apparence'),
      icon: Palette,
      rows: [
        {
          key: 'theme',
          label: t('Thème'),
          description: t('Suit le système, ou forcez clair / sombre.'),
          keywords: 'dark light mode sombre clair',
          control: (
            <div className="flex items-center gap-1 bg-bg-inset rounded-lg p-1">
              <ThemeButton icon={Sun} label={t('Clair')} value="light" current={settings.theme} onPick={(v) => void update({ theme: v })} />
              <ThemeButton icon={Moon} label={t('Sombre')} value="dark" current={settings.theme} onPick={(v) => void update({ theme: v })} />
              <ThemeButton icon={Monitor} label={t('Système')} value="system" current={settings.theme} onPick={(v) => void update({ theme: v })} />
            </div>
          ),
        },
        {
          key: 'bookmarkbar',
          label: t('Barre de favoris'),
          description: t('Afficher la barre sous la barre d’adresse.'),
          control: (
            <Toggle
              checked={settings.showBookmarkBar}
              onChange={(v) => void update({ showBookmarkBar: v })}
            />
          ),
        },
        {
          key: 'language',
          label: t('Langue'),
          description: t('Système suit la langue de votre ordinateur (français ou anglais).'),
          keywords: 'language francais english',
          control: (
            <select
              value={settings.language}
              onChange={(e) => void update({ language: e.target.value as typeof settings.language })}
              className="bg-bg-inset border border-border rounded-lg px-3 h-9 text-sm"
            >
              <option value="system">{t('Système')}</option>
              <option value="fr">Français</option>
              <option value="en">English</option>
            </select>
          ),
        },
      ],
    },
    {
      id: 'search',
      title: t('Moteur de recherche'),
      icon: SearchIcon,
      rows: [
        {
          key: 'engine',
          label: t('Moteur de recherche'),
          description: t(
            'Utilisé quand la barre d’adresse ne contient pas une URL, et pour la recherche d’une sélection.',
          ),
          keywords: 'google bing duckduckgo brave qwant ecosia startpage',
          control: (
            <div className="flex items-center gap-3">
              <span className="text-sm text-fg">{getEngine(settings.searchEngine, engines).name}</span>
              <button
                type="button"
                onClick={() => setEngineDialogOpen(true)}
                className="px-3 h-9 rounded-lg text-sm text-fg hover:bg-bg-hover border border-border transition-colors"
              >
                {t('Modifier')}
              </button>
            </div>
          ),
        },
        {
          key: 'manage-engines',
          label: t('Gérer les moteurs de recherche'),
          description: t(
            'Mots-clés de la barre d’adresse : tapez « duckduckgo.com » puis Espace pour chercher directement sur DuckDuckGo.',
          ),
          keywords: 'raccourci mot-cle keyword gerer',
          control: (
            <button
              type="button"
              onClick={() => openInternal('voksa://search')}
              aria-label={t('Gérer les moteurs de recherche')}
              className="flex items-center justify-center w-9 h-9 rounded-lg text-fg-muted hover:bg-bg-hover transition-colors"
            >
              <ChevronRight size={18} />
            </button>
          ),
        },
      ],
    },
    {
      id: 'startup',
      title: t('Au démarrage'),
      icon: Power,
      rows: [
        {
          key: 'startup-mode',
          label: t('Au démarrage'),
          description: t('Ce que Voksa ouvre au lancement.'),
          // The URL list is a CARD, and a card that only exists in 'urls' mode
          // is invisible to the filter in the other two. Its terms live here so
          // searching "pages à ouvrir" still finds the section that owns it.
          keywords: `demarrage session onglets restaurer reprendre ${t('Pages à ouvrir')} urls`,
          control: (
            <div className="flex flex-col gap-1.5">
              {STARTUP_CHOICES.map((choice) => (
                <label
                  key={choice.mode}
                  className="flex items-center gap-2.5 cursor-pointer text-sm text-fg"
                >
                  <input
                    type="radio"
                    name="startup-mode"
                    checked={settings.startupMode === choice.mode}
                    onChange={() => void update({ startupMode: choice.mode })}
                    className="accent-accent"
                  />
                  {choice.label(t)}
                </label>
              ))}
            </div>
          ),
        },
        {
          key: 'homepage',
          label: t('Page d’accueil'),
          description: t('Ouverte par le bouton Accueil et Alt+Home.'),
          keywords: 'accueil home',
          control: (
            <input
              value={settings.homepage}
              onChange={(e) => void update({ homepage: e.target.value })}
              placeholder="voksa://newtab"
              className="w-52 bg-bg-inset border border-border rounded-lg px-3 h-9 text-sm outline-none focus:border-accent/60"
            />
          ),
        },
      ],
      cardKeywords: `${t('Pages à ouvrir')} urls pages specifiques`,
      // Only when the mode calls for it: an empty URL list sitting under two
      // unselected radio buttons would just be noise.
      card:
        settings.startupMode === 'urls' ? (
          <StartupUrlsEditor
            urls={settings.startupUrls}
            onChange={(urls) => void update({ startupUrls: urls })}
          />
        ) : undefined,
    },
    {
      id: 'performance',
      title: t('Performances'),
      icon: Gauge,
      rows: [
        {
          key: 'memorysaver',
          label: t('Économiseur de mémoire'),
          description: t('Voksa libère la mémoire des onglets inactifs. Les onglets actifs et vos autres applications en profitent, et Voksa reste rapide. Un onglet mis en veille se recharge quand vous y revenez.'),
          keywords: 'ram memoire memory performance onglets veille',
          control: (
            <select
              value={settings.memorySaver}
              onChange={(e) =>
                void update({ memorySaver: e.target.value as typeof settings.memorySaver })
              }
              className="bg-bg-inset border border-border rounded-lg px-3 h-9 text-sm"
            >
              <option value="off">{t('Désactivé')}</option>
              <option value="moderate">{t('Modéré')}</option>
              <option value="balanced">{t('Équilibré')}</option>
              <option value="maximum">{t('Maximal')}</option>
            </select>
          ),
        },
        {
          key: 'preconnect',
          label: t('Vitesse'),
          description: t(
            'Voksa résout le DNS et ouvre la connexion des sites que vous survolez, pour que la page s’affiche plus vite au clic. Aucune page n’est téléchargée à l’avance.',
          ),
          keywords: 'vitesse rapide dns preconnexion reseau latence',
          control: (
            <Toggle
              checked={settings.preconnect}
              onChange={(v) => void update({ preconnect: v })}
            />
          ),
        },
        {
          key: 'memorylevel-help',
          label: t('Niveau appliqué'),
          description:
            settings.memorySaver === 'off'
              ? t('Aucun onglet n’est mis en veille.')
              : settings.memorySaver === 'moderate'
                ? t('Les onglets inactifs ne sont libérés que si votre ordinateur manque réellement de mémoire.')
                : settings.memorySaver === 'balanced'
                  ? t('Les onglets inactifs depuis longtemps sont libérés, plus tôt si la mémoire se tend.')
                  : t('Les onglets inactifs sont libérés dès que possible.'),
          keywords: 'niveau level',
          control: (
            <span className="text-xs text-fg-muted tabular-nums whitespace-nowrap">
              {dormantTabs > 1
                ? t('{n} onglets en veille', { n: dormantTabs })
                : t('{n} onglet en veille', { n: dormantTabs })}
            </span>
          ),
        },
        {
          key: 'memoryexceptions',
          label: t('Sites toujours actifs'),
          description: t('Ces sites ne sont jamais mis en veille, même inactifs (une webapp, un tableau de bord que vous gardez ouvert).'),
          keywords: 'exceptions sites toujours actifs',
          control: null,
        },
      ],
      cardKeywords: `${t('Sites toujours actifs')} exceptions veille memoire`,
      card: (
        <ExceptionsEditor
          hosts={settings.memorySaverExceptions}
          onChange={(hosts) => void update({ memorySaverExceptions: hosts })}
        />
      ),
    },
    {
      id: 'privacy',
      title: t('Confidentialité et sécurité'),
      icon: ShieldCheck,
      rows: [
        {
          key: 'cleardata',
          label: t('Effacer les données'),
          description: t('Par type (historique, cookies, cache, autorisations…) et par période.'),
          keywords: 'cookies cache historique',
          control: (
            <button
              onClick={() => setClearDataOpen(true)}
              className="flex items-center gap-2 px-3 h-9 rounded-lg text-sm text-danger hover:bg-danger/10 transition-colors"
            >
              <Trash2 size={14} /> {t('Effacer…')}
            </button>
          ),
        },
      ],
      cardKeywords: `${t('Mode Stream')} stream masquage ip email permissions`,
      card: (
        <BigCard
          icon={Shield}
          accent="stream"
          active={stream.enabled}
          title={stream.enabled ? t('Mode Stream actif') : t('Configurer le Mode Stream')}
          description={t('Masque IP, emails, téléphones et mots-clés en direct pour partager votre écran sans fuite.')}
          onClick={() => openInternal('voksa://stream')}
        />
      ),
    },
    {
      id: 'extensions',
      title: t('Extensions'),
      icon: Puzzle,
      rows: [],
      cardKeywords: `${t('Gérer les extensions')} chrome web store ublock`,
      card: (
        <BigCard
          icon={Puzzle}
          accent="accent"
          active={extensionCount > 0}
          title={t('Gérer les extensions')}
          description={
            extensionCount === 0
              ? t('Aucune extension installée : installez-en depuis le Chrome Web Store.')
              : extensionCount > 1
                ? t('{n} extensions installées · ordre de la barre d’outils, désinstallation.', { n: extensionCount })
                : t('{n} extension installée · ordre de la barre d’outils, désinstallation.', { n: extensionCount })
          }
          onClick={() => openInternal('voksa://extensions')}
        />
      ),
    },
    {
      id: 'about',
      title: t('À propos'),
      icon: Info,
      rows: [],
      cardKeywords: `${t('Vérifier les mises à jour')} ${t('Voir la chaîne Howmation')} ${t('Voir le dépôt GitHub')} ${t('logiciels libres')} version github youtube licence credits`,
      card: <AboutCard />,
    },
  ];

  const q = query.trim().toLowerCase();

  const matching = sections
    .map((section) => ({
      section,
      rows: q ? section.rows.filter((row) => rowMatches(section, row, q)) : section.rows,
      // The card is judged on its OWN terms: showing the Stream card just
      // because an unrelated row of the same section matched would be noise.
      showCard: section.card != null && (!q || cardMatches(section, q)),
    }))
    .filter(({ rows, showCard }) => rows.length > 0 || showCard);

  // One section at a time: the sidebar is navigation, not a table of contents.
  // Searching is the exception, and the only one: a query is a question about
  // the WHOLE of the settings, so it answers across every section at once.
  const visible = q
    ? matching
    : matching.filter(({ section }) => section.id === activeSection);

  const goTo = (id: string) => {
    setQuery('');
    setActiveSection(id);
  };

  return (
    <div className="bg-bg text-fg min-h-full">
      <div className="max-w-5xl mx-auto px-6 py-10">
        <div className="flex gap-10">
          {/* Sidebar: Chrome puts navigation on the left and keeps it in view. */}
          <aside className="hidden md:block w-52 flex-shrink-0">
            <div className="sticky top-10">
              <h1 className="flex items-center gap-2.5 text-lg font-semibold mb-6">
                <SettingsIcon size={19} className="text-accent" />
                {t('Paramètres')}
              </h1>
              <nav className="space-y-0.5">
                {sections.map((s) => {
                  const Icon = s.icon;
                  const current = !q && activeSection === s.id;
                  return (
                    <button
                      key={s.id}
                      data-voksa-settings-nav={s.id}
                      onClick={() => goTo(s.id)}
                      className={`w-full flex items-center gap-2.5 px-3 h-9 rounded-lg text-sm transition-colors text-left ${
                        current
                          ? 'bg-accent/10 text-accent font-medium'
                          : 'text-fg-muted hover:text-fg hover:bg-bg-hover'
                      }`}
                    >
                      <Icon size={15} className="flex-shrink-0" />
                      <span className="truncate">{s.title}</span>
                    </button>
                  );
                })}
              </nav>
            </div>
          </aside>

          <div className="flex-1 min-w-0">
            <div className="relative mb-8">
              <SearchIcon
                size={16}
                className="absolute left-3.5 top-1/2 -translate-y-1/2 text-fg-subtle pointer-events-none"
              />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('Rechercher un paramètre')}
                className="w-full h-11 pl-10 pr-10 rounded-xl bg-bg-inset border border-border text-sm outline-none focus:border-accent/60 focus:bg-bg-elevated transition-colors"
              />
              {query && (
                <button
                  onClick={() => setQuery('')}
                  aria-label={t('Effacer la recherche')}
                  className="absolute right-3 top-1/2 -translate-y-1/2 p-1 rounded-md text-fg-subtle hover:text-fg hover:bg-bg-hover"
                >
                  <X size={14} />
                </button>
              )}
            </div>

            {visible.length === 0 ? (
              <div className="py-16 text-center text-sm text-fg-muted">
                {t('Aucun paramètre ne correspond à « {query} ».', { query: query.trim() })}
              </div>
            ) : (
              visible.map(({ section, rows, showCard }) => {
                const Icon = section.icon;
                return (
                  <section key={section.id} id={section.id} className="mb-10">
                    <h2 className="flex items-center gap-2 text-sm font-semibold text-fg mb-3">
                      <Icon size={15} className="text-fg-muted" />
                      {section.title}
                    </h2>
                    {rows.length > 0 && (
                      <div className="bg-bg-elevated border border-border rounded-xl divide-y divide-border overflow-hidden mb-3">
                        {rows.map((row) => (
                          <div key={row.key} className="flex items-center gap-4 px-4 py-3.5">
                            <div className="flex-1 min-w-0">
                              <div className="text-sm text-fg">{row.label}</div>
                              {row.description && (
                                <div className="text-xs text-fg-muted mt-0.5 leading-snug">
                                  {row.description}
                                </div>
                              )}
                            </div>
                            {row.control && <div className="flex-shrink-0">{row.control}</div>}
                          </div>
                        ))}
                      </div>
                    )}
                    {showCard && section.card}
                  </section>
                );
              })
            )}
          </div>
        </div>

        {clearDataOpen && <ClearDataDialog onClose={() => setClearDataOpen(false)} />}
        {engineDialogOpen && (
          <SearchEngineDialog
            engines={engines}
            current={settings.searchEngine}
            onPick={(id) => {
              void update({ searchEngine: id });
              setEngineDialogOpen(false);
            }}
            onClose={() => setEngineDialogOpen(false)}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Default-engine picker, Chrome's "Search engine" dialog.
 *
 * No overlay refcount to thread (CLAUDE.md 4.8): an internal page already runs
 * with the chromeView expanded full-window, so a modal rendered inside one has
 * nothing to clip against. ClearDataDialog does exactly the same.
 */
function SearchEngineDialog({
  engines,
  current,
  onPick,
  onClose,
}: {
  engines: SearchEngineDef[];
  current: string;
  onPick: (id: string) => void;
  onClose: () => void;
}): React.ReactElement {
  const t = useT();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[420px] max-h-[80vh] flex flex-col bg-bg-elevated border border-border rounded-2xl shadow-xl overflow-hidden"
      >
        <div className="px-5 pt-5 pb-3">
          <h2 className="text-base font-semibold text-fg">{t('Moteur de recherche')}</h2>
          <p className="text-xs text-fg-muted mt-1">
            {t('Utilisé pour les recherches lancées depuis la barre d’adresse.')}
          </p>
        </div>

        <div className="flex-1 overflow-y-auto px-2 pb-2">
          {engines.map((engine) => {
            const selected = engine.id === current;
            return (
              <button
                key={engine.id}
                type="button"
                onClick={() => onPick(engine.id)}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-bg-hover transition-colors text-left"
              >
                <span
                  className={`flex-shrink-0 w-4 h-4 rounded-full border-2 transition-colors ${
                    selected ? 'border-accent bg-accent' : 'border-border-strong'
                  }`}
                />
                <span className="flex-1 min-w-0 text-sm text-fg">{engine.name}</span>
                {/* The keyword IS the feature: showing it here is how anyone
                    ever discovers tab-to-search. */}
                <span className="flex-shrink-0 text-[11px] font-mono text-fg-subtle">
                  {engine.keyword}
                </span>
              </button>
            );
          })}
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-border">
          <button
            type="button"
            onClick={onClose}
            className="px-3 h-9 rounded-lg text-sm text-fg hover:bg-bg-hover border border-border transition-colors"
          >
            {t('Annuler')}
          </button>
        </div>
      </div>
    </div>
  );
}

function ThemeButton({
  icon: Icon,
  label,
  value,
  current,
  onPick,
}: {
  icon: React.ComponentType<{ size?: number | string; className?: string }>;
  label: string;
  value: 'light' | 'dark' | 'system';
  current: string;
  onPick: (v: 'light' | 'dark' | 'system') => void;
}): React.ReactElement {
  const active = current === value;
  return (
    <button
      onClick={() => onPick(value)}
      className={`flex items-center gap-1.5 px-2.5 h-7 rounded-md text-xs transition-colors ${
        active ? 'bg-bg-elevated text-fg shadow-soft' : 'text-fg-muted hover:text-fg'
      }`}
    >
      <Icon size={14} />
      {label}
    </button>
  );
}

/** Full-width clickable card that leads to a dedicated page. */
function BigCard({
  icon: Icon,
  accent,
  active,
  title,
  description,
  onClick,
}: {
  icon: React.ComponentType<{ size?: number | string; className?: string }>;
  accent: 'stream' | 'accent';
  active: boolean;
  title: string;
  description: string;
  onClick: () => void;
}): React.ReactElement {
  const tint =
    accent === 'stream'
      ? active
        ? 'bg-stream text-stream-fg'
        : 'bg-stream/10 text-stream'
      : active
        ? 'bg-accent text-white'
        : 'bg-accent/10 text-accent';
  const hover = accent === 'stream' ? 'hover:border-stream/40' : 'hover:border-accent/40';
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full bg-bg-elevated border border-border ${hover} rounded-xl p-4 flex items-center gap-4 transition-colors group text-left`}
    >
      <div className={`flex-shrink-0 flex items-center justify-center w-11 h-11 rounded-xl transition-colors ${tint}`}>
        <Icon size={20} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-base font-semibold text-fg">{title}</div>
        <p className="text-xs text-fg-muted mt-0.5 leading-snug">{description}</p>
      </div>
      <ChevronRight
        size={18}
        className="flex-shrink-0 text-fg-subtle group-hover:text-fg group-hover:translate-x-0.5 transition-all"
      />
    </button>
  );
}

/** Hosts the Memory Saver must never put to sleep. */
/**
 * The pages of the "open specific pages" startup mode.
 *
 * Entries are stored RAW, exactly as typed, like the homepage setting is: the
 * main process runs them through normalizeInput when it opens them, so "hello"
 * becomes a search and "example.com" becomes a site, with no second set of
 * rules to keep in step with the address bar.
 */
function StartupUrlsEditor({
  urls,
  onChange,
}: {
  urls: string[];
  onChange: (urls: string[]) => void;
}): React.ReactElement {
  const t = useT();
  const tabs = useTabsStore((s) => s.tabs);
  const [input, setInput] = useState('');

  const add = () => {
    const url = input.trim();
    if (!url || urls.includes(url)) {
      setInput('');
      return;
    }
    onChange([...urls, url]);
    setInput('');
  };

  const useCurrentTabs = () => {
    const open = tabs.filter((tab) => !tab.isInternal).map((tab) => tab.url);
    const merged = [...urls];
    for (const url of open) if (!merged.includes(url)) merged.push(url);
    onChange(merged);
  };

  return (
    <div className="bg-bg-elevated border border-border rounded-xl overflow-hidden">
      <div className="flex items-center gap-2 p-4 border-b border-border">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
          placeholder="https://exemple.com"
          className="flex-1 h-9 px-3 rounded-lg bg-bg border border-border text-sm outline-none focus:border-accent/60"
        />
        <button
          type="button"
          onClick={add}
          disabled={!input.trim()}
          className="flex-shrink-0 px-3 h-9 rounded-lg bg-accent text-white text-sm font-medium hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {t('Ajouter')}
        </button>
        <button
          type="button"
          onClick={useCurrentTabs}
          className="flex-shrink-0 px-3 h-9 rounded-lg text-sm text-fg hover:bg-bg-hover border border-border transition-colors"
        >
          {t('Utiliser les pages actuelles')}
        </button>
      </div>
      {urls.length === 0 ? (
        <div className="px-4 py-6 text-center text-xs text-fg-subtle">
          {t('Aucune page : Voksa ouvrira un nouvel onglet.')}
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {urls.map((url) => (
            <li key={url} className="flex items-center gap-3 px-4 py-2.5">
              <span className="flex-1 min-w-0 text-[13px] text-fg truncate">{url}</span>
              <button
                type="button"
                onClick={() => onChange(urls.filter((u) => u !== url))}
                aria-label={t('Retirer {host}', { host: url })}
                className="flex-shrink-0 flex items-center justify-center w-7 h-7 rounded-lg text-fg-muted hover:text-danger hover:bg-danger/10 transition-colors"
              >
                <X size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ExceptionsEditor({
  hosts,
  onChange,
}: {
  hosts: string[];
  onChange: (hosts: string[]) => void;
}): React.ReactElement {
  const t = useT();
  const [input, setInput] = useState('');

  const add = () => {
    const raw = input.trim().toLowerCase();
    if (!raw) return;
    // Accept what a user actually types: a pasted URL, a www. prefix, a path,
    // a port. Must stay in step with normalizeHost in shared/memorySaver.ts,
    // or a site could be added here and still be put to sleep.
    const host = raw
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '')
      .replace(/:\d+$/, '')
      .replace(/^www\./, '')
      .trim();
    if (!host || hosts.includes(host)) {
      setInput('');
      return;
    }
    onChange([...hosts, host]);
    setInput('');
  };

  return (
    <div className="bg-bg-elevated border border-border rounded-xl overflow-hidden">
      <div className="flex items-center gap-2 p-4 border-b border-border">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
          placeholder={t('exemple.com')}
          className="flex-1 h-9 px-3 rounded-lg bg-bg border border-border text-sm outline-none focus:border-accent/60"
        />
        <button
          type="button"
          onClick={add}
          disabled={!input.trim()}
          className="flex-shrink-0 px-3 h-9 rounded-lg bg-accent text-white text-sm font-medium hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {t('Ajouter')}
        </button>
      </div>
      {hosts.length === 0 ? (
        <div className="px-4 py-6 text-center text-xs text-fg-subtle">
          {t('Aucun site protégé pour le moment.')}
        </div>
      ) : (
        <div className="flex flex-wrap gap-2 p-4">
          {hosts.map((host) => (
            <span
              key={host}
              className="inline-flex items-center gap-1.5 pl-3 pr-1 h-8 rounded-full bg-bg border border-border text-xs text-fg"
            >
              {host}
              <button
                type="button"
                onClick={() => onChange(hosts.filter((h) => h !== host))}
                aria-label={t('Retirer {host}', { host })}
                className="flex items-center justify-center w-6 h-6 rounded-full text-fg-muted hover:text-danger hover:bg-danger/10 transition-colors"
              >
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Version, update state, and who made this browser. The update state machine
 * lives in the main process (UpdateController); this card renders the pushed
 * state through the shared store (the toolbar dot and the burger menu read the
 * same one) and triggers check/install.
 */
function AboutCard(): React.ReactElement {
  const t = useT();
  const state = useUpdatesStore((s) => s.state);
  const check = useUpdatesStore((s) => s.check);
  const install = useUpdatesStore((s) => s.install);
  const openInternal = useNavigateActiveTab();

  const busy = state?.phase === 'checking' || state?.phase === 'downloading';

  let statusLine: string | null = null;
  switch (state?.phase) {
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
      statusLine = t('La vérification a échoué : {error}', {
        error: state.error ?? t('erreur inconnue'),
      });
      break;
    case 'unsupported':
      statusLine = t('Mises à jour automatiques indisponibles (version de développement ou installation .deb : mettez à jour via GitHub).');
      break;
    default:
      statusLine = t('Les mises à jour sont vérifiées au démarrage puis régulièrement.');
  }

  const openTab = (url: string) => void voksa.tabs.create(url);

  return (
    <div className="space-y-4">
      <div className="bg-bg-elevated border border-border rounded-xl divide-y divide-border overflow-hidden">
        {/* The product's real icon: the same file electron-builder packages, so
            the About card can never show a mark the installed app does not.
            Imported (not a hardcoded path) so Vite emits it into dist-ui and the
            URL resolves under file:// in a packaged build. */}
        <div className="flex items-center gap-4 px-4 py-4">
          <img
            src={logoUrl}
            alt=""
            width={44}
            height={44}
            data-voksa-logo
            className="flex-shrink-0 rounded-xl"
          />
          <div className="text-lg font-semibold text-fg">Voksa</div>
        </div>

        <div className="flex items-center gap-4 px-4 py-4">
          <div className="flex-shrink-0 text-fg-muted">
            {state?.phase === 'ready' ? (
              <CheckCircle2 size={18} className="text-accent" />
            ) : (
              <Info size={18} />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm text-fg leading-snug">{statusLine}</p>
            <p className="text-xs text-fg-muted mt-0.5">
              {t('Version {version}', { version: state?.currentVersion ?? '' })}
            </p>
          </div>
          {state?.phase === 'ready' ? (
            <button
              onClick={() => void install()}
              className="flex-shrink-0 px-3 h-9 rounded-lg text-sm font-medium bg-accent text-white hover:bg-accent-hover transition-colors"
            >
              {t('Redémarrer')}
            </button>
          ) : state?.phase !== 'unsupported' ? (
            <button
              onClick={() => void check()}
              disabled={busy}
              className="flex-shrink-0 px-3 h-9 rounded-lg text-sm text-fg hover:bg-bg-hover border border-border transition-colors disabled:opacity-50"
            >
              {busy ? t('Vérification…') : t('Vérifier les mises à jour')}
            </button>
          ) : null}
        </div>

        {/* Outbound links open in a tab of this browser (a browser that sends
            its own links to another browser is a browser that does not trust
            itself). tabs.create normalizes and routes them like any address. */}
        <LinkRow
          icon={<Youtube size={16} className="text-danger" />}
          label={t('Voir la chaîne Howmation')}
          onClick={() => openTab(YOUTUBE_URL)}
        />
        <LinkRow
          icon={<Github size={16} />}
          label={t('Voir le dépôt GitHub')}
          onClick={() => openTab(GITHUB_URL)}
        />
        <LinkRow
          icon={<Bug size={16} />}
          label={t('Signaler un problème')}
          onClick={() => openTab(ISSUES_URL)}
        />
      </div>

      <div className="bg-bg-elevated border border-border rounded-xl px-4 py-4 space-y-1.5">
        <div className="text-sm font-medium text-fg">Voksa</div>
        <p className="text-xs text-fg-muted leading-relaxed">
          {t('© 2026 Howmation. Distribué sous licence GPL-3.0.')}
        </p>
        <p className="text-xs text-fg-muted leading-relaxed">
          <Trans
            text={t('Voksa fonctionne grâce au projet Open Source Chromium et à d’autres {libs}.')}
            values={{
              libs: (
                <button
                  type="button"
                  onClick={() => openInternal('voksa://credits')}
                  className="text-accent hover:underline"
                >
                  {t('logiciels libres')}
                </button>
              ),
            }}
          />
        </p>
      </div>
    </div>
  );
}

/** One outbound row of the About card: icon, label, external-link affordance. */
function LinkRow({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full flex items-center gap-3 px-4 py-3.5 text-left hover:bg-bg-hover transition-colors"
    >
      <span className="flex-shrink-0 text-fg-muted">{icon}</span>
      <span className="flex-1 min-w-0 text-sm text-fg">{label}</span>
      <ExternalLink size={15} className="flex-shrink-0 text-fg-subtle" />
    </button>
  );
}
