/**
 * Single source of truth for Stream Mode masking patterns.
 *
 * Consumed by three worlds : the injected page masker (browser), the main
 * process (window title / hover URL masking), and the React chrome UI (tab
 * titles, address bar, suggestions, internal pages). It is a pure module
 * with no runtime dependencies so every world can import it directly.
 *
 * All regexes carry the global flag. `String.prototype.replace` with a `/g`
 * literal is stateless between calls (a fresh `lastIndex` walk each time), so
 * sharing one compiled instance across callers is safe. Do NOT call `.test()`
 * or `.exec()` on these without resetting `lastIndex`; use `replace`/`match`.
 */

export const MASK = {
  IPV4: 'xxx.xxx.xxx.xxx',
  IPV6: 'xxxx:xxxx:xxxx:xxxx',
  EMAIL: 'xxx@xxx.xxx',
  PHONE: '·· ·· ·· ·· ··',
  HOSTNAME: 'xxxxxx',
} as const;

/** IPv4 dotted-quad with word boundaries. */
export const IPV4_RE =
  /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\b/g;

/**
 * IPv6 : full, compressed (`::`), zone-id (`%eth0`) and IPv4-mapped
 * (`::ffff:1.2.3.4`) forms. Broad on purpose: Stream Mode prioritises zero
 * leaks over precision, and `isPrivateIPv6` filters the local forms back out.
 */
// Order matters: in a global `replace`, alternation takes the FIRST matching
// branch at each position (not the longest). Branches that capture a trailing
// hex group must precede the trailing-`::` branch, otherwise
// "2001:db8:db8::8888" matches "2001:db8:db8::" and leaves "8888" unmasked.
export const IPV6_RE = new RegExp(
  [
    '(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}', // full 1:2:3:4:5:6:7:8
    '::(?:ffff(?::0{1,4})?:)?(?:(?:25[0-5]|2[0-4]\\d|[01]?\\d?\\d)\\.){3}(?:25[0-5]|2[0-4]\\d|[01]?\\d?\\d)', // ipv4-mapped ::ffff:1.2.3.4
    '(?:[0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}',
    '(?:[0-9a-fA-F]{1,4}:){1,5}(?::[0-9a-fA-F]{1,4}){1,2}',
    '(?:[0-9a-fA-F]{1,4}:){1,4}(?::[0-9a-fA-F]{1,4}){1,3}',
    '(?:[0-9a-fA-F]{1,4}:){1,3}(?::[0-9a-fA-F]{1,4}){1,4}',
    '(?:[0-9a-fA-F]{1,4}:){1,2}(?::[0-9a-fA-F]{1,4}){1,5}',
    '[0-9a-fA-F]{1,4}:(?::[0-9a-fA-F]{1,4}){1,6}',
    '(?:[0-9a-fA-F]{1,4}:){1,7}:', // trailing 2001:db8::
    'fe80:(?::[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]+', // zone id
    ':(?:(?::[0-9a-fA-F]{1,4}){1,7}|:)', // leading ::8 / ::
  ].join('|'),
  'g',
);

export const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

/**
 * Phone-number candidate. Deliberately conservative to avoid the old
 * `PHONE_RE`'s catastrophic over-matching (it bulleted out dates, prices,
 * order numbers and versions). A candidate must look phone-shaped:
 *   - an international prefix (`+33`, `0033`, `(+1)`) OR a national leading 0,
 *   - followed by 6-14 more digits grouped with spaces / dots / dashes /
 *     parentheses.
 * The final accept/reject is done by `isLikelyPhone` (digit count + separator
 * + date/price guards), because a single regex cannot both stay readable and
 * exclude every ISO date or currency amount.
 */
export const PHONE_RE =
  /(?<![\w./@-])(?:\(?\+\d{1,3}\)?|00\d{1,3}|0)[\s./-]?(?:\(?\d{1,4}\)?[\s.-]?){2,6}\d(?![\w.])/g;

export function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    return true;
  }
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 255 && b === 255) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a >= 224) return true;
  return false;
}

export function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase().split('%')[0];
  if (lower === '::' || lower === '::1') return true;
  if (lower.startsWith('fe80')) return true;
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
  if (lower.startsWith('ff')) return true;
  if (lower.startsWith('::ffff:')) {
    const v4 = lower.slice('::ffff:'.length);
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v4)) return isPrivateIPv4(v4);
  }
  return false;
}

/**
 * Reject phone false-positives: dates (contain `/`), too-few / too-many
 * digits, or a bare digit run with no phone-like separator and no `+` prefix
 * (that is almost always an ID / quantity, not a phone number).
 */
export function isLikelyPhone(raw: string): boolean {
  const trimmed = raw.trim();
  if (trimmed.includes('/')) return false; // slash dates (01/15/2024)
  // ISO / DMY dates with a 4-digit year component are not phone numbers.
  if (/^\d{4}[-.]\d{1,2}[-.]\d{1,2}$/.test(trimmed)) return false;
  if (/^\d{1,2}[-.]\d{1,2}[-.]\d{4}$/.test(trimmed)) return false;
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) return false;
  const hasPlus = trimmed.startsWith('+') || trimmed.startsWith('(+');
  const hasSep = /[\s.()-]/.test(trimmed);
  // A run of digits with no separator and no international prefix is an ID.
  if (!hasSep && !hasPlus) return false;
  return true;
}

export type MaskFlags = {
  maskIPv4: boolean;
  maskIPv6: boolean;
  maskEmails: boolean;
  maskPhones: boolean;
  maskInternalHostnames: boolean;
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Mask a single string. Stateless and identical across all three worlds. The
 * caller supplies which categories are active, the local machine hostname
 * (for internal-hostname masking) and the user's custom substrings.
 */
export function maskText(
  input: string,
  flags: MaskFlags,
  hostname: string | null,
  customMasks: readonly string[] = [],
): string {
  if (!input) return input;
  let out = input;

  if (flags.maskIPv4) {
    out = out.replace(IPV4_RE, (m) => (isPrivateIPv4(m) ? m : MASK.IPV4));
  }
  if (flags.maskIPv6) {
    out = out.replace(IPV6_RE, (m) => (isPrivateIPv6(m) ? m : MASK.IPV6));
  }
  if (flags.maskEmails) {
    out = out.replace(EMAIL_RE, MASK.EMAIL);
  }
  if (flags.maskPhones) {
    out = out.replace(PHONE_RE, (m) => (isLikelyPhone(m) ? MASK.PHONE : m));
  }
  if (flags.maskInternalHostnames) {
    out = out.replace(/\b[a-z0-9][a-z0-9-]{0,62}\.(local|lan)\b/gi, `${MASK.HOSTNAME}.$1`);
    if (hostname) {
      const safe = escapeRegExp(hostname);
      out = out.replace(new RegExp(`\\b${safe}\\b`, 'gi'), MASK.HOSTNAME);
    }
  }

  const customList = customMasks.map((s) => s.trim()).filter((s) => s.length >= 2);
  if (customList.length > 0) {
    const alt = customList.map(escapeRegExp).join('|');
    out = out.replace(new RegExp(alt, 'gi'), (m) => '•'.repeat(Math.max(3, m.length)));
  }

  return out;
}

/** True if any masking category (or custom masks) would change output. */
export function hasAnyMask(flags: MaskFlags, customMasks: readonly string[] = []): boolean {
  return (
    flags.maskIPv4 ||
    flags.maskIPv6 ||
    flags.maskEmails ||
    flags.maskPhones ||
    flags.maskInternalHostnames ||
    customMasks.some((s) => s.trim().length >= 2)
  );
}
