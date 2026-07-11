import { describe, it, expect } from 'vitest';
import {
  DEFAULT_STREAM_COLOR,
  STREAM_COLOR_PRESETS,
  buildStreamColorCss,
  deriveStreamPalette,
  normalizeStreamColor,
} from '../streamColor';

const TRIPLET_RE = /^\d{1,3} \d{1,3} \d{1,3}$/;

/** Mean channel value of a "r g b" triplet, for rough light/dark checks. */
function mean(tripletStr: string): number {
  const [r, g, b] = tripletStr.split(' ').map(Number);
  return (r + g + b) / 3;
}

describe('normalizeStreamColor', () => {
  it('passes canonical #rrggbb through unchanged', () => {
    expect(normalizeStreamColor('#8b5cf6')).toBe('#8b5cf6');
  });

  it('lowercases and trims', () => {
    expect(normalizeStreamColor('  #8B5CF6 ')).toBe('#8b5cf6');
  });

  it('expands #rgb shorthand', () => {
    expect(normalizeStreamColor('#0af')).toBe('#00aaff');
  });

  it('rejects everything else', () => {
    for (const bad of [null, undefined, 42, '', 'red', '8b5cf6', '#12345', '#1234567', '#ggg', 'rgb(1,2,3)', 'url(x)']) {
      expect(normalizeStreamColor(bad)).toBeNull();
    }
  });
});

describe('STREAM_COLOR_PRESETS', () => {
  it('starts with the default color', () => {
    expect(STREAM_COLOR_PRESETS[0]).toBe(DEFAULT_STREAM_COLOR);
  });

  it('contains only canonical, unique values', () => {
    for (const hex of STREAM_COLOR_PRESETS) {
      expect(normalizeStreamColor(hex)).toBe(hex);
    }
    expect(new Set(STREAM_COLOR_PRESETS).size).toBe(STREAM_COLOR_PRESETS.length);
  });
});

describe('deriveStreamPalette', () => {
  it('returns null on invalid input', () => {
    expect(deriveStreamPalette('violet')).toBeNull();
    expect(deriveStreamPalette(undefined)).toBeNull();
  });

  it('uses an in-band pick verbatim as the light base and the dark hover', () => {
    const p = deriveStreamPalette('#8b5cf6')!;
    expect(p.light.stream).toBe('139 92 246');
    expect(p.dark.active).toBe('139 92 246');
    // Every shipped preset sits inside the visibility band: byte-verbatim.
    for (const hex of STREAM_COLOR_PRESETS) {
      const [r, g, b] = [hex.slice(1, 3), hex.slice(3, 5), hex.slice(5, 7)].map((c) =>
        parseInt(c, 16),
      );
      expect(deriveStreamPalette(hex)!.light.stream).toBe(`${r} ${g} ${b}`);
    }
  });

  it('clamps extreme picks so the live indicator stays visible on both themes', () => {
    const black = deriveStreamPalette('#000000')!;
    // Not lost against the dark backgrounds (--bg 22 23 27, elevated 31 33 38).
    expect(mean(black.dark.stream)).toBeGreaterThan(100);
    expect(mean(black.light.stream)).toBeGreaterThan(30);
    const white = deriveStreamPalette('#ffffff')!;
    // Not lost against the light backgrounds (--bg-elevated 255 255 255).
    expect(mean(white.light.stream)).toBeLessThan(215);
    expect(mean(white.dark.stream)).toBeLessThan(235);
  });

  it('emits well-formed RGB triplets everywhere', () => {
    const p = deriveStreamPalette('#f43f5e')!;
    for (const shades of [p.light, p.dark]) {
      for (const value of [shades.stream, shades.active, shades.muted, shades.fg]) {
        expect(value).toMatch(TRIPLET_RE);
        for (const channel of value.split(' ').map(Number)) {
          expect(channel).toBeGreaterThanOrEqual(0);
          expect(channel).toBeLessThanOrEqual(255);
        }
      }
    }
  });

  it('keeps the ladder direction: light muted is pale, dark muted is deep, dark base is lighter', () => {
    for (const hex of STREAM_COLOR_PRESETS) {
      const p = deriveStreamPalette(hex)!;
      expect(mean(p.light.muted)).toBeGreaterThan(200);
      expect(mean(p.dark.muted)).toBeLessThan(100);
      expect(mean(p.dark.stream)).toBeGreaterThan(mean(p.light.stream));
      expect(mean(p.light.active)).toBeLessThan(mean(p.light.stream));
    }
  });

  it('flips the on-color text to dark on light picks, keeps white on deep picks', () => {
    expect(deriveStreamPalette('#1d4ed8')!.light.fg).toBe('255 255 255');
    expect(deriveStreamPalette('#facc15')!.light.fg).toBe('17 24 39');
    expect(deriveStreamPalette('#ffffff')!.light.fg).toBe('17 24 39');
    expect(deriveStreamPalette('#000000')!.light.fg).toBe('255 255 255');
  });

  it('pins the shipped presets on the readable side of the fg threshold', () => {
    // Deep hues keep the default white-on-color look (3.5:1 or better)...
    for (const hex of ['#8b5cf6', '#3b82f6', '#f43f5e', '#ec4899']) {
      expect(deriveStreamPalette(hex)!.light.fg, hex).toBe('255 255 255');
    }
    // ...while the lighter ones need dark text (white would sit at 2.1-2.8:1).
    for (const hex of ['#0ea5e9', '#14b8a6', '#22c55e', '#f59e0b']) {
      expect(deriveStreamPalette(hex)!.light.fg, hex).toBe('17 24 39');
    }
  });
});

describe('buildStreamColorCss', () => {
  it('returns null for the default color (hand-tuned palette stays untouched)', () => {
    expect(buildStreamColorCss(DEFAULT_STREAM_COLOR)).toBeNull();
    // Same color through the non-canonical spellings.
    expect(buildStreamColorCss('#8B5CF6')).toBeNull();
    expect(buildStreamColorCss(' #8b5cf6 ')).toBeNull();
  });

  it('returns null for invalid input', () => {
    expect(buildStreamColorCss('')).toBeNull();
    expect(buildStreamColorCss(undefined)).toBeNull();
    expect(buildStreamColorCss('#8b5cf6; } body { display: none')).toBeNull();
  });

  it('overrides all four tokens for both themes', () => {
    const css = buildStreamColorCss('#0ea5e9')!;
    expect(css).toContain(':root {');
    expect(css).toContain(':root.dark {');
    for (const token of ['--stream:', '--stream-active:', '--stream-muted:', '--stream-fg:']) {
      const occurrences = css.split(token).length - 1;
      expect(occurrences, `${token} once per theme block`).toBe(2);
    }
  });

  it('emits nothing but selectors, tokens and integer triplets (injection-proof shape)', () => {
    const css = buildStreamColorCss('#22c55e')!;
    for (const line of css.split('\n')) {
      expect(line).toMatch(/^(:root(\.dark)? \{|\s{2}--stream(-active|-muted|-fg)?: \d{1,3} \d{1,3} \d{1,3};|\})$/);
    }
  });
});
