import React from 'react';
import { Puzzle, Store } from 'lucide-react';
import { useExtensionsStore } from '../../stores/extensionsStore';
import { voksa } from '../../lib/bridge';
import { ExtensionsSection } from './ExtensionsSection';
import { SettingsBackLink } from './SettingsBackLink';
import { useT } from '../../lib/i18n';

/** Dedicated extensions page (voksa://extensions), Chrome's chrome://extensions. */
export function ExtensionsPage(): React.ReactElement {
  const t = useT();
  const count = useExtensionsStore((s) => s.extensions.length);

  return (
    <div className="bg-bg text-fg min-h-full">
      <div className="max-w-2xl mx-auto px-6 py-10">
        <SettingsBackLink />
        <div className="flex items-center justify-between mb-2">
          <h1 className="flex items-center gap-3 text-xl font-semibold">
            <Puzzle size={20} className="text-accent" />
            {t('Extensions')}
          </h1>
          <button
            type="button"
            onClick={() => void voksa.tabs.create('https://chromewebstore.google.com')}
            className="inline-flex items-center gap-2 px-3 h-9 rounded-lg bg-accent hover:bg-accent-hover text-white text-[13px] font-medium transition-colors"
          >
            <Store size={14} />
            Chrome Web Store
          </button>
        </div>
        <p className="text-[13px] text-fg-muted mb-8">
          {count === 0
            ? t('Installez des extensions depuis le Chrome Web Store : elles apparaîtront ici et dans la barre d’outils.')
            : count > 1
              ? t('{n} extensions installées. L’ordre ci-dessous est celui des icônes de la barre d’outils.', { n: count })
              : t('{n} extension installée. L’ordre ci-dessous est celui des icônes de la barre d’outils.', { n: count })}
        </p>

        <ExtensionsSection />
      </div>
    </div>
  );
}
