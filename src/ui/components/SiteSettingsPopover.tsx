import React, { useEffect, useMemo } from 'react';
import { Lock, RotateCcw, Shield, ShieldAlert, X } from 'lucide-react';
import { voksa } from '../lib/bridge';
import { useT } from '../lib/i18n';
import { useSettingsStore } from '../stores/settingsStore';
import { useStreamStore } from '../stores/streamStore';
import { MaskedText } from './MaskedText';
import { permissionIcon, permissionName } from '../lib/permissionLabels';
import {
  clearOriginPermissions,
  nextSitePermissions,
  type PermissionSetting,
} from '../lib/sitePermissions';

/** Permissions always listed, even without a stored decision. */
const CURATED = ['media', 'geolocation', 'notifications'];

type Props = {
  origin: string;
  tabId: string;
  isSecure: boolean;
  onClose: () => void;
};

/**
 * Chrome-style "site settings" popover, anchored under the address bar's
 * left icon. Writes go straight through `voksa.settings.update`: the main
 * process re-reads sitePermissions on every permission request, so changes
 * apply to the site's next request without any re-registration.
 */
export function SiteSettingsPopover({
  origin,
  tabId,
  isSecure,
  onClose,
}: Props): React.ReactElement {
  const t = useT();
  const sitePermissions = useSettingsStore((s) => s.settings.sitePermissions);
  const updateSettings = useSettingsStore((s) => s.update);
  const streamEnabled = useStreamStore((s) => s.config.enabled);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const stored = useMemo(() => sitePermissions[origin] ?? {}, [sitePermissions, origin]);
  const rows = useMemo(() => {
    const keys = [...CURATED];
    for (const k of Object.keys(stored)) if (!keys.includes(k)) keys.push(k);
    return keys;
  }, [stored]);

  const host = useMemo(() => {
    try {
      return new URL(origin).host || origin;
    } catch {
      return origin;
    }
  }, [origin]);

  const setPermission = (permission: string, value: PermissionSetting) => {
    void updateSettings({
      sitePermissions: nextSitePermissions(sitePermissions, origin, permission, value),
    });
  };

  const resetAll = () => {
    void updateSettings({ sitePermissions: clearOriginPermissions(sitePermissions, origin) });
  };

  const reload = () => {
    void voksa.tabs.reload(tabId);
    onClose();
  };

  const hasStored = Object.keys(stored).length > 0;

  return (
    <>
      {/* Click-outside catcher (same pattern as Menu). */}
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div className="absolute left-0 top-11 z-50 w-[380px] max-h-[70vh] overflow-y-auto rounded-xl border border-border bg-bg-elevated shadow-light-strong animate-scale-in">
        <div className="flex items-center gap-2.5 px-4 pt-4 pb-3">
          {isSecure ? (
            <Lock size={15} className="text-fg-muted flex-shrink-0" />
          ) : (
            <ShieldAlert size={15} className="text-stream flex-shrink-0" />
          )}
          <div className="flex-1 min-w-0">
            <div className="text-[13px] font-semibold text-fg truncate">
              <MaskedText text={host} />
            </div>
            <div className="text-[11px] text-fg-muted">
              {isSecure ? t('Connexion sécurisée (HTTPS)') : t('Connexion non sécurisée')}
            </div>
          </div>
          <button
            onClick={onClose}
            className="flex-shrink-0 p-1.5 rounded-lg text-fg-muted hover:text-fg hover:bg-bg-hover transition-colors"
            aria-label={t('Fermer')}
          >
            <X size={14} />
          </button>
        </div>

        {streamEnabled && (
          <div className="mx-4 mb-3 flex items-start gap-2 rounded-lg bg-stream/10 px-3 py-2">
            <Shield size={13} className="text-stream flex-shrink-0 mt-0.5" />
            <p className="text-[11px] text-stream leading-snug">
              {t('Mode Stream actif : caméra, micro, géolocalisation et autres permissions sensibles sont refusées automatiquement. Les réglages ci-dessous s’appliquent hors stream.')}
            </p>
          </div>
        )}

        <div className="border-t border-border">
          {rows.map((permission) => {
            const Icon = permissionIcon(permission);
            const value: PermissionSetting = stored[permission] ?? 'ask';
            return (
              <div key={permission} className="flex items-center gap-3 px-4 py-2.5">
                <Icon size={15} className="text-fg-muted flex-shrink-0" />
                <div className="flex-1 min-w-0 text-[12.5px] text-fg truncate">
                  {t(permissionName(permission))}
                </div>
                <select
                  value={value}
                  onChange={(e) => setPermission(permission, e.target.value as PermissionSetting)}
                  className="flex-shrink-0 h-7 rounded-lg border border-border bg-bg text-[12px] text-fg px-1.5 focus:border-accent focus:outline-none cursor-pointer"
                >
                  <option value="ask">{t('Demander (défaut)')}</option>
                  <option value="allow">{t('Autoriser')}</option>
                  <option value="deny">{t('Bloquer')}</option>
                </select>
              </div>
            );
          })}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-2.5">
          <button
            onClick={resetAll}
            disabled={!hasStored}
            className="inline-flex items-center gap-1.5 px-2.5 h-8 rounded-lg text-[12px] text-fg-muted hover:text-fg hover:bg-bg-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <RotateCcw size={12} />
            {t('Réinitialiser les autorisations')}
          </button>
          <button
            onClick={reload}
            className="px-3 h-8 rounded-lg text-[12px] font-medium bg-accent text-white hover:bg-accent-hover transition-colors"
            title={t('Les changements s’appliquent à la prochaine demande du site')}
          >
            {t('Recharger')}
          </button>
        </div>
      </div>
    </>
  );
}
