import { describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import { installWebRtcPolicy } from '../webrtcPolicy';
import { DEFAULT_STREAM_CONFIG, type StreamModeConfig } from '../../../shared/streamConfig';

type FakeContents = {
  wc: WebContents;
  set: ReturnType<typeof vi.fn>;
  destroy: () => void;
};

function fakeContents(): FakeContents {
  let destroyed = false;
  const set = vi.fn();
  const wc = {
    isDestroyed: () => destroyed,
    setWebRTCIPHandlingPolicy: set,
  } as unknown as WebContents;
  return { wc, set, destroy: () => (destroyed = true) };
}

function setup(initial: Partial<StreamModeConfig> = {}) {
  let config: StreamModeConfig = { ...DEFAULT_STREAM_CONFIG, ...initial };
  let onCreated: ((wc: WebContents) => void) | null = null;
  let onChanged: ((cfg: StreamModeConfig) => void) | null = null;
  const live: FakeContents[] = [];
  installWebRtcPolicy({
    getStreamConfig: () => config,
    onConfigChanged: (cb) => (onChanged = cb),
    onContentsCreated: (cb) => (onCreated = cb),
    allContents: () => live.map((c) => c.wc),
  });
  return {
    /** A webContents is born (tab, popup, extension host...). */
    create(): FakeContents {
      const c = fakeContents();
      live.push(c);
      onCreated?.(c.wc);
      return c;
    },
    /** The controller emits 'config-changed'. */
    update(patch: Partial<StreamModeConfig>): void {
      config = { ...config, ...patch };
      onChanged?.(config);
    },
  };
}

describe('installWebRtcPolicy', () => {
  it('stamps every new webContents with the current policy at creation', () => {
    const off = setup();
    expect(off.create().set).toHaveBeenCalledWith('default');

    // Stream Mode already on (boot with it armed, or a popup opened while
    // live): the webContents is protected before its first navigation.
    const on = setup({ enabled: true });
    expect(on.create().set).toHaveBeenCalledWith('default_public_interface_only');
  });

  it('re-applies the policy live to every webContents when Stream Mode toggles', () => {
    const s = setup();
    const tab = s.create();
    const popup = s.create();
    tab.set.mockClear();
    popup.set.mockClear();

    s.update({ enabled: true });
    expect(tab.set).toHaveBeenCalledWith('default_public_interface_only');
    expect(popup.set).toHaveBeenCalledWith('default_public_interface_only');

    s.update({ enabled: false });
    expect(tab.set).toHaveBeenLastCalledWith('default');
    expect(popup.set).toHaveBeenLastCalledWith('default');
  });

  it('follows the strict opt-in while live, and new webContents pick it up', () => {
    const s = setup({ enabled: true });
    const tab = s.create();
    s.update({ strictWebRTC: true });
    expect(tab.set).toHaveBeenLastCalledWith('disable_non_proxied_udp');
    expect(s.create().set).toHaveBeenCalledWith('disable_non_proxied_udp');
  });

  it('does not touch any webContents when the policy is unchanged', () => {
    const s = setup({ enabled: true });
    const tab = s.create();
    tab.set.mockClear();
    // Cosmetic (color picker drag) and mask-only changes.
    s.update({ color: '#22c55e' });
    s.update({ maskEmails: false });
    expect(tab.set).not.toHaveBeenCalled();
  });

  it('skips destroyed webContents and survives one that throws', () => {
    const s = setup();
    const dead = s.create();
    const broken = s.create();
    const healthy = s.create();
    dead.destroy();
    dead.set.mockClear();
    broken.set.mockImplementation(() => {
      throw new Error('Object has been destroyed');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    s.update({ enabled: true });
    expect(dead.set).not.toHaveBeenCalled();
    expect(healthy.set).toHaveBeenLastCalledWith('default_public_interface_only');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
