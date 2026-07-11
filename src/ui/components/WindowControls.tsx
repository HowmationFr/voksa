import React, { useEffect, useState } from 'react';
import { Minus, Square, Copy, X } from 'lucide-react';
import { voksa } from '../lib/bridge';
import { useT } from '../lib/i18n';

/**
 * Windows/Linux custom window control trio. Rendered inside the React tree
 * (not as native titleBarOverlay) so that modal backdrops dim them naturally
 * and the background color always matches the current theme.
 *
 * macOS uses native traffic lights positioned via `trafficLightPosition` in
 * window.ts; this component returns null there.
 */
export function WindowControls(): React.ReactElement | null {
  const t = useT();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    void voksa.window.getState().then((s) => setMaximized(s.maximized));
    const unsub = voksa.window.onStateChanged((s) => setMaximized(s.maximized));
    return unsub;
  }, []);

  if (typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)) {
    return null;
  }

  return (
    <div className="flex items-stretch h-full no-drag">
      <ControlButton
        onClick={() => void voksa.window.minimize()}
        label={t('Réduire')}
        className="hover:bg-bg-hover text-fg-muted hover:text-fg"
      >
        <Minus size={14} strokeWidth={2} />
      </ControlButton>
      <ControlButton
        onClick={() => void voksa.window.maximize()}
        label={maximized ? t('Restaurer') : t('Agrandir')}
        className="hover:bg-bg-hover text-fg-muted hover:text-fg"
      >
        {maximized ? <Copy size={12} strokeWidth={2} /> : <Square size={12} strokeWidth={2} />}
      </ControlButton>
      <ControlButton
        onClick={() => void voksa.window.close()}
        label={t('Fermer')}
        className="hover:bg-[#e81123] hover:text-white text-fg-muted"
      >
        <X size={14} strokeWidth={2} />
      </ControlButton>
    </div>
  );
}

function ControlButton({
  onClick,
  label,
  className,
  children,
}: React.PropsWithChildren<{
  onClick: () => void;
  label: string;
  className?: string;
}>): React.ReactElement {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`flex items-center justify-center w-[46px] h-full transition-colors ${className ?? ''}`}
    >
      {children}
    </button>
  );
}
