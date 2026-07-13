/**
 * The search engines Voksa knows: the seven it ships, plus whatever the user
 * adds.
 *
 * ONE place. Before this module the list lived in six (search URLs in urlUtils,
 * a verbatim copy in the suggestions handler, labels in the settings page,
 * autocomplete endpoints in suggestEngine, the page context menu, and a third
 * copy of isUrlLike): adding an engine meant editing all of them, and
 * forgetting one failed silently.
 *
 * Pure module (no Electron, no DOM): main, preload and the UI all import it.
 * Every lookup takes the resolved engine LIST, because a custom engine only
 * exists in the user's settings and this module has no way to read them.
 */

export type SearchEngineId =
  | 'google'
  | 'bing'
  | 'duckduckgo'
  | 'brave'
  | 'qwant'
  | 'ecosia'
  | 'startpage';

export type SearchEngineDef = {
  /** A built-in id, or 'custom:<n>' for a user-added engine. */
  id: string;
  /** Proper noun (built-in) or the user's label. NEVER goes through t(). */
  name: string;
  /**
   * Typed in the address bar, followed by a space, to search this engine
   * directly (Chrome's tab-to-search). Lowercase, no spaces.
   */
  keyword: string;
  /**
   * URL template. `%s` is replaced by the URL-encoded query, exactly as Chrome
   * writes it. A template with no `%s` gets the query appended, which is what
   * the built-ins used to be and what a user pasting a bare search prefix
   * expects.
   */
  searchUrl: string;
  /**
   * OpenSearch autocomplete endpoint, `{q}` standing for the encoded query.
   * `null` when the engine publishes no usable public endpoint: the dropdown
   * then falls back to history and bookmarks alone. An invented endpoint would
   * be worse than none (a silent 404 on every keystroke). Custom engines are
   * always null: we have no way to know theirs.
   */
  suggestUrl: string | null;
  /** True for a user-added engine (renamable, deletable). */
  custom?: boolean;
};

/** A user-added engine, as persisted in settings. */
export type CustomSearchEngine = {
  id: string;
  name: string;
  keyword: string;
  searchUrl: string;
};

export const SEARCH_ENGINES: Record<SearchEngineId, SearchEngineDef> = {
  google: {
    id: 'google',
    name: 'Google',
    keyword: 'google.com',
    searchUrl: 'https://www.google.com/search?q=%s',
    suggestUrl: 'https://suggestqueries.google.com/complete/search?client=firefox&q={q}',
  },
  bing: {
    id: 'bing',
    name: 'Bing',
    keyword: 'bing.com',
    searchUrl: 'https://www.bing.com/search?q=%s',
    suggestUrl: 'https://www.bing.com/osjson.aspx?query={q}',
  },
  duckduckgo: {
    id: 'duckduckgo',
    name: 'DuckDuckGo',
    keyword: 'duckduckgo.com',
    searchUrl: 'https://duckduckgo.com/?q=%s',
    suggestUrl: 'https://duckduckgo.com/ac/?type=list&q={q}',
  },
  brave: {
    id: 'brave',
    name: 'Brave',
    keyword: 'search.brave.com',
    searchUrl: 'https://search.brave.com/search?q=%s',
    suggestUrl: 'https://search.brave.com/api/suggest?q={q}',
  },
  qwant: {
    id: 'qwant',
    name: 'Qwant',
    keyword: 'qwant.com',
    searchUrl: 'https://www.qwant.com/?q=%s',
    suggestUrl: null,
  },
  ecosia: {
    id: 'ecosia',
    name: 'Ecosia',
    keyword: 'ecosia.org',
    searchUrl: 'https://www.ecosia.org/search?q=%s',
    suggestUrl: null,
  },
  startpage: {
    id: 'startpage',
    name: 'Startpage',
    keyword: 'startpage.com',
    searchUrl: 'https://www.startpage.com/do/search?q=%s',
    suggestUrl: null,
  },
};

/** Display order of the built-ins. Google first, like Chrome. */
export const SEARCH_ENGINE_ORDER: readonly SearchEngineId[] = [
  'google',
  'bing',
  'duckduckgo',
  'brave',
  'qwant',
  'ecosia',
  'startpage',
];

export const BUILTIN_ENGINES: readonly SearchEngineDef[] = SEARCH_ENGINE_ORDER.map(
  (id) => SEARCH_ENGINES[id],
);

export const DEFAULT_SEARCH_ENGINE: SearchEngineId = 'google';

/** Bounded so a hand-edited settings.json cannot grow the list unboundedly. */
export const MAX_CUSTOM_ENGINES = 50;

export function isBuiltinEngineId(value: unknown): value is SearchEngineId {
  return typeof value === 'string' && value in SEARCH_ENGINES;
}

/**
 * Normalized keyword: what the address bar compares against.
 *
 * Trim and lowercase, and nothing else. It must NOT collapse inner whitespace:
 * this function canonicalizes STORED keywords, but findEngineByKeyword runs the
 * user's TYPED TEXT through it too, and a canonicalizer that strips spaces
 * turns an exact comparison into a fuzzy one. "git hub " would match an engine
 * keyed `github`, arm the chip and wipe the words the user was in the middle of
 * typing. A keyword with a space is refused at the door instead (see
 * validateCustomEngine), so an exact compare is always enough.
 */
export function normalizeKeyword(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Why a custom engine is not usable, or null when it is.
 *
 * The `%s` rule is Chrome's, and it is not a formality: without it we would
 * have to guess where the query goes, and guessing wrong sends whatever the
 * user typed to the wrong place. A template we cannot honour is refused at the
 * door rather than half-applied later.
 */
export type EngineProblem =
  | 'name'
  | 'keyword'
  | 'keyword-space'
  | 'keyword-taken'
  | 'url'
  | 'url-placeholder';

export function validateCustomEngine(
  engine: { name: string; keyword: string; searchUrl: string },
  existing: readonly SearchEngineDef[],
  /** The engine being edited keeps its own keyword. */
  selfId?: string,
): EngineProblem | null {
  if (!engine.name.trim()) return 'name';

  const keyword = normalizeKeyword(engine.keyword);
  if (!keyword) return 'keyword';
  // A keyword with a space is unhonourable, not merely awkward: the address bar
  // arms keyword mode on the Space that follows a keyword filling the whole
  // field, so a two-word keyword would fire halfway through being typed and
  // could never be finished. Refuse it here rather than silently rewrite it to
  // something the user never chose ("my wiki" quietly becoming `mywiki`).
  if (/\s/.test(keyword)) return 'keyword-space';
  if (existing.some((def) => def.keyword === keyword && def.id !== selfId)) return 'keyword-taken';

  const url = engine.searchUrl.trim();
  if (!/^https?:\/\/\S+$/i.test(url)) return 'url';
  if (!url.includes('%s')) return 'url-placeholder';

  return null;
}

/**
 * The engines available right now: the built-ins, then the user's own.
 * Invalid entries (a hand-edited settings.json, a keyword that now collides
 * with a built-in) are dropped rather than half-honoured.
 */
export function resolveEngines(
  custom: readonly CustomSearchEngine[] | undefined,
): SearchEngineDef[] {
  const out: SearchEngineDef[] = [...BUILTIN_ENGINES];
  if (!Array.isArray(custom)) return out;

  for (const entry of custom) {
    if (!entry || typeof entry.id !== 'string' || !entry.id) continue;
    if (out.some((def) => def.id === entry.id)) continue;
    if (typeof entry.name !== 'string' || typeof entry.searchUrl !== 'string') continue;
    if (typeof entry.keyword !== 'string') continue;
    if (validateCustomEngine(entry, out)) continue;

    out.push({
      id: entry.id,
      name: entry.name.trim(),
      keyword: normalizeKeyword(entry.keyword),
      searchUrl: entry.searchUrl.trim(),
      suggestUrl: null,
      custom: true,
    });
    if (out.length >= BUILTIN_ENGINES.length + MAX_CUSTOM_ENGINES) break;
  }
  return out;
}

/** The user's engines, cleaned: what gets persisted back to settings.json. */
export function sanitizeCustomEngines(raw: unknown): CustomSearchEngine[] {
  return resolveEngines(raw as CustomSearchEngine[] | undefined)
    .filter((def) => def.custom)
    .map(({ id, name, keyword, searchUrl }) => ({ id, name, keyword, searchUrl }));
}

/** An id no built-in can collide with, and that reads as what it is. */
export function newCustomEngineId(existing: readonly SearchEngineDef[]): string {
  let n = existing.length + 1;
  while (existing.some((def) => def.id === `custom:${n}`)) n += 1;
  return `custom:${n}`;
}

/** The engine, or the default one when the id is unknown (settings can lie). */
export function getEngine(
  id: string,
  engines: readonly SearchEngineDef[] = BUILTIN_ENGINES,
): SearchEngineDef {
  return (
    engines.find((def) => def.id === id) ??
    engines.find((def) => def.id === DEFAULT_SEARCH_ENGINE) ??
    SEARCH_ENGINES[DEFAULT_SEARCH_ENGINE]
  );
}

/** Where a plain-text query is sent. `%s` is the query; no `%s` means append. */
export function buildSearchUrl(engine: SearchEngineDef, query: string): string {
  const encoded = encodeURIComponent(query);
  return engine.searchUrl.includes('%s')
    ? engine.searchUrl.split('%s').join(encoded)
    : `${engine.searchUrl}${encoded}`;
}

export function searchUrlFor(
  id: string,
  query: string,
  engines: readonly SearchEngineDef[] = BUILTIN_ENGINES,
): string {
  return buildSearchUrl(getEngine(id, engines), query);
}

/** The engine's autocomplete endpoint for `query`, or null when it has none. */
export function suggestUrlFor(
  id: string,
  query: string,
  engines: readonly SearchEngineDef[] = BUILTIN_ENGINES,
): string | null {
  const template = getEngine(id, engines).suggestUrl;
  return template ? template.replace('{q}', encodeURIComponent(query)) : null;
}

/**
 * The engine whose keyword is EXACTLY this text, or null.
 *
 * Deliberately not a parser over a whole line. Tab-to-search is a MODE the
 * address bar enters when you type a keyword and then Space, exactly like
 * Chrome; it is state, not something inferred from the string afterwards.
 *
 * Inferring it would be a trap: "bing.com vs google" would search Bing for
 * "vs google" instead of searching your default engine for the whole phrase,
 * silently, with no way to ask for what you actually typed. And once the mode
 * is UI state, a bare "duckduckgo.com" can never be mistaken for a search
 * either: it is just a domain, and it navigates.
 *
 * The comparison is EXACT, and that word is load-bearing. It once ran the typed
 * text through a canonicalizer that stripped inner spaces, which quietly made
 * it fuzzy again: "git hub " matched an engine keyword `github`, so the chip
 * armed itself and the two words the user was typing vanished from the box. The
 * mode stayed state, but the trigger had become an inference. Keywords are
 * space-free by validation, so nothing here needs to be lenient.
 */
export function findEngineByKeyword(
  text: string,
  engines: readonly SearchEngineDef[] = BUILTIN_ENGINES,
): SearchEngineDef | null {
  const wanted = normalizeKeyword(text);
  if (!wanted) return null;
  return engines.find((def) => def.keyword === wanted) ?? null;
}
