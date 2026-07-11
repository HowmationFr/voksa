import { describe, it, expect } from 'vitest';
import { DEFAULT_STREAM_CONFIG, sameMaskingConfig, type StreamModeConfig } from '../streamConfig';

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

  it('fails closed on unknown future fields', () => {
    // A field added to StreamModeConfig but not to the cosmetic deny-list
    // must count as mask-relevant: frames get re-pushed, coverage re-checked.
    const withExtra = { ...base(), futureFlag: true } as unknown as StreamModeConfig;
    expect(sameMaskingConfig(base(), withExtra)).toBe(false);
    expect(sameMaskingConfig(withExtra, base())).toBe(false);
  });
});
