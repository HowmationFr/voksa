import React, { useMemo, useState } from 'react';
import { Scale, Search as SearchIcon } from 'lucide-react';
import { voksa } from '../../lib/bridge';
import { useT } from '../../lib/i18n';
import { useMaskedText } from '../../lib/masking';
import { SettingsBackLink } from './SettingsBackLink';
import { Trans } from '../ui/Trans';
import creditsData from '@shared/credits.generated.json';

/**
 * voksa://credits, our chrome://credits: every open-source project that ships
 * inside Voksa, with its licence.
 *
 * The data is generated from node_modules by scripts/gen-credits.mjs and
 * committed, so this page can never drift into claiming a dependency we no
 * longer ship (or, worse, silently drop one we do). It is imported statically
 * rather than fetched: the chrome UI is loaded over file:// in a packaged
 * build, where fetch() of a sibling file is not permitted.
 */

type CreditEntry = {
  name: string;
  version: string | null;
  license: string;
  homepage: string | null;
  /** Canonical licence URL, for the few projects whose text we do not ship. */
  licenseUrl: string | null;
  /** Verbatim licence file, or null when the package shipped none. */
  text: string | null;
};

const CREDITS = creditsData as CreditEntry[];

const SOURCE_URL = 'https://github.com/HowmationFr/voksa';
const CHROMIUM_SOURCE_URL = 'https://source.chromium.org/chromium';

export function CreditsPage(): React.ReactElement {
  const t = useT();
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const allExpanded = expanded.size === CREDITS.length;

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return CREDITS;
    return CREDITS.filter(
      (entry) =>
        entry.name.toLowerCase().includes(q) || entry.license.toLowerCase().includes(q),
    );
  }, [query]);

  const toggle = (name: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  return (
    <div className="bg-bg text-fg min-h-full">
      <div className="max-w-4xl mx-auto px-6 py-10">
        <SettingsBackLink />
        <div className="flex items-center justify-between gap-4 mb-2">
          <h1 className="flex items-center gap-3 text-xl font-semibold">
            <Scale size={20} className="text-accent" />
            {t('Crédits')}
          </h1>
          <button
            type="button"
            onClick={() =>
              setExpanded(allExpanded ? new Set() : new Set(CREDITS.map((e) => e.name)))
            }
            className="flex-shrink-0 px-3 h-8 rounded-lg text-[13px] text-fg hover:bg-bg-hover border border-border transition-colors"
          >
            {allExpanded ? t('Tout masquer') : t('Afficher toutes les licences')}
          </button>
        </div>

        <p className="text-[13px] text-fg-muted leading-relaxed mb-6">
          <Trans
            text={t(
              'Voksa est un logiciel libre : son {source} est public. Il fonctionne grâce au projet Open Source {chromium} et aux {n} projets ci-dessous, dont le code est distribué avec le navigateur.',
              { n: CREDITS.length },
            )}
            values={{
              source: (
                <button
                  type="button"
                  onClick={() => void voksa.tabs.create(SOURCE_URL)}
                  className="text-accent hover:underline"
                >
                  {t('code source')}
                </button>
              ),
              chromium: (
                <button
                  type="button"
                  onClick={() => void voksa.tabs.create(CHROMIUM_SOURCE_URL)}
                  className="text-accent hover:underline"
                >
                  Chromium
                </button>
              ),
            }}
          />
        </p>

        <div className="relative mb-4">
          <SearchIcon
            size={15}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle pointer-events-none"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('Rechercher un projet ou une licence')}
            className="w-full h-9 pl-9 pr-3 rounded-lg bg-bg-elevated border border-border text-[13px] text-fg placeholder:text-fg-subtle focus:outline-none focus:border-accent transition-colors"
          />
        </div>

        {visible.length === 0 ? (
          <p className="py-10 text-center text-[13px] text-fg-muted">
            {t('Aucun projet ne correspond à « {query} ».', { query: query.trim() })}
          </p>
        ) : (
          <div className="border border-border rounded-xl overflow-hidden divide-y divide-border">
            {visible.map((entry, i) => (
              <CreditRow
                key={entry.name}
                entry={entry}
                striped={i % 2 === 1}
                open={expanded.has(entry.name)}
                onToggle={() => toggle(entry.name)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

type RowProps = {
  entry: CreditEntry;
  striped: boolean;
  open: boolean;
  onToggle: () => void;
};

function CreditRow({ entry, striped, open, onToggle }: RowProps): React.ReactElement {
  const t = useT();
  // Ten of these licence files carry their author's email (debug, jsonfile,
  // loose-envify...). This page is chrome UI, so under Stream Mode it owes the
  // same promise as every other internal page: no address on screen. Not the
  // user's data, but the invariant is "no email is painted", not "no email of
  // yours is painted".
  const maskedText = useMaskedText(entry.text);

  return (
    <div className={striped ? 'bg-bg-elevated' : 'bg-bg'}>
      <div className="flex items-center gap-4 px-4 py-2.5">
        <div className="flex-1 min-w-0">
          <span className="text-[13px] font-medium text-fg break-all">{entry.name}</span>
          {entry.version ? (
            <span className="ml-2 text-[12px] text-fg-subtle tabular-nums">{entry.version}</span>
          ) : null}
        </div>

        <span className="flex-shrink-0 text-[12px] text-fg-muted">{entry.license}</span>

        <div className="flex-shrink-0 flex items-center gap-2 text-[12px]">
          {/* A project whose package shipped no licence file (or that is not an
              npm package at all) gets a link to the canonical text instead of a
              transcription: a hand-copied licence is a licence you can get wrong. */}
          {entry.text ? (
            <button type="button" onClick={onToggle} className="text-accent hover:underline">
              {open ? t('masquer la licence') : t('afficher la licence')}
            </button>
          ) : entry.licenseUrl ? (
            <button
              type="button"
              onClick={() => void voksa.tabs.create(entry.licenseUrl as string)}
              className="text-accent hover:underline"
            >
              {t('afficher la licence')}
            </button>
          ) : (
            <span className="text-fg-subtle">{t('licence non fournie')}</span>
          )}

          {entry.homepage ? (
            <>
              <span className="text-fg-subtle">-</span>
              <button
                type="button"
                onClick={() => void voksa.tabs.create(entry.homepage as string)}
                className="text-accent hover:underline"
              >
                {t('site web')}
              </button>
            </>
          ) : null}
        </div>
      </div>

      {open && entry.text ? (
        <pre className="px-4 pb-4 text-[11px] leading-relaxed text-fg-muted whitespace-pre-wrap break-words font-mono">
          {maskedText}
        </pre>
      ) : null}
    </div>
  );
}
