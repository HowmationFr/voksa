import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionWindow } from '../session';

// session.ts resolves its file through electron's app.getPath('userData');
// point that at a fresh temp dir per test (same pattern as settings.test.ts).
const mocked = vi.hoisted(() => ({ userDataDir: '' }));

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name !== 'userData') throw new Error(`unexpected app.getPath('${name}')`);
      return mocked.userDataDir;
    },
  },
}));

type SessionModule = typeof import('../session');

const win = (over: Partial<SessionWindow> = {}): SessionWindow => ({
  tabs: [{ url: 'https://example.com', title: 'Example' }],
  activeIndex: 0,
  closedStack: [],
  maximized: false,
  windowBounds: undefined,
  ...over,
});

describe('session storage', () => {
  let dir: string;

  const sessionFile = () => path.join(dir, 'session.json');

  /** Fresh module instance: session.ts caches path + snapshots. */
  async function freshImport(): Promise<SessionModule> {
    vi.resetModules();
    return import('../session');
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voksa-session-test-'));
    mocked.userDataDir = dir;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('migrates a v1 single-window file into one v2 window entry', async () => {
    // A session.json written by a single-window build.
    const legacy = {
      windowBounds: { x: 10, y: 20, width: 800, height: 600 },
      maximized: true,
      tabs: [{ url: 'https://example.com', title: 'Example' }],
      activeIndex: 0,
      closedStack: [],
    };
    fs.writeFileSync(sessionFile(), JSON.stringify(legacy), 'utf8');
    const { loadSession } = await freshImport();
    const loaded = loadSession();
    expect(loaded).not.toBeNull();
    expect(loaded!.windows).toHaveLength(1);
    expect(loaded!.windows[0].tabs.map((t) => t.url)).toEqual(['https://example.com']);
    expect(loaded!.windows[0].maximized).toBe(true);
    expect(loaded!.windows[0].windowBounds).toEqual(legacy.windowBounds);
  });

  it('migrates legacy hbb:// tab URLs to voksa:// on load (pre-rename profiles)', async () => {
    const legacy = {
      tabs: [
        { url: 'hbb://history', title: 'Historique' },
        { url: 'https://example.com/hbb://not-a-prefix', title: 'Example' },
      ],
      activeIndex: 0,
      closedStack: [{ url: 'hbb://newtab', title: 'Nouvel onglet' }],
    };
    fs.writeFileSync(sessionFile(), JSON.stringify(legacy), 'utf8');
    const { loadSession } = await freshImport();
    const loaded = loadSession();
    expect(loaded).not.toBeNull();
    expect(loaded!.windows[0].tabs.map((t) => t.url)).toEqual([
      'voksa://history',
      // Only a LEADING hbb:// is a scheme; anything later in the URL stays.
      'https://example.com/hbb://not-a-prefix',
    ]);
    // Reopen-closed entries become tab URLs too: same migration.
    expect(loaded!.windows[0].closedStack.map((t) => t.url)).toEqual(['voksa://newtab']);
  });

  it('round-trips a multi-window session in window order', async () => {
    const mod = await freshImport();
    const a = win({ tabs: [{ url: 'voksa://newtab', title: 'Nouvel onglet' }] });
    const b = win({
      tabs: [{ url: 'https://example.org', title: 'Org' }],
      activeIndex: 0,
      windowBounds: { x: 40, y: 40, width: 1000, height: 700 },
    });
    mod.updateWindowSnapshot(1, a);
    mod.updateWindowSnapshot(2, b);
    mod.flushSession();
    const loaded = mod.loadSession();
    expect(loaded).toEqual({ windows: [a, b] });
  });

  it('removeWindowSnapshot forgets a window immediately (close-while-others-remain)', async () => {
    const mod = await freshImport();
    mod.updateWindowSnapshot(1, win({ tabs: [{ url: 'https://a.example', title: 'A' }] }));
    mod.updateWindowSnapshot(2, win({ tabs: [{ url: 'https://b.example', title: 'B' }] }));
    mod.flushSession();
    // No flush after removal on purpose: the removal itself must be durable.
    mod.removeWindowSnapshot(1);
    const loaded = mod.loadSession();
    expect(loaded).not.toBeNull();
    expect(loaded!.windows).toHaveLength(1);
    expect(loaded!.windows[0].tabs[0].url).toBe('https://b.example');
  });

  it('updates replace an existing snapshot instead of appending', async () => {
    const mod = await freshImport();
    mod.updateWindowSnapshot(1, win());
    mod.updateWindowSnapshot(1, win({ tabs: [{ url: 'https://later.example', title: 'L' }] }));
    mod.flushSession();
    const loaded = mod.loadSession();
    expect(loaded!.windows).toHaveLength(1);
    expect(loaded!.windows[0].tabs[0].url).toBe('https://later.example');
  });

  it('returns null for files with no restorable window', async () => {
    fs.writeFileSync(sessionFile(), JSON.stringify({ windows: [] }), 'utf8');
    const { loadSession } = await freshImport();
    expect(loadSession()).toBeNull();
  });

  describe('boot restore freeze', () => {
    /** A saved run of three windows, as written by the previous session. */
    const saved = {
      windows: [
        win({ tabs: [{ url: 'https://one.example', title: '1' }] }),
        win({ tabs: [{ url: 'https://two.example', title: '2' }] }),
        win({ tabs: [{ url: 'https://three.example', title: '3' }] }),
      ],
    };

    it('keeps the saved file intact while windows are still being restored', async () => {
      fs.writeFileSync(sessionFile(), JSON.stringify(saved), 'utf8');
      const mod = await freshImport();
      mod.beginRestore();
      // Window 1 is back and already saving (geometry restore fires resize).
      mod.updateWindowSnapshot(1, win({ tabs: [] }));
      mod.flushSession();
      // Windows 2 and 3 have not booted yet: the file must still hold all
      // three, NOT the single half-booted window. This is the regression that
      // would silently erase two windows worth of tabs on a slow cold start.
      const onDisk = JSON.parse(fs.readFileSync(sessionFile(), 'utf8'));
      expect(onDisk.windows).toHaveLength(3);
      expect(onDisk.windows.map((w: { tabs: { url: string }[] }) => w.tabs[0].url)).toEqual([
        'https://one.example',
        'https://two.example',
        'https://three.example',
      ]);
    });

    it('writes the full set once the restore ends', async () => {
      fs.writeFileSync(sessionFile(), JSON.stringify(saved), 'utf8');
      const mod = await freshImport();
      mod.beginRestore();
      saved.windows.forEach((w, i) => mod.updateWindowSnapshot(i + 1, w));
      mod.endRestore();
      const loaded = mod.loadSession();
      expect(loaded!.windows.map((w) => w.tabs[0].url)).toEqual([
        'https://one.example',
        'https://two.example',
        'https://three.example',
      ]);
    });

    it('a window that fails to boot is dropped, the others survive', async () => {
      fs.writeFileSync(sessionFile(), JSON.stringify(saved), 'utf8');
      const mod = await freshImport();
      mod.beginRestore();
      // Window 2 threw during bootstrap: index.ts skips it and carries on.
      mod.updateWindowSnapshot(1, saved.windows[0]);
      mod.updateWindowSnapshot(3, saved.windows[2]);
      mod.endRestore();
      const loaded = mod.loadSession();
      expect(loaded!.windows.map((w) => w.tabs[0].url)).toEqual([
        'https://one.example',
        'https://three.example',
      ]);
    });
  });
});
