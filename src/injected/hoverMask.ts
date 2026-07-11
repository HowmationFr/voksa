import { maskText, type MaskFlags } from '../shared/maskPatterns';
import type { StreamModeConfig } from '../shared/streamConfig';
import type { MaskerHost } from './streamMask';

declare global {
  interface Window {
    __voksaHoverInstalled?: boolean;
  }
}

/**
 * Masks the URL shown by Chromium's native hover status bubble. The native
 * tooltip reads `a.href` before any JS mouseover listener fires, so we rewrite
 * every `<a href>` to a MASKED href up front (stashing the real one), and
 * intercept clicks to navigate to the real URL. This eliminates the
 * status-bubble leak entirely.
 */
const DATA_REAL = 'voksaHref';
const MASKED_ATTR = 'data-voksa-masked';

export function installHoverMasker(host: MaskerHost): void {
  if (window.__voksaHoverInstalled) return;
  window.__voksaHoverInstalled = true;

  let config: StreamModeConfig | null = host.getConfig();
  let pendingSweep = false;

  function flags(): MaskFlags {
    const c = config;
    return {
      maskIPv4: !!c?.maskIPv4,
      maskIPv6: !!c?.maskIPv6,
      maskEmails: !!c?.maskEmails,
      maskPhones: !!c?.maskPhones,
      maskInternalHostnames: !!c?.maskInternalHostnames,
    };
  }

  function maskUrl(url: string): string {
    if (!config) return url;
    return maskText(url, flags(), host.getHostname(), config.customMasks);
  }

  function shouldMask(): boolean {
    return !!(config?.enabled && config.hideLinkPreview);
  }

  function needsMasking(rawHref: string): boolean {
    if (!rawHref) return false;
    if (rawHref.startsWith('javascript:')) return false;
    if (rawHref.startsWith('#')) return false;
    return maskUrl(rawHref) !== rawHref;
  }

  function maskAnchor(a: HTMLAnchorElement): void {
    const real = a.href;
    if (!real) return;
    if (a.dataset[DATA_REAL] === real) return;
    if (!needsMasking(real)) {
      if (!a.dataset[DATA_REAL]) a.dataset[DATA_REAL] = real;
      return;
    }
    a.dataset[DATA_REAL] = real;
    a.setAttribute(MASKED_ATTR, '1');
    try {
      a.setAttribute('href', maskUrl(real));
    } catch {
      // ignore
    }
  }

  function restoreAnchor(a: HTMLAnchorElement): void {
    const real = a.dataset[DATA_REAL];
    if (real != null) {
      try {
        a.setAttribute('href', real);
      } catch {
        // ignore
      }
      delete a.dataset[DATA_REAL];
      a.removeAttribute(MASKED_ATTR);
    }
  }

  function sweepAll(): void {
    const enabled = shouldMask();
    const links = document.querySelectorAll('a[href]');
    for (let i = 0; i < links.length; i++) {
      const a = links[i] as HTMLAnchorElement;
      if (enabled) maskAnchor(a);
      else restoreAnchor(a);
    }
  }

  const mo = new MutationObserver((mutations) => {
    if (!shouldMask()) return;
    if (pendingSweep) return;
    pendingSweep = true;
    requestAnimationFrame(() => {
      pendingSweep = false;
      for (const m of mutations) {
        if (m.type === 'attributes' && m.attributeName === 'href') {
          const a = m.target as HTMLAnchorElement;
          if (a.hasAttribute(MASKED_ATTR) && a.getAttribute('href') !== a.dataset[DATA_REAL]) {
            delete a.dataset[DATA_REAL];
            maskAnchor(a);
          } else if (!a.hasAttribute(MASKED_ATTR)) {
            maskAnchor(a);
          }
        } else if (m.type === 'childList') {
          for (let i = 0; i < m.addedNodes.length; i++) {
            const n = m.addedNodes[i];
            if (n.nodeType !== Node.ELEMENT_NODE) continue;
            const root = n as Element;
            if (root.tagName === 'A') maskAnchor(root as HTMLAnchorElement);
            const inner = root.querySelectorAll?.('a[href]');
            if (inner) {
              for (let j = 0; j < inner.length; j++) {
                maskAnchor(inner[j] as HTMLAnchorElement);
              }
            }
          }
        }
      }
    });
  });

  function onClickCapture(e: MouseEvent): void {
    if (!shouldMask()) return;
    const a = (e.target as HTMLElement | null)?.closest?.('a') as HTMLAnchorElement | null;
    if (!a) return;
    if (!a.hasAttribute(MASKED_ATTR)) return;
    const real = a.dataset[DATA_REAL];
    if (!real) return;
    // Preserve middle-click / ctrl-click "open in new tab": briefly restore
    // the real href, let the browser handle it, re-mask next frame.
    const synthetic = e.button === 1 || e.metaKey || e.ctrlKey || e.shiftKey;
    if (synthetic) {
      a.setAttribute('href', real);
      requestAnimationFrame(() => maskAnchor(a));
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    window.location.href = real;
  }

  function boot(): void {
    sweepAll();
    mo.observe(document, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['href'],
    });
    document.addEventListener('click', onClickCapture, true);
    document.addEventListener('auxclick', onClickCapture, true);
  }

  host.subscribe((c) => {
    const prev = config;
    config = c;
    const wasMasking = !!(prev?.enabled && prev.hideLinkPreview);
    if (wasMasking !== shouldMask()) sweepAll();
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
}
