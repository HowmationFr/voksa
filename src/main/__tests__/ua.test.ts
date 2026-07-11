import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest';

// Mocked electron surface: ua.ts only touches app.getName(),
// app.userAgentFallback and session.defaultSession.webRequest, none of it
// at module load, so this tiny stub is enough.
const mocks = vi.hoisted(() => {
  const RAW_UA_FALLBACK =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/128.0.0.0 Voksa/0.1.0 Electron/38.0.0 Safari/537.36';
  return {
    RAW_UA_FALLBACK,
    app: {
      getName: () => 'Voksa',
      userAgentFallback: RAW_UA_FALLBACK,
    },
    onBeforeSendHeaders: vi.fn(),
  };
});

vi.mock('electron', () => ({
  app: mocks.app,
  session: {
    defaultSession: {
      webRequest: { onBeforeSendHeaders: mocks.onBeforeSendHeaders },
    },
  },
}));

import {
  applyUserAgentOverride,
  buildChromeUA,
  clearGoogleAuthFlow,
  getChromeUA,
  getFirefoxUA,
  getUaForUrl,
  isAnyGoogleDomain,
  isGoogleAuthDomain,
  setInGoogleAuthFlow,
} from '../ua';

const EXPECTED_CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/128.0.0.0 Safari/537.36';

// The webstore carve-out hosts (CLAUDE.md 4.4): must ALWAYS see Chrome, even
// mid sign-in flow, or extension installs break for the rest of the session.
const WEBSTORE_URLS = [
  'https://chromewebstore.google.com/detail/ublock-origin/cjpalhdlnbpafiamejdnhcphjbkeiagm',
  'https://clients2.google.com/service/update2/crx',
  'https://clients2.googleusercontent.com/crx/blobs/whatever',
];

const AUTH_URLS = [
  'https://accounts.google.com/ServiceLogin',
  'https://accounts.google.com/',
  'https://accounts.youtube.com/accounts/SetSID',
  'https://signin.google.com/signin/oauth',
  'https://www.google.com/signin/v2/identifier',
  'https://www.google.com/accounts/Logout',
  // Path check is case-insensitive.
  'https://www.google.com/Accounts',
];

// Prime the module the way index.ts does at boot: getUaForUrl reads the
// cached Chrome UA populated by applyUserAgentOverride.
beforeAll(() => {
  mocks.app.userAgentFallback = mocks.RAW_UA_FALLBACK;
  applyUserAgentOverride();
});

describe('buildChromeUA', () => {
  it('strips the Electron and app-name tokens, keeping the real Chromium version', () => {
    mocks.app.userAgentFallback = mocks.RAW_UA_FALLBACK;
    expect(buildChromeUA()).toBe(EXPECTED_CHROME_UA);
  });

  it('is idempotent on an already-stripped UA', () => {
    mocks.app.userAgentFallback = EXPECTED_CHROME_UA;
    expect(buildChromeUA()).toBe(EXPECTED_CHROME_UA);
  });
});

describe('UA strings', () => {
  it('Chrome UA carries no Firefox/Electron/app tokens; Firefox UA carries no Chrome token', () => {
    const chrome = getChromeUA();
    expect(chrome).toContain('Chrome/128.0.0.0');
    expect(chrome).not.toContain('Firefox');
    expect(chrome).not.toContain('Electron');
    expect(chrome).not.toContain('Voksa');

    const ff = getFirefoxUA();
    expect(ff).toContain('Firefox/');
    expect(ff).toContain('Gecko/20100101');
    expect(ff).not.toContain('Chrome');
  });

  it('Firefox platform token matches a real OS family (never an Electron-ish string)', () => {
    expect(getFirefoxUA()).toMatch(
      /^Mozilla\/5\.0 \((Windows NT 10\.0; Win64; x64|Macintosh; Intel Mac OS X 10\.15|X11; Linux x86_64); rv:128\.0\) Gecko\/20100101 Firefox\/128\.0$/,
    );
  });
});

describe('applyUserAgentOverride', () => {
  it('returns the stripped Chrome UA, caches it, and rewrites app.userAgentFallback', () => {
    mocks.app.userAgentFallback = mocks.RAW_UA_FALLBACK;
    const ua = applyUserAgentOverride();
    expect(ua).toBe(EXPECTED_CHROME_UA);
    expect(getChromeUA()).toBe(EXPECTED_CHROME_UA);
    expect(mocks.app.userAgentFallback).toBe(EXPECTED_CHROME_UA);
    expect(mocks.onBeforeSendHeaders).toHaveBeenCalled();
  });
});

describe('isGoogleAuthDomain', () => {
  it.each(AUTH_URLS)('flags %s as a Google auth URL', (url) => {
    expect(isGoogleAuthDomain(url)).toBe(true);
  });

  it.each([
    'https://www.google.com/search?q=test',
    'https://www.google.com/',
    'https://mail.google.com/mail/u/0', // plain google subdomain, no flow active
    'https://example.com/signin',
    'https://github.com/login',
  ])('does not flag %s', (url) => {
    expect(isGoogleAuthDomain(url)).toBe(false);
  });

  it('does NOT let a spoofed google.com suffix pass, even mid-flow', () => {
    setInGoogleAuthFlow(11, true);
    try {
      expect(isGoogleAuthDomain('https://accounts.google.com.evil.com/', 11)).toBe(false);
    } finally {
      clearGoogleAuthFlow(11);
    }
  });

  it('webstore carve-out hosts are never auth domains, even mid-flow', () => {
    setInGoogleAuthFlow(12, true);
    try {
      for (const url of WEBSTORE_URLS) {
        expect(isGoogleAuthDomain(url, 12)).toBe(false);
      }
    } finally {
      clearGoogleAuthFlow(12);
    }
  });

  it('malformed or empty input returns false instead of throwing', () => {
    for (const url of ['', 'not a url', 'http//broken', '://nope']) {
      expect(isGoogleAuthDomain(url)).toBe(false);
    }
  });
});

describe('getUaForUrl precedence', () => {
  const WC = 42;
  const OTHER_WC = 43;

  afterEach(() => {
    clearGoogleAuthFlow(WC);
    clearGoogleAuthFlow(OTHER_WC);
  });

  it('(1) webstore carve-out beats an active auth flow (extensions stay installable mid-login)', () => {
    setInGoogleAuthFlow(WC, true);
    for (const url of WEBSTORE_URLS) {
      expect(getUaForUrl(url, WC)).toBe(getChromeUA());
    }
  });

  it('(2) auth domains always get the Firefox UA, flow flag or not', () => {
    for (const url of AUTH_URLS) {
      expect(getUaForUrl(url, WC)).toBe(getFirefoxUA());
    }
    setInGoogleAuthFlow(WC, true);
    for (const url of AUTH_URLS) {
      expect(getUaForUrl(url, WC)).toBe(getFirefoxUA());
    }
  });

  it('(3) a plain *.google.com URL follows the flow flag of THAT webContents only', () => {
    const url = 'https://myaccount.google.com/security';
    expect(getUaForUrl(url, WC)).toBe(getChromeUA());

    setInGoogleAuthFlow(WC, true);
    expect(getUaForUrl(url, WC)).toBe(getFirefoxUA());
    // Scoped per webContents: another tab keeps Chrome.
    expect(getUaForUrl(url, OTHER_WC)).toBe(getChromeUA());
    // No webContents id at all: Chrome.
    expect(getUaForUrl(url)).toBe(getChromeUA());
  });

  it('(4) non-Google URLs always get Chrome, even mid-flow', () => {
    setInGoogleAuthFlow(WC, true);
    for (const url of [
      'https://example.com/',
      'https://github.com/login',
      'https://accounts.google.com.evil.com/',
    ]) {
      expect(getUaForUrl(url, WC)).toBe(getChromeUA());
    }
  });

  it('(5) malformed URLs fall back to the Chrome UA without throwing', () => {
    for (const url of ['', 'not a url', 'http//broken']) {
      expect(getUaForUrl(url, WC)).toBe(getChromeUA());
    }
  });

  it('falls back to the Firefox UA if the Chrome UA cache was never primed', async () => {
    // Fresh module instance: applyUserAgentOverride has not run yet, so the
    // fail-safe must be Firefox (a plausible browser), never an empty string.
    vi.resetModules();
    const fresh = await import('../ua');
    expect(fresh.getUaForUrl('https://example.com/')).toBe(fresh.getFirefoxUA());
  });
});

describe('auth flow tracking (TabManager / Tab contract)', () => {
  const MID_FLOW_URL = 'https://oauth2.google.com/callback';

  it('enter then explicit exit (did-navigate off Google) restores Chrome', () => {
    setInGoogleAuthFlow(7, true);
    expect(getUaForUrl(MID_FLOW_URL, 7)).toBe(getFirefoxUA());
    setInGoogleAuthFlow(7, false);
    expect(getUaForUrl(MID_FLOW_URL, 7)).toBe(getChromeUA());
  });

  it('clearGoogleAuthFlow (tab destroyed) removes the flag', () => {
    setInGoogleAuthFlow(8, true);
    clearGoogleAuthFlow(8);
    expect(getUaForUrl(MID_FLOW_URL, 8)).toBe(getChromeUA());
  });

  it('clearing an unknown webContents id is a no-op', () => {
    expect(() => clearGoogleAuthFlow(99999)).not.toThrow();
  });
});

describe('isAnyGoogleDomain (flow-exit detector in TabManager did-navigate)', () => {
  it('covers the apex and every subdomain, rejects lookalikes and garbage', () => {
    expect(isAnyGoogleDomain('https://google.com/')).toBe(true);
    expect(isAnyGoogleDomain('https://mail.google.com/')).toBe(true);
    expect(isAnyGoogleDomain('https://accounts.google.com/signin')).toBe(true);
    expect(isAnyGoogleDomain('https://google.com.evil.com/')).toBe(false);
    expect(isAnyGoogleDomain('https://example.com/')).toBe(false);
    expect(isAnyGoogleDomain('not a url')).toBe(false);
  });
});

describe('session header rewriting (onBeforeSendHeaders listener)', () => {
  type Listener = (
    details: { url: string; requestHeaders: Record<string, string>; webContentsId?: number },
    cb: (res: { requestHeaders: Record<string, string> }) => void,
  ) => void;

  function rewrite(
    url: string,
    headers: Record<string, string>,
    wcId?: number,
  ): Record<string, string> {
    const listener = mocks.onBeforeSendHeaders.mock.lastCall?.[0] as Listener;
    let out: Record<string, string> = {};
    listener({ url, requestHeaders: headers, webContentsId: wcId }, (res) => {
      out = res.requestHeaders;
    });
    return out;
  }

  it('rewrites auth requests to Firefox and purges every Client Hint header', () => {
    const out = rewrite('https://accounts.google.com/ServiceLogin', {
      'User-Agent': 'original',
      'sec-ch-ua': 'x',
      'Sec-CH-UA-Platform': 'x',
      'sec-ch-ua-mobile': '?0',
      Accept: 'text/html',
    });
    expect(out['User-Agent']).toBe(getFirefoxUA());
    expect(out['Accept-Language']).toBe('en-US,en;q=0.5');
    expect(out['Accept']).toBe('text/html');
    // Firefox emits zero Client Hints, whatever their casing.
    expect(Object.keys(out).some((k) => k.toLowerCase().startsWith('sec-ch-'))).toBe(false);
  });

  it('sends Chrome UA + consistent Client Hints on https non-auth requests', () => {
    const out = rewrite('https://example.com/', { 'User-Agent': 'original' });
    expect(out['User-Agent']).toBe(EXPECTED_CHROME_UA);
    expect(out['sec-ch-ua']).toContain('"Google Chrome";v="128"');
    expect(out['sec-ch-ua-mobile']).toBe('?0');
    expect(out['sec-ch-ua-platform']).toMatch(/^"(Windows|macOS|Linux)"$/);
  });

  it('omits Client Hints on plain http (real Chrome only sends them on secure transports)', () => {
    const out = rewrite('http://example.com/', { 'User-Agent': 'original' });
    expect(out['User-Agent']).toBe(EXPECTED_CHROME_UA);
    expect(out['sec-ch-ua']).toBeUndefined();
    expect(out['sec-ch-ua-platform']).toBeUndefined();
  });

  it('keeps Chrome UA + Client Hints on webstore hosts even while a flow is active', () => {
    setInGoogleAuthFlow(501, true);
    try {
      const out = rewrite(WEBSTORE_URLS[0], { 'User-Agent': 'original' }, 501);
      expect(out['User-Agent']).toBe(EXPECTED_CHROME_UA);
      expect(out['sec-ch-ua']).toBeDefined();
    } finally {
      clearGoogleAuthFlow(501);
    }
  });

  it('never leaks the DevTools emulation header', () => {
    const out = rewrite('https://example.com/', {
      'X-DevTools-Emulate-Network-Conditions-Client-Id': 'abc',
    });
    expect(out['X-DevTools-Emulate-Network-Conditions-Client-Id']).toBeUndefined();
  });
});
