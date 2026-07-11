import { describe, expect, it, vi } from 'vitest';
import type { Session, WebContents } from 'electron';
import {
  installPermissionHandlers,
  STREAM_ALLOW as EXPORTED_STREAM_ALLOW,
  STREAM_HARD_DENY as EXPORTED_STREAM_HARD_DENY,
  type PermissionDeps,
} from '../permissions';
import { DEFAULT_STREAM_CONFIG, type StreamModeConfig } from '../../../shared/streamConfig';
import type { PermissionDecision } from '../../../shared/types';

type RequestDetails = { mediaTypes?: string[]; requestingUrl?: string };
type RequestHandler = (
  wc: WebContents | null,
  permission: string,
  callback: (granted: boolean) => void,
  details?: RequestDetails,
) => void;
type CheckHandler = (wc: WebContents | null, permission: string, origin?: string) => boolean;

// Mirrors of the module's exported lists (pinned equal by a test below): a
// drift here IS a decision-matrix change and must be reviewed as one.
const STREAM_HARD_DENY = [
  'display-capture',
  'notifications',
  'clipboard-read',
  'idle-detection',
  'pointerLock',
  'keyboardLock',
  'hid',
  'serial',
  'usb',
  'bluetooth',
  'midi',
  'midiSysex',
  'speaker-selection',
  'window-management',
];
const STREAM_ALLOW = ['fullscreen', 'clipboard-sanitized-write'];

// Of the hard-deny list, Electron only ever delivers these to the REQUEST
// handler; hid/serial/usb arrive on the check path only, and 'bluetooth'
// exists in neither union (covered by the default-deny test below).
const REQUEST_PATH_HARD_DENY = STREAM_HARD_DENY.filter(
  (permission) => !['hid', 'serial', 'usb', 'bluetooth'].includes(permission),
);

/** Sentinel standing in for the chromeView webContents (compared by identity). */
const CHROME_WC = { id: 999 } as unknown as WebContents;

const ORIGIN = 'https://site.example';
const PAGE_URL = `${ORIGIN}/some/page`;

/** Settle the promptUser promise chain inside the request handler. */
async function flushPromises(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

/**
 * Fake Session that captures the two handlers installPermissionHandlers
 * registers so tests can drive them directly. Deps mirror the real wiring in
 * handlers.ts (getSettings().sitePermissions lookup, prompt via chrome UI).
 */
function setup(
  opts: {
    config?: Partial<StreamModeConfig>;
    remembered?: Record<string, Record<string, PermissionDecision>>;
    prompt?: PermissionDeps['promptUser'];
  } = {},
) {
  let requestHandler: RequestHandler | undefined;
  let checkHandler: CheckHandler | undefined;
  const session = {
    setPermissionRequestHandler: (h: RequestHandler) => {
      requestHandler = h;
    },
    setPermissionCheckHandler: (h: CheckHandler) => {
      checkHandler = h;
    },
  } as unknown as Session;

  const rememberedStore = opts.remembered ?? {};
  const remember = vi.fn();
  const promptImpl: PermissionDeps['promptUser'] =
    opts.prompt ?? (async () => ({ allow: false, remember: false }));
  const promptUser = vi.fn(promptImpl);
  const config: StreamModeConfig = { ...DEFAULT_STREAM_CONFIG, ...opts.config };

  installPermissionHandlers(session, {
    getStreamConfig: () => config,
    isChromeContents: (wc) => wc === CHROME_WC,
    getRemembered: (origin, permission) => rememberedStore[origin]?.[permission],
    remember,
    promptUser,
  });

  /** Drive the request handler; probe.granted stays undefined until the callback fires. */
  const request = (permission: string, details?: RequestDetails, wc: WebContents | null = null) => {
    const probe: { granted?: boolean } = {};
    requestHandler!(
      wc,
      permission,
      (granted) => {
        probe.granted = granted;
      },
      details,
    );
    return probe;
  };
  const check = (permission: string, origin: string = ORIGIN, wc: WebContents | null = null) =>
    checkHandler!(wc, permission, origin);

  return { request, check, remember, promptUser };
}

describe('decision lists', () => {
  it('test mirrors match the exported sets exactly (drift goes red both ways)', () => {
    expect(new Set(STREAM_HARD_DENY)).toEqual(EXPORTED_STREAM_HARD_DENY);
    expect(new Set(STREAM_ALLOW)).toEqual(EXPORTED_STREAM_ALLOW);
  });
});

describe('installPermissionHandlers, Stream Mode ON', () => {
  it('media: crosses requested device types with denyCamera/denyMicrophone', () => {
    const cases: Array<{
      types?: string[];
      denyCamera: boolean;
      denyMicrophone: boolean;
      expected: boolean;
    }> = [
      // Video only: gated by denyCamera alone.
      { types: ['video'], denyCamera: true, denyMicrophone: false, expected: false },
      { types: ['video'], denyCamera: false, denyMicrophone: true, expected: true },
      // Audio only: gated by denyMicrophone alone.
      { types: ['audio'], denyCamera: false, denyMicrophone: true, expected: false },
      { types: ['audio'], denyCamera: true, denyMicrophone: false, expected: true },
      // Both devices: any relevant deny blocks the whole request.
      { types: ['audio', 'video'], denyCamera: false, denyMicrophone: false, expected: true },
      { types: ['audio', 'video'], denyCamera: true, denyMicrophone: false, expected: false },
      { types: ['audio', 'video'], denyCamera: false, denyMicrophone: true, expected: false },
      // No declared types: treated as sensitive if either device is denied.
      { types: [], denyCamera: true, denyMicrophone: false, expected: false },
      { types: undefined, denyCamera: false, denyMicrophone: true, expected: false },
      { types: [], denyCamera: false, denyMicrophone: false, expected: true },
    ];
    for (const c of cases) {
      const { request, promptUser } = setup({
        config: { enabled: true, denyCamera: c.denyCamera, denyMicrophone: c.denyMicrophone },
      });
      const details: RequestDetails = { requestingUrl: PAGE_URL };
      if (c.types) details.mediaTypes = c.types;
      expect(request('media', details).granted, JSON.stringify(c)).toBe(c.expected);
      // Streaming decisions never go through the prompt.
      expect(promptUser).not.toHaveBeenCalled();
    }
  });

  it('check handler: media blocks when either device is denied (no per-type detail)', () => {
    const cases: Array<{ denyCamera: boolean; denyMicrophone: boolean; expected: boolean }> = [
      { denyCamera: false, denyMicrophone: false, expected: true },
      { denyCamera: true, denyMicrophone: false, expected: false },
      { denyCamera: false, denyMicrophone: true, expected: false },
      { denyCamera: true, denyMicrophone: true, expected: false },
    ];
    for (const c of cases) {
      const { check } = setup({
        config: { enabled: true, denyCamera: c.denyCamera, denyMicrophone: c.denyMicrophone },
      });
      expect(check('media'), JSON.stringify(c)).toBe(c.expected);
    }
  });

  it('geolocation follows denyGeolocation', () => {
    const denied = setup({ config: { enabled: true, denyGeolocation: true } });
    expect(denied.request('geolocation', { requestingUrl: PAGE_URL }).granted).toBe(false);
    expect(denied.check('geolocation')).toBe(false);

    const allowed = setup({ config: { enabled: true, denyGeolocation: false } });
    expect(allowed.request('geolocation', { requestingUrl: PAGE_URL }).granted).toBe(true);
    expect(allowed.check('geolocation')).toBe(true);
  });

  it('hard-denies the streamer leak list even with every toggle relaxed', () => {
    const { request, check, promptUser } = setup({
      config: {
        enabled: true,
        denyCamera: false,
        denyMicrophone: false,
        denyGeolocation: false,
      },
    });
    // Request path: only the strings Electron can actually deliver there.
    for (const permission of REQUEST_PATH_HARD_DENY) {
      expect(request(permission, { requestingUrl: PAGE_URL }).granted, permission).toBe(false);
    }
    // Check path: the full list is reachable (incl. hid/serial/usb).
    for (const permission of STREAM_HARD_DENY) {
      expect(check(permission), permission).toBe(false);
    }
    expect(promptUser).not.toHaveBeenCalled();
  });

  it('an unknown permission is refused while streaming (default-deny)', () => {
    const { request, check } = setup({ config: { enabled: true } });
    expect(request('some-future-permission', { requestingUrl: PAGE_URL }).granted).toBe(false);
    expect(check('some-future-permission')).toBe(false);
    // 'bluetooth' is not in Electron's request-handler union: on that path it
    // can only ever exercise this same default-deny branch.
    expect(request('bluetooth', { requestingUrl: PAGE_URL }).granted).toBe(false);
  });

  it('keeps the harmless allow list working during a stream', () => {
    const { request, check } = setup({ config: { enabled: true } });
    for (const permission of STREAM_ALLOW) {
      expect(request(permission, { requestingUrl: PAGE_URL }).granted, permission).toBe(true);
      expect(check(permission), permission).toBe(true);
    }
  });

  it('always trusts the chrome UI webContents, even for hard-denied permissions', () => {
    const on = setup({ config: { enabled: true } });
    expect(on.request('display-capture', undefined, CHROME_WC).granted).toBe(true);
    expect(on.request('clipboard-read', undefined, CHROME_WC).granted).toBe(true);
    expect(on.check('clipboard-read', ORIGIN, CHROME_WC)).toBe(true);
    expect(on.promptUser).not.toHaveBeenCalled();

    const off = setup({ config: { enabled: false } });
    expect(off.request('display-capture', undefined, CHROME_WC).granted).toBe(true);
    expect(off.promptUser).not.toHaveBeenCalled();
  });
});

describe('installPermissionHandlers, Stream Mode OFF', () => {
  it('honors a remembered allow without prompting', () => {
    const { request, promptUser } = setup({
      config: { enabled: false },
      remembered: { [ORIGIN]: { notifications: 'allow' } },
    });
    expect(request('notifications', { requestingUrl: PAGE_URL }).granted).toBe(true);
    expect(promptUser).not.toHaveBeenCalled();
  });

  it('honors a remembered deny without prompting', () => {
    const { request, promptUser } = setup({
      config: { enabled: false },
      remembered: { [ORIGIN]: { media: 'deny' } },
    });
    expect(
      request('media', { requestingUrl: PAGE_URL, mediaTypes: ['video'] }).granted,
    ).toBe(false);
    expect(promptUser).not.toHaveBeenCalled();
  });

  it('prompts for an unremembered permission with the requesting origin', async () => {
    let resolvePrompt!: (r: { allow: boolean; remember: boolean }) => void;
    const { request, promptUser, remember } = setup({
      config: { enabled: false },
      prompt: () =>
        new Promise((resolve) => {
          resolvePrompt = resolve;
        }),
    });

    const probe = request('media', { requestingUrl: PAGE_URL, mediaTypes: ['video'] });
    // Nothing is granted before the user answers.
    expect(probe.granted).toBeUndefined();
    // Second argument: the requesting webContents (null in this harness),
    // passed through so the prompt can be routed to the owning window.
    expect(promptUser).toHaveBeenCalledWith({ origin: ORIGIN, permission: 'media' }, null);

    resolvePrompt({ allow: true, remember: false });
    await flushPromises();
    expect(probe.granted).toBe(true);
    expect(remember).not.toHaveBeenCalled();
  });

  it('applies and persists a prompted deny when remember is checked', async () => {
    const { request, remember } = setup({
      config: { enabled: false },
      prompt: async () => ({ allow: false, remember: true }),
    });
    const probe = request('media', { requestingUrl: PAGE_URL, mediaTypes: ['video'] });
    await flushPromises();
    expect(probe.granted).toBe(false);
    expect(remember).toHaveBeenCalledWith(ORIGIN, 'media', 'deny');
  });

  it('applies and persists a prompted allow when remember is checked', async () => {
    const { request, remember } = setup({
      config: { enabled: false },
      prompt: async () => ({ allow: true, remember: true }),
    });
    const probe = request('geolocation', { requestingUrl: PAGE_URL });
    await flushPromises();
    expect(probe.granted).toBe(true);
    expect(remember).toHaveBeenCalledWith(ORIGIN, 'geolocation', 'allow');
  });

  it('falls back to wc.getURL() for the origin when details lack requestingUrl', async () => {
    const { request, promptUser } = setup({
      config: { enabled: false },
      prompt: async () => ({ allow: true, remember: false }),
    });
    const wc = { getURL: () => 'https://fallback.example/deep/path' } as unknown as WebContents;
    const probe = request('midi', undefined, wc);
    await flushPromises();
    expect(promptUser).toHaveBeenCalledWith(
      { origin: 'https://fallback.example', permission: 'midi' },
      wc,
    );
    expect(probe.granted).toBe(true);
  });

  it('never persists a decision for an unparsable origin', async () => {
    const { request, promptUser, remember } = setup({
      config: { enabled: false },
      prompt: async () => ({ allow: true, remember: true }),
    });
    const probe = request('notifications', { requestingUrl: 'not-a-url' });
    await flushPromises();
    expect(promptUser).toHaveBeenCalledWith({ origin: '', permission: 'notifications' }, null);
    expect(probe.granted).toBe(true);
    expect(remember).not.toHaveBeenCalled();
  });

  it('a rejected prompt fails closed (deny)', async () => {
    const { request, remember } = setup({
      config: { enabled: false },
      prompt: () => Promise.reject(new Error('prompt torn down')),
    });
    const probe = request('media', { requestingUrl: PAGE_URL, mediaTypes: ['audio'] });
    await flushPromises();
    expect(probe.granted).toBe(false);
    expect(remember).not.toHaveBeenCalled();
  });

  it('check handler: remembered deny blocks, everything else reads permissive', () => {
    const { check } = setup({
      config: { enabled: false },
      remembered: { [ORIGIN]: { notifications: 'deny', geolocation: 'allow' } },
    });
    expect(check('notifications')).toBe(false);
    expect(check('geolocation')).toBe(true);
    // Unremembered: capability reporting only; a sensitive grant still goes
    // through the prompting request handler.
    expect(check('media')).toBe(true);
  });

  it('check handler: normalizes the trailing-slash origin Electron sends to the stored URL.origin key', () => {
    const { check } = setup({
      config: { enabled: false },
      remembered: { [ORIGIN]: { notifications: 'deny' } },
    });
    // Electron passes requestingOrigin as an origin URL with a trailing slash
    // ('https://site.example/'); decisions are stored under URL.origin
    // ('https://site.example'). The remembered deny must still be honored.
    expect(check('notifications', `${ORIGIN}/`)).toBe(false);
    // And an unremembered permission on the same slashed origin stays permissive.
    expect(check('midi', `${ORIGIN}/`)).toBe(true);
  });
});
