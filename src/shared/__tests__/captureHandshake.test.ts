import { describe, expect, it, vi } from 'vitest';
import {
  grantAndClassify,
  sourceKind,
  thumbnailIsSafe,
  ticketMatches,
  windowHandleFromSourceId,
  type CaptureTicket,
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

describe('ticketMatches', () => {
  const ticket = (over: Partial<CaptureTicket> = {}): CaptureTicket => ({
    requesterId: 7,
    securityOrigin: 'https://meet.example/',
    sourceId: 'window:42:0',
    name: 'Meet',
    consumed: false,
    ...over,
  });

  it('takes only an unconsumed ticket of the same requester and origin', () => {
    expect(ticketMatches(ticket(), 7, 'https://meet.example/')).toBe(true);
    // The raw strings Electron repeats on both sides, opaque ones included.
    expect(ticketMatches(ticket({ securityOrigin: 'file:///' }), 7, 'file:///')).toBe(true);
  });

  it('refuses another requester, another origin, a consumed or missing ticket', () => {
    expect(ticketMatches(ticket(), 8, 'https://meet.example/')).toBe(false);
    expect(ticketMatches(ticket(), null, 'https://meet.example/')).toBe(false);
    expect(ticketMatches(ticket(), 7, 'https://evil.example/')).toBe(false);
    expect(ticketMatches(ticket({ consumed: true }), 7, 'https://meet.example/')).toBe(false);
    expect(ticketMatches(undefined, 7, 'https://meet.example/')).toBe(false);
  });

  it('fails closed on an empty origin on either side', () => {
    expect(ticketMatches(ticket({ securityOrigin: '' }), 7, '')).toBe(false);
    expect(ticketMatches(ticket(), 7, undefined)).toBe(false);
  });
});

describe('grantAndClassify', () => {
  it('grants, then reports getDisplayMedia when the display handler ran inside the grant', () => {
    let ran = false;
    const grant = vi.fn(() => {
      ran = true; // Electron calls the display-media handler synchronously here
    });
    expect(grantAndClassify(grant, () => ran)).toBe('display-media');
    expect(grant).toHaveBeenCalledWith(true);
  });

  it('reports the legacy getUserMedia path when nothing ran during the grant', () => {
    const grant = vi.fn();
    expect(grantAndClassify(grant, () => false)).toBe('legacy-getusermedia');
    expect(grant).toHaveBeenCalledOnce();
  });
});
