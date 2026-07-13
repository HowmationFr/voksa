import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_STREAM_CONFIG } from '../../../shared/streamConfig';
import type { AppSettings } from '../../../shared/types';

// settings.ts resolves its file through electron's app.getPath('userData');
// point that at a fresh temp dir per test.
const mocked = vi.hoisted(() => ({ userDataDir: '' }));

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name !== 'userData') throw new Error(`unexpected app.getPath('${name}')`);
      return mocked.userDataDir;
    },
  },
}));

type SettingsModule = typeof import('../settings');

describe('settings storage', () => {
  let dir: string;

  const settingsFile = () => path.join(dir, 'settings.json');

  /** Fresh module instance: settings.ts caches path and parsed settings. */
  async function freshImport(): Promise<SettingsModule> {
    vi.resetModules();
    return import('../settings');
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voksa-settings-test-'));
    mocked.userDataDir = dir;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('parses a settings.json that starts with a UTF-8 BOM', async () => {
    fs.writeFileSync(
      settingsFile(),
      '\uFEFF' + JSON.stringify({ searchEngine: 'duckduckgo', showBookmarkBar: false }),
      'utf8',
    );
    const { getSettings } = await freshImport();
    const s = getSettings();
    // Values honored, not silently replaced by defaults.
    expect(s.searchEngine).toBe('duckduckgo');
    expect(s.showBookmarkBar).toBe(false);
    // And NOT treated as corrupt: no forensic backup written.
    expect(fs.existsSync(`${settingsFile()}.bak`)).toBe(false);
  });

  it('falls back to defaults on a truncated file, without throwing, and backs it up', async () => {
    const garbage = '{ "searchEngine": "duckduck';
    fs.writeFileSync(settingsFile(), garbage, 'utf8');
    // Silence the expected forensics log line.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { getSettings } = await freshImport();
    const s = getSettings();
    expect(s.searchEngine).toBe('google');
    expect(s.theme).toBe('system');
    expect(s.streamMode).toEqual(DEFAULT_STREAM_CONFIG);
    // The corrupted file is preserved verbatim as settings.json.bak.
    const bak = `${settingsFile()}.bak`;
    expect(fs.existsSync(bak)).toBe(true);
    expect(fs.readFileSync(bak, 'utf8')).toBe(garbage);
    expect(errSpy).toHaveBeenCalled();
  });

  it('defaults the homepage to voksa://newtab and migrates a legacy hbb:// homepage', async () => {
    // No file at all: the DEFAULTS homepage is the new scheme.
    const first = await freshImport();
    expect(first.getSettings().homepage).toBe('voksa://newtab');
    // A settings.json written before the Voksa rename stores hbb://...;
    // loading must rewrite the prefix (case-insensitive) and keep the rest.
    fs.writeFileSync(
      settingsFile(),
      JSON.stringify({ homepage: 'hbb://bookmarks', searchEngine: 'brave' }),
      'utf8',
    );
    const mod = await freshImport();
    const s = mod.getSettings();
    expect(s.homepage).toBe('voksa://bookmarks');
    expect(s.searchEngine).toBe('brave'); // migration touches only the prefix
    // External homepages pass through untouched.
    fs.writeFileSync(settingsFile(), JSON.stringify({ homepage: 'https://example.com' }), 'utf8');
    const ext = await freshImport();
    expect(ext.getSettings().homepage).toBe('https://example.com');
  });

  describe('startupMode migration (0.3 -> 0.4)', () => {
    it('keeps session restore for a profile that already existed', async () => {
      // Until 0.4 Voksa restored the previous session unconditionally. The new
      // DEFAULT is 'newtab', and applying it to an existing profile would look,
      // to that user, exactly like the browser losing every tab on an update.
      fs.writeFileSync(settingsFile(), JSON.stringify({ theme: 'dark' }), 'utf8');
      const { getSettings } = await freshImport();
      expect(getSettings().startupMode).toBe('restore');
    });

    it('gives a brand-new profile the new default', async () => {
      const { getSettings } = await freshImport();
      expect(getSettings().startupMode).toBe('newtab');
    });

    it('never overrides an explicit choice, and never re-runs on a later write', async () => {
      fs.writeFileSync(
        settingsFile(),
        JSON.stringify({ theme: 'dark', startupMode: 'newtab' }),
        'utf8',
      );
      const { getSettings, setSettings } = await freshImport();
      expect(getSettings().startupMode).toBe('newtab');
      // The migration lives in load(), not sanitize(): a write must not resurrect it.
      setSettings({ theme: 'light' });
      expect(getSettings().startupMode).toBe('newtab');
    });
  });

  it('sanitizes unknown enum values back to defaults, keeping valid fields', async () => {
    fs.writeFileSync(
      settingsFile(),
      JSON.stringify({
        // Not a shipped engine id (a hand-edited file, or one written by a
        // future version whose engine we removed).
        searchEngine: 'askjeeves',
        theme: 'sepia',
        language: 'de',
        homepage: 'https://example.com',
        extensionOrder: 'not-an-array',
      }),
      'utf8',
    );
    const { getSettings } = await freshImport();
    const s = getSettings();
    expect(s.searchEngine).toBe('google');
    expect(s.theme).toBe('system');
    expect(s.language).toBe('system');
    expect(s.extensionOrder).toEqual([]);
    // Sanitizing enums must not discard the valid fields around them.
    expect(s.homepage).toBe('https://example.com');
  });

  it('deep-merges streamMode patches and persists the merge', async () => {
    // Start from a config that already diverges from defaults on ONE flag.
    fs.writeFileSync(
      settingsFile(),
      JSON.stringify({ streamMode: { ...DEFAULT_STREAM_CONFIG, maskPhones: false } }),
      'utf8',
    );
    const mod = await freshImport();
    // Patch a single flag. Production callers pass a full streamMode config;
    // the deep merge below is a defensive property of settings.ts itself
    // (a partial object must never wipe the other flags). The cast lets the
    // test exercise that path despite the full-config type.
    const next = mod.setSettings({
      streamMode: { maskEmails: false } as AppSettings['streamMode'],
    });
    expect(next.streamMode.maskEmails).toBe(false); // the patched flag
    expect(next.streamMode.maskPhones).toBe(false); // pre-existing divergence kept
    expect(next.streamMode.maskIPv4).toBe(true); // untouched flags keep defaults
    mod.flushSettings();
    // Re-import: the merged config survived the round-trip to disk.
    const again = await freshImport();
    expect(again.getSettings().streamMode).toEqual({
      ...DEFAULT_STREAM_CONFIG,
      maskEmails: false,
      maskPhones: false,
    });
  });

  it('flushes the debounced write through the timer path, without flushSettings', async () => {
    // Import with real timers first: the fake-timer install must not interact
    // with the dynamic-import/reset pattern, only with the debounce itself.
    const mod = await freshImport();
    vi.useFakeTimers();
    try {
      mod.setSettings({ theme: 'dark' });
      // Debounced: nothing on disk until the 500 ms timer fires.
      expect(fs.existsSync(settingsFile())).toBe(false);
      await vi.advanceTimersByTimeAsync(500);
      // The setTimeout flush wrote the file; this is the path every real
      // settings change relies on (flushSettings only runs at quit).
      const parsed = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) as AppSettings;
      expect(parsed.theme).toBe('dark');
    } finally {
      vi.useRealTimers();
    }
  });

  it('writes debounced, atomic-ish and BOM-free JSON', async () => {
    const mod = await freshImport();
    mod.setSettings({ theme: 'dark' });
    // The write is debounced (500 ms), nothing on disk yet.
    expect(fs.existsSync(settingsFile())).toBe(false);
    mod.flushSettings();
    const raw = fs.readFileSync(settingsFile(), 'utf8');
    // First byte is '{': no BOM, no leading junk.
    expect(raw.charCodeAt(0)).toBe('{'.charCodeAt(0));
    const parsed = JSON.parse(raw) as AppSettings;
    expect(parsed.theme).toBe('dark');
    expect(parsed.streamMode).toEqual(DEFAULT_STREAM_CONFIG);
    // The temp file used for the rename-over-target must not linger.
    expect(fs.existsSync(`${settingsFile()}.tmp`)).toBe(false);
  });
});
