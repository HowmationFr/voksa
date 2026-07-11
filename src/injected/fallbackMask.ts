import { hasAnyMask, maskText, type MaskFlags } from '../shared/maskPatterns';
import type { StreamModeConfig } from '../shared/streamConfig';

/**
 * Fallback Stream Mode masker: the rescue path for frames Electron never
 * injects our preload into.
 *
 * WHY THIS EXISTS. electron/electron#34727 (upstream, closed as NOT PLANNED):
 * when a page script reads an iframe's `contentWindow` / `contentDocument`
 * BEFORE that frame has committed its document, Electron silently skips preload
 * injection into it, for the rest of that frame's life. Such a frame therefore
 * runs with NEITHER the L0 shroud (preload/page.ts) NOR the L1 masker
 * (injected/streamMask.ts), and under Stream Mode it would paint raw emails /
 * IPs / phone numbers. Ad, analytics and widget libraries do exactly this.
 * Neither `sandbox: false` nor `session.registerPreloadScript({type:'frame'})`
 * fixes it: there is no Electron-config way out.
 *
 * HOW IT GETS HERE. main/stream-mode/frameGuard.ts detects such a frame (it
 * committed a document but never announced itself over STREAM_FRAME_ALIVE) and
 * injects this bundle with `WebFrameMain.executeJavaScript`, which runs in the
 * frame's MAIN world: with no preload there is no isolated world to run in, and
 * no `ipcRenderer` either, so the configuration arrives as a JSON payload
 * interpolated into the injected source and every later update is a re-injection.
 *
 * MAIN-WORLD FOOTPRINT. Exactly one property: `window[Symbol.for('voksa.fallbackMask')]`,
 * a handle with a single `update()` method used by main to re-configure or tear
 * the masker down. A Symbol.for key is needed because each injection is a fresh
 * script: without a rendezvous point main could not reach the installed instance
 * and every update would stack a second observer on the document. This does NOT
 * weaken the "stream API never in the main world" rule (CLAUDE.md 4.5): that rule
 * is about the preload's IPC surface, which is not exposed here. The handle
 * carries no IPC, no config getter and no privileged capability: a page can only
 * call `update()` with data it already has, or drop the property, and in the
 * worst case main re-injects.
 *
 * BEHAVIOUR. Same guarantees as the real masker where it can offer them:
 *  - one full sweep, then a MutationObserver processed SYNCHRONOUSLY in its
 *    callback (a microtask, strictly before the next paint), never via rAF;
 *  - the same source of truth for the patterns (shared/maskPatterns.ts) and the
 *    same config shape (shared/streamConfig.ts);
 *  - form controls are redacted visually, never through `.value`;
 *  - restore-on-disable only rewrites nodes we still own (their content is
 *    exactly what we wrote), so a page update, or a second masker, is not
 *    clobbered.
 *
 * NESTED IFRAMES. Any iframe inside this frame is hidden on sight and stays
 * hidden while Stream Mode is on: a frame we had to rescue has no IPC channel,
 * so it cannot run the gate handshake (renderer gates, main confirms coverage)
 * that injected/streamMask.ts uses to reveal frames again. Fail closed.
 */

export type FallbackPayload = {
  config: StreamModeConfig | null;
  hostname: string | null;
};

export type FallbackHandle = {
  update(payload: FallbackPayload): void;
};

/**
 * The one and only main-world footprint. Symbol.for (the global symbol
 * registry) is the rendezvous point: main injects this bundle as a fresh script
 * every time, and needs a stable, non-enumerable-ish key to find the instance it
 * installed earlier. Kept in sync with FALLBACK_HANDLE_KEY in
 * src/main/stream-mode/frameGuard.ts.
 */
const HANDLE_KEY = Symbol.for('voksa.fallbackMask');
const MASKABLE_ATTRS = ['title', 'alt', 'placeholder', 'aria-label'];
const OBSERVED_ATTRS = [...MASKABLE_ATTRS, 'src'];
const REDACT_ATTR = 'data-voksa-fb-redact';
const GATE_ATTR = 'data-voksa-fb-gate';
const STYLE_ID = '__voksa_fb_style';
const REDACTABLE_INPUT = new Set(['text', 'search', 'email', 'tel', 'url', 'number', '']);
const HEAVY_BATCH = 1500;

function createHandle(): FallbackHandle {
  let config: StreamModeConfig | null = null;
  let hostname: string | null = null;
  let observing = false;

  // Reversal bookkeeping. `written` remembers what WE put in the node, so a
  // restore never overwrites a value the page (or another masker) set since.
  const originalText = new WeakMap<Text, string>();
  const writtenText = new WeakMap<Text, string>();
  const modifiedTextNodes = new Set<Text>();
  const originalAttrs = new WeakMap<Element, Map<string, string>>();
  const writtenAttrs = new WeakMap<Element, Map<string, string>>();
  const modifiedAttrEls = new Set<Element>();
  const redactedEls = new Set<Element>();
  const gatedFrames = new Map<HTMLElement, { value: string; priority: string }>();
  const shadowObserved = new WeakSet<ShadowRoot>();

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

  function active(): boolean {
    return !!config?.enabled && hasAnyMask(flags(), config?.customMasks ?? []);
  }

  function maskString(input: string): string {
    if (!config) return input;
    return maskText(input, flags(), hostname, config.customMasks);
  }

  function ensureStyle(): void {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    // Redaction never touches el.value (submitted data stays intact); the gate
    // rule is a backstop in case the page overwrites our inline style.
    style.textContent =
      `[${REDACT_ATTR}]{-webkit-text-security:disc!important;}` +
      `iframe[${GATE_ATTR}],frame[${GATE_ATTR}]{visibility:hidden!important;}`;
    (document.head || document.documentElement || document).appendChild(style);
  }

  // --- text / attributes -----------------------------------------------------
  function maskTextNode(node: Text): void {
    const parent = node.parentElement;
    if (!parent) return;
    const tag = parent.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEXTAREA') return;
    if (parent.isContentEditable) return;
    const current = node.data;
    const next = maskString(current);
    if (next === current) return;
    if (!originalText.has(node)) originalText.set(node, current);
    writtenText.set(node, next);
    modifiedTextNodes.add(node);
    node.data = next;
  }

  function maskAttributes(el: Element): void {
    for (const name of MASKABLE_ATTRS) {
      const value = el.getAttribute(name);
      if (value == null) continue;
      const next = maskString(value);
      if (next === value) continue;
      let originals = originalAttrs.get(el);
      if (!originals) {
        originals = new Map();
        originalAttrs.set(el, originals);
      }
      if (!originals.has(name)) originals.set(name, value);
      let written = writtenAttrs.get(el);
      if (!written) {
        written = new Map();
        writtenAttrs.set(el, written);
      }
      written.set(name, next);
      modifiedAttrEls.add(el);
      el.setAttribute(name, next);
    }
  }

  function redactField(el: HTMLInputElement | HTMLTextAreaElement): void {
    if (!config?.maskInputValues) {
      if (el.hasAttribute(REDACT_ATTR)) {
        el.removeAttribute(REDACT_ATTR);
        redactedEls.delete(el);
      }
      return;
    }
    const value = el.value ?? '';
    const sensitive = value.length > 0 && maskString(value) !== value;
    if (sensitive) {
      if (!el.hasAttribute(REDACT_ATTR)) {
        ensureStyle();
        el.setAttribute(REDACT_ATTR, '');
        redactedEls.add(el);
      }
    } else if (el.hasAttribute(REDACT_ATTR)) {
      el.removeAttribute(REDACT_ATTR);
      redactedEls.delete(el);
    }
  }

  function maybeRedact(el: Element): void {
    if (el.tagName === 'TEXTAREA') {
      redactField(el as HTMLTextAreaElement);
    } else if (el.tagName === 'INPUT') {
      const input = el as HTMLInputElement;
      if (REDACTABLE_INPUT.has((input.getAttribute('type') || '').toLowerCase())) {
        redactField(input);
      }
    }
  }

  // --- nested-iframe gate (fail closed, see the file header) -----------------
  function gateFrame(el: HTMLElement): void {
    if (gatedFrames.has(el)) return;
    ensureStyle();
    gatedFrames.set(el, {
      value: el.style.getPropertyValue('visibility'),
      priority: el.style.getPropertyPriority('visibility'),
    });
    el.setAttribute(GATE_ATTR, '');
    // Inline + important: the strongest author declaration there is, so a page
    // stylesheet cannot reveal the frame behind our back.
    el.style.setProperty('visibility', 'hidden', 'important');
  }

  function ungateAll(): void {
    for (const [el, previous] of gatedFrames) {
      try {
        el.removeAttribute(GATE_ATTR);
        if (previous.value) el.style.setProperty('visibility', previous.value, previous.priority);
        else el.style.removeProperty('visibility');
      } catch {
        // element gone; ignore
      }
    }
    gatedFrames.clear();
  }

  // --- tree walk (incl. shadow DOM) -----------------------------------------
  function visitElement(el: Element): void {
    maskAttributes(el);
    maybeRedact(el);
    if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') gateFrame(el as HTMLElement);
    if (el.shadowRoot) {
      observeShadow(el.shadowRoot);
      walkAndMask(el.shadowRoot);
    }
  }

  function observeShadow(root: ShadowRoot): void {
    if (shadowObserved.has(root)) return;
    shadowObserved.add(root);
    const shadowObserver = new MutationObserver(onMutations);
    shadowObserver.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: OBSERVED_ATTRS,
    });
  }

  function walkAndMask(root: Node): void {
    if (root.nodeType === Node.TEXT_NODE) {
      maskTextNode(root as Text);
      return;
    }
    if (
      root.nodeType !== Node.ELEMENT_NODE &&
      root.nodeType !== Node.DOCUMENT_NODE &&
      root.nodeType !== Node.DOCUMENT_FRAGMENT_NODE
    ) {
      return;
    }
    if (root.nodeType === Node.ELEMENT_NODE) visitElement(root as Element);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode(node) {
        if (node.nodeType === Node.TEXT_NODE) {
          const parent = (node as Text).parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          const tag = parent.tagName;
          if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') {
            return NodeFilter.FILTER_REJECT;
          }
          if (parent.isContentEditable) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let current: Node | null = walker.nextNode();
    while (current) {
      if (current.nodeType === Node.TEXT_NODE) maskTextNode(current as Text);
      else if (current.nodeType === Node.ELEMENT_NODE) visitElement(current as Element);
      current = walker.nextNode();
    }
  }

  // --- mutation handling (synchronous, pre-paint) ---------------------------
  function onMutations(mutations: MutationRecord[]): void {
    if (!active()) return;
    let added = 0;
    for (const m of mutations) added += m.addedNodes.length;
    if (added > HEAVY_BATCH) {
      if (document.body) walkAndMask(document.body);
      return;
    }
    for (const m of mutations) {
      if (m.type === 'characterData' && m.target.nodeType === Node.TEXT_NODE) {
        maskTextNode(m.target as Text);
      } else if (m.type === 'childList') {
        for (let i = 0; i < m.addedNodes.length; i++) walkAndMask(m.addedNodes[i]);
      } else if (m.type === 'attributes' && m.target.nodeType === Node.ELEMENT_NODE) {
        visitElement(m.target as Element);
      }
    }
  }

  const observer = new MutationObserver(onMutations);

  function onInput(e: Event): void {
    if (!active()) return;
    const target = e.target as Element | null;
    if (target) maybeRedact(target);
  }

  function startObserving(): void {
    if (observing) return;
    observing = true;
    observer.observe(document, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: OBSERVED_ATTRS,
    });
    document.addEventListener('input', onInput, true);
  }

  function stopObserving(): void {
    if (!observing) return;
    observing = false;
    observer.disconnect();
    document.removeEventListener('input', onInput, true);
  }

  function fullSweep(): void {
    if (document.documentElement) walkAndMask(document.documentElement);
    if (document.body) walkAndMask(document.body);
  }

  function restoreAll(): void {
    for (const node of modifiedTextNodes) {
      const original = originalText.get(node);
      // Only take back what we still own: if the page rewrote the node since,
      // or another masker owns it now, leave it alone.
      if (original != null && node.isConnected && node.data === writtenText.get(node)) {
        node.data = original;
      }
    }
    modifiedTextNodes.clear();
    for (const el of modifiedAttrEls) {
      const originals = originalAttrs.get(el);
      const written = writtenAttrs.get(el);
      if (!originals) continue;
      for (const [name, value] of originals) {
        if (written && el.getAttribute(name) !== written.get(name)) continue;
        el.setAttribute(name, value);
      }
    }
    modifiedAttrEls.clear();
    for (const el of redactedEls) el.removeAttribute(REDACT_ATTR);
    redactedEls.clear();
  }

  function apply(): void {
    if (active()) {
      startObserving();
      fullSweep();
    } else {
      stopObserving();
      restoreAll();
      ungateAll();
    }
  }

  return {
    update(payload: FallbackPayload): void {
      config = payload?.config ?? null;
      hostname = payload?.hostname ?? null;
      apply();
      // The document may still be parsing: sweep again once it is complete, so
      // late-parsed content is covered even if no mutation record fires for it.
      if (document.readyState === 'loading') {
        document.addEventListener(
          'DOMContentLoaded',
          () => {
            if (active()) fullSweep();
          },
          { once: true },
        );
      }
    },
  };
}

// Idempotent install: main re-injects this whole bundle on every update, so a
// second run must reuse the live handle (and its bookkeeping) instead of
// stacking a second observer on the same document.
const target = window as unknown as Record<symbol, FallbackHandle | undefined>;
if (!target[HANDLE_KEY]) {
  const handle = createHandle();
  try {
    Object.defineProperty(target, HANDLE_KEY, {
      value: handle,
      configurable: true,
      enumerable: false,
      writable: false,
    });
  } catch {
    target[HANDLE_KEY] = handle;
  }
}
