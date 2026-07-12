import { app, session } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { UpdateState } from '../shared/types';

/**
 * Route the updater's HTTP traffic through the DEFAULT session.
 *
 * By default electron-updater requests run on a private session partition
 * ('electron-updater', see ElectronHttpExecutor.getNetSession). Issuing a
 * request on a session that has no Chrome extension system, while extensions
 * ARE loaded on the default session, kills the process: a hard native crash,
 * no JS exception, no 'error' event. Symptom: the packaged app dies about 10
 * seconds after boot (the startup check), but only on a profile with at least
 * one extension installed, which is why dev and a fresh CI profile never see it.
 *
 * Pre-creating that partition early does NOT help: the crash is at request
 * time, not at context creation. The default session is the only one wired to
 * the extension system, so the updater has to use it.
 *
 * `cachedSession` is internal to electron-updater (pinned ^6.8.9). If a future
 * version renames it we would silently fall back to the crashing path, so the
 * caller MUST treat `false` as "do not enable the updater".
 */
function routeUpdaterThroughDefaultSession(): boolean {
  const executor = (autoUpdater as unknown as {
    httpExecutor?: { cachedSession: Electron.Session | null };
  }).httpExecutor;
  if (!executor || !('cachedSession' in executor)) return false;
  executor.cachedSession = session.defaultSession;
  return executor.cachedSession === session.defaultSession;
}

/**
 * Auto-update over GitHub Releases (electron-updater reads the latest*.yml
 * uploaded by the release workflow; drafts and prereleases are invisible).
 *
 * Policy:
 * - Silent check shortly after startup, then downloads in the background and
 *   installs on quit (autoInstallOnAppQuit).
 * - Manual check from the settings page at any time.
 * - `unsupported` when running unpackaged (dev) or when the install channel
 *   has no update path (.deb: electron-updater only handles AppImage on
 *   Linux). The UI shows a muted explanation instead of a button.
 */
export class UpdateController {
  private state: UpdateState;
  private broadcast: (state: UpdateState) => void = () => {};
  private updater: typeof import('electron-updater').autoUpdater | null = null;

  constructor() {
    const supported =
      app.isPackaged && (process.platform !== 'linux' || !!process.env.APPIMAGE);
    this.state = {
      currentVersion: app.getVersion(),
      phase: supported ? 'idle' : 'unsupported',
    };
    if (supported) this.initUpdater();
  }

  private initUpdater(): void {
    try {
      // Without this the first check crashes the app on any profile that has
      // an extension installed. Never enable the updater when it fails.
      if (!routeUpdaterThroughDefaultSession()) {
        this.state = {
          ...this.state,
          phase: 'error',
          error: 'Auto-update disabled: incompatible electron-updater internals.',
        };
        return;
      }

      autoUpdater.autoDownload = true;
      autoUpdater.autoInstallOnAppQuit = true;
      autoUpdater.logger = null;

      autoUpdater.on('checking-for-update', () => this.setState({ phase: 'checking' }));
      autoUpdater.on('update-available', (info) =>
        this.setState({ phase: 'downloading', availableVersion: info.version, percent: 0 }),
      );
      autoUpdater.on('update-not-available', () => this.setState({ phase: 'uptodate' }));
      autoUpdater.on('download-progress', (p) =>
        this.setState({ phase: 'downloading', percent: Math.round(p.percent) }),
      );
      autoUpdater.on('update-downloaded', (info) =>
        this.setState({ phase: 'ready', availableVersion: info.version, percent: 100 }),
      );
      autoUpdater.on('error', (err) =>
        this.setState({ phase: 'error', error: err?.message ?? String(err) }),
      );
      this.updater = autoUpdater;
    } catch (err) {
      this.state = {
        ...this.state,
        phase: 'error',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private setState(patch: Partial<UpdateState>): void {
    // Carry the previous fields (availableVersion must survive the stream of
    // download-progress events), then clear what no longer applies.
    const next: UpdateState = { ...this.state, ...patch };
    if (next.phase !== 'downloading' && next.phase !== 'ready' && patch.percent === undefined) {
      next.percent = undefined;
    }
    if (next.phase !== 'error') next.error = undefined;
    if (next.phase === 'idle' || next.phase === 'uptodate') next.availableVersion = undefined;
    this.state = next;
    this.broadcast(this.state);
  }

  onStateChanged(broadcast: (state: UpdateState) => void): void {
    this.broadcast = broadcast;
  }

  getState(): UpdateState {
    return this.state;
  }

  /** Manual or startup check. No-op while a cycle is already running. */
  check(): UpdateState {
    if (
      this.updater &&
      this.state.phase !== 'checking' &&
      this.state.phase !== 'downloading' &&
      this.state.phase !== 'ready'
    ) {
      this.updater.checkForUpdates().catch(() => {
        // The 'error' event already updated the state.
      });
    }
    return this.state;
  }

  /**
   * Silent background check a moment after boot, then every few hours
   * (packaged only). Without the periodic leg, a browser left running for
   * days never learns a new version exists. `check()` self-guards against
   * re-entry and against the 'ready' phase, so the interval is safe to fire
   * unconditionally. Both timers are unref'd: they never hold the app alive.
   */
  scheduleChecks(): void {
    if (!this.updater) return;
    const boot = setTimeout(() => this.check(), 10_000);
    boot.unref();
    const periodic = setInterval(() => this.check(), 4 * 60 * 60 * 1000);
    periodic.unref();
  }

  install(): void {
    // isSilent=true: with nsis.oneClick=false the default (false) would open
    // the full installer wizard after quitting instead of updating in place.
    // isForceRunAfter=true relaunches the app once the update is applied.
    if (this.state.phase === 'ready') this.updater?.quitAndInstall(true, true);
  }
}
