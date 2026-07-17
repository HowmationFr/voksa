import React, { useEffect, useState } from 'react';
import { Monitor, AppWindow, ShieldCheck } from 'lucide-react';
import { voksa } from '../lib/bridge';
import { useT } from '../lib/i18n';
import { useMaskedText } from '../lib/masking';

type PickerSource = {
  id: string;
  name: string;
  kind: 'screen' | 'window';
  thumbnail: string | null;
  containsVoksa: boolean;
};

type PickerRequest = { pickId: string; sources: PickerSource[] };

/**
 * Voksa's own screen-share picker (Capture Handshake). Shown when a page calls
 * getDisplayMedia; main enumerated the sources and stripped the thumbnails of
 * any Voksa surface (a thumbnail predates masking). Selecting a Voksa surface
 * arms Stream Mode and waits for masking before the stream is delivered, so
 * the far side's first frame is already masked; the picker says so.
 */
export function CapturePicker({
  onOpenChange,
}: {
  onOpenChange?: (open: boolean) => void;
}): React.ReactElement | null {
  const t = useT();
  const [request, setRequest] = useState<PickerRequest | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    // Queueing is unnecessary: getDisplayMedia is user-initiated and serial.
    // A new request replaces any stale one (the old page gave up).
    return voksa.capture.onPickerShow((payload) => {
      setRequest(payload);
      setSelected(null);
    });
  }, []);

  useEffect(() => {
    onOpenChange?.(request !== null);
  }, [request, onOpenChange]);

  if (!request) return null;

  const answer = (sourceId: string | null) => {
    voksa.capture.pick(request.pickId, sourceId);
    setRequest(null);
  };

  const screens = request.sources.filter((s) => s.kind === 'screen');
  const windows = request.sources.filter((s) => s.kind === 'window');

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center animate-fade-in">
      <div className="absolute inset-0 bg-black/50" onClick={() => answer(null)} />
      <div
        data-voksa-capture-picker={request.sources.length}
        className="relative w-[560px] max-w-[92vw] max-h-[80vh] flex flex-col rounded-2xl bg-bg-elevated border border-border shadow-float animate-scale-in"
      >
        <div className="px-5 pt-5 pb-3">
          <h2 className="text-md font-semibold text-fg">{t('Partager votre écran')}</h2>
          <p className="mt-1 text-[13px] text-fg-muted">
            {t('Choisissez ce que vous voulez partager. Une fenêtre Voksa est masquée avant la première image envoyée.')}
          </p>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto px-5 pb-3 space-y-4">
          {screens.length > 0 && (
            <Group label={t('Écrans')}>
              {screens.map((s) => (
                <SourceTile
                  key={s.id}
                  source={s}
                  active={selected === s.id}
                  onSelect={() => setSelected(s.id)}
                />
              ))}
            </Group>
          )}
          {windows.length > 0 && (
            <Group label={t('Fenêtres')}>
              {windows.map((s) => (
                <SourceTile
                  key={s.id}
                  source={s}
                  active={selected === s.id}
                  onSelect={() => setSelected(s.id)}
                />
              ))}
            </Group>
          )}
          {request.sources.length === 0 && (
            // Enumeration failed or found nothing (headless session, Wayland
            // without portal): say so instead of a mysteriously empty dialog.
            <p className="text-[13px] text-fg-muted text-center py-8">
              {t('Aucune surface capturable n’a été trouvée sur ce système.')}
            </p>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border">
          <button
            onClick={() => answer(null)}
            className="px-4 h-9 rounded-lg text-sm text-fg hover:bg-bg-hover"
          >
            {t('Annuler')}
          </button>
          <button
            data-voksa-capture-confirm
            onClick={() => selected && answer(selected)}
            disabled={!selected}
            className="px-4 h-9 rounded-lg text-sm font-medium text-white bg-accent hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {t('Partager')}
          </button>
        </div>
      </div>
    </div>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-fg-subtle mb-2">{label}</div>
      <div className="grid grid-cols-2 gap-2">{children}</div>
    </div>
  );
}

function SourceTile({
  source,
  active,
  onSelect,
}: {
  source: PickerSource;
  active: boolean;
  onSelect: () => void;
}): React.ReactElement {
  const t = useT();
  // A window title is user content (an open document name, an email subject):
  // masked like every other chrome surface.
  const name = useMaskedText(source.name);
  const Icon = source.kind === 'screen' ? Monitor : AppWindow;
  return (
    <button
      data-voksa-capture-source={source.id}
      onClick={onSelect}
      className={`text-left rounded-xl border overflow-hidden transition-colors ${
        active ? 'border-accent ring-1 ring-accent' : 'border-border hover:bg-bg-hover'
      }`}
    >
      <div className="aspect-video bg-bg-inset flex items-center justify-center overflow-hidden">
        {source.thumbnail ? (
          <img src={source.thumbnail} alt="" className="w-full h-full object-cover" />
        ) : (
          <div className="flex flex-col items-center gap-1 text-fg-subtle">
            <Icon size={22} />
            {source.containsVoksa && (
              <span className="flex items-center gap-1 text-[10px] text-stream">
                <ShieldCheck size={11} /> {t('Voksa (masqué)')}
              </span>
            )}
          </div>
        )}
      </div>
      <div className="px-2.5 py-1.5 flex items-center gap-1.5">
        <Icon size={13} className="flex-shrink-0 text-fg-subtle" />
        <span className="text-[12px] text-fg truncate">{name}</span>
      </div>
    </button>
  );
}
