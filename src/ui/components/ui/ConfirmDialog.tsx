import React, { useEffect } from 'react';
import { create } from 'zustand';
import { useT } from '../../lib/i18n';

type ConfirmOptions = {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
};

type ConfirmState = {
  request: (ConfirmOptions & { resolve: (v: boolean) => void }) | null;
  ask: (opts: ConfirmOptions) => Promise<boolean>;
  resolve: (v: boolean) => void;
};

const useConfirmStore = create<ConfirmState>((set, get) => ({
  request: null,
  ask: (opts) =>
    new Promise<boolean>((resolve) => {
      set({ request: { ...opts, resolve } });
    }),
  resolve: (v) => {
    const req = get().request;
    if (req) req.resolve(v);
    set({ request: null });
  },
}));

/** Imperative confirm: a themed replacement for window.confirm(). */
export function askConfirm(opts: ConfirmOptions): Promise<boolean> {
  return useConfirmStore.getState().ask(opts);
}

export function ConfirmDialogHost(): React.ReactElement | null {
  const t = useT();
  const request = useConfirmStore((s) => s.request);
  const resolve = useConfirmStore((s) => s.resolve);

  useEffect(() => {
    if (!request) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') resolve(false);
      else if (e.key === 'Enter') resolve(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [request, resolve]);

  if (!request) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center animate-fade-in">
      <div className="absolute inset-0 bg-black/40" onClick={() => resolve(false)} />
      <div className="relative w-[380px] max-w-[90vw] rounded-2xl bg-bg-elevated border border-border shadow-float animate-scale-in p-5">
        <h2 className="text-md font-semibold text-fg">{request.title}</h2>
        {request.message && <p className="mt-1.5 text-sm text-fg-muted">{request.message}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={() => resolve(false)}
            className="px-4 h-9 rounded-lg text-sm text-fg hover:bg-bg-hover"
          >
            {request.cancelLabel ?? t('Annuler')}
          </button>
          <button
            onClick={() => resolve(true)}
            className={`px-4 h-9 rounded-lg text-sm font-medium text-white ${
              request.danger ? 'bg-danger hover:bg-danger-hover' : 'bg-accent hover:bg-accent-hover'
            }`}
          >
            {request.confirmLabel ?? t('Confirmer')}
          </button>
        </div>
      </div>
    </div>
  );
}
