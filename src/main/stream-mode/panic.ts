/**
 * Panic Key: one system-wide keystroke that makes every Voksa window safe to
 * look at, even while OBS or a game holds the keyboard focus. Curtain over
 * every tab of every window, global mute, and Stream Mode armed if it was
 * off. A second press restores the curtains and the audio.
 *
 * Deliberate choices:
 *  - The restore does NOT disarm Stream Mode. Panic fired because something
 *    was exposed; silently dropping the protection on restore would re-expose
 *    it. Turning the stream off stays a manual, deliberate act.
 *  - The hotkey is registered LAZILY: only while Stream Mode is on or a panic
 *    is already active (so the second press always works). A browser that
 *    permanently owns a global chord would collide with other apps for a key
 *    it needs only while streaming. Corollary: with autoStreamOnRecorder off
 *    AND the stream off, the key is simply not armed; the settings card says
 *    when it is.
 *  - The ACTION is this controller's toggle(), reachable over IPC too: the
 *    hotkey is just one trigger, which is what makes the behaviour testable
 *    (CDP cannot synthesize OS-level global shortcuts).
 *  - Wayland does not deliver global shortcuts to unprivileged apps; the
 *    hotkey silently cannot work there (the IPC path still does).
 */
import { globalShortcut } from 'electron';
import { allWindows } from '../windows';
import { getSettings } from '../storage/settings';
import { getStreamMode } from './StreamModeController';
import { isPanicActive, setPanicActive } from './panicState';

class PanicController {
  private registered: string | null = null;

  init(): void {
    getStreamMode().on('config-changed', () => this.syncRegistration());
    this.syncRegistration();
  }

  isActive(): boolean {
    return isPanicActive();
  }

  toggle(): { active: boolean } {
    if (!isPanicActive()) {
      // Order matters: the flag first (any audio re-application from here on
      // resolves to muted), then the covers, then arming the stream. Arming
      // last keeps the toggle-ON masking work under curtains that are
      // already up.
      setPanicActive(true);
      for (const win of allWindows()) win.tabs.panicCover();
      if (!getStreamMode().isEnabled()) getStreamMode().update({ enabled: true });
    } else {
      setPanicActive(false);
      for (const win of allWindows()) win.tabs.panicUncover();
    }
    this.syncRegistration();
    return { active: isPanicActive() };
  }

  /**
   * Reconcile the global shortcut with the current settings and state.
   * Called on stream toggles, settings writes and panic transitions; cheap
   * and idempotent.
   */
  syncRegistration(): void {
    const settings = getSettings();
    const accelerator = settings.panicKey;
    const wanted =
      settings.panicKeyEnabled && (isPanicActive() || getStreamMode().isEnabled())
        ? accelerator
        : null;
    if (wanted === this.registered) return;

    if (this.registered) {
      try {
        globalShortcut.unregister(this.registered);
      } catch {
        // already gone
      }
      this.registered = null;
    }
    if (wanted) {
      try {
        // register() returns false when another app owns the chord: surfaced
        // as "not registered" rather than thrown, so a collision degrades to
        // the IPC/UI path instead of crashing the boot.
        if (globalShortcut.register(wanted, () => this.toggle())) {
          this.registered = wanted;
        }
      } catch {
        this.registered = null;
      }
    }
  }
}

let instance: PanicController | null = null;

export function getPanic(): PanicController {
  if (!instance) instance = new PanicController();
  return instance;
}
