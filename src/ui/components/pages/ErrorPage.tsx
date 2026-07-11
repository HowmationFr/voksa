import React from 'react';
import { CloudOff, RotateCw } from 'lucide-react';
import type { TabError } from '../../../shared/types';
import { voksa } from '../../lib/bridge';
import { useT } from '../../lib/i18n';

// French source strings kept as data; translated at render time via t().
const MESSAGES: Record<number, string> = {
  [-105]: "L'adresse est introuvable (DNS). Vérifiez le nom du site.",
  [-106]: 'Vous semblez hors ligne.',
  [-109]: 'Le site est injoignable.',
  [-118]: 'La connexion a expiré.',
  [-201]: 'Le certificat de sécurité du site est invalide.',
  [-501]: 'Connexion non sécurisée.',
};

export function ErrorPage({ error, tabId }: { error: TabError; tabId: string }): React.ReactElement {
  const t = useT();
  const known = MESSAGES[error.code];
  const message = known ? t(known) : error.description ?? t('La page n’a pas pu être chargée.');
  let host = error.url;
  try {
    host = new URL(error.url).host || error.url;
  } catch {
    // keep raw
  }
  return (
    <div className="flex flex-col items-center justify-center h-full px-6 text-center bg-bg">
      <div className="w-16 h-16 rounded-2xl bg-bg-hover flex items-center justify-center text-fg-subtle mb-5">
        <CloudOff size={30} />
      </div>
      <h1 className="text-lg font-semibold text-fg mb-1">{t('Cette page est inaccessible')}</h1>
      <p className="text-[13px] text-fg-muted max-w-md mb-1">{message}</p>
      <p className="text-[12px] text-fg-subtle mb-6">{host}</p>
      <button
        onClick={() => void voksa.tabs.reload(tabId)}
        className="flex items-center gap-2 px-4 h-9 rounded-lg bg-accent text-white text-[13px] font-medium hover:bg-accent-hover"
      >
        <RotateCw size={15} /> {t('Réessayer')}
      </button>
      <p className="mt-4 text-[11px] text-fg-subtle font-mono">
        {t('Code {code}', { code: error.code })}
      </p>
    </div>
  );
}
