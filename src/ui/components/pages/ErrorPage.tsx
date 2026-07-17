import React, { useState } from 'react';
import { CloudOff, RotateCw, ShieldAlert, ArrowLeft } from 'lucide-react';
import type { TabError } from '../../../shared/types';
import { voksa } from '../../lib/bridge';
import { useT } from '../../lib/i18n';
import { useMaskedText } from '../../lib/masking';
import { useTabsStore } from '../../stores/tabsStore';

// French source strings kept as data; translated at render time via t().
const MESSAGES: Record<number, string> = {
  [-105]: "L'adresse est introuvable (DNS). Vérifiez le nom du site.",
  [-106]: 'Vous semblez hors ligne.',
  [-109]: 'Le site est injoignable.',
  [-118]: 'La connexion a expiré.',
  [-201]: 'Le certificat de sécurité du site est invalide.',
  [-501]: 'Connexion non sécurisée.',
};

/**
 * Chromium's certificate net-error band. A failure in it gets the TLS
 * interstitial (with "continue anyway") instead of the generic error page.
 */
function isCertError(code: number): boolean {
  return code <= -200 && code >= -218;
}

export function ErrorPage({ error, tabId }: { error: TabError; tabId: string }): React.ReactElement {
  const t = useT();
  let rawHost = error.url;
  try {
    rawHost = new URL(error.url).host || error.url;
  } catch {
    // keep raw
  }
  // An internal hostname or an IP in a failed URL is exactly what Stream Mode
  // masks everywhere else; the error surface is painted chrome like any other.
  const host = useMaskedText(rawHost);

  if (isCertError(error.code)) {
    return <TlsInterstitial error={error} tabId={tabId} host={host} />;
  }

  const known = MESSAGES[error.code];
  const message = known ? t(known) : error.description ?? t('La page n’a pas pu être chargée.');
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

/**
 * The "your connection is not private" interstitial. "Continue anyway" trusts
 * the exact certificate the user is looking at, for this app run only (the
 * exception lives in main-process memory and is never persisted); main
 * refuses when no exception is pending, so the link can never navigate on its
 * own authority.
 */
function TlsInterstitial({
  error,
  tabId,
  host,
}: {
  error: TabError;
  tabId: string;
  host: string;
}): React.ReactElement {
  const t = useT();
  const [advanced, setAdvanced] = useState(false);
  // A fresh tab has nowhere to go back to: "back to safety" then means the
  // new tab page, never a silent no-op that strands the user here.
  const canGoBack = useTabsStore((s) => s.tabs.find((t2) => t2.id === tabId)?.canGoBack ?? false);
  const retreat = () => {
    if (canGoBack) void voksa.tabs.back(tabId);
    else void voksa.tabs.navigate(tabId, 'voksa://newtab');
  };

  return (
    <div
      data-voksa-tls-interstitial
      className="flex flex-col items-center justify-center h-full px-6 text-center bg-bg"
    >
      <div className="w-16 h-16 rounded-2xl bg-danger/10 flex items-center justify-center text-danger mb-5">
        <ShieldAlert size={30} />
      </div>
      <h1 className="text-lg font-semibold text-fg mb-1">
        {t('Votre connexion n’est pas privée')}
      </h1>
      <p className="text-[13px] text-fg-muted max-w-md mb-1">
        {t(
          'Le certificat de sécurité de {host} n’est pas approuvé. Quelqu’un pourrait tenter d’intercepter ce que vous voyez ou saisissez.',
          { host },
        )}
      </p>
      <p className="mb-6 text-[11px] text-fg-subtle font-mono">{error.description}</p>
      <button
        onClick={retreat}
        className="flex items-center gap-2 px-4 h-9 rounded-lg bg-accent text-white text-[13px] font-medium hover:bg-accent-hover"
      >
        <ArrowLeft size={15} /> {t('Revenir en sécurité')}
      </button>
      {!advanced ? (
        <button
          data-voksa-tls-advanced
          onClick={() => setAdvanced(true)}
          className="mt-5 text-[12px] text-fg-subtle hover:text-fg-muted underline underline-offset-2"
        >
          {t('Paramètres avancés')}
        </button>
      ) : (
        <div className="mt-5 max-w-md">
          <p className="text-[12px] text-fg-subtle mb-2">
            {t(
              'Si vous comprenez le risque, vous pouvez continuer : l’exception ne vaut que pour ce certificat précis et sera oubliée à la fermeture de Voksa.',
            )}
          </p>
          <button
            data-voksa-tls-proceed
            onClick={() => void voksa.tabs.tlsProceed(tabId)}
            className="text-[12px] text-danger hover:underline underline-offset-2"
          >
            {t('Continuer vers {host} (non sécurisé)', { host })}
          </button>
        </div>
      )}
    </div>
  );
}
