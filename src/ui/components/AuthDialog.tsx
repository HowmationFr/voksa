import React, { useEffect, useRef, useState } from 'react';
import { KeyRound } from 'lucide-react';
import type { AuthRequest } from '../../shared/types';
import { voksa } from '../lib/bridge';
import { useT } from '../lib/i18n';
import { useMaskedText } from '../lib/masking';

/**
 * HTTP authentication dialog (Basic/Digest/proxy), pushed by the main process
 * for challenges hitting this window. Modeled on Chrome: a centered modal, one
 * challenge at a time (they queue), Escape cancels. Credentials are relayed to
 * Chromium's auth callback and never persisted.
 *
 * The host is user-destined text that can carry exactly what Stream Mode
 * hides (an internal hostname, an IP): it goes through the same mask as every
 * other chrome surface.
 */
export function AuthDialog({
  onOpenChange,
}: {
  onOpenChange?: (open: boolean) => void;
}): React.ReactElement | null {
  const t = useT();
  const [queue, setQueue] = useState<AuthRequest[]>([]);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const userRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    return voksa.auth.onRequest((req) => setQueue((q) => [...q, req]));
  }, []);

  const current = queue[0] ?? null;
  useEffect(() => {
    onOpenChange?.(current !== null);
  }, [current, onOpenChange]);

  // Fresh fields per challenge: credentials from one server must never
  // pre-fill the dialog of another. Keyed on the challenge id alone: the
  // object identity of `current` changes on every queue update, and resetting
  // then would wipe what the user is typing.
  const currentId = current?.id ?? null;
  useEffect(() => {
    setUsername('');
    setPassword('');
    if (currentId) userRef.current?.focus();
  }, [currentId]);

  const maskedHost = useMaskedText(current?.host ?? '');

  if (!current) return null;

  const advance = () => setQueue((q) => q.slice(1));
  const submit = () => {
    voksa.auth.respond(current.id, username, password);
    advance();
  };
  const cancel = () => {
    voksa.auth.cancel(current.id);
    advance();
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center animate-fade-in">
      <div className="absolute inset-0 bg-black/40" onClick={cancel} />
      <div
        data-voksa-auth
        className="relative w-[400px] max-w-[90vw] rounded-2xl bg-bg-elevated border border-border shadow-float animate-scale-in p-5"
      >
        <div className="flex items-start gap-3 mb-4">
          <div className="flex-shrink-0 w-9 h-9 rounded-lg bg-accent-muted flex items-center justify-center text-accent">
            <KeyRound size={18} />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-md font-semibold text-fg">{t('Connexion requise')}</h2>
            <p className="mt-0.5 text-[13px] text-fg-muted break-all">
              {current.isProxy
                ? t('Le proxy {host} demande un identifiant.', { host: maskedHost })
                : t('{host} demande un identifiant.', { host: maskedHost })}
              {current.realm ? (
                <span className="text-fg-subtle"> ({current.realm})</span>
              ) : null}
            </p>
          </div>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <label className="block mb-3">
            <span className="block text-[12px] text-fg-muted mb-1">{t('Nom d’utilisateur')}</span>
            <input
              ref={userRef}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') cancel();
              }}
              autoComplete="off"
              className="w-full h-9 px-3 rounded-lg bg-bg border border-border text-sm outline-none focus:border-accent/60"
            />
          </label>
          <label className="block mb-5">
            <span className="block text-[12px] text-fg-muted mb-1">{t('Mot de passe')}</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') cancel();
              }}
              autoComplete="off"
              className="w-full h-9 px-3 rounded-lg bg-bg border border-border text-sm outline-none focus:border-accent/60"
            />
          </label>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              data-voksa-auth-cancel
              onClick={cancel}
              className="px-4 h-9 rounded-lg text-sm text-fg hover:bg-bg-hover"
            >
              {t('Annuler')}
            </button>
            <button
              type="submit"
              className="px-4 h-9 rounded-lg text-sm font-medium text-white bg-accent hover:bg-accent-hover"
            >
              {t('Se connecter')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
