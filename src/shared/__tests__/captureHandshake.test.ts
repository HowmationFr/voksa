import { describe, expect, it } from 'vitest';
import {
  sourceKind,
  thumbnailIsSafe,
  windowHandleFromSourceId,
} from '../captureHandshake';

describe('thumbnailIsSafe', () => {
  it('withholds a Voksa surface thumbnail, keeps everything else', () => {
    // A thumbnail predates masking: a Voksa thumbnail can leak a raw email.
    expect(thumbnailIsSafe(true)).toBe(false);
    expect(thumbnailIsSafe(false)).toBe(true);
  });
});

describe('sourceKind', () => {
  it('classifies screen vs window, defaulting unknown to window', () => {
    expect(sourceKind('screen:0:0')).toBe('screen');
    expect(sourceKind('window:12345:0')).toBe('window');
    expect(sourceKind('weird')).toBe('window');
  });
});

describe('windowHandleFromSourceId', () => {
  it('extracts the decimal handle from a window source id', () => {
    expect(windowHandleFromSourceId('window:12345:0')).toBe('12345');
    expect(windowHandleFromSourceId('window:0x3039:1')).toBe('12345');
  });

  it('returns null for a screen id or garbage', () => {
    expect(windowHandleFromSourceId('screen:0:0')).toBeNull();
    expect(windowHandleFromSourceId('window::0')).toBeNull();
    expect(windowHandleFromSourceId('window:0:0')).toBeNull();
    expect(windowHandleFromSourceId('nope')).toBeNull();
  });
});
