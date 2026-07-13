import { buildSearchUrl, type SearchEngineDef } from './searchEngines';

// 'hbb' is the legacy alias of 'voksa' (pre-rename profiles / muscle memory);
// normalizeInput rewrites it to voksa://, but isUrlLike must still treat it
// as a URL rather than a search query.
const SCHEME_RE = /^(https?|file|voksa|hbb|about|chrome|chrome-extension):/i;
/** Legacy scheme prefix from before the Voksa rename. */
const LEGACY_SCHEME_RE = /^hbb:\/\//i;
const IPV4_HOST_RE = /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/\S*)?$/;
// `\/\S*` and not `\/.*`: a path may not contain a space. Otherwise
// "example.com/a b" would be a domain here while isUrlLike (which rejects any
// input with a space) called it a query, and the address bar would offer to
// SEARCH for a string that Enter would NAVIGATE to.
const DOMAIN_RE = /^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/;

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
 * Turn raw address-bar input into a loadable URL, sending plain text to
 * `searchEngine`. The single funnel: TabManager and the suggestions handler
 * both go through it, so what Enter does and what the dropdown offers can
 * never drift apart.
 *
 * It takes the resolved ENGINE, not an id: a custom engine only exists in the
 * user's settings, which this module has no business reading.
 */
export function normalizeInput(input: string, searchEngine: SearchEngineDef): string {
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
  return buildSearchUrl(searchEngine, t);
}
