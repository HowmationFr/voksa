import { maskText, type MaskFlags } from '../../shared/maskPatterns';
import { useStreamStore } from '../stores/streamStore';

let hostname: string | null = null;
void voksaGetHostname();
async function voksaGetHostname(): Promise<void> {
  try {
    const { voksa } = await import('./bridge');
    hostname = await voksa.app.getHostname();
  } catch {
    hostname = null;
  }
}

/**
 * Mask a string for display in the chrome UI (tab titles, address bar,
 * suggestions, internal pages) whenever Stream Mode is ON. Uses the exact same
 * shared patterns as the injected page masker, so what the streamer sees in the
 * chrome matches what viewers see in the page.
 */
export function useMaskedText(text: string | null | undefined): string {
  const config = useStreamStore((s) => s.config);
  if (!text) return text ?? '';
  if (!config.enabled) return text;
  const flags: MaskFlags = {
    maskIPv4: config.maskIPv4,
    maskIPv6: config.maskIPv6,
    maskEmails: config.maskEmails,
    maskPhones: config.maskPhones,
    maskInternalHostnames: config.maskInternalHostnames,
  };
  return maskText(text, flags, hostname, config.customMasks);
}
