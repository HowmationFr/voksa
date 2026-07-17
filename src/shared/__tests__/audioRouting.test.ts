import { describe, expect, it } from 'vitest';
import {
  buildAudioRouteApply,
  buildAudioRoutePatch,
  matchOutputByLabel,
  routableOutputs,
  type MediaDeviceLike,
} from '../audioRouting';

const dev = (deviceId: string, label: string, kind = 'audiooutput'): MediaDeviceLike => ({
  deviceId,
  kind,
  label,
});

// A realistic Windows enumeration: synthetic default/communications entries
// duplicating a physical device, inputs mixed in, and one label-less device
// (what Chromium returns when labels are not permission-exposed).
const TYPICAL: MediaDeviceLike[] = [
  dev('default', 'Default - Speakers (Realtek(R) Audio)'),
  dev('communications', 'Communications - Headset (USB Audio)'),
  dev('mic-1', 'Microphone (USB Audio)', 'audioinput'),
  dev('spk-1', 'Speakers (Realtek(R) Audio)'),
  dev('hp-1', 'Headset (USB Audio)'),
  dev('anon-1', ''),
];

describe('routableOutputs', () => {
  it('keeps only labeled physical audiooutput devices', () => {
    expect(routableOutputs(TYPICAL)).toEqual([
      { deviceId: 'spk-1', label: 'Speakers (Realtek(R) Audio)' },
      { deviceId: 'hp-1', label: 'Headset (USB Audio)' },
    ]);
  });

  it('drops the synthetic default/communications entries even though they are audiooutput', () => {
    // Routing to them would silently follow OS default changes: the opposite
    // of an explicit route.
    const labels = routableOutputs(TYPICAL).map((d) => d.label);
    expect(labels.some((l) => l.startsWith('Default -'))).toBe(false);
    expect(labels.some((l) => l.startsWith('Communications -'))).toBe(false);
  });

  it('dedupes identical labels keeping the first: an unreachable row must not render', () => {
    const twins = [dev('a', 'USB Speakers'), dev('b', 'USB Speakers')];
    expect(routableOutputs(twins)).toEqual([{ deviceId: 'a', label: 'USB Speakers' }]);
  });

  it('returns empty on an empty or input-only enumeration', () => {
    expect(routableOutputs([])).toEqual([]);
    expect(routableOutputs([dev('m', 'Mic', 'audioinput')])).toEqual([]);
  });
});

describe('matchOutputByLabel', () => {
  it('resolves a stored label to the frame-local deviceId', () => {
    expect(matchOutputByLabel(TYPICAL, 'Headset (USB Audio)')).toBe('hp-1');
  });

  it('is EXACT: no trimming, no case folding (a fuzzy match could route to the wrong device)', () => {
    expect(matchOutputByLabel(TYPICAL, 'headset (usb audio)')).toBeNull();
    expect(matchOutputByLabel(TYPICAL, ' Headset (USB Audio)')).toBeNull();
  });

  it('returns null for a vanished device (caller must fail visible, never guess)', () => {
    expect(matchOutputByLabel(TYPICAL, 'Bluetooth Buds')).toBeNull();
  });

  it('never resolves through a synthetic entry, even by its decorated label', () => {
    expect(matchOutputByLabel(TYPICAL, 'Default - Speakers (Realtek(R) Audio)')).toBeNull();
  });

  it('first wins on duplicate labels, consistent with the deduped menu', () => {
    const twins = [dev('a', 'USB Speakers'), dev('b', 'USB Speakers')];
    expect(matchOutputByLabel(twins, 'USB Speakers')).toBe('a');
  });
});

describe('main-world patch source', () => {
  it('parses as valid JavaScript (a syntax error would only surface at runtime in a page)', () => {
    // new Function() parses without executing: no browser API is touched.
    expect(() => new Function(buildAudioRoutePatch('__h_test'))).not.toThrow();
    expect(() => new Function(buildAudioRouteApply('__h_test', 'sink-id'))).not.toThrow();
    expect(() => new Function(buildAudioRouteApply('__h_test', null))).not.toThrow();
  });

  it('embeds the handle and sink JSON-escaped (a hostile label cannot break out of the string)', () => {
    const patch = buildAudioRoutePatch('__h"\\`${x}');
    expect(() => new Function(patch)).not.toThrow();
    const apply = buildAudioRouteApply('__h', 'id"with\\quotes');
    expect(() => new Function(apply)).not.toThrow();
    expect(apply).toContain(JSON.stringify('id"with\\quotes'));
  });

  it('apply(null) resets to the system default (empty-string sink), not a literal "null"', () => {
    // The patch routes with (sink || ''): a null sink must reach the elements
    // as setSinkId(''), the platform's "system default".
    expect(buildAudioRouteApply('__h', null)).toContain('f(null)');
    expect(buildAudioRoutePatch('__h')).toContain("setSinkId(sink || '')");
  });

  it('play wrap remembers UNCONDITIONALLY, before the sink-null guard', () => {
    // Regression pin (review finding): an element that plays while the sink
    // is still null (document-start scripts racing the async enumeration)
    // must be remembered anyway, or it plays on the system default forever
    // while the tab claims routed. The remember call must sit OUTSIDE the
    // `if (sink != null)` guard.
    expect(buildAudioRoutePatch('__h')).toMatch(
      /function play\(\) \{[\s\S]*?remember\(elRefs, this\);[\s\S]*?if \(sink != null\) routeEl\(this\);/,
    );
  });

  it('wraps the Audio constructor (detached autoplay never crosses play())', () => {
    // `new Audio(src); el.autoplay = true` starts playback through Blink's
    // internal steps: only a constructor wrap can remember such elements.
    expect(buildAudioRoutePatch('__h')).toMatch(/window\.Audio = new Proxy/);
  });
});
