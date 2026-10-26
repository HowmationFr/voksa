import { DEFAULT_STREAM_COLOR } from './streamColor';

export type StreamModeConfig = {
  enabled: boolean;
  maskIPv4: boolean;
  maskIPv6: boolean;
  maskEmails: boolean;
  maskPhones: boolean;
  maskMacAddresses: boolean;
  maskInputValues: boolean;
  /**
   * While streaming, WebRTC only gathers on the default route and never
   * exposes a local/private address (LAN, split-tunnel VPN, secondary NICs).
   * Calls and screen sharing keep working. See webRtcPolicyFor.
   */
  blockWebRTC: boolean;
  /**
   * Opt-in: while streaming, WebRTC may not use UDP outside a proxy (no STUN,
   * no direct UDP media). Hides the public address from page scripts too, but
   * without a proxy calls fall back to TURN over TCP at best, and often fail.
   * Wins over blockWebRTC when both are set (fail closed).
   */
  strictWebRTC: boolean;
  denyGeolocation: boolean;
  denyCamera: boolean;
  denyMicrophone: boolean;
  maskInternalHostnames: boolean;
  hideLinkPreview: boolean;
  /**
   * While streaming, keep browsing habits off-screen: address-bar suggestions
   * stop searching the history and the new-tab page hides "top sites".
   * Recording of history is NOT affected, only its display surfaces.
   */
  hideHistory: boolean;
  /**
   * Auto-enable Stream Mode when a known recording/streaming app (OBS,
   * Streamlabs, XSplit…) is running or launches. Rising-edge only: turning
   * Stream Mode off manually while the recorder keeps running is respected.
   */
  autoStreamOnRecorder: boolean;
  /**
   * User-defined substrings (case-insensitive) that should be masked out of
   * the DOM in addition to the built-in patterns. Useful for hiding a
   * project name, a client name, an internal service URL, etc.
   */
  customMasks: string[];
  /**
   * Accent color of every Stream Mode surface in the chrome UI (window ring,
   * toolbar shield, badges): hex `#rrggbb`, the light and dark palettes are
   * derived from it (see streamColor.ts). Purely cosmetic: it never changes
   * what gets masked, and changing it must never re-gate iframes or re-sweep
   * pages (see sameMaskingConfig below).
   */
  color: string;
};

/**
 * Config fields the masking pipeline never reads. Kept as a deny-list so a
 * FUTURE field is treated as mask-relevant by default (fail-closed): frames
 * get re-pushed and coverage re-checked unless someone deliberately lists the
 * field here.
 */
const COSMETIC_KEYS: ReadonlySet<string> = new Set(['color']);

/**
 * True when both configs agree on everything the masking pipeline reads
 * (page maskers, frame guard, permissions, curtains). Used to skip the
 * frame-config push and the frame-guard coverage invalidation on cosmetic
 * changes: without it, dragging the color picker while live would hide every
 * iframe for a beat on each step.
 */
export function sameMaskingConfig(a: StreamModeConfig, b: StreamModeConfig): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (COSMETIC_KEYS.has(key)) continue;
    const va = (a as Record<string, unknown>)[key];
    const vb = (b as Record<string, unknown>)[key];
    if (Array.isArray(va) && Array.isArray(vb)) {
      if (va.length !== vb.length || va.some((v, i) => v !== vb[i])) return false;
    } else if (va !== vb) {
      return false;
    }
  }
  return true;
}

export const DEFAULT_STREAM_CONFIG: StreamModeConfig = {
  enabled: false,
  maskIPv4: true,
  maskIPv6: true,
  maskEmails: true,
  maskPhones: true,
  maskMacAddresses: true,
  maskInputValues: true,
  blockWebRTC: true,
  strictWebRTC: false,
  denyGeolocation: true,
  denyCamera: true,
  denyMicrophone: true,
  maskInternalHostnames: false,
  hideLinkPreview: true,
  hideHistory: true,
  autoStreamOnRecorder: true,
  customMasks: [],
  color: DEFAULT_STREAM_COLOR,
};

/**
 * The Chromium WebRTC IP handling policies Stream Mode uses (values of
 * webContents.setWebRTCIPHandlingPolicy). The policy lives in each
 * webContents' renderer prefs and applies to every RTCPeerConnection created
 * AFTER it is set: a call already connected keeps the candidates it gathered.
 */
export type WebRtcIpPolicy = 'default' | 'default_public_interface_only' | 'disable_non_proxied_udp';

/**
 * The policy every webContents must carry for this config:
 *  - Stream Mode off, or both WebRTC toggles off: Chromium's default
 *    (all interfaces; host addresses mDNS-obfuscated until a media grant);
 *  - blockWebRTC: `default_public_interface_only`, the default route only and
 *    no host candidate at all, so no local/private address ever reaches the
 *    page while STUN/TURN keep calls (Meet, Discord, Zoom web) working;
 *  - strictWebRTC: `disable_non_proxied_udp`, no UDP outside a proxy. Wins
 *    over blockWebRTC: the user explicitly asked for the stricter one.
 */
export function webRtcPolicyFor(config: StreamModeConfig): WebRtcIpPolicy {
  if (!config.enabled) return 'default';
  if (config.strictWebRTC) return 'disable_non_proxied_udp';
  if (config.blockWebRTC) return 'default_public_interface_only';
  return 'default';
}

export type StreamToggleKey = Exclude<keyof StreamModeConfig, 'enabled'>;

export const STREAM_TOGGLES: Array<{
  key: StreamToggleKey;
  label: string;
  description: string;
}> = [
  {
    key: 'maskIPv4',
    label: 'Masquer les IPv4 publiques',
    description: 'Remplace toute IPv4 non locale par xxx.xxx.xxx.xxx dans le DOM.',
  },
  {
    key: 'maskIPv6',
    label: 'Masquer les IPv6 publiques',
    description: 'Remplace toute IPv6 non locale par xxxx:xxxx:…',
  },
  {
    key: 'maskEmails',
    label: 'Masquer les adresses email',
    description: 'Toute adresse email visible est remplacée par xxx@xxx.xxx.',
  },
  {
    key: 'maskPhones',
    label: 'Masquer les numéros de téléphone',
    description: 'Les numéros de téléphone au format courant sont masqués.',
  },
  {
    key: 'maskMacAddresses',
    label: 'Masquer les adresses MAC',
    description: 'Remplace toute adresse MAC par xx:xx:xx:xx:xx:xx dans le DOM.',
  },
  {
    key: 'maskInputValues',
    label: 'Masquer le contenu des champs',
    description:
      'Redacte visuellement (•) les champs de formulaire contenant une donnée sensible, sans altérer la valeur envoyée.',
  },
  {
    key: 'blockWebRTC',
    label: 'Masquer l’IP locale (WebRTC)',
    description:
      'Les sites ne voient plus vos adresses locales (réseau, VPN) via WebRTC. Les appels et le partage d’écran continuent de fonctionner.',
  },
  {
    key: 'strictWebRTC',
    label: 'WebRTC strict',
    description:
      'Coupe l’UDP direct de WebRTC (hors proxy). Les appels et le partage d’écran peuvent échouer. Désactivé par défaut.',
  },
  {
    key: 'denyGeolocation',
    label: 'Refuser la géolocalisation',
    description: 'Toute demande de géolocalisation est refusée sans popup.',
  },
  {
    key: 'denyCamera',
    label: 'Refuser la caméra',
    description: 'Toute demande d’accès à la caméra est refusée sans popup.',
  },
  {
    key: 'denyMicrophone',
    label: 'Refuser le microphone',
    description: 'Toute demande d’accès au micro est refusée sans popup.',
  },
  {
    key: 'hideLinkPreview',
    label: 'Masquer la prévisualisation d’URL au survol',
    description: 'Supprime l’aperçu de destination des liens survolés.',
  },
  {
    key: 'maskInternalHostnames',
    label: 'Masquer les noms d’hôte internes',
    description:
      'Masque également *.local, *.lan et le nom de machine. Désactivé par défaut.',
  },
];
