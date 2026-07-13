import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Bookmark, BookmarkCheck, Info, Search, SlidersHorizontal } from 'lucide-react';
import { findEngineByKeyword, getEngine, resolveEngines } from '../../../shared/searchEngines';
import { voksa } from '../../lib/bridge';
import { useTabsStore } from '../../stores/tabsStore';
import { useStreamStore } from '../../stores/streamStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { Suggestions } from './Suggestions';
import { SiteSettingsPopover } from '../SiteSettingsPopover';
import type { Suggestion } from '../../../shared/types';
import { useMaskedText } from '../../lib/masking';
import { useT } from '../../lib/i18n';

/** The one internal page that keeps an empty bar: it IS the search box. */
const NEW_TAB_URL = 'voksa://newtab';

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
  const blurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [isBookmarked, setIsBookmarked] = useState(false);
  const [siteSettingsOpen, setSiteSettingsOpen] = useState(false);
  // Tab-to-search: the engine whose keyword the user typed. Entering the mode
  // moves the keyword out of the text and into the chip, so `query` holds the
  // search terms alone; the engine is then named EXPLICITLY on the way out
  // (navigate / suggestions take an engine id). It is never re-derived from the
  // text, which is what stops "bing.com vs google" from becoming a Bing search
  // for "vs google". The renderer still builds no URL: main does that.
  const [keywordId, setKeywordId] = useState<string | null>(null);
  // The user's engines count too: a custom keyword must work like a built-in.
  const customEngines = useSettingsStore((s) => s.settings.customEngines);
  const engines = useMemo(() => resolveEngines(customEngines), [customEngines]);

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
  //
  // Internal pages show their voksa:// address like any other page, and go
  // through the SAME masking path: no `if (isInternal) skipMask` shortcut to
  // maintain, so a future internal URL carrying a parameter cannot become a
  // leak. Only the new tab page keeps an empty bar, as Chrome does: that bar
  // is where you type, a prefix to delete first would just be in the way.
  const maskedUrl = useMaskedText(active?.url);
  const displayUrl = (masked: boolean) => {
    if (!active || active.url === NEW_TAB_URL) return '';
    return masked && stream.enabled ? maskedUrl : active.url;
  };
  useEffect(() => {
    if (!focused && active) {
      setKeywordId(null);
      setQuery(displayUrl(true));
      void voksa.bookmarks.findByUrl(active.url).then((b) => setIsBookmarked(!!b));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, focused, stream.enabled, maskedUrl]);

  // Switching tab must reset the bar even while it is FOCUSED. Ctrl+Tab and
  // Ctrl+1-9 are native menu accelerators handled in main: they never blur the
  // input, so without this the chip (and, under Stream Mode, the real URL of
  // the tab we just left, revealed by focus) would stay on screen over the new
  // tab, and Enter would apply them to it.
  const activeId = active?.id;
  useEffect(() => {
    if (!activeId) return;
    setKeywordId(null);
    setSuggestions([]);
    setSelectedIndex(-1);
    setQuery(displayUrl(!focused));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

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
      // With the chip up, `q` is TERMS and the engine is named explicitly. Main
      // builds every search URL either way: the renderer never does.
      void voksa.suggestions.query(q, keywordId ?? undefined).then((s) => {
        if (!cancelled) setSuggestions(s);
      });
    }, 80);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, focused, keywordId]);

  /** `engine` set = `target` is a query for that engine, not an address. */
  const navigate = (target: string, engine?: string) => {
    if (!active) return;
    void voksa.tabs.navigate(active.id, target, engine);
    setKeywordId(null);
    inputRef.current?.blur();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (selectedIndex >= 0 && suggestions[selectedIndex]) {
        navigate(suggestions[selectedIndex].url);
      } else if (query.trim()) {
        navigate(query.trim(), keywordId ?? undefined);
      }
    } else if (e.key === 'Escape') {
      inputRef.current?.blur();
      setKeywordId(null);
      if (active) setQuery(displayUrl(false));
    } else if (
      e.key === 'Backspace' &&
      keywordId &&
      e.currentTarget.selectionStart === 0 &&
      e.currentTarget.selectionEnd === 0
    ) {
      // Backspace at the very start drops the chip and hands the keyword back
      // as text. It stays dropped: onChange only re-arms on a fresh
      // keyword-then-Space sequence, never by re-reading the line.
      e.preventDefault();
      setQuery(`${getEngine(keywordId, engines).keyword} ${query}`);
      setKeywordId(null);
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
          ) : isInternal && active?.url !== NEW_TAB_URL ? (
            // An internal page now shows its address, so the search glyph would
            // be a lie. It has no site permissions either: nothing to click.
            <Info size={14} className="text-fg-muted" aria-label={t('Page interne de Voksa')} />
          ) : (
            <Search size={14} className="text-fg-muted" />
          )}
        </div>

        {keywordId && (
          <span className="flex-shrink-0 flex items-center px-2 h-6 rounded-md bg-accent/10 text-accent text-xs font-medium whitespace-nowrap">
            {t('Rechercher sur {engine}', { engine: getEngine(keywordId, engines).name })}
          </span>
        )}

        <input
          ref={inputRef}
          type="text"
          value={query}
          data-voksa-address
          placeholder={t('Recherchez ou saisissez une URL')}
          onChange={(e) => {
            const next = e.target.value;
            // Keyword mode is entered by ONE keystroke: the Space typed right
            // after a keyword that is the WHOLE input, exactly like Chrome.
            //
            // It is never re-derived from the text afterwards. Doing that was a
            // trap: "bing.com vs google" would silently become a Bing search for
            // "vs google", and dismissing the chip only lasted until the next
            // character re-armed it. Here, once the chip is gone, it stays gone
            // until the user types the sequence again.
            const justTypedSpace = next.endsWith(' ') && next.trimEnd() === query.trimEnd();
            const engine =
              !keywordId && justTypedSpace ? findEngineByKeyword(next, engines) : null;
            if (engine) {
              setKeywordId(engine.id);
              setQuery('');
            } else {
              setQuery(next);
            }
          }}
          onMouseDown={() => {
            if (document.activeElement !== inputRef.current) {
              focusByMouseRef.current = true;
            }
          }}
          onFocus={() => {
            // Cancel a blur still in its 150 ms grace period: clicking out and
            // straight back in used to let that timer fire while the input held
            // focus, wiping what the user had typed (and now the chip too).
            if (blurTimerRef.current !== null) {
              clearTimeout(blurTimerRef.current);
              blurTimerRef.current = null;
            }
            setFocused(true);
            setSiteSettingsOpen(false);
            // Reveal the real URL for editing (display was masked while blurred
            // under Stream Mode); navigation always uses this real value.
            if (active && !keywordId) setQuery(displayUrl(false));
            // Select-all only for keyboard focus (Tab); mouse clicks keep
            // the browser's native caret placement + drag selection.
            if (!focusByMouseRef.current) {
              requestAnimationFrame(() => inputRef.current?.select());
            }
            focusByMouseRef.current = false;
          }}
          onBlur={() => {
            // The delay lets a click on a suggestion land before the dropdown
            // unmounts.
            blurTimerRef.current = setTimeout(() => {
              blurTimerRef.current = null;
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
