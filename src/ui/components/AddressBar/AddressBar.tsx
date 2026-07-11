import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Bookmark, BookmarkCheck, Search, SlidersHorizontal } from 'lucide-react';
import { voksa } from '../../lib/bridge';
import { useTabsStore } from '../../stores/tabsStore';
import { useStreamStore } from '../../stores/streamStore';
import { Suggestions } from './Suggestions';
import { SiteSettingsPopover } from '../SiteSettingsPopover';
import type { Suggestion } from '../../../shared/types';
import { useMaskedText } from '../../lib/masking';
import { useT } from '../../lib/i18n';

type Props = {
  onSuggestionsVisibleChange?: (visible: boolean) => void;
  onSiteSettingsOpenChange?: (open: boolean) => void;
  focusSignal?: number;
  bookmarkSignal?: number;
};

export function AddressBar({
  onSuggestionsVisibleChange,
  onSiteSettingsOpenChange,
  focusSignal,
  bookmarkSignal,
}: Props = {}): React.ReactElement {
  const t = useT();
  const active = useTabsStore((s) => s.tabs.find((t) => t.isActive) ?? null);
  const stream = useStreamStore((s) => s.config);
  const inputRef = useRef<HTMLInputElement>(null);
  // Distinguishes mouse-initiated focus from keyboard/programmatic focus:
  // a click must place the caret at the click point (and let the user drag
  // to select a range) instead of selecting everything. mousedown fires
  // before focus, so the flag is set in time for the onFocus handler.
  const focusByMouseRef = useRef(false);
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [isBookmarked, setIsBookmarked] = useState(false);
  const [siteSettingsOpen, setSiteSettingsOpen] = useState(false);

  const suggestionsVisible = focused && suggestions.length > 0;
  useEffect(() => {
    onSuggestionsVisibleChange?.(suggestionsVisible);
  }, [suggestionsVisible, onSuggestionsVisibleChange]);

  // Origin of the current page (null on internal/unparsable URLs; the
  // site-settings popover only makes sense for real web origins).
  const origin = useMemo(() => {
    if (!active || active.isInternal) return null;
    try {
      const o = new URL(active.url).origin;
      return o === 'null' ? null : o;
    } catch {
      return null;
    }
  }, [active?.url, active?.isInternal]);

  // The popover threads its visibility up to Chrome.tsx (overlay refcount,
  // CLAUDE.md §4.8) and closes itself when the page navigates elsewhere.
  useEffect(() => {
    onSiteSettingsOpenChange?.(siteSettingsOpen);
  }, [siteSettingsOpen, onSiteSettingsOpenChange]);
  useEffect(() => {
    setSiteSettingsOpen(false);
  }, [origin]);

  // While Stream Mode is ON and the bar isn't being edited, DISPLAY the masked
  // URL (viewers never see the raw address). Focusing to edit reveals the real
  // URL (the user's deliberate action), and navigation always uses the real one.
  const maskedUrl = useMaskedText(active?.url);
  useEffect(() => {
    if (!focused && active) {
      const display = active.isInternal ? '' : stream.enabled ? maskedUrl : active.url;
      setQuery(display);
      void voksa.bookmarks.findByUrl(active.url).then((b) => setIsBookmarked(!!b));
    }
  }, [active, focused, stream.enabled, maskedUrl]);

  // Keep the bookmark star in sync when the bookmark set changes anywhere
  // else in the UI (e.g. right-click delete on the bookmark bar).
  useEffect(() => {
    const unsub = voksa.bookmarks.onChanged(() => {
      if (active && !active.isInternal) {
        void voksa.bookmarks.findByUrl(active.url).then((b) => setIsBookmarked(!!b));
      }
    });
    return unsub;
  }, [active?.url, active?.isInternal]);

  useEffect(() => {
    if (!focused) {
      setSuggestions([]);
      return;
    }
    let cancelled = false;
    const q = query.trim();
    if (!q) {
      setSuggestions([]);
      return;
    }
    const t = setTimeout(() => {
      void voksa.suggestions.query(q).then((s) => {
        if (!cancelled) setSuggestions(s);
      });
    }, 80);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, focused]);

  const navigate = (target: string) => {
    if (!active) return;
    void voksa.tabs.navigate(active.id, target);
    inputRef.current?.blur();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (selectedIndex >= 0 && suggestions[selectedIndex]) {
        navigate(suggestions[selectedIndex].url);
      } else if (query.trim()) {
        navigate(query.trim());
      }
    } else if (e.key === 'Escape') {
      inputRef.current?.blur();
      if (active) setQuery(active.isInternal ? '' : active.url);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, -1));
    }
  };

  // Ctrl+L / Alt+D → focus + select the address bar.
  useEffect(() => {
    if (focusSignal === undefined || focusSignal === 0) return;
    const el = inputRef.current;
    if (el) {
      el.focus();
      el.select();
    }
  }, [focusSignal]);

  const toggleBookmark = async () => {
    if (!active) return;
    if (isBookmarked) {
      const b = await voksa.bookmarks.findByUrl(active.url);
      if (b) {
        await voksa.bookmarks.remove(b.id);
        setIsBookmarked(false);
      }
    } else {
      await voksa.bookmarks.add({
        url: active.url,
        title: active.title || active.url,
        faviconUrl: active.favicon,
      });
      setIsBookmarked(true);
    }
  };

  // Ctrl+D → toggle bookmark for the current page.
  useEffect(() => {
    if (bookmarkSignal === undefined || bookmarkSignal === 0) return;
    if (active && !active.isInternal) void toggleBookmark();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookmarkSignal]);

  const isSecure = active?.url.startsWith('https://');
  const isInternal = active?.isInternal;

  return (
    <div className="relative">
      <div
        className={`flex items-center gap-2.5 h-9 px-3 rounded-xl transition-all ${
          focused
            ? 'bg-bg-elevated border border-accent/60 ring-2 ring-accent/20'
            : 'bg-bg-inset border border-border hover:border-border-strong hover:bg-bg-elevated'
        }`}
      >
        <div className="flex-shrink-0">
          {origin ? (
            <button
              onClick={() => setSiteSettingsOpen((v) => !v)}
              className="flex items-center justify-center p-1 -m-1 rounded hover:bg-bg-hover transition-colors"
              title={t('Paramètres du site')}
              aria-label={t('Paramètres du site')}
            >
              <SlidersHorizontal
                size={14}
                className={
                  stream.enabled
                    ? 'text-stream'
                    : isSecure
                      ? 'text-fg-muted'
                      : 'text-fg-subtle'
                }
              />
            </button>
          ) : (
            <Search size={14} className="text-fg-muted" />
          )}
        </div>
        <input
          ref={inputRef}
          type="text"
          value={query}
          placeholder={t('Recherchez ou saisissez une URL')}
          onChange={(e) => setQuery(e.target.value)}
          onMouseDown={() => {
            if (document.activeElement !== inputRef.current) {
              focusByMouseRef.current = true;
            }
          }}
          onFocus={() => {
            setFocused(true);
            setSiteSettingsOpen(false);
            // Reveal the real URL for editing (display was masked while blurred
            // under Stream Mode); navigation always uses this real value.
            if (active && !active.isInternal) setQuery(active.url);
            // Select-all only for keyboard focus (Tab); mouse clicks keep
            // the browser's native caret placement + drag selection.
            if (!focusByMouseRef.current) {
              requestAnimationFrame(() => inputRef.current?.select());
            }
            focusByMouseRef.current = false;
          }}
          onBlur={() => {
            setTimeout(() => {
              setFocused(false);
              setSelectedIndex(-1);
            }, 150);
          }}
          onKeyDown={onKeyDown}
          className="flex-1 bg-transparent outline-none text-sm text-fg placeholder:text-fg-subtle"
          spellCheck={false}
        />
        {active && !isInternal && (
          <button
            onClick={toggleBookmark}
            className="flex-shrink-0 p-1 rounded hover:bg-bg-hover text-fg-muted hover:text-fg"
            title={isBookmarked ? t('Retirer des favoris') : t('Ajouter aux favoris')}
          >
            {isBookmarked ? (
              <BookmarkCheck size={14} className="text-accent" />
            ) : (
              <Bookmark size={14} />
            )}
          </button>
        )}
      </div>

      {focused && suggestions.length > 0 && (
        <Suggestions
          items={suggestions}
          selectedIndex={selectedIndex}
          onSelect={(s) => navigate(s.url)}
          onHover={setSelectedIndex}
        />
      )}

      {siteSettingsOpen && origin && active && (
        <SiteSettingsPopover
          origin={origin}
          tabId={active.id}
          isSecure={!!isSecure}
          onClose={() => setSiteSettingsOpen(false)}
        />
      )}
    </div>
  );
}
