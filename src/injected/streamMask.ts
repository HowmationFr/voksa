import {
  maskText,
  hasAnyMask,
  type MaskFlags,
} from '../shared/maskPatterns';
import type { StreamModeConfig } from '../shared/streamConfig';

/**
 * Stream Mode masker (Layer 1). Runs in every frame's isolated preload world.
 *
 * Guarantees no unmasked pixel paints, on any navigation path:
 *  - The preload (page.ts, Layer 0) hides the document (`html{opacity:0}`)
 *    at document-start via `beginProtected`; this masker lifts it via
 *    `endProtected` only after the initial full sweep.
 *  - Mutations are processed SYNCHRONOUSLY in the MutationObserver callback
 *    (a microtask that runs strictly before the next paint), never via rAF,
 *    which is throttled for occluded views and would leak on reveal.
 *  - Shadow DOM (open roots), form-control values and dynamic subtrees are
 *    covered. Toggling categories re-sweeps; disabling restores originals.
 *
 * IFRAME GATE (electron/electron#34727). One frame flavour escapes all of the
 * above: a frame whose contentWindow is read by a page script before it commits
 * NEVER gets our preload, so it has no shroud and no masker of its own. This
 * masker therefore hides every iframe ELEMENT it sees, synchronously, the moment
 * it appears (same pre-paint microtask as the masking itself), and reveals them
 * only once main (stream-mode/frameGuard.ts) confirms that every subframe of the
 * tab is covered: either it announced its preload, or the fallback masker was
 * injected into it. Gate first, ask second: we bump a seq and send
 * STREAM_FRAME_GATE, and only accept a verdict that echoes a seq at least as
 * recent, so an "all covered" computed before main had even heard of the frame
 * can never reveal it. The gate is element-level styling ONLY: touching
 * contentWindow/contentDocument here would trigger the very bug it guards.
 */

export type FramesStatus = {
  /** At least one subframe of the tab is not covered yet: keep iframes hidden. */
  pending: boolean;
  /** The last gate seq main heard from THIS frame (see signalGate). */
  seq: number;
};

export type MaskerHost = {
  getConfig(): StreamModeConfig | null;
  getHostname(): string | null;
  subscribe(cb: (c: StreamModeConfig) => void): () => void;
  /** Insert the shroud + signal doc-start (main frame). */
  beginProtected(): void;
  /** Remove the shroud + signal ready (main frame). */
  endProtected(): void;
  /** Tell main we just hid iframe element(s); it must re-verify coverage. */
  signalGate(seq: number): void;
  /** Subscribe to main's aggregate subframe-coverage verdict for this tab. */
  onFramesStatus(cb: (status: FramesStatus) => void): void;
};

declare global {
  interface Window {
    __voksaMaskerInstalled?: boolean;
  }
}

const MASKABLE_ATTRS = ['title', 'alt', 'placeholder', 'aria-label'];
// 'src' is not maskable, it is OBSERVED: an iframe pointed at a new document
// must be re-gated (its next document has no preload until proven otherwise).
const OBSERVED_ATTRS = [...MASKABLE_ATTRS, 'src'];
const REDACT_STYLE_ID = '__voksa_redact_style';
const REDACT_ATTR = 'data-voksa-redact';
const GATE_STYLE_ID = '__voksa_gate_style';
const GATE_ATTR = 'data-voksa-gate';

export function installStreamMasker(host: MaskerHost): void {
  if (window.__voksaMaskerInstalled) return;
  window.__voksaMaskerInstalled = true;

  let config: StreamModeConfig | null = host.getConfig();

  // Reversal bookkeeping: strong refs so we can restore on disable. Only
  // nodes that actually changed are tracked, so the sets stay small.
  const originalText = new WeakMap<Text, string>();
  const modifiedTextNodes = new Set<Text>();
  const originalAttrs = new WeakMap<Element, Map<string, string>>();
  const modifiedAttrEls = new Set<Element>();
  const redactedEls = new Set<Element>();
  const shadowObserved = new WeakSet<ShadowRoot>();

  // Iframe gate bookkeeping (see the header). `knownFrames` also covers frames
  // inside shadow roots, which a document-level querySelectorAll would miss.
  const knownFrames = new Set<HTMLElement>();
  const gatedFrames = new Map<HTMLElement, { value: string; priority: string }>();
  let gateSeq = 0;
  let gateSignalPending = false;
  let statusPending = false;
  let statusSeq = 0;

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

  function maskString(input: string): string {
    if (!config) return input;
    return maskText(input, flags(), host.getHostname(), config.customMasks);
  }

  function active(): boolean {
    return !!config?.enabled && hasAnyMask(flags(), config?.customMasks ?? []);
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
    if (next !== current) {
      if (!originalText.has(node)) originalText.set(node, current);
      modifiedTextNodes.add(node);
      node.data = next;
    }
  }

  function maskAttributes(el: Element): void {
    for (const name of MASKABLE_ATTRS) {
      const v = el.getAttribute(name);
      if (v == null) continue;
      const next = maskString(v);
      if (next !== v) {
        let store = originalAttrs.get(el);
        if (!store) {
          store = new Map();
          originalAttrs.set(el, store);
        }
        if (!store.has(name)) store.set(name, v);
        modifiedAttrEls.add(el);
        el.setAttribute(name, next);
      }
    }
  }

  // --- form control values (no data corruption) ------------------------------
  function ensureRedactStyle(): void {
    if (document.getElementById(REDACT_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = REDACT_STYLE_ID;
    // Visually redact WITHOUT touching el.value (submitted data stays intact).
    style.textContent = `[${REDACT_ATTR}]{-webkit-text-security:disc!important;}`;
    (document.head || document.documentElement || document).appendChild(style);
  }

  function redactField(el: HTMLInputElement | HTMLTextAreaElement): void {
    if (!config?.maskInputValues) {
      if (el.hasAttribute(REDACT_ATTR)) {
        el.removeAttribute(REDACT_ATTR);
        redactedEls.delete(el);
      }
      return;
    }
    const val = el.value ?? '';
    const sensitive = val.length > 0 && maskString(val) !== val;
    if (sensitive) {
      if (!el.hasAttribute(REDACT_ATTR)) {
        ensureRedactStyle();
        el.setAttribute(REDACT_ATTR, '');
        redactedEls.add(el);
      }
    } else if (el.hasAttribute(REDACT_ATTR)) {
      el.removeAttribute(REDACT_ATTR);
      redactedEls.delete(el);
    }
  }

  const REDACTABLE_INPUT = new Set([
    'text',
    'search',
    'email',
    'tel',
    'url',
    'number',
    '',
  ]);
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

  // --- iframe gate (unprotected-subframe guard) ------------------------------
  function ensureGateStyle(): void {
    if (document.getElementById(GATE_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = GATE_STYLE_ID;
    // Backstop for the inline style below: if the page rewrites the element's
    // style attribute, this author !important rule still holds the frame down.
    style.textContent = `iframe[${GATE_ATTR}],frame[${GATE_ATTR}]{visibility:hidden!important;}`;
    (document.head || document.documentElement || document).appendChild(style);
  }

  function gateFrame(el: HTMLElement): void {
    if (gatedFrames.has(el)) return;
    ensureGateStyle();
    gatedFrames.set(el, {
      value: el.style.getPropertyValue('visibility'),
      priority: el.style.getPropertyPriority('visibility'),
    });
    el.setAttribute(GATE_ATTR, '');
    // Inline + important is the strongest author declaration there is: no page
    // stylesheet can reveal the frame behind our back. visibility (not opacity)
    // so the frame's subtree is not painted at all.
    el.style.setProperty('visibility', 'hidden', 'important');
    gateSignalPending = true;
  }

  /** Every iframe we ever saw, from any root: gate it (nothing is revealed). */
  function gateAllFrames(): void {
    for (const el of [...knownFrames]) {
      if (el.isConnected) gateFrame(el);
      else knownFrames.delete(el);
    }
    flushGateSignal();
  }

  function ungateAllFrames(): void {
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

  /** One signal per batch: main only needs to know "something new is hidden". */
  function flushGateSignal(): void {
    if (!gateSignalPending) return;
    gateSignalPending = false;
    gateSeq += 1;
    try {
      host.signalGate(gateSeq);
    } catch {
      // ignore
    }
  }

  function maybeUngate(): void {
    if (statusPending) return;
    // A verdict that predates our latest gate says nothing about the frame we
    // just hid: main may not even have heard of it yet.
    if (statusSeq < gateSeq) return;
    ungateAllFrames();
  }

  function noteFrame(el: HTMLElement): void {
    knownFrames.add(el);
    if (active()) gateFrame(el);
  }

  // --- tree walk (incl. shadow DOM) -----------------------------------------
  function observeShadow(root: ShadowRoot): void {
    if (shadowObserved.has(root)) return;
    shadowObserved.add(root);
    const so = new MutationObserver((mutations) => onMutations(mutations));
    so.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: OBSERVED_ATTRS,
    });
  }

  function visitElement(el: Element): void {
    maskAttributes(el);
    maybeRedact(el);
    // Gate BEFORE anything else can paint: this runs in the MutationObserver
    // microtask, i.e. still before the frame that would show the iframe.
    if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') noteFrame(el as HTMLElement);
    if (el.shadowRoot) {
      observeShadow(el.shadowRoot);
      walkAndMask(el.shadowRoot);
    }
  }

  function walkAndMask(root: Node): void {
    if (root.nodeType === Node.TEXT_NODE) {
      maskTextNode(root as Text);
      return;
    }
    if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE &&
      root.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) {
      return;
    }
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
    // Handle the root element itself first.
    if (root.nodeType === Node.ELEMENT_NODE) visitElement(root as Element);
    let current: Node | null = walker.nextNode();
    while (current) {
      if (current.nodeType === Node.TEXT_NODE) {
        maskTextNode(current as Text);
      } else if (current.nodeType === Node.ELEMENT_NODE) {
        visitElement(current as Element);
      }
      current = walker.nextNode();
    }
  }

  // --- mutation handling (synchronous, pre-paint) ---------------------------
  const HEAVY_BATCH = 1500;
  function processMutations(mutations: MutationRecord[]): void {
    // Under a very large batch, one full sweep is cheaper than per-record work
    // and still completes synchronously before paint (no degraded interval).
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
        // Covers a `src` swap on an already-known iframe: the document it is
        // about to commit has no preload until proven otherwise, so re-gate it.
        visitElement(m.target as Element);
      }
    }
  }

  function onMutations(mutations: MutationRecord[]): void {
    if (!active()) return;
    processMutations(mutations);
    flushGateSignal();
  }

  const observer = new MutationObserver(onMutations);

  function startObserver(): void {
    observer.observe(document, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: OBSERVED_ATTRS,
    });
    // Re-check field values as the user types (never touches submitted data).
    document.addEventListener(
      'input',
      (e) => {
        if (!active()) return;
        const t = e.target as Element | null;
        if (t) maybeRedact(t);
      },
      true,
    );
  }

  function fullSweep(): void {
    if (document.documentElement) walkAndMask(document.documentElement);
    if (document.body) walkAndMask(document.body);
    // Parser-inserted iframes were gated by walkAndMask: tell main so it starts
    // verifying coverage (and so we never accept a verdict older than this).
    flushGateSignal();
  }

  // --- reversal (disable) ----------------------------------------------------
  function restoreAll(): void {
    for (const node of modifiedTextNodes) {
      const orig = originalText.get(node);
      if (orig != null && node.isConnected) node.data = orig;
    }
    modifiedTextNodes.clear();
    for (const el of modifiedAttrEls) {
      const store = originalAttrs.get(el);
      if (store) for (const [name, val] of store) el.setAttribute(name, val);
    }
    modifiedAttrEls.clear();
    for (const el of redactedEls) el.removeAttribute(REDACT_ATTR);
    redactedEls.clear();
  }

  // --- WebRTC stub -----------------------------------------------------------
  let webrtcStubbed = false;
  const realRTC = window.RTCPeerConnection;
  function installWebRTCStub(): void {
    if (webrtcStubbed || !realRTC) return;
    if (!config?.blockWebRTC) return;
    webrtcStubbed = true;
    const Blocked = function (): never {
      throw new Error('RTCPeerConnection blocked by Stream Mode');
    } as unknown as typeof RTCPeerConnection;
    try {
      Object.defineProperty(window, 'RTCPeerConnection', { value: Blocked, configurable: true });
      Object.defineProperty(window, 'webkitRTCPeerConnection', {
        value: Blocked,
        configurable: true,
      });
    } catch {
      // ignore
    }
  }
  function removeWebRTCStub(): void {
    if (!webrtcStubbed || !realRTC) return;
    webrtcStubbed = false;
    try {
      Object.defineProperty(window, 'RTCPeerConnection', { value: realRTC, configurable: true });
      Object.defineProperty(window, 'webkitRTCPeerConnection', {
        value: realRTC,
        configurable: true,
      });
    } catch {
      // ignore
    }
  }

  /**
   * A document whose visible content is painted by a PLUGIN (Chromium's PDF
   * viewer), not by DOM nodes. The sweep can only reach the viewer's shell;
   * an email inside the PDF itself is pixels this masker will never see, so
   * the only honest behaviour under Stream Mode is to keep the whole document
   * shrouded: fail closed, an invisible page, never a leak. Decided on the
   * committed MIME type, not the URL: query strings and extension-less links
   * lie about what they serve, `document.contentType` does not.
   */
  function isUnmaskableDocument(): boolean {
    try {
      return document.contentType === 'application/pdf';
    } catch {
      return false;
    }
  }

  // --- config transitions ----------------------------------------------------
  function onConfig(next: StreamModeConfig): void {
    const wasEnabled = active();
    config = next;
    const nowEnabled = active();

    if (nowEnabled) {
      // Toggle-ON or category/customMask change while running: shroud, sweep
      // synchronously, lift, all in this task so the next paint is masked
      // with no blank frame and no screenshot. The sweep also gates every
      // iframe: main drops coverage on a config change too, so the gate holds
      // until each unprotected frame's fallback masker is re-injected with the
      // NEW config (a freshly added custom mask must not paint even once).
      host.beginProtected();
      fullSweep();
      installWebRTCStub();
      // An unmaskable document keeps its shroud for as long as masking is on
      // (this branch also runs on config CHANGES while enabled: skipping the
      // lift here is what keeps it held across them).
      if (!isUnmaskableDocument()) host.endProtected();
    } else if (wasEnabled) {
      restoreAll();
      removeWebRTCStub();
      ungateAllFrames();
      // The shroud held over an unmaskable document is lifted only here.
      // endProtected is idempotent (a normal page already lifted at boot);
      // the guard keeps the disable path byte-identical for normal pages.
      if (isUnmaskableDocument()) host.endProtected();
    }
  }

  // Main's verdict on this tab's subframes: gate or reveal.
  host.onFramesStatus((status) => {
    statusPending = !!status?.pending;
    if (typeof status?.seq === 'number') statusSeq = status.seq;
    // Recorded even while Stream Mode is off (the config push may land after
    // this one): the gate itself is applied by the sweep, which only runs when
    // masking is active, and a stale "ok" can never survive the seq check.
    if (!active()) return;
    if (statusPending) gateAllFrames();
    else maybeUngate();
  });

  // --- boot ------------------------------------------------------------------
  startObserver();

  let didBegin = false;
  if (config?.enabled) {
    host.beginProtected();
    didBegin = true;
  }

  const boot = () => {
    if (active()) {
      fullSweep();
      installWebRTCStub();
    }
    // Unmaskable document (PDF viewer) while masking is on: the shroud stays.
    // The curtain over the navigation then runs out its fail-to-blank timeout
    // rather than revealing plugin-painted content no sweep ever touched.
    if (didBegin && !(active() && isUnmaskableDocument())) host.endProtected();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }

  host.subscribe(onConfig);
}
