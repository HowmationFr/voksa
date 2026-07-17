import { describe, expect, it } from 'vitest';
import { audioGuardVerdict, type AudioTabSnapshot } from '../audioGuard';

function tab(over: Partial<AudioTabSnapshot> = {}): AudioTabSnapshot {
  return {
    isActive: false,
    isAudible: false,
    isMuted: false,
    streamMuted: false,
    allowed: false,
    ...over,
  };
}

describe('audioGuardVerdict: who gets muted under Stream Mode', () => {
  it('mutes a background tab the moment it becomes audible', () => {
    expect(audioGuardVerdict(true, tab({ isAudible: true }))).toBe('mute');
  });

  it('never auto-mutes the active tab: it is the content being shown', () => {
    expect(audioGuardVerdict(true, tab({ isActive: true, isAudible: true }))).toBe('keep');
  });

  it('does not lift a guard-mute on activation: the chip is the only exit', () => {
    // Clicking a tab is navigation, not consent. Without this, switching to a
    // muted music tab would blast copyrighted audio into the stream.
    expect(audioGuardVerdict(true, tab({ isActive: true, streamMuted: true, isAudible: true }))).toBe(
      'keep',
    );
  });

  it('respects an explicit allow, and un-mutes when it arrives', () => {
    expect(audioGuardVerdict(true, tab({ allowed: true, isAudible: true }))).toBe('keep');
    expect(audioGuardVerdict(true, tab({ allowed: true, streamMuted: true }))).toBe('unmute');
  });

  it('never stacks on the user own mute (stream off must restore it exactly)', () => {
    expect(audioGuardVerdict(true, tab({ isMuted: true, isAudible: true }))).toBe('keep');
  });

  it('lifts every guard-mute when Stream Mode turns off, and only those', () => {
    expect(audioGuardVerdict(false, tab({ streamMuted: true }))).toBe('unmute');
    // A user-muted tab stays user-muted: the guard flag is the only thing
    // that toggles with the stream.
    expect(audioGuardVerdict(false, tab({ isMuted: true }))).toBe('keep');
    expect(audioGuardVerdict(false, tab({ isAudible: true }))).toBe('keep');
  });

  it('does nothing to silent background tabs', () => {
    expect(audioGuardVerdict(true, tab())).toBe('keep');
  });
});
