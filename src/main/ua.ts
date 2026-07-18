import { app, session } from 'electron';

/**
 * Normal browsing UA: Chrome desktop with the Electron token stripped.
 * Electron's default UA looks like:
 *   Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36
 *   Chrome/139.0.7258.110 Electron/38.0.0 Safari/537.36 Voksa/0.1.0
 * We keep the Chromium version (accurate) and strip the `Electron/...`
 * and app tokens so we advertise as regular Chrome.
 */
export function buildChromeUA(): string {
  const raw = app.userAgentFallback ?? '';
  const stripped = raw
    .replace(/\s*Electron\/[^\s]+/i, '')
    .replace(new RegExp(`\\s*${escapeReg(app.getName())}\\/[^\\s]+`, 'i'), '')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped;
}

/**
 * Firefox UA used ONLY on Google auth domains.
 *
 * Google's "embedded browser" block kicks in when it detects a Chromium
 * browser that isn't a real Chrome build: it reads Client Hints, checks
 * for specific JS signals, and cross-references the TLS fingerprint.
 * Those heuristics are calibrated against Chromium; Firefox is excluded
 * from them. By spoofing Firefox on `accounts.google.com` and stripping
 * every `Sec-CH-UA-*` header (Firefox doesn't emit any Client Hints),
 * Google's login page lets us through.
 *
 * Chosen Firefox version is deliberately recent but not cutting-edge, to
 * avoid being flagged as unsupported in a year.
 *
 * The platform token MUST match the real OS: the webstore carve-out hosts
 * keep sending Chrome Client Hints with the true platform in the same
 * session, and a "Firefox on Windows" login from a Mac would hand Google a
 * flat contradiction.
 */
const FIREFOX_PLATFORM =
  process.platform === 'darwin'
    ? 'Macintosh; Intel Mac OS X 10.15'
    : process.platform === 'win32'
      ? 'Windows NT 10.0; Win64; x64'
      : 'X11; Linux x86_64';
const FIREFOX_UA = `Mozilla/5.0 (${FIREFOX_PLATFORM}; rv:140.0) Gecko/20100101 Firefox/140.0`;

function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractChromeMajor(ua: string): string {
  const m = ua.match(/Chrome\/(\d+)/);
  return m ? m[1] : '139';
}

function detectPlatform(): '"Windows"' | '"macOS"' | '"Linux"' {
  if (process.platform === 'darwin') return '"macOS"';
  if (process.platform === 'win32') return '"Windows"';
  return '"Linux"';
}

const GOOGLE_AUTH_HOSTS = new Set([
  'accounts.google.com',
  'accounts.youtube.com',
  'signin.google.com',
]);

/**
 * Hosts that must ALWAYS receive the Chrome UA + Client Hints, even while a
 * Google sign-in flow is active. chromewebstore.google.com refuses to enable
 * extension installs for non-Chrome browsers, and clients2.google.com /
 * clients2.googleusercontent.com serve the CRX downloads. Without this
 * carve-out, the `authState.inFlow` catch-all below sends them the Firefox
 * UA and the store shows "navigateur non supporté" / disabled install
 * buttons for the rest of the session.
 */
const CHROME_UA_ALWAYS_HOSTS = new Set([
  'chromewebstore.google.com',
  'clients2.google.com',
  'clients2.googleusercontent.com',
]);

/**
 * Track whether a given tab is currently inside a Google sign-in flow. Once
 * the user lands on accounts.google.com and then bounces through related
 * Google subdomains (oauth2, myaccount, passwords-via-ssl…), the Firefox UA
 * must stay active for THAT tab or Google detects mid-flow inconsistencies
 * and blocks.
 *
 * Keyed per `webContents.id` (was a single global boolean, which got stuck
 * `true` after an abandoned login and let one tab leaving google.com clear
 * the flow for a login in progress in another tab). Cleared when a main-frame
 * navigation exits *.google.com or the tab is destroyed.
 */
const authFlowByWebContents = new Map<number, boolean>();

export function setInGoogleAuthFlow(webContentsId: number, active: boolean): void {
  if (active) authFlowByWebContents.set(webContentsId, true);
  else authFlowByWebContents.delete(webContentsId);
}

export function clearGoogleAuthFlow(webContentsId: number): void {
  authFlowByWebContents.delete(webContentsId);
}

function isInFlow(webContentsId: number | undefined): boolean {
  return webContentsId != null && authFlowByWebContents.get(webContentsId) === true;
}

/**
 * Cache the Chrome UA once `applyUserAgentOverride` runs, so callers that
 * need to swap the UA on a webContents can do so without re-querying.
 */
let cachedChromeUA = '';

export function getUaForUrl(url: string, webContentsId?: number): string {
  if (isGoogleAuthDomain(url, webContentsId)) return FIREFOX_UA;
  return cachedChromeUA || FIREFOX_UA;
}

export function getChromeUA(): string {
  return cachedChromeUA;
}

export function getFirefoxUA(): string {
  return FIREFOX_UA;
}

export function isGoogleAuthDomain(url: string, webContentsId?: number): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    if (CHROME_UA_ALWAYS_HOSTS.has(u.hostname)) return false;
    if (GOOGLE_AUTH_HOSTS.has(u.hostname)) return true;
    if (u.hostname === 'www.google.com' && /^\/(signin|accounts)/i.test(u.pathname)) return true;
    // While a flow is active for THIS tab, every *.google.com request keeps
    // the Firefox UA so the check doesn't flip mid-redirect.
    if (isInFlow(webContentsId) && u.hostname.endsWith('.google.com')) return true;
    return false;
  } catch {
    return false;
  }
}

export function isAnyGoogleDomain(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname === 'google.com' || u.hostname.endsWith('.google.com');
  } catch {
    return false;
  }
}

/**
 * Install per-request header rewriting on the default session:
 *   - Google auth URLs (or any *.google.com mid-flow) → Firefox UA, no Client Hints.
 *   - Everything else → Chrome UA + fully consistent Client Hints.
 *
 * Also sets `app.userAgentFallback` to the Chrome UA so windowing APIs
 * (native dialogs, etc.) fall back to Chrome when they sample a UA directly.
 */
export function applyUserAgentOverride(): string {
  const chromeUA = buildChromeUA();
  cachedChromeUA = chromeUA;
  app.userAgentFallback = chromeUA;

  const chromeMajor = extractChromeMajor(chromeUA);
  const platform = detectPlatform();
  const secChUa = `"Chromium";v="${chromeMajor}", "Google Chrome";v="${chromeMajor}", "Not:A-Brand";v="99"`;

  session.defaultSession.webRequest.onBeforeSendHeaders((details, cb) => {
    const h = { ...details.requestHeaders };
    const wcId = details.webContentsId;

    if (isGoogleAuthDomain(details.url, wcId)) {
      h['User-Agent'] = FIREFOX_UA;
      h['Accept-Language'] = 'en-US,en;q=0.5';
      // Firefox emits zero Client Hints: purge everything Chromium might add.
      for (const k of Object.keys(h)) {
        if (k.toLowerCase().startsWith('sec-ch-')) {
          delete h[k];
        }
      }
    } else {
      h['User-Agent'] = chromeUA;
      // Real Chrome only sends Client Hints over secure transports. Emitting
      // them on plain http:// is a fingerprint anomaly, so gate on scheme.
      if (details.url.startsWith('https://') || details.url.startsWith('wss://')) {
        h['sec-ch-ua'] = secChUa;
        h['sec-ch-ua-mobile'] = '?0';
        h['sec-ch-ua-platform'] = platform;
      }
    }

    // Never let this Electron-only diagnostic header leak.
    delete h['X-DevTools-Emulate-Network-Conditions-Client-Id'];

    cb({ requestHeaders: h });
  });

  return chromeUA;
}
