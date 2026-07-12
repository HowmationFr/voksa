import React from 'react';
import { ArrowLeft } from 'lucide-react';
import { useNavigateActiveTab } from '../../lib/navigation';
import { useT } from '../../lib/i18n';

/**
 * "Back to Settings" for the settings sub-pages (Stream, Extensions, Credits).
 *
 * They are reachable from voksa://settings but are full internal pages, and an
 * internal page never touches the tab's webContents history: the toolbar back
 * button cannot bring the user home from here. Without this, the only way back
 * is retyping the address.
 */
export function SettingsBackLink(): React.ReactElement {
  const t = useT();
  const navigate = useNavigateActiveTab();

  return (
    <button
      type="button"
      onClick={() => navigate('voksa://settings')}
      className="inline-flex items-center gap-1.5 -ml-1 mb-4 px-2 h-7 rounded-lg text-[13px] text-fg-muted hover:text-fg hover:bg-bg-hover transition-colors"
    >
      <ArrowLeft size={15} />
      {t('Paramètres')}
    </button>
  );
}
