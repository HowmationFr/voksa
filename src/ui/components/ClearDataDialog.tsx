import React, { useEffect, useState } from 'react';
import { Trash2, X } from 'lucide-react';
import { voksa } from '../lib/bridge';
import { useT } from '../lib/i18n';
import type { ClearBrowsingDataOptions } from '../../shared/types';

const HOUR = 3_600_000;

const RANGES = [
  { value: 'hour', label: 'Dernière heure', ms: HOUR },
  { value: 'day', label: 'Dernières 24 heures', ms: 24 * HOUR },
  { value: 'week', label: '7 derniers jours', ms: 7 * 24 * HOUR },
  { value: 'month', label: '4 dernières semaines', ms: 28 * 24 * HOUR },
  { value: 'all', label: 'Toutes les périodes', ms: null },
] as const;

type RangeValue = (typeof RANGES)[number]['value'];

type TypeKey = Exclude<keyof ClearBrowsingDataOptions, 'since'>;

const TYPES: Array<{
  key: TypeKey;
  label: string;
  description: string;
  /** Chromium doesn't timestamp these stores; always cleared whole. */
  wholeOnly?: boolean;
}> = [
  {
    key: 'history',
    label: 'Historique de navigation',
    description: 'Pages visitées et sites les plus visités.',
  },
  {
    key: 'downloads',
    label: 'Historique des téléchargements',
    description: 'La liste seulement : les fichiers téléchargés restent sur le disque.',
  },
  {
    key: 'cookies',
    label: 'Cookies',
    description: 'Vous serez déconnecté de la plupart des sites.',
    wholeOnly: true,
  },
  {
    key: 'cache',
    label: 'Images et fichiers en cache',
    description: 'Certains sites se rechargeront plus lentement à la prochaine visite.',
    wholeOnly: true,
  },
  {
    key: 'siteStorage',
    label: 'Données de sites',
    description: 'localStorage, IndexedDB, service workers.',
    wholeOnly: true,
  },
  {
    key: 'sitePermissions',
    label: 'Autorisations de sites',
    description: 'Décisions caméra / micro / localisation / notifications mémorisées.',
    wholeOnly: true,
  },
  {
    key: 'zoomLevels',
    label: 'Niveaux de zoom',
    description: 'Zoom mémorisé site par site.',
    wholeOnly: true,
  },
];

type Props = { onClose: () => void };

/** Chrome-style fine-grained "clear browsing data" dialog. */
export function ClearDataDialog({ onClose }: Props): React.ReactElement {
  const t = useT();
  const [range, setRange] = useState<RangeValue>('all');
  const [checked, setChecked] = useState<Record<TypeKey, boolean>>({
    history: true,
    downloads: false,
    cookies: false,
    cache: true,
    siteStorage: false,
    sitePermissions: false,
    zoomLevels: false,
  });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onEsc);
    return () => document.removeEventListener('keydown', onEsc);
  }, [onClose]);

  const nothingChecked = !Object.values(checked).some(Boolean);
  const rangeMs = RANGES.find((r) => r.value === range)?.ms ?? null;
  const partialRange = rangeMs !== null;
  const wholeOnlySelected = TYPES.some((item) => item.wholeOnly && checked[item.key]);

  const submit = async () => {
    if (nothingChecked || busy) return;
    setBusy(true);
    try {
      await voksa.app.clearBrowsingData({
        since: rangeMs === null ? null : Date.now() - rangeMs,
        ...checked,
      });
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="fixed inset-0 bg-black/40 z-[9998] animate-fade-in" onClick={onClose} />
      <div className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[460px] max-h-[80vh] overflow-y-auto bg-bg-elevated border border-border rounded-2xl shadow-float z-[9999] animate-scale-in">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-base font-semibold">{t('Effacer les données de navigation')}</h2>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-bg-hover text-fg-muted">
            <X size={16} />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          <div className="flex items-center gap-3">
            <label className="text-sm text-fg flex-shrink-0">{t('Période')}</label>
            <select
              value={range}
              onChange={(e) => setRange(e.target.value as RangeValue)}
              className="flex-1 h-9 rounded-lg bg-bg-inset border border-border px-3 text-sm focus:border-accent focus:outline-none cursor-pointer"
            >
              {RANGES.map((r) => (
                <option key={r.value} value={r.value}>
                  {t(r.label)}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1">
            {TYPES.map((item) => (
              <label
                key={item.key}
                className="flex items-start gap-3 px-3 py-2.5 rounded-lg hover:bg-bg-hover cursor-pointer transition-colors"
              >
                <input
                  type="checkbox"
                  checked={checked[item.key]}
                  onChange={(e) => setChecked((c) => ({ ...c, [item.key]: e.target.checked }))}
                  className="mt-0.5 accent-[rgb(var(--accent))]"
                />
                <span className="flex-1 min-w-0">
                  <span className="block text-[13px] text-fg">{t(item.label)}</span>
                  <span className="block text-[11px] text-fg-muted leading-snug">
                    {t(item.description)}
                  </span>
                </span>
              </label>
            ))}
          </div>

          {partialRange && wholeOnlySelected && (
            <p className="text-[11px] text-fg-muted leading-snug px-1">
              {t(
                'La période choisie s’applique à l’historique et aux téléchargements. Cookies, cache, données et autorisations de sites n’ont pas d’horodatage : ils seront effacés en entier.',
              )}
            </p>
          )}
        </div>

        <div className="flex justify-end gap-2 px-5 py-4 border-t border-border">
          <button
            type="button"
            onClick={onClose}
            className="px-4 h-9 rounded-lg border border-border text-fg hover:bg-bg-hover text-sm"
          >
            {t('Annuler')}
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={nothingChecked || busy}
            className="inline-flex items-center gap-2 px-4 h-9 rounded-lg bg-danger hover:bg-danger-hover text-white text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <Trash2 size={14} />
            {busy ? t('Effacement…') : t('Effacer les données')}
          </button>
        </div>
      </div>
    </>
  );
}
