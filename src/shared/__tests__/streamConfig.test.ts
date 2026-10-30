import { describe, it, expect } from 'vitest';
import {
  DEFAULT_STREAM_CONFIG,
  sameMaskingConfig,
  webRtcPolicyFor,
  type StreamModeConfig,
} from '../streamConfig';

const base = (): StreamModeConfig => ({ ...DEFAULT_STREAM_CONFIG, customMasks: ['acme'] });

describe('sameMaskingConfig', () => {
  it('is true for identical configs', () => {
    expect(sameMaskingConfig(base(), base())).toBe(true);
  });

  it('ignores the cosmetic color field', () => {
    expect(sameMaskingConfig(base(), { ...base(), color: '#22c55e' })).toBe(true);
  });

  it('sees any mask flag change', () => {
    expect(sameMaskingConfig(base(), { ...base(), maskEmails: false })).toBe(false);
    expect(sameMaskingConfig(base(), { ...base(), enabled: true })).toBe(false);
  });

  it('sees customMasks edits (add, remove, reorder, rewrite)', () => {
    expect(sameMaskingConfig(base(), { ...base(), customMasks: ['acme', 'x'] })).toBe(false);
    expect(sameMaskingConfig(base(), { ...base(), customMasks: [] })).toBe(false);
    expect(sameMaskingConfig(base(), { ...base(), customMasks: ['ACME'] })).toBe(false);
  });

  it('compares customReplacements by value', () => {
    const pairs = () => [{ from: 'acme', to: 'corp' }];
    const a = { ...base(), customReplacements: pairs() };
    // A fresh array of fresh objects (every settings load) is the same config.
    expect(sameMaskingConfig(a, { ...base(), customReplacements: pairs() })).toBe(true);
    expect(sameMaskingConfig(a, { ...a, color: '#00ff00' })).toBe(true);
    expect(
      sameMaskingConfig(a, { ...base(), customReplacements: [{ from: 'acme', to: 'other' }] }),
    ).toBe(false);
    expect(sameMaskingConfig(a, base())).toBe(false);
  });

  it('fails closed on unknown future fields', () => {
    // A field added to StreamModeConfig but not to the cosmetic deny-list
    // must count as mask-relevant: frames get re-pushed, coverage re-checked.
    const withExtra = { ...base(), futureFlag: true } as unknown as StreamModeConfig;
    expect(sameMaskingConfig(base(), withExtra)).toBe(false);
    expect(sameMaskingConfig(withExtra, base())).toBe(false);
  });
});

describe('webRtcPolicyFor', () => {
  const on = (patch: Partial<StreamModeConfig> = {}): StreamModeConfig => ({
    ...DEFAULT_STREAM_CONFIG,
    enabled: true,
    ...patch,
  });

  it('leaves Chromium defaults alone while Stream Mode is off, whatever the toggles', () => {
    expect(webRtcPolicyFor(DEFAULT_STREAM_CONFIG)).toBe('default');
    expect(
      webRtcPolicyFor({ ...DEFAULT_STREAM_CONFIG, blockWebRTC: true, strictWebRTC: true }),
    ).toBe('default');
  });

  it('hides local addresses but keeps calls working by default under Stream Mode', () => {
    // The default config must never pick the strict policy: it kills UDP
    // media without a proxy, i.e. screen sharing in Meet while streaming.
    expect(DEFAULT_STREAM_CONFIG.blockWebRTC).toBe(true);
    expect(DEFAULT_STREAM_CONFIG.strictWebRTC).toBe(false);
    expect(webRtcPolicyFor(on())).toBe('default_public_interface_only');
  });

  it('applies the strict policy only when opted in, and lets it win (fail closed)', () => {
    expect(webRtcPolicyFor(on({ strictWebRTC: true }))).toBe('disable_non_proxied_udp');
    expect(webRtcPolicyFor(on({ blockWebRTC: false, strictWebRTC: true }))).toBe(
      'disable_non_proxied_udp',
    );
  });

  it('falls back to the default policy when both WebRTC toggles are off', () => {
    expect(webRtcPolicyFor(on({ blockWebRTC: false }))).toBe('default');
  });
});
