/**
 * Stream Mode accent color. One user-picked hex drives every violet surface
 * of the chrome UI: the full palette (light + dark themes, hover shade, soft
 * tint, readable text color) is DERIVED from that single hex and applied by
 * overriding the `--stream*` CSS custom properties of globals.css from
 * Chrome.tsx. Pure module (no DOM, no Electron), unit-tested.
 */

export const DEFAULT_STREAM_COLOR = '#8b5cf6';

/** Curated swatches shown on voksa://stream. First entry is the default. */
export const STREAM_COLOR_PRESETS: readonly string[] = [
  DEFAULT_STREAM_COLOR, // violet (default)
  '#3b82f6', // blue
  '#0ea5e9', // sky
  '#14b8a6', // teal
  '#22c55e', // green
  '#f59e0b', // amber
  '#f43f5e', // rose
  '#ec4899', // pink
];

type Rgb = { r: number; g: number; b: number };
type Hsl = { h: number; s: number; l: number };

export type StreamShades = {
  /** Base surface color, as a space-separated RGB triplet ("139 92 246"). */
  stream: string;
  /** Hover / pressed shade (one step darker than the base). */
  active: string;
  /** Soft tint for large muted surfaces. */
  muted: string;
  /** Text color readable on top of `stream` (white or near-black). */
  fg: string;
};

export type StreamPalette = { light: StreamShades; dark: StreamShades };

/**
 * Accepts `#rgb` / `#rrggbb` (any case, surrounding whitespace tolerated) and
 * returns the canonical lowercase `#rrggbb`, or null for anything else. The
 * null path is the safety net for a hand-edited settings.json: an invalid
 * color falls back to the default palette instead of breaking the UI.
 */
export function normalizeStreamColor(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const value = input.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(value)) return value;
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(value);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  return null;
}

function hexToRgb(normalized: string): Rgb {
  return {
    r: parseInt(normalized.slice(1, 3), 16),
    g: parseInt(normalized.slice(3, 5), 16),
    b: parseInt(normalized.slice(5, 7), 16),
  };
}

function rgbToHsl({ r, g, b }: Rgb): Hsl {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return { h: h * 60, s, l };
}

function hslToRgb({ h, s, l }: Hsl): Rgb {
  const hue = (((h % 360) + 360) % 360) / 360;
  if (s === 0) {
    const v = Math.round(l * 255);
    return { r: v, g: v, b: v };
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number): number => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return {
    r: Math.round(channel(hue + 1 / 3) * 255),
    g: Math.round(channel(hue) * 255),
    b: Math.round(channel(hue - 1 / 3) * 255),
  };
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
function relativeLuminance({ r, g, b }: Rgb): number {
  const lin = (v: number): number => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

const triplet = ({ r, g, b }: Rgb): string => `${r} ${g} ${b}`;
const clampL = (l: number): number => Math.min(0.95, Math.max(0.05, l));

const FG_LIGHT = '255 255 255';
const FG_DARK = '17 24 39';

/**
 * Text color for content sitting ON a stream-colored surface. The 0.3
 * threshold is calibrated on the shipped presets: deep hues (violet, blue,
 * rose, pink, luminance 0.20 to 0.25) keep the default white look at 3.5:1+,
 * while the lighter ones (sky, teal, green, amber, 0.33 to 0.44) flip to
 * near-black at 6.4:1 to 8.3:1; white there would sit at an unreadable
 * 2.1:1 to 2.8:1. Pinned by tests.
 */
function fgOn(surface: Rgb): string {
  return relativeLuminance(surface) > 0.3 ? FG_DARK : FG_LIGHT;
}

/**
 * Derives both theme palettes from one hex. The shade offsets mirror the
 * built-in violet ladder (Tailwind 400/500/600 steps plus a 100-level tint
 * and a dark desaturated tint), so any hue lands on the same visual rhythm
 * as the handcrafted default.
 */
export function deriveStreamPalette(color: unknown): StreamPalette | null {
  const normalized = normalizeStreamColor(color);
  if (!normalized) return null;
  const base = hexToRgb(normalized);
  const { h, s, l } = rgbToHsl(base);
  // Visibility floor: a near-black or near-white pick would melt the window
  // ring, the top bar and the shield tint into the theme backgrounds and
  // silence the "live and masked" signal this color exists for. Each theme
  // clamps the base lightness into a band that keeps a perceivable delta
  // from its backgrounds; every shipped preset (l between 0.48 and 0.66)
  // passes through unchanged, and an in-band pick stays byte-verbatim (no
  // HSL round-trip drift).
  const lLight = Math.min(0.8, Math.max(0.16, l));
  const lDark = Math.min(0.9, Math.max(0.45, l + 0.1));
  const lightBase = lLight === l ? base : hslToRgb({ h, s, l: lLight });
  const lightActive = hslToRgb({ h, s, l: clampL(lLight - 0.09) });
  const lightMuted = hslToRgb({ h, s: s * 0.9, l: 0.95 });
  const darkStream = hslToRgb({ h, s, l: lDark });
  const darkMuted = hslToRgb({ h, s: s * 0.35, l: 0.22 });
  return {
    light: {
      stream: triplet(lightBase),
      active: triplet(lightActive),
      muted: triplet(lightMuted),
      fg: fgOn(lightBase),
    },
    dark: {
      stream: triplet(darkStream),
      active: triplet(lightBase),
      muted: triplet(darkMuted),
      fg: fgOn(darkStream),
    },
  };
}

/**
 * CSS overriding the `--stream*` tokens for both themes, or null when the
 * default palette should be kept as-is (default color, or anything invalid).
 * The default bypass is deliberate: the shipped palette in globals.css is
 * hand-tuned (its dark muted shade is not exactly derivable), so the default
 * experience stays byte-for-byte identical to a build without this feature.
 * Injection-safe by construction: every emitted value is rebuilt from parsed
 * integers, never from the raw input string.
 */
export function buildStreamColorCss(color: unknown): string | null {
  const normalized = normalizeStreamColor(color);
  if (!normalized || normalized === DEFAULT_STREAM_COLOR) return null;
  const palette = deriveStreamPalette(normalized);
  if (!palette) return null;
  const block = (selector: string, p: StreamShades): string =>
    [
      `${selector} {`,
      `  --stream: ${p.stream};`,
      `  --stream-active: ${p.active};`,
      `  --stream-muted: ${p.muted};`,
      `  --stream-fg: ${p.fg};`,
      '}',
    ].join('\n');
  return `${block(':root', palette.light)}\n${block(':root.dark', palette.dark)}`;
}
