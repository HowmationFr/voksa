import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FileDown, Loader2, Printer, X } from 'lucide-react';
import { voksa } from '../lib/bridge';
import { useT } from '../lib/i18n';
import type { PrinterInfo, PrintMarginType } from '../../shared/types';

const PDF_DESTINATION = '__pdf__';

type Props = {
  tabId: string;
  onClose: () => void;
};

/**
 * Real-browser print dialog: options on the left, live PDF preview on the
 * right (printToPDF → blob URL → Chromium's PDF viewer in an iframe).
 * Printing is silent with the chosen options; "Enregistrer en PDF" routes
 * through a save dialog instead.
 */
export function PrintDialog({ tabId, onClose }: Props): React.ReactElement {
  const t = useT();
  const [printers, setPrinters] = useState<PrinterInfo[]>([]);
  const [destination, setDestination] = useState<string>(PDF_DESTINATION);
  const [copies, setCopies] = useState(1);
  const [landscape, setLandscape] = useState(false);
  const [allPages, setAllPages] = useState(true);
  const [rangeText, setRangeText] = useState('');
  const [marginType, setMarginType] = useState<PrintMarginType>('default');
  const [color, setColor] = useState(true);
  const [printBackground, setPrintBackground] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const previewUrlRef = useRef<string | null>(null);

  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onEsc);
    return () => document.removeEventListener('keydown', onEsc);
  }, [onClose]);

  useEffect(() => {
    void voksa.print.printers(tabId).then((list) => {
      setPrinters(list);
      // Electron no longer reports the OS default printer: preselect the
      // first one; "Enregistrer en PDF" stays the fallback with no printer.
      if (list[0]) setDestination(list[0].name);
    });
  }, [tabId]);

  const effectiveRanges = allPages ? '' : rangeText;

  // Debounced preview re-render on every layout-affecting change.
  useEffect(() => {
    let cancelled = false;
    setPreviewLoading(true);
    const t = setTimeout(() => {
      void voksa.print
        .preview(tabId, { landscape, marginType, pageRanges: effectiveRanges, printBackground })
        .then((base64) => {
          if (cancelled) return;
          setPreviewLoading(false);
          if (!base64) {
            setPreviewUrl(null);
            return;
          }
          const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
          const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
          if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
          previewUrlRef.current = url;
          setPreviewUrl(url);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [tabId, landscape, marginType, effectiveRanges, printBackground]);

  useEffect(() => {
    return () => {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    };
  }, []);

  const isPdf = destination === PDF_DESTINATION;
  const submitLabel = isPdf ? t('Enregistrer') : t('Imprimer');
  const SubmitIcon = isPdf ? FileDown : Printer;

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await voksa.print.execute(tabId, {
        deviceName: isPdf ? null : destination,
        copies,
        landscape,
        marginType,
        pageRanges: effectiveRanges,
        printBackground,
        color,
      });
      if (result.ok) onClose();
      else if (result.error !== 'cancelled') setError(result.error ?? t('Échec de l’impression.'));
    } finally {
      setBusy(false);
    }
  };

  const destinations = useMemo(
    () => [
      ...printers.map((p) => ({ value: p.name, label: p.displayName })),
      { value: PDF_DESTINATION, label: t('Enregistrer en PDF') },
    ],
    [printers, t],
  );

  return (
    <>
      <div className="fixed inset-0 bg-black/40 z-[9990] animate-fade-in" onClick={onClose} />
      <div className="fixed inset-6 z-[9991] flex bg-bg-elevated border border-border rounded-2xl shadow-float overflow-hidden animate-scale-in">
        {/* Options column */}
        <div className="w-[320px] flex-shrink-0 flex flex-col border-r border-border">
          <div className="flex items-center justify-between px-5 py-4 border-b border-border">
            <h2 className="text-base font-semibold">{t('Imprimer')}</h2>
            <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-bg-hover text-fg-muted">
              <X size={16} />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
            <Field label={t('Destination')}>
              <select
                value={destination}
                onChange={(e) => setDestination(e.target.value)}
                className="w-full h-9 rounded-lg bg-bg-inset border border-border px-3 text-sm focus:border-accent focus:outline-none cursor-pointer"
              >
                {destinations.map((d) => (
                  <option key={d.value} value={d.value}>
                    {d.label}
                  </option>
                ))}
              </select>
            </Field>

            {!isPdf && (
              <Field label={t('Copies')}>
                <input
                  type="number"
                  min={1}
                  max={99}
                  value={copies}
                  onChange={(e) =>
                    setCopies(Math.max(1, Math.min(99, parseInt(e.target.value, 10) || 1)))
                  }
                  className="w-24 h-9 rounded-lg bg-bg-inset border border-border px-3 text-sm focus:border-accent focus:outline-none"
                />
              </Field>
            )}

            <Field label={t('Mise en page')}>
              <div className="flex items-center gap-1 bg-bg-inset rounded-lg p-1">
                {[
                  { v: false, label: 'Portrait' },
                  { v: true, label: 'Paysage' },
                ].map((o) => (
                  <button
                    key={o.label}
                    onClick={() => setLandscape(o.v)}
                    className={`flex-1 h-7 rounded-md text-xs transition-colors ${
                      landscape === o.v
                        ? 'bg-bg-elevated text-fg shadow-soft'
                        : 'text-fg-muted hover:text-fg'
                    }`}
                  >
                    {t(o.label)}
                  </button>
                ))}
              </div>
            </Field>

            <Field label={t('Pages')}>
              <select
                value={allPages ? 'all' : 'custom'}
                onChange={(e) => setAllPages(e.target.value === 'all')}
                className="w-full h-9 rounded-lg bg-bg-inset border border-border px-3 text-sm focus:border-accent focus:outline-none cursor-pointer"
              >
                <option value="all">{t('Toutes')}</option>
                <option value="custom">{t('Personnalisées')}</option>
              </select>
              {!allPages && (
                <input
                  type="text"
                  value={rangeText}
                  onChange={(e) => setRangeText(e.target.value)}
                  placeholder={t('Ex. : 1-5, 8, 11-13')}
                  className="mt-2 w-full h-9 rounded-lg bg-bg-inset border border-border px-3 text-sm focus:border-accent focus:outline-none"
                />
              )}
            </Field>

            {!isPdf && (
              <Field label={t('Couleur')}>
                <select
                  value={color ? 'color' : 'bw'}
                  onChange={(e) => setColor(e.target.value === 'color')}
                  className="w-full h-9 rounded-lg bg-bg-inset border border-border px-3 text-sm focus:border-accent focus:outline-none cursor-pointer"
                >
                  <option value="color">{t('Couleur')}</option>
                  <option value="bw">{t('Noir et blanc')}</option>
                </select>
              </Field>
            )}

            <Field label={t('Marges')}>
              <select
                value={marginType}
                onChange={(e) => setMarginType(e.target.value as PrintMarginType)}
                className="w-full h-9 rounded-lg bg-bg-inset border border-border px-3 text-sm focus:border-accent focus:outline-none cursor-pointer"
              >
                <option value="default">{t('Par défaut')}</option>
                <option value="printableArea">{t('Minimales')}</option>
                <option value="none">{t('Aucune')}</option>
              </select>
            </Field>

            <label className="flex items-center gap-2.5 cursor-pointer">
              <input
                type="checkbox"
                checked={printBackground}
                onChange={(e) => setPrintBackground(e.target.checked)}
                className="accent-[rgb(var(--accent))]"
              />
              <span className="text-[13px] text-fg">{t('Imprimer les arrière-plans')}</span>
            </label>

            {error && (
              <p className="text-[12px] text-danger leading-snug bg-danger/10 rounded-lg px-3 py-2">
                {error}
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
              disabled={busy}
              className="inline-flex items-center gap-2 px-4 h-9 rounded-lg bg-accent hover:bg-accent-hover text-white text-sm font-medium disabled:opacity-50 transition-colors"
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <SubmitIcon size={14} />}
              {submitLabel}
            </button>
          </div>
        </div>

        {/* Preview */}
        <div className="flex-1 min-w-0 bg-bg-inset relative">
          {previewUrl ? (
            <iframe
              title={t('Aperçu avant impression')}
              src={`${previewUrl}#toolbar=0`}
              className="absolute inset-0 w-full h-full border-0"
            />
          ) : (
            !previewLoading && (
              <div className="absolute inset-0 flex items-center justify-center text-sm text-fg-muted px-8 text-center">
                {t('Aperçu indisponible pour cette page.')}
              </div>
            )
          )}
          {previewLoading && (
            <div className="absolute inset-0 flex items-center justify-center bg-bg-inset/70">
              <Loader2 size={22} className="animate-spin text-fg-muted" />
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function Field({
  label,
  children,
}: React.PropsWithChildren<{ label: string }>): React.ReactElement {
  return (
    <div>
      <label className="block text-xs font-medium text-fg-muted mb-1.5">{label}</label>
      {children}
    </div>
  );
}
