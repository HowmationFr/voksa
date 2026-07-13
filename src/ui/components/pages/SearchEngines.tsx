import React, { useMemo, useState } from 'react';
import { Pencil, Plus, Search as SearchIcon, Trash2 } from 'lucide-react';
import {
  MAX_CUSTOM_ENGINES,
  newCustomEngineId,
  normalizeKeyword,
  resolveEngines,
  validateCustomEngine,
  type CustomSearchEngine,
  type EngineProblem,
  type SearchEngineDef,
} from '../../../shared/searchEngines';
import { useSettingsStore } from '../../stores/settingsStore';
import { SettingsBackLink } from './SettingsBackLink';
import { useT } from '../../lib/i18n';

/**
 * voksa://search: the engines Voksa ships, the ones the user added, and their
 * address-bar keywords. Chrome's "Manage search engines".
 *
 * Engine names, keywords and URL templates are NEVER translated: they are
 * proper nouns and literal input the user types.
 */
export function SearchEnginesPage(): React.ReactElement {
  const t = useT();
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);

  const engines = useMemo(
    () => resolveEngines(settings.customEngines),
    [settings.customEngines],
  );
  const [editing, setEditing] = useState<CustomSearchEngine | 'new' | null>(null);

  const custom = settings.customEngines ?? [];
  const full = custom.length >= MAX_CUSTOM_ENGINES;

  const save = (engine: CustomSearchEngine) => {
    const exists = custom.some((e) => e.id === engine.id);
    const next = exists
      ? custom.map((e) => (e.id === engine.id ? engine : e))
      : [...custom, engine];
    void update({ customEngines: next });
    setEditing(null);
  };

  const remove = (id: string) => {
    // The default engine cannot vanish under the user: sanitize() would fall
    // back to Google anyway, so say so by doing it here, explicitly.
    const patch: Partial<typeof settings> = {
      customEngines: custom.filter((e) => e.id !== id),
    };
    if (settings.searchEngine === id) patch.searchEngine = 'google';
    void update(patch);
  };

  return (
    <div className="bg-bg text-fg min-h-full">
      <div className="max-w-3xl mx-auto px-6 py-10">
        <SettingsBackLink />

        <div className="flex items-center justify-between gap-4 mb-2">
          <h1 className="flex items-center gap-3 text-xl font-semibold">
            <SearchIcon size={20} className="text-accent" />
            {t('Moteurs de recherche')}
          </h1>
          <button
            type="button"
            onClick={() => setEditing('new')}
            disabled={full}
            className="inline-flex items-center gap-2 px-3 h-9 rounded-lg bg-accent hover:bg-accent-hover text-white text-[13px] font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Plus size={14} />
            {t('Ajouter')}
          </button>
        </div>
        <p className="text-[13px] text-fg-muted leading-relaxed mb-8">
          {t(
            'Tapez le mot-clé d’un moteur dans la barre d’adresse, puis Espace, pour chercher directement dessus sans changer votre moteur par défaut.',
          )}
        </p>

        <div
          data-voksa-search-engines={engines.length}
          className="border border-border rounded-xl overflow-hidden divide-y divide-border"
        >
          <div className="flex items-center gap-4 px-4 py-2.5 bg-bg-elevated text-[11px] font-medium uppercase tracking-wide text-fg-subtle">
            <span className="flex-1">{t('Nom')}</span>
            <span className="w-44">{t('Mot-clé')}</span>
            <span className="w-40" />
          </div>

          {engines.map((engine) => (
            <EngineRow
              key={engine.id}
              engine={engine}
              isDefault={engine.id === settings.searchEngine}
              onMakeDefault={() => void update({ searchEngine: engine.id })}
              onEdit={() =>
                setEditing({
                  id: engine.id,
                  name: engine.name,
                  keyword: engine.keyword,
                  searchUrl: engine.searchUrl,
                })
              }
              onRemove={() => remove(engine.id)}
            />
          ))}
        </div>

        {full && (
          <p className="mt-3 text-xs text-fg-subtle">
            {t('Nombre maximal de moteurs personnalisés atteint ({n}).', {
              n: MAX_CUSTOM_ENGINES,
            })}
          </p>
        )}

        {editing && (
          <EngineDialog
            engine={editing === 'new' ? null : editing}
            engines={engines}
            onSave={save}
            onClose={() => setEditing(null)}
          />
        )}
      </div>
    </div>
  );
}

function EngineRow({
  engine,
  isDefault,
  onMakeDefault,
  onEdit,
  onRemove,
}: {
  engine: SearchEngineDef;
  isDefault: boolean;
  onMakeDefault: () => void;
  onEdit: () => void;
  onRemove: () => void;
}): React.ReactElement {
  const t = useT();

  return (
    <div className="flex items-center gap-4 px-4 py-3">
      <span className="flex-1 min-w-0 text-sm text-fg truncate">
        {engine.name}
        {isDefault ? (
          <span className="ml-2 text-xs text-fg-muted">{t('(par défaut)')}</span>
        ) : null}
      </span>
      <span className="w-44 text-[12px] font-mono text-fg-muted truncate">{engine.keyword}</span>
      <span className="w-40 flex justify-end items-center gap-1">
        {!isDefault && (
          <button
            type="button"
            onClick={onMakeDefault}
            className="px-2.5 h-8 rounded-lg text-[12px] text-fg hover:bg-bg-hover border border-border transition-colors"
          >
            {t('Définir par défaut')}
          </button>
        )}
        {/* Built-ins are not editable: their URL and keyword are part of the
            product, and a user who wants a variant can add their own. */}
        {engine.custom && (
          <>
            <button
              type="button"
              onClick={onEdit}
              aria-label={t('Modifier')}
              className="flex items-center justify-center w-8 h-8 rounded-lg text-fg-muted hover:text-fg hover:bg-bg-hover transition-colors"
            >
              <Pencil size={14} />
            </button>
            <button
              type="button"
              onClick={onRemove}
              aria-label={t('Supprimer')}
              className="flex items-center justify-center w-8 h-8 rounded-lg text-fg-muted hover:text-danger hover:bg-danger/10 transition-colors"
            >
              <Trash2 size={14} />
            </button>
          </>
        )}
      </span>
    </div>
  );
}

/** Add or edit a custom engine. Chrome's dialog: name, keyword, URL with %s. */
function EngineDialog({
  engine,
  engines,
  onSave,
  onClose,
}: {
  engine: CustomSearchEngine | null;
  engines: SearchEngineDef[];
  onSave: (engine: CustomSearchEngine) => void;
  onClose: () => void;
}): React.ReactElement {
  const t = useT();
  const [name, setName] = useState(engine?.name ?? '');
  const [keyword, setKeyword] = useState(engine?.keyword ?? '');
  const [searchUrl, setSearchUrl] = useState(engine?.searchUrl ?? '');
  const [problem, setProblem] = useState<EngineProblem | null>(null);

  const submit = () => {
    const draft = { name, keyword, searchUrl };
    const issue = validateCustomEngine(draft, engines, engine?.id);
    if (issue) {
      setProblem(issue);
      return;
    }
    onSave({
      id: engine?.id ?? newCustomEngineId(engines),
      name: name.trim(),
      keyword: normalizeKeyword(keyword),
      searchUrl: searchUrl.trim(),
    });
  };

  const message =
    problem === 'name'
      ? t('Donnez un nom à ce moteur.')
      : problem === 'keyword'
        ? t('Choisissez un mot-clé (ce que vous taperez dans la barre d’adresse).')
        : problem === 'keyword-taken'
          ? t('Ce mot-clé est déjà utilisé par un autre moteur.')
          : problem === 'url'
            ? t('L’URL doit commencer par https://.')
            : problem === 'url-placeholder'
              ? t('L’URL doit contenir %s à l’endroit de la recherche.')
              : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[460px] bg-bg-elevated border border-border rounded-2xl shadow-xl overflow-hidden"
      >
        <div className="px-5 pt-5 pb-2">
          <h2 className="text-base font-semibold text-fg">
            {engine ? t('Modifier le moteur de recherche') : t('Ajouter un moteur de recherche')}
          </h2>
        </div>

        <div className="px-5 py-3 space-y-3">
          <Field label={t('Nom')} value={name} onChange={setName} placeholder="Wikipédia" />
          <Field
            label={t('Mot-clé')}
            value={keyword}
            onChange={setKeyword}
            placeholder="wikipedia.org"
            hint={t('Tapez ce mot-clé puis Espace dans la barre d’adresse.')}
          />
          <Field
            label={t('URL avec %s à la place de la recherche')}
            value={searchUrl}
            onChange={setSearchUrl}
            placeholder="https://fr.wikipedia.org/w/index.php?search=%s"
            mono
          />
          {message && <p className="text-xs text-danger">{message}</p>}
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-border">
          <button
            type="button"
            onClick={onClose}
            className="px-3 h-9 rounded-lg text-sm text-fg hover:bg-bg-hover border border-border transition-colors"
          >
            {t('Annuler')}
          </button>
          <button
            type="button"
            onClick={submit}
            className="px-3 h-9 rounded-lg text-sm font-medium bg-accent text-white hover:bg-accent-hover transition-colors"
          >
            {t('Enregistrer')}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  hint,
  mono,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  hint?: string;
  mono?: boolean;
}): React.ReactElement {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-fg-muted mb-1">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`w-full h-9 px-3 rounded-lg bg-bg border border-border text-sm text-fg placeholder:text-fg-subtle outline-none focus:border-accent/60 ${
          mono ? 'font-mono text-[12px]' : ''
        }`}
      />
      {hint && <span className="block text-[11px] text-fg-subtle mt-1">{hint}</span>}
    </label>
  );
}
