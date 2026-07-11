import type { AppSettings } from './types';

export type SearchEngine = AppSettings['searchEngine'];

/** Where a plain-text query is sent, per configured engine. */
export const ENGINE_SEARCH_URLS: Record<SearchEngine, string> = {
  google: 'https://www.google.com/search?q=',
  duckduckgo: 'https://duckduckgo.com/?q=',
  startpage: 'https://www.startpage.com/do/search?q=',
  brave: 'https://search.brave.com/search?q=',
};

// 'hbb' is the legacy alias of 'voksa' (pre-rename profiles / muscle memory);
// normalizeInput rewrites it to voksa://, but isUrlLike must still treat it
// as a URL rather than a search query.
const SCHEME_RE = /^(https?|file|voksa|hbb|about|chrome|chrome-extension):/i;
/** Legacy scheme prefix from before the Voksa rename. */
const LEGACY_SCHEME_RE = /^hbb:\/\//i;
const IPV4_HOST_RE = /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/.*)?$/;
const DOMAIN_RE = /^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/;

/**
 * True when the string looks like something to navigate to (URL, IP, domain,
 * localhost) rather than a search query. Used by the suggestions engine to
 * decide the primary "go to X" vs "search X" action.
 */
export function isUrlLike(input: string): boolean {
  const t = input.trim();
  if (!t || t.includes(' ')) return false;
  if (SCHEME_RE.test(t)) return true;
  if (IPV4_HOST_RE.test(t)) return true;
  if (t === 'localhost' || /^localhost[:/]/.test(t)) return true;
  if (DOMAIN_RE.test(t)) return true;
  return false;
}

/**
 * Turn raw address-bar input into a loadable URL. Honours the configured
 * search engine for plain-text queries (the old code hard-coded Google).
 * The single source of truth, imported by TabManager, the suggestions
 * handler and the new-tab page so their behaviour can never drift.
 */
export function normalizeInput(input: string, searchEngine: SearchEngine): string {
  let t = input.trim();
  if (!t) return 'voksa://newtab';
  // Legacy alias: rewrite a leading hbb:// (any case) to the canonical
  // voksa:// scheme before any other handling, so old persisted URLs and
  // typed input converge on the new scheme.
  t = t.replace(LEGACY_SCHEME_RE, 'voksa://');
  if (SCHEME_RE.test(t)) return t;
  if (IPV4_HOST_RE.test(t)) return `http://${t}`;
  if (t === 'localhost' || /^localhost[:/]/.test(t)) return `http://${t}`;
  if (DOMAIN_RE.test(t)) return `https://${t}`;
  const prefix = ENGINE_SEARCH_URLS[searchEngine] ?? ENGINE_SEARCH_URLS.google;
  return `${prefix}${encodeURIComponent(t)}`;
}
