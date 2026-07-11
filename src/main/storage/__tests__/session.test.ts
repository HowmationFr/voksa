import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionData } from '../session';

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

describe('session storage', () => {
  let dir: string;

  const sessionFile = () => path.join(dir, 'session.json');

  /** Fresh module instance: session.ts caches the resolved file path. */
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

  it('migrates legacy hbb:// tab URLs to voksa:// on load (pre-rename profiles)', async () => {
    // A session.json written by a build before the Voksa rename.
    const legacy: SessionData = {
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
    expect(loaded!.tabs.map((t) => t.url)).toEqual([
      'voksa://history',
      // Only a LEADING hbb:// is a scheme; anything later in the URL stays.
      'https://example.com/hbb://not-a-prefix',
    ]);
    // Reopen-closed entries become tab URLs too: same migration.
    expect(loaded!.closedStack.map((t) => t.url)).toEqual(['voksa://newtab']);
  });

  it('round-trips a modern session unchanged', async () => {
    const mod = await freshImport();
    const data: SessionData = {
      tabs: [
        { url: 'voksa://newtab', title: 'Nouvel onglet' },
        { url: 'https://example.com', title: 'Example' },
      ],
      activeIndex: 1,
      closedStack: [],
    };
    mod.saveSession(data);
    mod.flushSession();
    const loaded = mod.loadSession();
    expect(loaded).toEqual({ ...data, maximized: false, windowBounds: undefined });
  });
});
