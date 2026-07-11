// CI end-to-end test: boot the PACKAGED-STYLE app (dist-electron + dist-ui,
// no Vite dev server) with CDP enabled and drive it through a real user flow
// over the DevTools protocol:
//   1. BOOT: CDP endpoint answers, the chrome UI page target exists.
//   2. UI ALIVE: window.voksa is exposed and React mounted into #root.
//   3. EXTENSIONS: both extension runtimes logged their ready lines.
//   4. REAL PAGE LOADS: a tab opened via voksa.tabs.create renders a local
//      leak-probe page (email + public IP + same-origin iframe), stream OFF.
//   5. FINGERPRINT: navigator.webdriver undefined, window.chrome present,
//      Chrome UA without Electron/Firefox/Voksa markers.
//   6. STREAM MASKS LIVE PAGES: enabling Stream Mode scrubs the email/IP from
//      the live DOM (top document AND iframe) without leaving the page
//      shrouded (documentElement opacity back to 1).
//   7. STREAM NAVIGATION NOT STUCK: navigating under stream shows the new
//      document masked and unshrouded well under the 6s curtain timeout, AND
//      the curtain element is gone from the chrome UI DOM (the curtain lives
//      in Chrome.tsx, not in the page target: a stuck curtain would otherwise
//      pass every page-side check).
//   8. STREAM OFF RESTORES: disabling Stream Mode restores the raw DOM text,
//      leaves the page unshrouded and leaves no curtain in the chrome UI.
//   9. TAB CLOSE NO LEAK: closing the tab destroys its CDP page target.
//  10. STREAM GUARDS PRELOAD-LESS FRAME: a page that reproduces
//      electron/electron#34727 (touch iframe.contentWindow before the frame
//      commits) gets an iframe with NO preload, hence no shroud (L0) and no
//      masker (L1). Under Stream Mode that frame must never be visible while
//      it still shows raw text, and the healthy sibling frame must end up
//      masked AND visible (anti-vacuity). Asserted on BOTH paths into Stream
//      Mode: the page loaded with it already on, and it toggled on over a page
//      already painted raw. Toggling Stream OFF must ungate and restore both.
//  11. MULTI-WINDOW: voksa.window.openNew() boots a second chrome UI whose
//      tab list is isolated from window 1 in both directions; closing it
//      tears its target down and leaves window 1 intact.
//  12. NO RENDERER EXCEPTIONS: no Runtime.exceptionThrown on the chrome UI
//      target during the whole run.
//
// Catches boot crashes, preload failures, a blank chrome UI, a broken voksa
// bridge, stream masking regressions, unprotected subframes and leaked
// webContents; none of which unit tests can see.
//
// Usage: npm run build && node scripts/smoke.mjs
// (on Linux CI wrap with `xvfb-run -a`)
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const PORT = 9313;
const BOOT_TIMEOUT_MS = 60_000;
const STEP_TIMEOUT_MS = 15_000;
// Stream transitions must settle well under the 6s curtain fail-to-blank.
const STREAM_TIMEOUT_MS = 5_000;
// Budget for the frame guard to cover a preload-less subframe: it waits a
// short grace period after the frame commits (the frame may still announce
// itself), then injects the fallback masker. Generous because it is only ever
// burned in full on failure: a real leak fails fast (first poll that sees raw
// text in a visible frame), it never waits this out.
const GUARD_TIMEOUT_MS = 8_000;

// Strings served by the local leak-probe pages. The email/IPv4 forms match
// the default Stream Mode masks (203.0.113.7 / 203.0.113.9 are TEST-NET-3:
// public per isPrivateIPv4, so maskIPv4 must scrub them).
const PROBE_EMAIL = 'leak-probe@example.com';
const PROBE_IP = '203.0.113.7';
const FRAME_EMAIL = 'frame-leak@example.com';
const PAGE2_EMAIL = 'second-leak@example.com';
const PAGE2_MARKER = 'PAGE2-LOADED';

// Scenario 10 (preload-less frame). Markers are unmaskable by construction (no
// '@', no dotted quad, no phone shape) so "frame loaded" stays observable even
// once every sensitive token has been scrubbed.
const POISON_MARKER = 'POISON-PAGE-LOADED';
const POISON_FRAME_MARKER = 'POISON-FRAME-LOADED';
const POISON_EMAIL = 'poisoned-leak@example.com';
const POISON_IP = '203.0.113.9';
const CLEAN_FRAME_MARKER = 'CLEAN-FRAME-LOADED';
const CLEAN_FRAME_EMAIL = 'clean-frame@example.com';

// Exact ready lines printed by src/main/extensions/webstore.ts.
const EXT_RUNTIME_READY = '[extensions] Chrome extension runtime ready.';
const EXT_WEBSTORE_READY = '[extensions] Chrome Web Store ready on session.';

// Isolated profile: never touch a real user profile, never fight another
// running instance for the single-instance lock.
const profile = mkdtempSync(path.join(os.tmpdir(), 'voksa-smoke-'));

const env = { ...process.env, VOKSA_DEBUG_PROFILE: profile, VOKSA_DEBUG_PORT: String(PORT) };
// A machine-wide ELECTRON_RUN_AS_NODE would turn the electron binary into a
// bare Node process and the smoke test into a false negative.
delete env.ELECTRON_RUN_AS_NODE;

let child = null;
let output = '';
let exited = false;

// If something already answers CDP on our fixed port (a stale instance from a
// previous run, or an unrelated debugger), every /json query below would
// silently target IT instead of the process we are about to spawn and the
// whole run would be a false green. Abort instead.
async function assertPortFree() {
  let answered = false;
  try {
    await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(2000) });
    answered = true;
  } catch {
    // connection refused / timed out: nothing is listening, proceed
  }
  if (answered) {
    throw new Error(`port ${PORT} already in use: stale instance?`);
  }
}

function spawnElectron() {
  const args = ['electron', 'debug-profile.cjs'];
  // Chromium's setuid sandbox is unavailable on CI runners.
  if (process.env.CI) args.push('--no-sandbox');
  child = spawn('npx', args, {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
    detached: process.platform !== 'win32',
  });
  child.stdout.on('data', (d) => {
    output += d;
    process.stdout.write(d);
  });
  child.stderr.on('data', (d) => {
    output += d;
    process.stderr.write(d);
  });
  child.on('exit', () => {
    exited = true;
  });
}

function killTree() {
  if (child == null || child.pid == null || exited) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Poll `fn` until it returns a truthy value. Exceptions mean "not ready yet"
// but the last one is surfaced in the timeout error so failures stay
// actionable. `hint` should tell the reader what is probably broken.
async function waitFor(what, fn, timeoutMs = BOOT_TIMEOUT_MS, hint = '') {
  const start = Date.now();
  let lastError = '';
  while (Date.now() - start < timeoutMs) {
    if (exited) throw new Error(`electron exited before ${what}`);
    try {
      const result = await fn();
      if (result) return result;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await sleep(250);
  }
  const detail = [lastError && `last error: ${lastError}`, hint].filter(Boolean).join('; ');
  throw new Error(`timeout waiting for ${what}${detail ? ` (${detail})` : ''}`);
}

// ---------------------------------------------------------------------------
// Minimal CDP client over WebSocket. Prefers the global WebSocket (Node 22+),
// falls back to the `ws` devDependency on Node 20 CI runners.
// ---------------------------------------------------------------------------

function openNativeSocket(url) {
  return new Promise((resolve, reject) => {
    const ws = new globalThis.WebSocket(url);
    ws.addEventListener(
      'open',
      () =>
        resolve({
          send: (s) => ws.send(s),
          close: () => {
            try {
              ws.close();
            } catch {
              // already closed
            }
          },
          onMessage: (fn) =>
            ws.addEventListener('message', (ev) =>
              fn(typeof ev.data === 'string' ? ev.data : String(ev.data)),
            ),
          onClose: (fn) => ws.addEventListener('close', fn, { once: true }),
        }),
      { once: true },
    );
    ws.addEventListener('error', () => reject(new Error(`WebSocket connect failed: ${url}`)), {
      once: true,
    });
  });
}

async function openWsPackageSocket(url) {
  const { default: WS } = await import('ws');
  const ws = new WS(url);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return {
    send: (s) => ws.send(s),
    close: () => {
      try {
        ws.close();
      } catch {
        // already closed
      }
    },
    onMessage: (fn) => ws.on('message', (d) => fn(d.toString())),
    onClose: (fn) => ws.once('close', fn),
  };
}

async function openSocket(url) {
  if (typeof globalThis.WebSocket === 'function') {
    try {
      return await openNativeSocket(url);
    } catch {
      // fall through: some runtimes reject the CDP handshake, `ws` does not
    }
  }
  return openWsPackageSocket(url);
}

class CdpClient {
  constructor(sock, label) {
    this.sock = sock;
    this.label = label;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
    sock.onMessage((raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`CDP error on ${this.label}: ${msg.error.message}`));
        else resolve(msg.result ?? {});
      } else if (msg.method) {
        for (const fn of this.listeners.get(msg.method) ?? []) fn(msg.params);
      }
    });
    sock.onClose(() => {
      this.closed = true;
      for (const { reject } of this.pending.values()) {
        reject(new Error(`CDP socket closed (${this.label})`));
      }
      this.pending.clear();
    });
  }

  static async connect(wsUrl, label) {
    const client = new CdpClient(await openSocket(wsUrl), label);
    await client.send('Runtime.enable');
    return client;
  }

  send(method, params = {}) {
    if (this.closed) {
      return Promise.reject(new Error(`CDP socket already closed (${this.label}, ${method})`));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.sock.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, fn) {
    const fns = this.listeners.get(method) ?? [];
    fns.push(fn);
    this.listeners.set(method, fns);
  }

  // Evaluate in the target's main world; promises are awaited, results come
  // back by value, and in-page exceptions become rejections here.
  async evaluate(expression) {
    const { result, exceptionDetails } = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (exceptionDetails) {
      const text =
        exceptionDetails.exception?.description ?? exceptionDetails.text ?? 'evaluation threw';
      throw new Error(`evaluate failed on ${this.label}: ${text.split('\n')[0]}`);
    }
    return result?.value;
  }

  close() {
    this.closed = true;
    this.sock.close();
  }
}

const listTargets = async () =>
  (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();

// ---------------------------------------------------------------------------
// Local leak-probe server: tiny pages with data the default Stream Mode config
// must mask (emails, a public IPv4), plus same-origin iframes to prove masking
// reaches subframes, including one frame that Electron refuses to inject the
// preload into (see /poison.html).
// ---------------------------------------------------------------------------

function startProbeServer() {
  const pages = {
    '/page.html': `<!doctype html><html><head><meta charset="utf-8"><title>probe</title></head><body>
      <p>contact: ${PROBE_EMAIL}</p>
      <p>server: ${PROBE_IP}</p>
      <iframe src="/frame.html"></iframe>
    </body></html>`,
    '/frame.html': `<!doctype html><html><head><meta charset="utf-8"></head><body>
      <p>frame contact: ${FRAME_EMAIL}</p>
    </body></html>`,
    '/page2.html': `<!doctype html><html><head><meta charset="utf-8"></head><body>
      <p>${PAGE2_MARKER}</p>
      <p>contact: ${PAGE2_EMAIL}</p>
    </body></html>`,

    // Reproduction of electron/electron#34727 (upstream, closed as NOT
    // PLANNED). A page script that reads an iframe's contentWindow BEFORE that
    // frame has committed its document makes Electron skip preload injection
    // into it, permanently. The frame therefore runs WITHOUT the L0 shroud and
    // WITHOUT the L1 masker, and paints its raw content under Stream Mode.
    // Ad / analytics / widget libraries do exactly this in the wild, so this is
    // the real bug, not a proxy for it.
    //
    // #clean is the control: a plain static iframe, never touched, which does
    // get a preload. It must end up MASKED and VISIBLE, which is what stops the
    // frame guard from "passing" by hiding every iframe forever.
    '/poison.html': `<!doctype html><html><head><meta charset="utf-8"><title>poison</title></head><body>
      <p>${POISON_MARKER}</p>
      <iframe id="clean" src="/clean-frame.html"></iframe>
      <script>
        var poisoned = document.createElement('iframe');
        poisoned.id = 'poisoned';
        poisoned.src = '/poison-frame.html';
        document.body.appendChild(poisoned);
        // THE POISON: read contentWindow synchronously, before the frame has
        // committed. From here on Electron never injects the preload into it.
        void poisoned.contentWindow;
      </script>
    </body></html>`,
    '/poison-frame.html': `<!doctype html><html><head><meta charset="utf-8"></head><body>
      <p>${POISON_FRAME_MARKER}</p>
      <p>frame contact: ${POISON_EMAIL}</p>
      <p>frame server: ${POISON_IP}</p>
    </body></html>`,
    '/clean-frame.html': `<!doctype html><html><head><meta charset="utf-8"></head><body>
      <p>${CLEAN_FRAME_MARKER}</p>
      <p>frame contact: ${CLEAN_FRAME_EMAIL}</p>
    </body></html>`,
  };
  const server = http.createServer((req, res) => {
    const body = pages[new URL(req.url, 'http://x').pathname];
    if (!body) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(body);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, origin: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

// Snapshot of the probe page as one JSON-safe object; never throws so the
// waitFor polls can inspect partial states.
//
// The iframe is only inspected once the document is fully loaded. Reading an
// iframe's contentDocument/contentWindow BEFORE the frame has committed its
// document permanently prevents Electron from injecting the preload into that
// frame (electron/electron#34727): the probe would then destroy the very
// masking it is meant to verify, and fail intermittently under CPU contention.
// frameText stays null until then, which the polls treat as "not ready yet".
const PAGE_STATE_EXPR = `(() => {
  const body = document.body ? document.body.innerText : '';
  const opacity = getComputedStyle(document.documentElement).opacity;
  const f = document.querySelector('iframe');
  let frameText = null;
  try {
    if (document.readyState === 'complete' && f && f.contentDocument && f.contentDocument.body) {
      frameText = f.contentDocument.body.innerText;
    }
  } catch (e) { frameText = 'ERR:' + e.message; }
  return { body, opacity, frameText, url: location.href };
})()`;

// Snapshot of the poison page (scenario 10): for each of the two iframes, is
// its document text still raw, and is the element actually visible to a viewer?
//
// Three deliberate choices:
//   - contentDocument is read ONLY once the TOP document is complete. Reading
//     it earlier is itself the trigger of electron/electron#34727 and would
//     poison the #clean control frame too, destroying the anti-vacuity check.
//   - textContent, not innerText: innerText is layout-dependent and a gated
//     (visibility:hidden) frame can report an empty string, which would look
//     exactly like "masked" and let a real leak through.
//   - visibility is resolved through getComputedStyle (so an inherited or
//     stylesheet-driven gate counts) AND through the documentElement opacity
//     (the L0 shroud blanks the whole document, iframes included).
const POISON_STATE_EXPR = `(() => {
  const docOpacity = getComputedStyle(document.documentElement).opacity;
  const shrouded = Number(docOpacity) === 0;
  const isVisible = (el) => {
    if (!el || shrouded) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility !== 'visible' || cs.display === 'none') return false;
    if (Number(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const ready = document.readyState === 'complete';
  const textOf = (el) => {
    if (!ready || !el) return null;
    try {
      const d = el.contentDocument;
      return d && d.body ? d.body.textContent : null;
    } catch (e) { return 'ERR:' + e.message; }
  };
  const poisoned = document.getElementById('poisoned');
  const clean = document.getElementById('clean');
  return {
    // innerText here (not textContent): it keeps the inline poison script's
    // source out of the snapshot, which would otherwise drown every failure
    // message. The frames above still use textContent, where it matters.
    body: document.body ? document.body.innerText : '',
    docOpacity,
    poisonedPresent: poisoned !== null,
    poisonedText: textOf(poisoned),
    poisonedVisible: isVisible(poisoned),
    cleanPresent: clean !== null,
    cleanText: textOf(clean),
    cleanVisible: isVisible(clean),
    url: location.href,
  };
})()`;

// Evaluated on the CHROME UI target: the Stream Mode curtain is rendered by
// Chrome.tsx (data-testid="curtain"), never inside the page webContents.
const CURTAIN_UP_EXPR = `document.querySelector('[data-testid="curtain"]') !== null`;

/** True if a frame's text still carries either sensitive token verbatim. */
const rawInPoisonFrame = (text) =>
  typeof text === 'string' && (text.includes(POISON_EMAIL) || text.includes(POISON_IP));

/**
 * Poll the poison page until the frame guard has settled into a safe state,
 * failing on the FIRST observation of a leak instead of waiting it out.
 *
 * Called for BOTH phases of scenario 10, which are different code paths:
 *   - the page is LOADED with Stream Mode already on (the guard covers the
 *     frame as it commits: grace period, then fallback injection);
 *   - Stream Mode is TOGGLED ON over a page already painted raw (FrameGuard
 *     .onConfigChanged drops coverage and re-raises the gate, and the parent
 *     masker re-gates every iframe synchronously in the config push).
 * An initial load exercises only the first, so both are asserted.
 */
async function awaitGuardedPoisonPage(poisonPage, phase) {
  let ps = null;
  const start = Date.now();
  while (Date.now() - start < GUARD_TIMEOUT_MS) {
    if (exited) {
      throw new Error(`electron exited during the preload-less frame scenario (${phase})`);
    }
    try {
      ps = await poisonPage.evaluate(POISON_STATE_EXPR);
    } catch {
      // renderer busy / navigating: retry
      await sleep(150);
      continue;
    }

    // THE GUARANTEE. Raw sensitive text must never sit in a frame the viewer
    // can see. Fail on the FIRST observation; never wait a leak out.
    if (rawInPoisonFrame(ps.poisonedText) && ps.poisonedVisible) {
      throw new Error(
        `ZERO-FRAME LEAK (${phase}): the preload-less iframe is visible while still showing raw ${POISON_EMAIL} / ` +
          `${POISON_IP}. state: ${JSON.stringify(ps)}. That frame gets no preload (electron/electron#34727), hence no ` +
          `shroud and no masker: it must be gated by the parent (iframe element hidden pre-paint) and then covered by ` +
          `the fallback masker. See src/main/stream-mode/frameGuard.ts, src/injected/fallbackMask.ts and the parent ` +
          `gate in src/injected/streamMask.ts`,
      );
    }

    // The guard must PROTECT the page, not mutilate it: the iframe element
    // stays in the DOM (it has to come back on stream OFF, checked below).
    const poisonedLoaded =
      ps.poisonedPresent &&
      typeof ps.poisonedText === 'string' &&
      ps.poisonedText.includes(POISON_FRAME_MARKER);
    const poisonedSafe =
      poisonedLoaded && (!rawInPoisonFrame(ps.poisonedText) || !ps.poisonedVisible);

    // ANTI-VACUITY. A guard that simply hid every iframe forever would satisfy
    // the check above. The healthy sibling frame (its own preload + masker)
    // must end up MASKED and VISIBLE, on an unshrouded page.
    const cleanOk =
      ps.cleanPresent &&
      typeof ps.cleanText === 'string' &&
      ps.cleanText.includes(CLEAN_FRAME_MARKER) &&
      !ps.cleanText.includes(CLEAN_FRAME_EMAIL) &&
      ps.cleanVisible;

    if (poisonedSafe && cleanOk && ps.docOpacity === '1' && ps.body.includes(POISON_MARKER)) {
      return ps;
    }
    await sleep(150);
  }
  throw new Error(
    `preload-less frame never settled into a guarded state within ${GUARD_TIMEOUT_MS}ms (${phase}); last state: ` +
      `${JSON.stringify(ps)}. Expected: the poisoned iframe masked (fallback masker injected) or hidden (parent gate), ` +
      `AND the healthy #clean iframe masked AND visible on an unshrouded page`,
  );
}

const clients = [];
let probeServer = null;

function closeEverything() {
  for (const c of clients) c.close();
  if (probeServer) {
    probeServer.closeAllConnections?.();
    probeServer.close();
  }
  killTree();
}

const pass = (name) => console.log(`[smoke] ${name}: OK`);

async function main() {
  await assertPortFree();
  spawnElectron();

  const probe = await startProbeServer();
  probeServer = probe.server;
  const pageUrl = `${probe.origin}/page.html`;
  const page2Url = `${probe.origin}/page2.html`;
  const poisonUrl = `${probe.origin}/poison.html`;

  // --- 1. BOOT -------------------------------------------------------------
  await waitFor('CDP endpoint', async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
    return r.ok;
  });

  const uiTarget = await waitFor('chrome UI page target', async () => {
    const list = await listTargets();
    return list.find(
      (t) => t.type === 'page' && t.url.includes('index.html') && t.url.includes('chrome=1'),
    );
  });

  const fatal = output.match(/(Uncaught \w*Error|Unable to load preload script)[^\n]*/g) ?? [];
  if (fatal.length > 0) {
    throw new Error(`fatal errors during boot:\n${fatal.join('\n')}`);
  }
  pass('BOOT');

  // --- 2. UI ALIVE -----------------------------------------------------------
  const ui = await CdpClient.connect(uiTarget.webSocketDebuggerUrl, 'chrome UI');
  clients.push(ui);
  // Collect renderer exceptions on the chrome UI target for the whole run
  // (checked in scenario 10).
  const uiExceptions = [];
  ui.on('Runtime.exceptionThrown', (p) => {
    uiExceptions.push(
      p?.exceptionDetails?.exception?.description ?? p?.exceptionDetails?.text ?? 'unknown',
    );
  });

  await waitFor(
    'chrome UI alive (window.voksa + mounted React root)',
    async () => {
      const s = await ui.evaluate(`({
        voksa: typeof window.voksa,
        create: typeof (window.voksa && window.voksa.tabs && window.voksa.tabs.create),
        rootChildren: (() => { const r = document.getElementById('root'); return r ? r.childElementCount : -1; })(),
      })`);
      return s.voksa === 'object' && s.create === 'function' && s.rootChildren > 0;
    },
    STEP_TIMEOUT_MS,
    'voksa bridge missing or React did not mount; check preload/ui.ts and dist-ui build',
  );
  pass('UI ALIVE');

  // --- 3. EXTENSIONS ---------------------------------------------------------
  await waitFor(
    'extension runtime ready logs',
    () => output.includes(EXT_RUNTIME_READY) && output.includes(EXT_WEBSTORE_READY),
    30_000,
    `expected both "${EXT_RUNTIME_READY}" and "${EXT_WEBSTORE_READY}" on stdout; check setupChromeWebStore in src/main/extensions/webstore.ts`,
  );
  pass('EXTENSIONS');

  // --- 4. REAL PAGE LOADS ----------------------------------------------------
  // Precondition: stream OFF. A fresh profile boots with the default config
  // (enabled: false), but autoStreamOnRecorder can flip it ON at boot when a
  // real recorder (OBS...) runs on the host machine; force it OFF so the
  // raw-text assertion below stays meaningful everywhere.
  const bootCfg = await ui.evaluate(`window.voksa.stream.get()`);
  if (bootCfg?.enabled) {
    // On CI runners no recorder process (OBS...) can be running, so a fresh
    // profile booting with stream ON can only mean a regression; never
    // launder it into a warning there.
    if (process.env.CI) {
      throw new Error('fresh profile booted with Stream Mode ON: default config or boot logic regressed');
    }
    console.log('[smoke] warning: Stream Mode ON at boot (recorder running?); forcing OFF');
    await ui.evaluate(`window.voksa.stream.update({ enabled: false })`);
  }

  const tabId = await ui.evaluate(`window.voksa.tabs.create(${JSON.stringify(pageUrl)})`);
  if (typeof tabId !== 'string' || tabId.length === 0) {
    throw new Error(`voksa.tabs.create did not return a tab id (got ${JSON.stringify(tabId)})`);
  }

  const pageTarget = await waitFor(
    'probe page CDP target',
    async () => {
      const list = await listTargets();
      return list.find((t) => t.type === 'page' && t.url === pageUrl);
    },
    STEP_TIMEOUT_MS,
    'tab created but its webContents never navigated to the probe URL',
  );
  const page = await CdpClient.connect(pageTarget.webSocketDebuggerUrl, 'probe page');
  clients.push(page);

  let state = null;
  try {
    await waitFor(
      'probe page rendered with raw text and iframe',
      async () => {
        state = await page.evaluate(PAGE_STATE_EXPR);
        return (
          state.body.includes(PROBE_EMAIL) &&
          state.body.includes(PROBE_IP) &&
          typeof state.frameText === 'string' &&
          state.frameText.includes(FRAME_EMAIL)
        );
      },
      STEP_TIMEOUT_MS,
    );
  } catch (err) {
    throw new Error(
      `${err.message}; last state: ${JSON.stringify(state)} (stream is OFF so the raw email/IP and the same-origin iframe text must be visible)`,
    );
  }
  pass('REAL PAGE LOADS');

  // --- 5. FINGERPRINT --------------------------------------------------------
  const fp = await page.evaluate(`({
    webdriver: typeof navigator.webdriver === 'undefined' ? 'undefined' : String(navigator.webdriver),
    chrome: !!window.chrome,
    ua: navigator.userAgent,
  })`);
  if (fp.webdriver !== 'undefined') {
    throw new Error(
      `navigator.webdriver is ${fp.webdriver}, expected undefined; webdriver patch in preload/page.ts broken`,
    );
  }
  if (!fp.chrome) {
    throw new Error('window.chrome is missing; chrome stub in preload/page.ts broken');
  }
  if (!fp.ua.includes('Chrome/') || /Electron|Firefox|Voksa/.test(fp.ua)) {
    throw new Error(`user agent leaks the embedded browser: "${fp.ua}"; check src/main/ua.ts`);
  }
  pass('FINGERPRINT');

  // --- 6. STREAM MASKS LIVE PAGES ---------------------------------------------
  const cfg = await ui.evaluate(`window.voksa.stream.update({ enabled: true })`);
  if (!cfg || cfg.enabled !== true || cfg.maskEmails !== true || cfg.maskIPv4 !== true) {
    throw new Error(
      `stream.update({enabled:true}) returned ${JSON.stringify(cfg)}; expected enabled with default email/IPv4 masks on`,
    );
  }

  try {
    await waitFor(
      'live page masked without staying shrouded',
      async () => {
        state = await page.evaluate(PAGE_STATE_EXPR);
        return (
          !state.body.includes(PROBE_EMAIL) &&
          !state.body.includes(PROBE_IP) &&
          state.opacity === '1' &&
          typeof state.frameText === 'string' &&
          !state.frameText.includes(FRAME_EMAIL)
        );
      },
      STREAM_TIMEOUT_MS,
    );
  } catch (err) {
    throw new Error(
      `${err.message}; last state: ${JSON.stringify(state)} (body must lose the email/IP, iframe must lose its email, opacity must be back to 1: check streamMask.ts sweep + shroud lift in preload/page.ts)`,
    );
  }
  pass('STREAM MASKS LIVE PAGES');

  // --- 7. STREAM NAVIGATION NOT STUCK ------------------------------------------
  await ui.evaluate(
    `window.voksa.tabs.navigate(${JSON.stringify(tabId)}, ${JSON.stringify(page2Url)})`,
  );
  // The 5s budget is deliberately under the 6s curtain fail-to-blank: a stuck
  // curtain AND the fail-to-blank fallback both go red here.
  let curtainUp = null;
  try {
    await waitFor(
      'navigation under stream settles masked, unshrouded and curtain-free',
      async () => {
        state = await page.evaluate(PAGE_STATE_EXPR);
        curtainUp = await ui.evaluate(CURTAIN_UP_EXPR);
        return (
          state.body.includes(PAGE2_MARKER) &&
          !state.body.includes(PAGE2_EMAIL) &&
          state.opacity === '1' &&
          curtainUp === false
        );
      },
      STREAM_TIMEOUT_MS,
    );
  } catch (err) {
    throw new Error(
      `${err.message} (curtain fail-to-blank is 6s); last state: ${JSON.stringify(state)}, curtain up: ${JSON.stringify(curtainUp)} (new doc must show ${PAGE2_MARKER}, hide the email, lift the shroud, and drop the chrome UI curtain)`,
    );
  }
  pass('STREAM NAVIGATION NOT STUCK');

  // --- 8. STREAM OFF RESTORES ---------------------------------------------------
  await ui.evaluate(`window.voksa.stream.update({ enabled: false })`);
  await waitFor(
    'stream OFF restores the raw DOM',
    async () => {
      state = await page.evaluate(PAGE_STATE_EXPR);
      // opacity too: a re-applied shroud would blank the page while the
      // innerText still matches.
      return state.body.includes(PAGE2_EMAIL) && state.opacity === '1';
    },
    STREAM_TIMEOUT_MS,
    'masker WeakMap restore in injected/streamMask.ts did not bring the original text back (or a re-applied shroud kept the page blank)',
  );
  // Toggle-OFF drops every curtain (TabManager config-changed loop): none may
  // survive in the chrome UI.
  if (await ui.evaluate(CURTAIN_UP_EXPR)) {
    throw new Error(
      'curtain element still present in the chrome UI after stream OFF; TabManager toggle-OFF curtain drop regressed',
    );
  }
  pass('STREAM OFF RESTORES');

  // --- 9. TAB CLOSE NO LEAK ------------------------------------------------------
  const pagesBefore = (await listTargets()).filter((t) => t.type === 'page').length;
  const tabs = await ui.evaluate(`window.voksa.tabs.list()`);
  const probeTab = (tabs ?? []).find((t) => t.url.startsWith(probe.origin));
  if (!probeTab) {
    throw new Error(
      `voksa.tabs.list() has no tab on ${probe.origin}; got ${JSON.stringify(
        (tabs ?? []).map((t) => t.url),
      )}`,
    );
  }
  // The page target dies with the tab; drop our socket first.
  page.close();
  await ui.evaluate(`window.voksa.tabs.close(${JSON.stringify(probeTab.id)})`);

  await waitFor(
    'probe tab webContents destroyed',
    async () => {
      const list = await listTargets();
      const stillThere = list.some((t) => t.type === 'page' && t.url.startsWith(probe.origin));
      const pagesNow = list.filter((t) => t.type === 'page').length;
      return !stillThere && pagesNow <= pagesBefore - 1;
    },
    STREAM_TIMEOUT_MS,
    'Tab.destroy leak: the closed tab still has a live CDP page target (see CLAUDE.md 4.7)',
  );
  pass('TAB CLOSE NO LEAK');

  // --- 10. STREAM GUARDS PRELOAD-LESS FRAME --------------------------------------
  // The zero-frame guarantee, on the one frame flavour the three-layer design
  // cannot reach on its own: an iframe whose contentWindow was touched before
  // it committed gets NO preload from Electron (electron/electron#34727), so it
  // has neither the L0 shroud nor the L1 masker. The page is loaded with Stream
  // Mode ALREADY ON, which is the strict case: nothing may ever paint raw.
  await ui.evaluate(`window.voksa.stream.update({ enabled: true })`);
  const poisonTabId = await ui.evaluate(`window.voksa.tabs.create(${JSON.stringify(poisonUrl)})`);
  if (typeof poisonTabId !== 'string' || poisonTabId.length === 0) {
    throw new Error(
      `voksa.tabs.create did not return a tab id for the poison page (got ${JSON.stringify(poisonTabId)})`,
    );
  }

  const poisonTarget = await waitFor(
    'poison page CDP target',
    async () => {
      const list = await listTargets();
      return list.find((t) => t.type === 'page' && t.url === poisonUrl);
    },
    STEP_TIMEOUT_MS,
    'tab created but its webContents never navigated to the poison URL',
  );
  const poisonPage = await CdpClient.connect(poisonTarget.webSocketDebuggerUrl, 'poison page');
  clients.push(poisonPage);

  // Phase A: the page LOADED with Stream Mode already on.
  await awaitGuardedPoisonPage(poisonPage, 'page loaded under Stream Mode');

  // Stream OFF must undo everything the guard did: drop the iframe gate and
  // have the fallback masker restore the original DOM text. A gate that
  // survives the toggle leaves the page permanently broken.
  await ui.evaluate(`window.voksa.stream.update({ enabled: false })`);
  let offState = null;
  try {
    await waitFor(
      'stream OFF ungates the preload-less frame and restores both frames',
      async () => {
        offState = await poisonPage.evaluate(POISON_STATE_EXPR);
        return (
          offState.docOpacity === '1' &&
          offState.poisonedVisible &&
          rawInPoisonFrame(offState.poisonedText) &&
          offState.cleanVisible &&
          typeof offState.cleanText === 'string' &&
          offState.cleanText.includes(CLEAN_FRAME_EMAIL)
        );
      },
      STREAM_TIMEOUT_MS,
    );
  } catch (err) {
    throw new Error(
      `${err.message}; last state: ${JSON.stringify(offState)} (with stream OFF there must be no gate and no fallback ` +
        `masker left: both iframes visible with their original text back)`,
    );
  }

  // Phase B: Stream Mode toggled ON over a page that is ALREADY painted raw.
  // The state above is exactly the dangerous starting point (preload-less frame
  // visible, showing its email and IP), and this is the path a user actually
  // takes when they start streaming. It runs through FrameGuard.onConfigChanged
  // (coverage dropped, gate re-raised, fallback re-injected with the new config)
  // rather than the commit path of phase A, so a guard that only worked on load
  // would leak here.
  await ui.evaluate(`window.voksa.stream.update({ enabled: true })`);
  await awaitGuardedPoisonPage(poisonPage, 'Stream Mode toggled ON over an already painted page');
  await ui.evaluate(`window.voksa.stream.update({ enabled: false })`);
  pass('STREAM GUARDS PRELOAD-LESS FRAME');

  // --- 11. MULTI-WINDOW ------------------------------------------------------
  // A second browser window opened from the first (voksa.window.openNew) must
  // boot its own chrome UI, keep its tab list fully isolated from window 1,
  // and die cleanly when closed: its chrome UI target disappears while
  // window 1 keeps working.
  const chromeUiTargets = async () =>
    (await listTargets()).filter(
      (t) => t.type === 'page' && t.url.includes('index.html') && t.url.includes('chrome=1'),
    );

  const w1TabsBefore = (await ui.evaluate(`window.voksa.tabs.list()`)).length;
  await ui.evaluate(`window.voksa.window.openNew()`);
  await waitFor(
    'second chrome UI target',
    async () => (await chromeUiTargets()).length >= 2,
    STEP_TIMEOUT_MS,
    'voksa.window.openNew() produced no second chrome UI; check the WINDOW_NEW handler and the window factory wiring in src/main/index.ts',
  );
  const secondTarget = (await chromeUiTargets()).find((t) => t.id !== uiTarget.id);
  if (!secondTarget) {
    throw new Error('two chrome UI targets reported but none differs from window 1');
  }
  const ui2 = await CdpClient.connect(secondTarget.webSocketDebuggerUrl, 'second chrome UI');
  clients.push(ui2);

  await waitFor(
    'second window UI alive with its own fresh tab',
    async () => {
      const s = await ui2.evaluate(`({
        voksa: typeof window.voksa,
        tabs: typeof window.voksa === 'object' ? (window.voksa.tabs ? -2 : -3) : -4,
      })`);
      if (s.voksa !== 'object') return false;
      const list = await ui2.evaluate(`window.voksa.tabs.list()`);
      return Array.isArray(list) && list.length === 1;
    },
    STEP_TIMEOUT_MS,
    'window 2 chrome UI never exposed voksa with exactly one fresh tab; per-sender IPC routing in src/main/ipc/handlers.ts likely serves the wrong TabManager',
  );

  // Isolation, both directions: creating a tab in window 2 must not touch
  // window 1's list, and window 1's count must have survived the new window.
  await ui2.evaluate(`window.voksa.tabs.create('voksa://settings')`);
  await waitFor(
    'tab created in window 2 stays in window 2',
    async () => (await ui2.evaluate(`window.voksa.tabs.list()`)).length === 2,
    STEP_TIMEOUT_MS,
  );
  const w1TabsAfter = (await ui.evaluate(`window.voksa.tabs.list()`)).length;
  if (w1TabsAfter !== w1TabsBefore) {
    throw new Error(
      `window 1 tab count changed from ${w1TabsBefore} to ${w1TabsAfter} while acting on window 2: tab isolation broken`,
    );
  }

  // Close window 2 from its own chrome UI (deferred so the CDP reply gets
  // out before the target dies), then window 1 must still answer.
  await ui2.evaluate(`(setTimeout(() => window.voksa.window.close(), 50), true)`);
  await waitFor(
    'second window torn down',
    async () => (await chromeUiTargets()).length === 1,
    STEP_TIMEOUT_MS,
    'window 2 chrome UI target survived voksa.window.close(); check WINDOW_CLOSE sender routing',
  );
  const w1Alive = (await ui.evaluate(`window.voksa.tabs.list()`)).length;
  if (w1Alive !== w1TabsBefore) {
    throw new Error(
      `window 1 lost tabs when window 2 closed (${w1TabsBefore} -> ${w1Alive}); per-window teardown leaked across windows`,
    );
  }
  pass('MULTI-WINDOW');

  // --- 12. NO RENDERER EXCEPTIONS -------------------------------------------------
  if (uiExceptions.length > 0) {
    throw new Error(
      `chrome UI threw ${uiExceptions.length} uncaught exception(s) during the run:\n${uiExceptions.join('\n')}`,
    );
  }
  pass('NO RENDERER EXCEPTIONS');

  console.log('[smoke] OK');
}

// Hang protection: a wedged CDP socket or child process could stall a step
// forever despite the per-step timeouts. Deliberately NOT unref'd so it can
// fire even on an otherwise empty event loop; cleared on every normal path.
const watchdog = setTimeout(() => {
  console.error('[smoke] FAILED: global watchdog (180s), run hung');
  closeEverything();
  process.exit(1);
}, 180_000);

main()
  .then(() => {
    clearTimeout(watchdog);
    closeEverything();
    process.exitCode = 0;
  })
  .catch((err) => {
    clearTimeout(watchdog);
    console.error(`[smoke] FAILED: ${err.message}`);
    closeEverything();
    process.exitCode = 1;
  })
  .finally(async () => {
    // Keep the process alive long enough for Windows to release its locks on
    // the profile dir (an unref'd timer on an empty loop would never run).
    await sleep(1500);
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      // profile dir may still be held; non-fatal
    }
  });
