import { buildSearchUrl, type SearchEngineDef } from './searchEngines';
import { localPathToFileUrl, type PathPlatform } from './localFiles';

// 'hbb' is the legacy alias of 'voksa' (pre-rename profiles / muscle memory);
// normalizeInput rewrites it to voksa://, but isUrlLike must still treat it
// as a URL rather than a search query.
const SCHEME_RE = /^(https?|file|voksa|hbb|about|chrome|chrome-extension):/i;
/** The only scheme whose addresses may legitimately contain a space. */
const FILE_SCHEME_RE = /^file:/i;
/** Legacy scheme prefix from before the Voksa rename. */
const LEGACY_SCHEME_RE = /^hbb:\/\//i;
const IPV4_HOST_RE = /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/\S*)?$/;
// `\/\S*` and not `\/.*`: a path may not contain a space. Otherwise
// "example.com/a b" would be a domain here while isUrlLike (which rejects any
// input with a space) called it a query, and the address bar would offer to
// SEARCH for a string that Enter would NAVIGATE to.
const DOMAIN_RE = /^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/;

/**
 * Which local-path syntax an input may be read as. 'none' means "never a
 * path": the reading is for text the USER typed. A URL handed over by a page,
 * an extension or the OS must not gain it, or `<a href="c:/Users/…/x.png">`
 * (a valid URL of scheme "c") would open a local file.
 */
export type PathSyntax = PathPlatform | 'none';

/**
 * Whose path syntax a typed local path follows: the machine's. Read through
 * globalThis so this module keeps compiling without Node's types (the UI
 * project type-checks src/shared too); anything that is not Windows is POSIX.
 */
function hostPathSyntax(): PathPlatform {
  const proc = (globalThis as { process?: { platform?: string } }).process;
  return proc?.platform === 'win32' ? 'win32' : 'posix';
}

function typedPathToFileUrl(text: string, paths: PathSyntax): string | null {
  return paths === 'none' ? null : localPathToFileUrl(text, paths);
}

/**
 * True when the string looks like something to navigate to (URL, IP, domain,
 * localhost, path to an openable local file) rather than a search query. Used
 * by the suggestions engine to decide the primary "go to X" vs "search X"
 * action.
 */
export function isUrlLike(input: string, paths: PathSyntax = hostPathSyntax()): boolean {
  const t = input.trim();
  if (!t) return false;
  // A file: URL is the one address where a space is not ambiguous: paths
  // legitimately contain them, and nobody searches for a string that starts
  // with file:///. It is tested before the whitespace gate for that reason.
  if (FILE_SCHEME_RE.test(t)) return true;
  // Same reasoning for an absolute path to an openable local file
  // (C:\Users\me\My pic.png): unambiguous, and full of legitimate spaces.
  if (typedPathToFileUrl(t, paths) !== null) return true;
  // Any other inner whitespace means a phrase, not an address. This gate sits
  // ABOVE the scheme and localhost tests deliberately: it used to sit below
  // them in normalizeInput and nowhere at all here, so "https://api.example.com
  // returned 500" was a query to this function and a URL to normalizeInput. The
  // dropdown offered to SEARCH exactly what Enter was about to OPEN.
  if (/\s/.test(t)) return false;
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
 *
 * `paths` defaults to the machine's path syntax, which is right for the
 * address bar. Callers passing along a URL they did not get from the user's
 * keyboard pass 'none' (see PathSyntax).
 */
export function normalizeInput(
  input: string,
  searchEngine: SearchEngineDef,
  paths: PathSyntax = hostPathSyntax(),
): string {
  let t = input.trim();
  if (!t) return 'voksa://newtab';
  // Legacy alias: rewrite a leading hbb:// (any case) to the canonical
  // voksa:// scheme before any other handling, so old persisted URLs and
  // typed input converge on the new scheme.
  t = t.replace(LEGACY_SCHEME_RE, 'voksa://');
  // A typed or pasted path to an openable local file becomes its file: URL.
  // Only passive types qualify (localFiles.ts says why); any other path stays
  // what it always was here, a search. isUrlLike asks the same function, so
  // the two cannot drift on paths either.
  const fileUrl = typedPathToFileUrl(t, paths);
  if (fileUrl !== null) return fileUrl;
  // isUrlLike is the SINGLE arbiter of "address or query". This function used
  // to decide for itself, and the two drifted: each branch below had to
  // re-derive the rule, and the scheme and localhost branches forgot the
  // whitespace one. Asking the same question of the same function is the only
  // way the dropdown and the Enter key cannot disagree.
  if (!isUrlLike(t, paths)) return buildSearchUrl(searchEngine, t);
  if (SCHEME_RE.test(t)) return t;
  if (IPV4_HOST_RE.test(t)) return `http://${t}`;
  if (t === 'localhost' || /^localhost[:/]/.test(t)) return `http://${t}`;
  return `https://${t}`;
}
