import React, { useEffect, useState } from 'react';
import { voksa } from '../lib/bridge';
import { useT } from '../lib/i18n';
import { permissionIcon, permissionRequestLabel } from '../lib/permissionLabels';

type PermReq = { id: string; origin: string; permission: string };

/**
 * Renders the current permission request (Stream Mode OFF) as a prompt anchored
 * under the address bar. Requests queue so rapid-fire prompts don't stack.
 */
export function PermissionPrompt({
  onOpenChange,
}: {
  onOpenChange?: (open: boolean) => void;
}): React.ReactElement | null {
  const t = useT();
  const [queue, setQueue] = useState<PermReq[]>([]);

  useEffect(() => {
    return voksa.permissions.onRequest((req) => setQueue((q) => [...q, req]));
  }, []);

  const current = queue[0] ?? null;
  useEffect(() => {
    onOpenChange?.(current !== null);
  }, [current, onOpenChange]);

  if (!current) return null;

  const label = t(permissionRequestLabel(current.permission));
  const Icon = permissionIcon(current.permission);
  const respond = (allow: boolean, remember: boolean) => {
    voksa.permissions.respond(current.id, allow, remember);
    setQueue((q) => q.slice(1));
  };

  let host = current.origin;
  try {
    host = new URL(current.origin).host || current.origin;
  } catch {
    // keep raw
  }

  return (
    <div className="absolute left-4 top-[92px] z-50 w-[360px] rounded-xl border border-border bg-bg-elevated shadow-light-strong animate-scale-in overflow-hidden">
      <div className="flex items-start gap-3 p-4">
        <div className="flex-shrink-0 w-9 h-9 rounded-lg bg-accent-muted flex items-center justify-center text-accent">
          <Icon size={18} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[13px] text-fg">
            <span className="font-semibold">{host || t('Ce site')}</span>{' '}
            {t('souhaite {label}.', { label })}
          </div>
        </div>
      </div>
      <div className="flex items-center justify-end gap-2 px-4 pb-3">
        <button
          onClick={() => respond(false, true)}
          className="px-3 h-8 rounded-lg text-[12px] text-fg-muted hover:bg-bg-hover"
        >
          {t('Toujours refuser')}
        </button>
        <button
          onClick={() => respond(false, false)}
          className="px-3 h-8 rounded-lg text-[12px] text-fg hover:bg-bg-hover"
        >
          {t('Bloquer')}
        </button>
        <button
          onClick={() => respond(true, true)}
          className="px-3 h-8 rounded-lg text-[12px] font-medium bg-accent text-white hover:bg-accent-hover"
        >
          {t('Autoriser')}
        </button>
      </div>
    </div>
  );
}
