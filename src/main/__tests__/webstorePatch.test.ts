/**
 * Guard for patches/electron-chrome-web-store+0.13.0.patch (SECURITY).
 *
 * The patch closes two holes of electron-chrome-web-store 0.13.0:
 *   1. the store API was gated by a PREFIX match on the origin, so any
 *      https://chromewebstore.google.com.<anything> host (main-process IPC
 *      gate) or URL (preload) could install and uninstall extensions;
 *   2. page-supplied extension IDs were joined into filesystem paths:
 *      chrome.management.uninstall('../../Documents') ran rm -rf on it.
 *
 * patch-package re-applies the patch on every install and fails on a version
 * mismatch (--error-on-fail --error-on-warn), but a hand-ported patch for a
 * new version could still drop a check. So this suite tests the INSTALLED
 * files, i.e. what Voksa ships:
 *   - STATIC: the exact checks are present in all three builds;
 *   - BEHAVIOUR: the preload (run in a vm) and both main-process builds
 *     (ESM, the one Voksa loads through import(), and CJS) are driven like
 *     a hostile page would, against a throwaway profile directory.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

type IpcHandler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

// One fake electron per build: each build registers its own IPC handlers.
const fakes = vi.hoisted(() => {
  const makeElectron = () => {
    const handlers = new Map<string, IpcHandler>();
    const module = {
      app: {
        whenReady: () => Promise.resolve(),
        getName: () => 'Voksa',
        getPath: () => {
          throw new Error('tests must pass extensionsPath explicitly');
        },
        on: () => undefined,
      },
      ipcMain: {
        handle: (channel: string, fn: IpcHandler) => {
          handlers.set(channel, fn);
        },
      },
      BrowserWindow: { fromWebContents: () => null },
      nativeImage: { createFromBuffer: () => ({ isEmpty: () => true }) },
      net: undefined,
      session: { defaultSession: undefined },
      powerMonitor: { getSystemIdleState: () => 'active' },
    };
    return { handlers, module };
  };
  return { makeElectron, esm: makeElectron(), cjs: makeElectron() };
});

// Reaches the library's ESM build because vitest.config.ts inlines it.
vi.mock('electron', () => fakes.esm.module);

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const PKG_DIR = path.join(ROOT, 'node_modules', 'electron-chrome-web-store');
const ESM_BUILD = 'dist/esm/browser/index.mjs';
const CJS_BUILD = 'dist/cjs/browser/index.js';
const PRELOAD = 'dist/chrome-web-store.preload.js';
const read = (rel: string) => fs.readFileSync(path.join(PKG_DIR, rel), 'utf8');

const STORE = 'https://chromewebstore.google.com';
const LOOK_ALIKES = [
  'https://chromewebstore.google.com.evil.example',
  'https://chromewebstore.google.com.evil.example:8443',
];
const VALID_ID = 'a'.repeat(32);

describe('electron-chrome-web-store patch: pin and wiring', () => {
  const installed = JSON.parse(read('package.json')).version as string;
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  it('is pinned exactly to the installed (patched) version', () => {
    expect(pkg.dependencies['electron-chrome-web-store']).toBe(installed);
  });

  it('has a patch for that exact version', () => {
    const patch = path.join(ROOT, 'patches', `electron-chrome-web-store+${installed}.patch`);
    expect(fs.existsSync(patch)).toBe(true);
  });

  it('fails the install when a patch no longer applies', () => {
    expect(pkg.scripts.postinstall).toMatch(/^patch-package --error-on-fail --error-on-warn(\s|$)/);
  });
});

describe('electron-chrome-web-store patch: static checks', () => {
  it('preload exposes the store API on the exact store origin only', () => {
    const src = read(PRELOAD);
    expect(src).toContain(
      'if (new URL(location.href).origin === "https://chromewebstore.google.com") {',
    );
    expect(src).not.toMatch(/location\.href\.startsWith\(/);
  });

  it.each([ESM_BUILD, CJS_BUILD])('%s gates IPC on the exact origin', (build) => {
    const src = read(build);
    expect(src).toContain('var WEBSTORE_URL = "https://chromewebstore.google.com";');
    expect(src).toContain('if (senderOrigin !== WEBSTORE_URL) {');
    expect(src).not.toMatch(/startsWith\(WEBSTORE_URL\)/);
  });

  it.each([ESM_BUILD, CJS_BUILD])('%s validates every page-supplied extension id', (build) => {
    const src = read(build);
    expect(src).toContain('var EXTENSION_ID_PATTERN = /^[a-p]{32}$/;');
    for (const head of [
      'async function downloadExtension(extensionId, extensionsDir) {',
      'async function installExtension(extensionId, opts = {}) {',
      'async function uninstallExtension(extensionId, opts = {}) {',
    ]) {
      expect(src).toContain(`${head}\n  assertValidExtensionId(extensionId);\n`);
    }
    expect(src).toContain(
      '  const extensionId = details.id;\n  if (!isValidExtensionId(extensionId)) {\n    return { result: Result.INVALID_ID };\n  }\n',
    );
    expect(src).toMatch(
      /handle\("chromeWebstore\.getExtensionStatus", async \(_event, id, manifestJson\) => \{\n\s+if \(!isValidExtensionId\(id\)\) \{/,
    );
    expect(src).toMatch(
      /if \(!isValidExtensionId\(id\)\) \{\n\s+return Result\.INVALID_ID;\n\s+\}\n\s+try \{\n\s+await uninstallExtension\(id, webStoreState\);/,
    );
  });
});

describe('electron-chrome-web-store patch: preload behaviour', () => {
  const code = read(PRELOAD);

  /** Runs the session preload as Electron would in a frame at `href`. */
  function exposedGlobals(href: string, origin = new URL(href).origin): string[] {
    const exposed: string[] = [];
    const electron = {
      contextBridge: { exposeInMainWorld: (key: string) => exposed.push(key) },
      ipcRenderer: {
        invoke: async () => ({ version_number: '140.0.0.0', app_name: 'Voksa' }),
        on: () => undefined,
        removeListener: () => undefined,
      },
      webFrame: { executeJavaScript: async () => undefined },
    };
    vm.runInNewContext(code, {
      require: (name: string) => {
        if (name !== 'electron') throw new Error(`unexpected require(${name})`);
        return electron;
      },
      location: { href, origin },
      navigator: { userAgent: 'Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36' },
      document: { querySelectorAll: () => [] },
      window: {},
      requestAnimationFrame: () => 0,
      setTimeout: () => 0,
      process: { once: () => undefined },
      console: { debug: () => undefined },
      URL,
    });
    return exposed;
  }

  it('exposes the API on a real store page (anti-vacuity)', () => {
    expect(
      exposedGlobals(`${STORE}/detail/ublock-origin-lite/ddkjiahejlhfcafbddmgiahcphecmpfh`),
    ).toEqual(['electronWebstore', 'electronRuntime', 'electronManagement']);
  });

  it.each([
    ...LOOK_ALIKES.map((o) => `${o}/detail/x`),
    'https://chromewebstore.google.com@evil.example/',
    'http://chromewebstore.google.com/',
    'http://127.0.0.1:8080/?https://chromewebstore.google.com',
  ])('exposes nothing on %s', (href) => {
    expect(exposedGlobals(href)).toEqual([]);
  });

  it('exposes nothing in an about:blank frame inheriting the store origin', () => {
    expect(exposedGlobals('about:blank', STORE)).toEqual([]);
  });
});

type WebStoreLib = {
  installChromeWebStore: (opts: Record<string, unknown>) => Promise<void>;
  installExtension: (id: string, opts: Record<string, unknown>) => Promise<unknown>;
  uninstallExtension: (id: string, opts: Record<string, unknown>) => Promise<void>;
  downloadExtension: (id: string, dir: string) => Promise<string>;
};

async function loadEsm() {
  const lib = (await import('electron-chrome-web-store')) as unknown as WebStoreLib;
  return { lib, handlers: fakes.esm.handlers };
}

const libRequire = createRequire(path.join(PKG_DIR, 'package.json'));
const electronPath = libRequire.resolve('electron');

async function loadCjs() {
  // Plain require() never goes through vi.mock: seed the CJS cache instead.
  libRequire.cache[electronPath] = {
    id: electronPath,
    filename: electronPath,
    loaded: true,
    exports: fakes.cjs.module,
  } as unknown as NodeJS.Module;
  const lib = libRequire(path.join(PKG_DIR, CJS_BUILD)) as WebStoreLib;
  return { lib, handlers: fakes.cjs.handlers };
}

afterAll(() => {
  delete libRequire.cache[electronPath];
});

describe.each([
  ['ESM', loadEsm],
  ['CJS', loadCjs],
])('electron-chrome-web-store patch: %s build behaviour', (_label, load) => {
  let lib: WebStoreLib;
  let handlers: Map<string, IpcHandler>;
  let tmp: string;
  let extensionsPath: string;
  let victim: string;
  let installed: string;
  const removeExtension = vi.fn();
  const session = {
    registerPreloadScript: () => undefined,
    extensions: {
      getAllExtensions: () => [],
      getExtension: () => undefined,
      removeExtension,
      loadExtension: vi.fn(),
    },
  };

  const invoke = (channel: string, origin: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`no IPC handler registered for ${channel}`);
    const event = {
      sender: { session, send: vi.fn() },
      senderFrame: { origin, isDestroyed: () => false, send: vi.fn() },
    };
    return handler(event, ...args);
  };

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'voksa-cws-patch-'));
    extensionsPath = path.join(tmp, 'profile', 'Extensions');
    ({ lib, handlers } = await load());
    await lib.installChromeWebStore({
      session,
      extensionsPath,
      loadExtensions: false,
      autoUpdate: false,
    });
  });

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  beforeEach(() => {
    // profile/victim stands for ~/Documents: a sibling of the extensions dir.
    victim = path.join(tmp, 'profile', 'victim');
    fs.mkdirSync(victim, { recursive: true });
    fs.writeFileSync(path.join(victim, 'keep.txt'), 'user data');
    installed = path.join(extensionsPath, VALID_ID, '1.0_0');
    fs.mkdirSync(installed, { recursive: true });
    fs.writeFileSync(path.join(installed, 'manifest.json'), '{"manifest_version":3}');
  });

  it.each(LOOK_ALIKES)('ignores every store call from %s', async (origin) => {
    expect(await invoke('chrome.management.uninstall', origin, VALID_ID, {})).toBeUndefined();
    expect(fs.existsSync(installed)).toBe(true);
    expect(
      await invoke('chromeWebstore.beginInstall', origin, { id: VALID_ID, manifest: '{}' }),
    ).toBeUndefined();
  });

  it('lets the real store uninstall a valid id (anti-vacuity)', async () => {
    expect(await invoke('chrome.management.uninstall', STORE, VALID_ID, {})).toBe('success');
    expect(fs.existsSync(path.join(extensionsPath, VALID_ID))).toBe(false);
    expect(fs.existsSync(path.join(victim, 'keep.txt'))).toBe(true);
  });

  it.each(['../victim', '..', '../../profile/victim', `${VALID_ID}/../../victim`])(
    'refuses to uninstall %j, even from the real store',
    async (id) => {
      expect(await invoke('chrome.management.uninstall', STORE, id, {})).toBe('invalid_id');
      expect(fs.existsSync(path.join(victim, 'keep.txt'))).toBe(true);
      expect(fs.existsSync(installed)).toBe(true);
    },
  );

  it('answers INVALID_ID to beginInstall with a traversal id', async () => {
    expect(
      await invoke('chromeWebstore.beginInstall', STORE, { id: '../victim', manifest: '{}' }),
    ).toEqual({ result: 'invalid_id' });
  });

  it('rejects getExtensionStatus for an invalid id, answers for a valid one', async () => {
    const manifest = '{"manifest_version":3}';
    await expect(
      invoke('chromeWebstore.getExtensionStatus', STORE, '../victim', manifest),
    ).rejects.toThrow('Invalid id');
    expect(await invoke('chromeWebstore.getExtensionStatus', STORE, VALID_ID, manifest)).toBe(
      'installable',
    );
  });

  it('refuses invalid ids in the exported installer functions', async () => {
    const opts = { session, extensionsPath };
    await expect(lib.uninstallExtension('../victim', opts)).rejects.toThrow(/invalid extension ID/);
    await expect(lib.installExtension('../victim', opts)).rejects.toThrow(/invalid extension ID/);
    await expect(lib.downloadExtension('../victim', extensionsPath)).rejects.toThrow(
      /invalid extension ID/,
    );
    expect(fs.existsSync(path.join(victim, 'keep.txt'))).toBe(true);
    expect(removeExtension).not.toHaveBeenCalledWith('../victim');
  });
});
