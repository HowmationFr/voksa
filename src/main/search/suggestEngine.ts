import { net } from 'electron';
import type { SearchEngineDef } from '../../shared/searchEngines';

/**
 * Every engine that publishes an autocomplete endpoint speaks the de-facto
 * OpenSearch convention: `[query, [suggestions...]]`. Parsing still goes
 * through a tolerant reader so a change on their side degrades to "no
 * suggestions" rather than crashing the address bar.
 *
 * Engines with no usable public endpoint (Startpage, Qwant, Ecosia) declare
 * `suggestUrl: null` in the registry and fall back to history + bookmarks.
 */
function extractOpenSearchSuggestions(data: unknown): string[] {
  if (!Array.isArray(data)) return [];
  const second = data[1];
  if (!Array.isArray(second)) return [];
  const out: string[] = [];
  for (const item of second) {
    if (typeof item === 'string' && item.trim().length > 0) out.push(item);
    else if (item && typeof item === 'object' && 'phrase' in item) {
      const phrase = (item as { phrase: unknown }).phrase;
      if (typeof phrase === 'string') out.push(phrase);
    }
  }
  return out;
}

/**
 * Fetch search-engine autocomplete for `query` using the configured engine.
 *
 * Uses Electron's `net.fetch` so the request goes through Chromium's network
 * stack (respects proxy settings, uses the app session cookies, etc.). We
 * pass a realistic UA to avoid the occasional 403 returned by Google when
 * the Client is identifiable as "bot".
 *
 * `signal` lets the caller cancel an in-flight fetch when the user types a
 * new character before the previous query resolved. All errors / timeouts
 * return `[]`: suggestions are best-effort, never fatal.
 */
export async function fetchSearchSuggestions(
  engine: SearchEngineDef,
  query: string,
  signal?: AbortSignal,
): Promise<string[]> {
  // A custom engine has no endpoint we could know: suggestUrl is null and the
  // dropdown falls back to history and bookmarks, which is honest.
  if (!engine.suggestUrl) return [];
  const url = engine.suggestUrl.replace('{q}', encodeURIComponent(query));

  const timeout = AbortSignal.timeout(1200);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  try {
    const res = await net.fetch(url, {
      signal: combined,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
        Accept: 'application/json, text/javascript, */*',
        'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
      },
      credentials: 'omit',
    });
    if (!res.ok) return [];
    const text = await res.text();
    const data = tolerantJsonParse(text);
    if (data === undefined) return [];
    return extractOpenSearchSuggestions(data).slice(0, 8);
  } catch {
    // Timed out, cancelled, or network failure: treat as no suggestions.
    return [];
  }
}

function tolerantJsonParse(text: string): unknown {
  if (!text) return undefined;
  // Some endpoints return JSONP (`callback([...])`) or have a leading
  // `)]}',\n` prefix (Google classic). Try a raw parse first; fall back to
  // stripping the wrapper and trying again.
  try {
    return JSON.parse(text);
  } catch {
    // ignore
  }
  const stripped = text
    .replace(/^[^[{]+/, '')
    .replace(/\)[;\s]*$/, '');
  try {
    return JSON.parse(stripped);
  } catch {
    return undefined;
  }
}
