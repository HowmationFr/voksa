import React from 'react';
import { voksa } from '../lib/bridge';
import { useT } from '../lib/i18n';

type State = { error: Error | null };

/**
 * Guards the chrome tree below the window controls. A render crash shows a
 * recoverable panel instead of a blank frameless window with no way to close.
 */
export class ErrorBoundary extends React.Component<React.PropsWithChildren, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error): void {
    console.error('[ui] render error', error);
  }

  render(): React.ReactNode {
    if (this.state.error) {
      return <ErrorFallback error={this.state.error} />;
    }
    return this.props.children;
  }
}

/** Function component so the fallback UI can use the i18n hook. */
function ErrorFallback({ error }: { error: Error }): React.ReactElement {
  const t = useT();
  return (
    <div className="relative flex flex-col items-center justify-center h-full w-full bg-bg text-center px-6">
      {/* Fallback window controls so a frameless window stays controllable. */}
      <div className="absolute top-0 inset-x-0 h-9 drag-region flex justify-end items-center pr-2">
        <button
          onClick={() => void voksa.window.close()}
          className="no-drag w-8 h-8 rounded-lg flex items-center justify-center text-fg-muted hover:bg-danger hover:text-white"
          title={t('Fermer')}
        >
          ✕
        </button>
      </div>
      <h1 className="text-lg font-semibold text-fg mb-1">{t('Une erreur est survenue')}</h1>
      <p className="text-sm text-fg-muted mb-5 max-w-md">
        {t('L’interface a rencontré un problème inattendu.')}
      </p>
      <button
        onClick={() => location.reload()}
        className="px-4 h-9 rounded-lg bg-accent text-white text-sm font-medium hover:bg-accent-hover"
      >
        {t('Recharger l’interface')}
      </button>
      <pre className="mt-6 text-2xs text-fg-subtle font-mono max-w-lg overflow-x-auto opacity-70">
        {error.message}
      </pre>
    </div>
  );
}
