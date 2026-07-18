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
//  12. MEMORY SAVER: discarding a background tab destroys its renderer (its
//      CDP page target disappears: the only real proof the memory came back)
//      WITHOUT closing the tab, and re-activating it rebuilds the page with a
//      back/forward history that actually walks.
//  13. MEMORY SAVER REVIVE UNDER STREAM: reviving a dormant tab while Stream
//      Mode is on must never paint the replayed page raw. The revive is watched
//      frame by frame: a visible page still showing the probe email is a leak.
//  14. ABOUT LOGO LOADS: the settings About card really decodes the product
//      icon over file:// (a broken <img> there fails silently).
//  15. INTERNAL URL VISIBLE: an internal page shows its voksa:// address in the
//      bar, the new tab page keeps it empty, and voksa://search really renders
//      (a missing slug registration falls back to NewTab in silence).
//  16. TAB-TO-SEARCH KEYWORDS: "duckduckgo.com cats" searches DDG, while
//      "duckduckgo.com" alone still navigates to the site.
//  17. PDF IN TAB: a .pdf URL renders inside the tab (viewer embed present),
//      it does not silently become a download. Also OBSERVES (logs, no
//      assertion) what a PDF does under Stream Mode, to keep the docs honest.
//  18. BASIC AUTH: a 401 challenge raises the chrome-UI credentials dialog;
//      submitting loads the protected page, cancelling renders the 401 body
//      without looping the dialog.
//  19. TLS INTERSTITIAL: a self-signed https server never receives a request
//      before the user proceeds (hit counter is the anti-leak proof), the
//      interstitial renders in the chrome UI, and "continue anyway" loads the
//      page.
//  20. PINNED TABS: pinning re-homes the tab into the left cluster, a reorder
//      that interleaves the cluster is snapped back by main, and
//      "close others" spares pinned tabs.
//  21. DMCA AUDIO GUARD: under Stream Mode a BACKGROUND tab that plays audio
//      is guard-muted (streamMuted, separate from the user's mute), stays
//      muted on activation (the chip is the only exit), un-mutes on explicit
//      allow, and Stream OFF restores the exact prior state. Reduced to
//      wiring-only checks (loudly logged) when the environment renders no
//      audio at all (headless CI without an audio device).
//  22. PANIC: voksa.stream.panic() (the same action the global hotkey fires)
//      curtains the window, arms Stream Mode, and reports active; the second
//      call restores the curtain but leaves the stream armed on purpose.
//  23. CAPTURE HANDSHAKE: driving the controller (getDisplayMedia does not
//      route to setDisplayMediaRequestHandler under CDP, so a debug seam
//      enters the SAME path) raises OUR picker, picking a Voksa source arms
//      Stream Mode before the source is delivered, and the delivered id is the
//      one picked.
//  24. GO-LIVE PREFLIGHT: a tab whose title carries an email is flagged (with
//      a MASKED preview), a clean profile flags nothing (anti-vacuity), and
//      the flag names a real tab id.
//  25. NO RENDERER EXCEPTIONS: no Runtime.exceptionThrown on the chrome UI
//      target during the whole run.
//
// Catches boot crashes, preload failures, a blank chrome UI, a broken voksa
// bridge, stream masking regressions, unprotected subframes and leaked
// webContents; none of which unit tests can see.
//
// Usage: npm run build && node scripts/smoke.mjs
// (on Linux CI wrap with `xvfb-run -a`)
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import selfsigned from 'selfsigned';

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

// Scenarios 18-19 (auth + TLS). Markers are unmaskable by construction.
const AUTH_USER = 'smokeuser';
const AUTH_PASS = 'smokepass';
const AUTH_OK_MARKER = 'AUTH-GRANTED-PAGE';
const AUTH_DENIED_MARKER = 'AUTH-DENIED-BODY';
const TLS_OK_MARKER = 'TLS-PAGE-LOADED';

// Exact ready lines printed by src/main/extensions/webstore.ts.
const EXT_RUNTIME_READY = '[extensions] Chrome extension runtime ready.';
const EXT_WEBSTORE_READY = '[extensions] Chrome Web Store ready on session.';

// Isolated profile: never touch a real user profile, never fight another
// running instance for the single-instance lock.
const profile = mkdtempSync(path.join(os.tmpdir(), 'voksa-smoke-'));

// Pin the profile to FRENCH before first boot (the effective userData is
// <profile>/voksa: index.ts re-pins userData under appData). This makes the
// extension-contract i18n assertion deterministic on English CI runners too:
// the Chromium lang switch and the localized getMessage patch must resolve
// the fixture's fr catalog whatever the host OS speaks. No smoke assertion
// matches language-dependent UI text (the one textual click handles both
// Annuler/Cancel), so the rest of the suite is unaffected. startupMode is
// pinned too: an existing settings.json without the key would be migrated to
// 'restore' (CLAUDE.md 4.13), and the suite expects a new-tab boot.
mkdirSync(path.join(profile, 'voksa'), { recursive: true });
writeFileSync(
  path.join(profile, 'voksa', 'settings.json'),
  JSON.stringify({ language: 'fr', startupMode: 'newtab' }),
);

// The contract fixture (scenario 26) is loaded through the debug-only seam in
// src/main/index.ts; the harness just points at it.
const CONTRACT_EXT_DIR = path.join(root, 'scripts', 'fixtures', 'contract-extension');

const env = {
  ...process.env,
  VOKSA_DEBUG_PROFILE: profile,
  VOKSA_DEBUG_PORT: String(PORT),
  VOKSA_DEBUG_LOAD_EXTENSION: CONTRACT_EXT_DIR,
  // Linux resolves the Chromium locale from the LAUNCH environment; --lang
  // and env vars set later from the main process both come too late for the
  // browser-side extension catalogs (lived: the i18n contract assertion
  // stayed English on the Linux runner only). Pinning the environment here
  // is exactly "a French Linux user": the profile language (seeded above)
  // and the process locale agree, like they do for real users. Harmless on
  // Windows/macOS, which follow --lang.
  LANGUAGE: 'fr',
  LANG: 'fr_FR.UTF-8',
};
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
  // NO --no-sandbox, EVER (it used to be passed on CI): without the sandbox,
  // Electron never attaches service-worker preload realms, so every
  // extension API the runtime injects into MV3 workers vanishes and their
  // service workers die at module evaluation. Lived: the extension contract
  // scenario was red on all three CI OSes while green locally, and the flag
  // was the only difference. Its original reason was Linux-only anyway
  // (Ubuntu 24 restricts unprivileged user namespaces): ci.yml now lifts
  // that restriction with a sysctl instead, so the sandbox, and with it the
  // production behaviour, is what gets tested.
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
  async evaluate(expression, { userGesture = false } = {}) {
    const { result, exceptionDetails } = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      // getDisplayMedia needs a transient user activation; CDP can supply one.
      userGesture,
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
    // Scenario 24: a page whose TITLE carries an email, for the preflight scan.
    '/leaky-title.html': `<!doctype html><html><head><meta charset="utf-8">
      <title>Inbox ${FRAME_EMAIL}</title></head><body><p>leaky title page</p></body></html>`,
    // Scenario 21: a page that plays a quiet tone as soon as it loads, so the
    // tab's audible flag flips (Electron's default autoplay policy allows an
    // AudioContext without a user gesture).
    '/audio.html': `<!doctype html><html><head><meta charset="utf-8"></head><body>
      <p>AUDIO-PAGE-LOADED</p>
      <script>
        const ctx = new AudioContext();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        gain.gain.value = 0.02;
        osc.frequency.value = 440;
        osc.connect(gain).connect(ctx.destination);
        osc.start();
        if (ctx.state === 'suspended') void ctx.resume();
      </script>
    </body></html>`,
    // Scenario 25: audio routing. An ATTACHED media element (routed by the
    // isolated-world sweep); detached Audio()s and AudioContexts are created
    // from the test itself to exercise the main-world patch. The inline
    // script creates a DETACHED element that plays at document-start, i.e.
    // BEFORE the async device enumeration can possibly have resolved: on a
    // routed document it must still end up routed (the play wrap remembers
    // unconditionally), or it would sit on the system default forever while
    // the tab claims routed.
    '/route-audio.html': `<!doctype html><html><head><meta charset="utf-8"></head><body>
      <p>ROUTE-AUDIO-PAGE</p>
      <audio id="probe-audio"></audio>
      <script>
        window.__earlyAudio = new Audio();
        window.__earlyAudio.loop = true;
        window.__earlyAudio.play().catch(function () {});
      </script>
    </body></html>`,
  };
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://x').pathname;

    // Scenario 17: a real (tiny) PDF, served with the PDF content type. If
    // tabs lack `plugins: true` this becomes a download instead of a page.
    if (pathname === '/doc.pdf') {
      res.writeHead(200, { 'Content-Type': 'application/pdf' }).end(tinyPdf());
      return;
    }

    // Scenario 18: HTTP Basic Auth. /protected accepts the smoke credentials;
    // /protected-cancel NEVER accepts, whatever is sent: after a successful
    // login Chromium re-sends cached credentials for the same origin on its
    // own, so a route that accepted them would never re-challenge and the
    // cancel path would have nothing to cancel.
    if (pathname === '/protected' || pathname === '/protected-cancel') {
      const expected = `Basic ${Buffer.from(`${AUTH_USER}:${AUTH_PASS}`).toString('base64')}`;
      if (pathname === '/protected' && req.headers.authorization === expected) {
        res
          .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          .end(`<!doctype html><body><p>${AUTH_OK_MARKER}</p></body>`);
      } else {
        res
          .writeHead(401, {
            'WWW-Authenticate': `Basic realm="voksa-smoke${pathname === '/protected-cancel' ? '-cancel' : ''}"`,
            'Content-Type': 'text/html; charset=utf-8',
          })
          .end(`<!doctype html><body><p>${AUTH_DENIED_MARKER}</p></body>`);
      }
      return;
    }

    const body = pages[pathname];
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

/**
 * A syntactically complete one-page PDF with computed xref offsets: enough for
 * Chromium's viewer to render without repair heuristics.
 */
function tinyPdf() {
  const objs = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>',
  ];
  let body = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj${o}endobj\n`;
  });
  const xrefPos = body.length;
  body += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) body += `${String(off).padStart(10, '0')} 00000 n \n`;
  body += `trailer<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xrefPos}\n%%EOF`;
  return body;
}

/**
 * Self-signed https server for the TLS interstitial scenario. The key/cert
 * pair is generated FRESH per run (devDependency `selfsigned`), never checked
 * in: `*.pem` is gitignored on purpose, and a committed private key, even a
 * harmless test one, trips secret scanning and trains everyone to ignore it.
 * The hit counter is the scenario's anti-leak proof: certificate-error aborts
 * during the handshake, so a request that reaches the handler before the user
 * proceeded would mean the rejection path is broken.
 */
async function startTlsServer() {
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'localhost' }], {
    days: 365,
    keySize: 2048,
    extensions: [
      {
        name: 'subjectAltName',
        altNames: [
          { type: 7, ip: '127.0.0.1' },
          { type: 2, value: 'localhost' },
        ],
      },
    ],
  });
  const key = pems.private;
  const cert = pems.cert;
  let hits = 0;
  const server = https.createServer({ key, cert }, (_req, res) => {
    hits += 1;
    res
      .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      .end(`<!doctype html><body><p>${TLS_OK_MARKER}</p></body>`);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        origin: `https://127.0.0.1:${server.address().port}`,
        hits: () => hits,
      });
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
let tlsServer = null;

function closeEverything() {
  for (const c of clients) c.close();
  if (probeServer) {
    probeServer.closeAllConnections?.();
    probeServer.close();
  }
  if (tlsServer) {
    tlsServer.closeAllConnections?.();
    tlsServer.close();
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

  // --- 12. MEMORY SAVER: DISCARD FREES THE RENDERER, REVIVE KEEPS HISTORY -----
  // Three things must hold, and each has a way of silently not holding:
  //  (a) the discard REALLY destroys the renderer. Its CDP page target dying is
  //      the only observable proof memory came back: a tab merely parked
  //      off-screen (what an inactive tab is today) keeps its target.
  //  (b) a discard is NOT a close. electron-chrome-extensions relays every
  //      webContents destruction back into TabManager.close(), so a wrong
  //      ordering in discard() closes the tab instead of freeing it.
  //  (c) activating it brings the page back WITH its session history
  //      (navigationHistory.getAllEntries -> restore), not just the URL.
  const J = JSON.stringify;

  const victimId = await ui.evaluate(`window.voksa.tabs.create(${J(pageUrl)})`);
  // The first load must COMMIT before we navigate away, or the second
  // navigation replaces it and the tab ends up with no back entry at all.
  await waitFor(
    'victim tab settled on page 1',
    async () => {
      const v = (await ui.evaluate(`window.voksa.tabs.list()`)).find((t) => t.id === victimId);
      return v?.url === pageUrl && v?.isLoading === false;
    },
    STEP_TIMEOUT_MS,
  );
  await ui.evaluate(`window.voksa.tabs.navigate(${J(victimId)}, ${J(page2Url)})`);
  // Anti-vacuity: the tab must really HAVE back history, or the assertion that
  // it survives the discard would pass on an empty history.
  await waitFor(
    'victim has back history before the discard',
    async () => {
      const list = await ui.evaluate(`window.voksa.tabs.list()`);
      const v = list.find((t) => t.id === victimId);
      return v?.url === page2Url && v?.canGoBack === true;
    },
    STEP_TIMEOUT_MS,
    'the victim tab never got a back entry: the history assertions below would be vacuous',
  );

  // The active tab is never discardable (by policy AND by discard() itself):
  // move focus off the victim first.
  const tabsBefore = await ui.evaluate(`window.voksa.tabs.list()`);
  const otherId = tabsBefore.find((t) => t.id !== victimId)?.id;
  if (!otherId) throw new Error('no second tab to focus: cannot test a background discard');
  await ui.evaluate(`window.voksa.tabs.activate(${J(otherId)})`);

  const discarded = await ui.evaluate(`window.voksa.tabs.discard(${J(victimId)})`);
  if (discarded !== true) {
    throw new Error(`voksa.tabs.discard returned ${J(discarded)}, expected true`);
  }

  // (a) THE RENDERER IS REALLY GONE.
  await waitFor(
    'discarded tab has no CDP page target left',
    async () => !(await listTargets()).some((t) => t.type === 'page' && t.url === page2Url),
    STEP_TIMEOUT_MS,
    'the discarded tab still owns a live CDP page target: its webContents was not closed, so NO memory was freed (see TabManager.discard + teardownView in src/main/tabs/Tab.ts)',
  );

  // (b) A DISCARD IS NOT A CLOSE.
  const tabsAfter = await ui.evaluate(`window.voksa.tabs.list()`);
  const victim = tabsAfter.find((t) => t.id === victimId);
  if (!victim) {
    throw new Error(
      'the discarded tab vanished from the tab strip: the electron-chrome-extensions destruction relay closed it. discard() must sever the tab from its webContents (detachView + frame guard dispose) BEFORE calling unregisterTabFromExtensions',
    );
  }
  if (tabsAfter.length !== tabsBefore.length) {
    throw new Error(
      `tab count changed on discard (${tabsBefore.length} -> ${tabsAfter.length}): freeing memory must not close anything`,
    );
  }
  if (victim.isDiscarded !== true) throw new Error('TabState.isDiscarded is not true after a discard');
  if (victim.url !== page2Url) throw new Error(`the discarded tab lost its url: ${victim.url}`);
  if (victim.canGoBack !== true) throw new Error('the discarded tab lost its back history in TabState');

  // (c) REVIVE: same document, and a history that is actually navigable.
  await ui.evaluate(`window.voksa.tabs.activate(${J(victimId)})`);
  const revivedTarget = await waitFor(
    'revived page CDP target',
    async () => (await listTargets()).find((t) => t.type === 'page' && t.url === page2Url),
    STEP_TIMEOUT_MS,
    'activating a discarded tab did not rebuild its webContents (see TabManager.reviveTab)',
  );
  const revived = await CdpClient.connect(revivedTarget.webSocketDebuggerUrl, 'revived page');
  clients.push(revived);
  await waitFor(
    'revived page painted the same document, unshrouded',
    async () => {
      const s = await revived.evaluate(PAGE_STATE_EXPR);
      return s.body.includes(PAGE2_MARKER) && s.opacity === '1';
    },
    STEP_TIMEOUT_MS,
    'the revived tab has a target but never painted its page (see Tab.restoreNavigation)',
  );
  await waitFor(
    'revived tab is no longer dormant and kept its back history',
    async () => {
      const v = (await ui.evaluate(`window.voksa.tabs.list()`)).find((t) => t.id === victimId);
      return v?.isDiscarded === false && v?.canGoBack === true;
    },
    STEP_TIMEOUT_MS,
    'canGoBack is false after the revive: navigationHistory.restore({entries,index}) did not replay the session history (see Tab.captureNavigation / Tab.restoreNavigation)',
  );

  // And the restored history actually WALKS, not just reports a boolean.
  await ui.evaluate(`window.voksa.tabs.back(${J(victimId)})`);
  await waitFor(
    'going back from a revived tab reaches the pre-discard entry',
    async () => (await listTargets()).some((t) => t.type === 'page' && t.url === pageUrl),
    STEP_TIMEOUT_MS,
    'back after a revive did not reach the entry that preceded the discard: the restored history is not navigable',
  );
  pass('MEMORY SAVER DISCARD/REVIVE');

  // --- 13. MEMORY SAVER UNDER STREAM MODE: A REVIVE MUST NOT LEAK ----------------
  // A revive rebuilds a webContents and replays a navigation while Stream Mode
  // is on. That is exactly the situation the whole L0/L1.5/L2 stack exists for,
  // except the tab arrives with no view at all, so the ordering is its own code
  // path (curtain BEFORE the view exists, then shroud, then guard, then the
  // document). If it were wrong, the first frame of the replayed page would be
  // painted raw: an unmasked email, on screen, mid-stream.
  await ui.evaluate(`window.voksa.stream.update({ enabled: true })`);
  await ui.evaluate(`window.voksa.tabs.activate(${J(victimId)})`);
  await ui.evaluate(`window.voksa.tabs.navigate(${J(victimId)}, ${J(page2Url)})`);
  await waitFor(
    'victim is masked under Stream before the discard',
    async () => {
      const s = await revived.evaluate(PAGE_STATE_EXPR);
      return s.body.includes(PAGE2_MARKER) && !s.body.includes(PAGE2_EMAIL) && s.opacity === '1';
    },
    STEP_TIMEOUT_MS,
    'the victim tab never reached a masked-and-visible state under Stream: the leak assertions below would be vacuous',
  );

  await ui.evaluate(`window.voksa.tabs.activate(${J(otherId)})`);
  if ((await ui.evaluate(`window.voksa.tabs.discard(${J(victimId)})`)) !== true) {
    throw new Error('discard under Stream Mode returned false');
  }
  await waitFor(
    'stream victim renderer is gone',
    async () => !(await listTargets()).some((t) => t.type === 'page' && t.url === page2Url),
    STEP_TIMEOUT_MS,
  );

  // Revive, then WATCH. Every sample that shows the raw email while the page is
  // actually visible (opacity 1) is a leaked frame. This cannot prove the
  // absence of a leak between two samples, but it is the same detector the
  // preload-less frame scenario uses, and it caught real regressions there.
  await ui.evaluate(`window.voksa.tabs.activate(${J(victimId)})`);
  const streamTarget = await waitFor(
    'revived-under-stream page target',
    async () => (await listTargets()).find((t) => t.type === 'page' && t.url === page2Url),
    STEP_TIMEOUT_MS,
  );
  const streamRevived = await CdpClient.connect(streamTarget.webSocketDebuggerUrl, 'revived under stream');
  clients.push(streamRevived);

  let maskedAndVisible = false;
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    let s;
    try {
      s = await streamRevived.evaluate(PAGE_STATE_EXPR);
    } catch {
      break; // target went away (a re-navigation); the checks below still apply
    }
    if (s.body.includes(PAGE2_EMAIL) && s.opacity === '1') {
      throw new Error(
        `ZERO-FRAME LEAK on revive: the replayed page painted raw ${PAGE2_EMAIL} at opacity 1. ` +
          'The curtain must be raised (and awaited) BEFORE createView, and the L0 shroud armed before the ' +
          'document loads (see TabManager.runMaterialize / reviveTab).',
      );
    }
    if (s.body.includes(PAGE2_MARKER) && !s.body.includes(PAGE2_EMAIL) && s.opacity === '1') {
      maskedAndVisible = true;
      break;
    }
  }
  if (!maskedAndVisible) {
    throw new Error(
      'the tab revived under Stream Mode never came back masked AND visible: it is either still shrouded ' +
        '(a permanently blank tab) or never repainted (see Tab.restoreNavigation)',
    );
  }
  await ui.evaluate(`window.voksa.stream.update({ enabled: false })`);
  pass('MEMORY SAVER REVIVE UNDER STREAM');

  // --- 14. ABOUT LOGO ACTUALLY LOADS ---------------------------------------------
  // The chrome UI is served over file:// in a build. An <img> whose URL does not
  // resolve there fails SILENTLY (empty box, no exception, no console error the
  // suite would catch), which is exactly why this card used to draw an icon glyph
  // instead of the product's real logo. naturalWidth is the only honest proof the
  // bytes arrived.
  await ui.evaluate(`window.voksa.tabs.navigate(${J(victimId)}, "voksa://settings")`);
  // Settings shows ONE section at a time (the sidebar is navigation, not a
  // table of contents), so the About card only exists once its tab is picked.
  await waitFor(
    'settings sidebar reached the About section',
    async () =>
      ui.evaluate(
        `(() => { const b = document.querySelector('[data-voksa-settings-nav="about"]');
           if (!b) return false; b.click(); return true; })()`,
      ),
    STEP_TIMEOUT_MS,
    'the settings sidebar never rendered its About entry',
  );
  const logo = await waitFor(
    'About card logo decoded',
    async () => {
      const l = await ui.evaluate(
        `(() => { const i = document.querySelector('img[data-voksa-logo]');
           return i ? { src: i.currentSrc || i.src, w: i.naturalWidth, done: i.complete } : null; })()`,
      );
      return l && l.done ? l : null;
    },
    STEP_TIMEOUT_MS,
    'the settings page never rendered its About logo element',
  );
  if (!logo.w) {
    throw new Error(
      `the About logo failed to load (naturalWidth 0) from ${logo.src}: the asset does not resolve under file://. ` +
        'Import it (so Vite emits it into dist-ui) instead of hardcoding a path.',
    );
  }
  pass('ABOUT LOGO LOADS');

  // --- 15. INTERNAL PAGES SHOW THEIR URL (and voksa://search really renders) ------
  // Two assertions, and BOTH are needed: asserting only that voksa://settings
  // shows in the bar would still pass if the bar were hardcoded to it, and
  // asserting only that the new tab page is empty is what the old (broken)
  // behaviour did for every internal page.
  const addressValue = async () =>
    ui.evaluate(
      `(() => { const i = document.querySelector('[data-voksa-address]'); return i ? i.value : null; })()`,
    );

  await waitFor(
    'the address bar shows voksa://settings',
    async () => (await addressValue()) === 'voksa://settings',
    STEP_TIMEOUT_MS,
    'an internal page left the address bar empty: it must show its voksa:// address (see displayUrl in AddressBar.tsx)',
  );

  await ui.evaluate(`window.voksa.tabs.navigate(${J(victimId)}, "voksa://newtab")`);
  await waitFor(
    'the new tab page keeps an empty address bar, like Chrome',
    async () => (await addressValue()) === '',
    STEP_TIMEOUT_MS,
    'voksa://newtab printed its address into the bar: that bar is the search box, a prefix to delete first is in the way',
  );

  // The three-place registration of an internal page (InternalPage slug union,
  // Chrome.internalSlugForUrl, Tab.titleForInternalUrl): miss the middle one and
  // the page silently renders NewTab instead. Nothing else would notice.
  await ui.evaluate(`window.voksa.tabs.navigate(${J(victimId)}, "voksa://search")`);
  const engineCount = await waitFor(
    'voksa://search renders the engine list',
    async () => {
      const n = await ui.evaluate(
        `(() => { const el = document.querySelector('[data-voksa-search-engines]');
           return el ? Number(el.getAttribute('data-voksa-search-engines')) : null; })()`,
      );
      return n || null;
    },
    STEP_TIMEOUT_MS,
    'voksa://search did not render its engine table (a missing slug in Chrome.internalSlugForUrl silently falls back to the new tab page)',
  );
  if (engineCount < 2) throw new Error(`voksa://search lists ${engineCount} engine(s)`);
  pass('INTERNAL URL VISIBLE');

  // --- 16. TAB-TO-SEARCH KEYWORDS -------------------------------------------------
  // Keyword mode is STATE the address bar holds and names explicitly on the way
  // out (tabs.navigate(id, terms, engine)); main builds the URL. What is
  // verified here is that contract, and above all that plain text is NEVER
  // reinterpreted: a phrase starting with an engine's domain must reach the
  // DEFAULT engine, whole. Inferring the mode from the string meant
  // "bing.com vs google" searched Bing for "vs google", losing half the query.
  const kwTabId = await ui.evaluate(`window.voksa.tabs.create("voksa://newtab")`);
  const urlOf = async (id) =>
    (await ui.evaluate(`window.voksa.tabs.list()`)).find((t) => t.id === id)?.url;

  await ui.evaluate(`window.voksa.tabs.navigate(${J(kwTabId)}, "chats", "duckduckgo")`);
  await waitFor(
    'keyword mode searches the named engine',
    async () => (await urlOf(kwTabId))?.startsWith('https://duckduckgo.com/?q=chats'),
    STEP_TIMEOUT_MS,
    'tabs.navigate with an engine override did not search that engine (handlers.ts TAB_NAVIGATE)',
  );

  await ui.evaluate(`window.voksa.tabs.navigate(${J(kwTabId)}, "bing.com vs google")`);
  await waitFor(
    'a phrase starting with a keyword is NOT hijacked',
    async () => {
      const url = await urlOf(kwTabId);
      // Default engine (google), and the WHOLE phrase, keyword included.
      return Boolean(
        url?.startsWith('https://www.google.com/search?q=') && url.includes('bing.com'),
      );
    },
    STEP_TIMEOUT_MS,
    'typing "bing.com vs google" was rewritten into a Bing search: the keyword hijacked plain text',
  );

  // And a search engine's own address still opens the site.
  await ui.evaluate(`window.voksa.tabs.navigate(${J(kwTabId)}, "duckduckgo.com")`);
  await waitFor(
    'a bare keyword still navigates to the site',
    async () => {
      const url = await urlOf(kwTabId);
      // Not an equality check: once the real navigation commits, the site's
      // own canonical URL (trailing slash, a redirect) replaces ours. What
      // must hold is that we went TO the site and did not search FOR it.
      return Boolean(url?.startsWith('https://duckduckgo.com') && !url.includes('?q='));
    },
    STEP_TIMEOUT_MS,
    'typing "duckduckgo.com" searched instead of navigating: the keyword stole a real URL',
  );
  await ui.evaluate(`window.voksa.tabs.close(${J(kwTabId)})`);
  pass('TAB-TO-SEARCH KEYWORDS');

  // --- 17. PDF IN TAB --------------------------------------------------------------
  // Before `plugins: true`, a .pdf response never became a page: will-download
  // grabbed it and the tab stayed where it was. So "the tab's URL IS the pdf
  // and the viewer's <embed> exists" can only pass with the viewer working,
  // and "no download appeared" pins the old behaviour as the failure mode.
  const pdfUrl = `${probe.origin}/doc.pdf`;
  const pdfTabId = await ui.evaluate(`window.voksa.tabs.create(${J(pdfUrl)})`);
  const pdfTarget = await waitFor(
    'pdf tab CDP target',
    async () => {
      const list = await listTargets();
      return list.find((t) => t.type === 'page' && t.url === pdfUrl);
    },
    STEP_TIMEOUT_MS,
    'the .pdf navigation never committed: it was probably intercepted as a download (plugins:true missing in Tab.createView?)',
  );
  const pdfPage = await CdpClient.connect(pdfTarget.webSocketDebuggerUrl, 'pdf page');
  clients.push(pdfPage);
  // Two viewer architectures, both accepted: the pre-OOPIF viewer renders an
  // <embed> in the top document; the OOPIF viewer (newer Chromium, reached
  // with Electron 43) leaves the embedder's DOM empty and attaches the PDF
  // extension (fixed Chromium id) as its own frame target instead. Without
  // plugins:true NEITHER exists: the navigation becomes a download and the
  // first wait above already failed.
  const PDF_VIEWER_EXT = 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/';
  await waitFor(
    'PDF viewer surface present',
    async () => {
      const hasEmbed = await pdfPage
        .evaluate(`document.querySelector('embed') !== null`)
        .catch(() => false);
      if (hasEmbed) return true;
      const list = await listTargets();
      return list.some((t) => (t.url ?? '').startsWith(PDF_VIEWER_EXT));
    },
    STEP_TIMEOUT_MS,
    'the pdf URL committed but no viewer surface rendered (neither an <embed> nor the pdf extension frame)',
  );
  const downloads = await ui.evaluate(`window.voksa.downloads.list()`);
  if (Array.isArray(downloads) && downloads.some((d) => (d.url ?? '').includes('/doc.pdf'))) {
    throw new Error('the pdf rendered AND started a download: it must do only the former');
  }
  // Under Stream Mode a PDF document is UNMASKABLE: its content is painted by
  // the plugin, not by DOM nodes the masker can sweep. The rule is fail
  // closed (streamMask.ts isUnmaskableDocument): the shroud is held, the
  // document must be invisible. Asserted, not observed: without the hold this
  // exact check watched an email-carrying surface paint raw on stream.
  await ui.evaluate(`window.voksa.stream.update({ enabled: true })`);
  await waitFor(
    'PDF shrouded under Stream Mode (fail closed)',
    async () => {
      const opacity = await pdfPage
        .evaluate(`getComputedStyle(document.documentElement).opacity`)
        .catch(() => null);
      return Number(opacity) === 0;
    },
    STREAM_TIMEOUT_MS,
    'a PDF stayed visible under Stream Mode: plugin-painted content cannot be masked, so it must be shrouded',
  );
  await ui.evaluate(`window.voksa.stream.update({ enabled: false })`);
  await waitFor(
    'PDF visible again once Stream Mode is off',
    async () => {
      const opacity = await pdfPage
        .evaluate(`getComputedStyle(document.documentElement).opacity`)
        .catch(() => null);
      return Number(opacity) === 1;
    },
    STREAM_TIMEOUT_MS,
    'the unmaskable-document shroud was not lifted on toggle-off',
  );
  await ui.evaluate(`window.voksa.tabs.close(${J(pdfTabId)})`);
  pass('PDF IN TAB');

  // --- 18. BASIC AUTH ---------------------------------------------------------------
  // React inputs are controlled: setting .value directly is invisible to
  // React. Go through the native setter + an input event, the standard way to
  // type into a controlled input from automation.
  const typeIntoAuthDialog = (selector, value) => `(() => {
    const dialog = document.querySelector('[data-voksa-auth]');
    if (!dialog) return false;
    const input = dialog.querySelector(${JSON.stringify(selector)});
    if (!input) return false;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`;

  const authTabId = await ui.evaluate(
    `window.voksa.tabs.create(${J(`${probe.origin}/protected`)})`,
  );
  await waitFor(
    'auth dialog visible in the chrome UI',
    async () => ui.evaluate(`document.querySelector('[data-voksa-auth]') !== null`),
    STEP_TIMEOUT_MS,
    "the 401 challenge never raised the credentials dialog (app.on('login') in netGuards.ts)",
  );
  if (!(await ui.evaluate(typeIntoAuthDialog('input:not([type="password"])', AUTH_USER)))) {
    throw new Error('could not type the username into the auth dialog');
  }
  if (!(await ui.evaluate(typeIntoAuthDialog('input[type="password"]', AUTH_PASS)))) {
    throw new Error('could not type the password into the auth dialog');
  }
  await ui.evaluate(
    `document.querySelector('[data-voksa-auth] button[type="submit"]').click()`,
  );
  await waitFor(
    'credentials accepted, protected page rendered',
    async () => {
      const list = await listTargets();
      const target = list.find((t) => t.type === 'page' && t.url.includes('/protected'));
      if (!target) return false;
      const c = await CdpClient.connect(target.webSocketDebuggerUrl, 'auth page');
      try {
        return (await c.evaluate(`document.body ? document.body.innerText : ''`)).includes(
          AUTH_OK_MARKER,
        );
      } finally {
        c.close();
      }
    },
    STEP_TIMEOUT_MS,
    'submitting valid credentials did not load the protected page',
  );

  // Cancel path: a fresh realm re-challenges; cancelling must render the 401
  // body and must NOT re-raise the dialog in a loop.
  await ui.evaluate(
    `window.voksa.tabs.navigate(${J(authTabId)}, ${J(`${probe.origin}/protected-cancel`)})`,
  );
  await waitFor(
    'auth dialog for the cancel path',
    async () => ui.evaluate(`document.querySelector('[data-voksa-auth]') !== null`),
    STEP_TIMEOUT_MS,
  );
  await ui.evaluate(`document.querySelector('[data-voksa-auth-cancel]').click()`);
  await waitFor(
    'cancelled challenge renders the 401 body',
    async () => {
      const list = await listTargets();
      const target = list.find((t) => t.type === 'page' && t.url.includes('/protected-cancel'));
      if (!target) return false;
      const c = await CdpClient.connect(target.webSocketDebuggerUrl, 'auth cancel page');
      try {
        return (await c.evaluate(`document.body ? document.body.innerText : ''`)).includes(
          AUTH_DENIED_MARKER,
        );
      } finally {
        c.close();
      }
    },
    STEP_TIMEOUT_MS,
    'cancelling the auth dialog did not fall through to the 401 body',
  );
  await sleep(500);
  if (await ui.evaluate(`document.querySelector('[data-voksa-auth]') !== null`)) {
    throw new Error('the auth dialog re-raised itself after cancel: challenge loop');
  }
  await ui.evaluate(`window.voksa.tabs.close(${J(authTabId)})`);
  pass('BASIC AUTH');

  // --- 19. TLS INTERSTITIAL -----------------------------------------------------------
  const tls = await startTlsServer();
  tlsServer = tls.server;
  const tlsTabId = await ui.evaluate(`window.voksa.tabs.create(${J(`${tls.origin}/`)})`);
  await waitFor(
    'TLS interstitial rendered in the chrome UI',
    async () => ui.evaluate(`document.querySelector('[data-voksa-tls-interstitial]') !== null`),
    STEP_TIMEOUT_MS,
    'a self-signed certificate did not raise the interstitial (certificate-error in netGuards.ts / cert branch of ErrorPage.tsx)',
  );
  // The anti-leak core: certificate-error aborts the HANDSHAKE, so the server
  // must never have seen a request while the interstitial is up.
  if (tls.hits() !== 0) {
    throw new Error(
      `the https server received ${tls.hits()} request(s) BEFORE the user proceeded: the rejection path leaks`,
    );
  }
  await ui.evaluate(`document.querySelector('[data-voksa-tls-advanced]').click()`);
  await waitFor(
    'proceed link revealed',
    async () => ui.evaluate(`document.querySelector('[data-voksa-tls-proceed]') !== null`),
    STEP_TIMEOUT_MS,
  );
  await ui.evaluate(`document.querySelector('[data-voksa-tls-proceed]').click()`);
  await waitFor(
    'page loads after proceeding',
    async () => {
      const list = await listTargets();
      const target = list.find((t) => t.type === 'page' && t.url.startsWith(tls.origin));
      if (!target) return false;
      const c = await CdpClient.connect(target.webSocketDebuggerUrl, 'tls page');
      try {
        return (await c.evaluate(`document.body ? document.body.innerText : ''`)).includes(
          TLS_OK_MARKER,
        );
      } finally {
        c.close();
      }
    },
    STEP_TIMEOUT_MS,
    'proceeding past the interstitial did not load the page (TAB_TLS_PROCEED / allowPendingCertException)',
  );
  if (tls.hits() === 0) {
    throw new Error('the page claims to have loaded but the https server saw no request');
  }
  await ui.evaluate(`window.voksa.tabs.close(${J(tlsTabId)})`);
  pass('TLS INTERSTITIAL');

  // --- 20. PINNED TABS ----------------------------------------------------------------
  const pinA = await ui.evaluate(`window.voksa.tabs.create("voksa://newtab")`);
  const pinB = await ui.evaluate(`window.voksa.tabs.create("voksa://newtab")`);
  const pinC = await ui.evaluate(`window.voksa.tabs.create("voksa://newtab")`);
  const tabList = async () => await ui.evaluate(`window.voksa.tabs.list()`);

  await ui.evaluate(`window.voksa.tabs.setPinned(${J(pinC)}, true)`);
  await waitFor(
    'pinning re-homes the tab into the left cluster',
    async () => {
      const list = await tabList();
      const first = list[0];
      return first?.id === pinC && first?.pinned === true;
    },
    STEP_TIMEOUT_MS,
    'setPinned did not move the tab to the front of the strip (TabManager.setPinned)',
  );

  // A reorder payload that buries the pinned tab in the middle must come back
  // clamped: pinned first is structural in main, not a UI courtesy.
  const interleaved = (await tabList()).map((t) => t.id);
  interleaved.splice(interleaved.indexOf(pinC), 1);
  interleaved.splice(2, 0, pinC);
  await ui.evaluate(`window.voksa.tabs.reorder(${JSON.stringify(interleaved)})`);
  await waitFor(
    'an interleaving reorder is snapped back',
    async () => (await tabList())[0]?.id === pinC,
    STEP_TIMEOUT_MS,
    'reorder() accepted an order that buries the pinned cluster (invariant must be re-imposed in main)',
  );

  // "Close others" spares the pinned tab (and the caller, which is active).
  await ui.evaluate(`window.voksa.tabs.activate(${J(pinA)})`);
  await ui.evaluate(`window.voksa.tabs.closeOthers(${J(pinA)})`);
  await waitFor(
    'close-others spares the pinned tab',
    async () => {
      const ids = (await tabList()).map((t) => t.id);
      return ids.includes(pinC) && ids.includes(pinA) && !ids.includes(pinB);
    },
    STEP_TIMEOUT_MS,
    'closeOthers closed a pinned tab (or failed to close an unpinned one)',
  );
  await ui.evaluate(`window.voksa.tabs.setPinned(${J(pinC)}, false)`);
  await ui.evaluate(`window.voksa.tabs.close(${J(pinC)})`);
  pass('PINNED TABS');

  // --- 21. DMCA AUDIO GUARD ------------------------------------------------------
  const audioTabId = await ui.evaluate(
    `window.voksa.tabs.create(${J(`${probe.origin}/audio.html`)})`,
  );
  const audioTab = async () =>
    (await ui.evaluate(`window.voksa.tabs.list()`)).find((t) => t.id === audioTabId);

  // Anti-vacuity: the tone must actually render as audible BEFORE the guard
  // is asked to act on it. Headless CI machines may have no audio device at
  // all; that is an environment limit, not a regression, and it is LOGGED,
  // never silently absorbed.
  let audioWorks = true;
  try {
    await waitFor('audio tab reports audible', async () => (await audioTab())?.isAudible === true, 8_000);
  } catch {
    audioWorks = false;
    console.log(
      '[smoke] note: environment renders no audio (no device?); AUDIO GUARD reduced to wiring-only checks',
    );
  }

  // Background the audio tab, then arm the stream: the guard must mute it.
  const coverTabId = await ui.evaluate(`window.voksa.tabs.create("voksa://newtab")`);
  await ui.evaluate(`window.voksa.tabs.activate(${J(coverTabId)})`);
  await ui.evaluate(`window.voksa.stream.update({ enabled: true })`);

  if (audioWorks) {
    await waitFor(
      'background audible tab guard-muted under stream',
      async () => {
        const t2 = await audioTab();
        return t2?.streamMuted === true && t2?.isMuted === false;
      },
      STREAM_TIMEOUT_MS,
      'an audible background tab was not guard-muted under Stream Mode (applyAudioGuard in TabManager)',
    );

    // Activation is NOT consent: the guard mute must survive switching to it.
    await ui.evaluate(`window.voksa.tabs.activate(${J(audioTabId)})`);
    await sleep(400);
    const activated = await audioTab();
    if (activated?.streamMuted !== true) {
      throw new Error('activating a guard-muted tab lifted the mute: the chip must be the only exit');
    }

    // The chip's explicit allow lifts it, for the tab's lifetime.
    await ui.evaluate(`window.voksa.tabs.allowStreamAudio(${J(audioTabId)})`);
    await waitFor(
      'explicit allow lifts the guard mute',
      async () => (await audioTab())?.streamMuted === false,
      STREAM_TIMEOUT_MS,
    );
  } else {
    // Reduced check: the IPC path exists and flips nothing it should not.
    await ui.evaluate(`window.voksa.tabs.allowStreamAudio(${J(audioTabId)})`);
  }

  // Stream OFF restores the exact prior audio state (no stray user mute).
  await ui.evaluate(`window.voksa.stream.update({ enabled: false })`);
  await sleep(300);
  const after = await audioTab();
  if (after?.streamMuted !== false || after?.isMuted !== false) {
    throw new Error(
      `stream OFF did not restore the audio state: ${JSON.stringify({ streamMuted: after?.streamMuted, isMuted: after?.isMuted })}`,
    );
  }
  await ui.evaluate(`window.voksa.tabs.close(${J(audioTabId)})`);
  await ui.evaluate(`window.voksa.tabs.close(${J(coverTabId)})`);
  pass('DMCA AUDIO GUARD');

  // --- 22. PANIC ------------------------------------------------------------------
  // Driven through the IPC action (the hotkey is just another trigger of the
  // same toggle; CDP cannot synthesize OS-level global shortcuts).
  if (await ui.evaluate(CURTAIN_UP_EXPR)) {
    throw new Error('a curtain is already up before panic: the assertion below would be vacuous');
  }
  const panicOn = await ui.evaluate(`window.voksa.stream.panic()`);
  if (panicOn?.active !== true) {
    throw new Error(`panic() did not report active: ${JSON.stringify(panicOn)}`);
  }
  await waitFor(
    'panic curtain up over the active tab',
    async () => ui.evaluate(CURTAIN_UP_EXPR),
    STREAM_TIMEOUT_MS,
    'panic did not curtain the window (TabManager.panicCover)',
  );
  const armed = await ui.evaluate(`window.voksa.stream.get()`);
  if (!armed?.enabled) {
    throw new Error('panic did not arm Stream Mode');
  }
  const panicOff = await ui.evaluate(`window.voksa.stream.panic()`);
  if (panicOff?.active !== false) {
    throw new Error(`second panic() did not restore: ${JSON.stringify(panicOff)}`);
  }
  await waitFor(
    'panic curtain gone after restore',
    async () => !(await ui.evaluate(CURTAIN_UP_EXPR)),
    STREAM_TIMEOUT_MS,
  );
  // The restore deliberately KEEPS the stream armed: dropping the protection
  // on restore would re-expose whatever caused the panic.
  const stillArmed = await ui.evaluate(`window.voksa.stream.get()`);
  if (!stillArmed?.enabled) {
    throw new Error('panic restore disarmed Stream Mode: it must stay armed until turned off manually');
  }
  await ui.evaluate(`window.voksa.stream.update({ enabled: false })`);
  pass('PANIC');

  // --- 23. CAPTURE HANDSHAKE ------------------------------------------------------
  // getDisplayMedia does not route to setDisplayMediaRequestHandler under CDP
  // in this Electron build, so the real Chromium entry edge cannot be driven
  // here (verified: the handler is never invoked). The debug seam
  // (voksa.capture.simulate) enters the SAME controller path from a known
  // requester, so everything the feature owns IS exercised: source
  // enumeration, our picker, arming Stream Mode before delivery, and returning
  // the picked id. Only the trivial Chromium->handler glue is out of reach.
  await ui.evaluate(`window.voksa.stream.update({ enabled: false })`);
  const simPromise = ui.evaluate(`window.voksa.capture.simulate()`);

  await waitFor(
    'Voksa capture picker shown',
    async () => ui.evaluate(`document.querySelector('[data-voksa-capture-picker]') !== null`),
    STEP_TIMEOUT_MS,
    'the handshake did not raise the Voksa picker (getSources/handleRequest)',
  );
  const sourceCount = await ui.evaluate(
    `Number(document.querySelector('[data-voksa-capture-picker]').getAttribute('data-voksa-capture-picker'))`,
  );
  if (sourceCount < 1) {
    // A box that enumerates no capturable surface: cancel cleanly and reduce
    // to the picker-ownership proof (the arming/delivery need a real source).
    console.log('[smoke] note: 0 screen-share sources enumerated; CAPTURE HANDSHAKE delivery skipped');
    await ui.evaluate(`document.querySelector('[data-voksa-capture-picker] ~ *, [data-voksa-capture-picker]') && window.voksa.capture.pick && true`);
    // Cancel via the picker's own path: click the backdrop-cancel button.
    await ui.evaluate(`(() => {
      const btns = document.querySelectorAll('button');
      for (const b of btns) if (/Annuler|Cancel/.test(b.textContent||'')) { b.click(); return true; }
      return false;
    })()`);
    await simPromise.catch(() => null);
    pass('CAPTURE HANDSHAKE');
  } else {
    // Pick the first source and confirm through OUR UI.
    await ui.evaluate(`document.querySelector('[data-voksa-capture-source]').click()`);
    await ui.evaluate(`document.querySelector('[data-voksa-capture-confirm]').click()`);

    // Delivery happens ONLY after Stream Mode is armed (the guarantee).
    await waitFor(
      'picking a source armed Stream Mode',
      async () => (await ui.evaluate(`window.voksa.stream.get()`))?.enabled === true,
      STREAM_TIMEOUT_MS,
      'selecting a source did not arm Stream Mode (captureHandshake containsVoksa/arming)',
    );
    const deliveredId = await simPromise;
    if (!deliveredId || typeof deliveredId !== 'string') {
      throw new Error(`the handshake did not deliver a source id (got ${JSON.stringify(deliveredId)})`);
    }
    await ui.evaluate(`window.voksa.stream.update({ enabled: false })`);
    pass('CAPTURE HANDSHAKE');
  }

  // --- 24. GO-LIVE PREFLIGHT ------------------------------------------------------
  // Baseline: the current tabs are clean (newtab/etc.), so preflight flags
  // nothing. This is the anti-vacuity anchor.
  const cleanReport = await ui.evaluate(`window.voksa.preflight.run()`);
  const cleanSensitive = (cleanReport?.findings ?? []).filter((f) => f.kind === 'sensitive-text');
  if (cleanSensitive.length > 0) {
    throw new Error(`preflight flagged a clean profile: ${JSON.stringify(cleanSensitive)}`);
  }

  // Open a tab whose TITLE carries an email; preflight must flag it, masked.
  const leakyTabId = await ui.evaluate(
    `window.voksa.tabs.create(${J(`${probe.origin}/leaky-title.html`)})`,
  );
  await waitFor(
    'leaky tab title picked up',
    async () => {
      const tabs = await ui.evaluate(`window.voksa.tabs.list()`);
      return tabs.find((t) => t.id === leakyTabId)?.title?.includes('Inbox');
    },
    STEP_TIMEOUT_MS,
  );
  const report = await ui.evaluate(`window.voksa.preflight.run()`);
  const flag = (report?.findings ?? []).find(
    (f) => f.kind === 'sensitive-text' && f.tabId === leakyTabId,
  );
  if (!flag) {
    throw new Error(
      `preflight did not flag the email-in-title tab: ${JSON.stringify(report?.findings)}`,
    );
  }
  if (flag.label.includes(FRAME_EMAIL)) {
    throw new Error('preflight finding reprinted the raw email it warns about');
  }
  if (!flag.label.includes('xxx')) {
    throw new Error(`preflight finding label is not masked: ${JSON.stringify(flag.label)}`);
  }
  await ui.evaluate(`window.voksa.tabs.close(${J(leakyTabId)})`);
  pass('GO-LIVE PREFLIGHT');

  // --- 25. AUDIO ROUTING (DMCA stage 2) --------------------------------------------
  // Route a tab's audio to a chosen output device. Devices are matched by
  // LABEL inside each frame (deviceIds are origin-hashed): the full path needs
  // a real physical output device, which headless CI machines may not have.
  // Without one, the scenario degrades to wiring + fail-visible checks and
  // LOGS it, exactly like scenario 21.

  // Wiring probe on an internal tab first: it has no webContents, so the route
  // is stored without any page round-trip. Proves the SET path and the
  // TabState plumbing independently of the audio environment.
  const wiringTabId = await ui.evaluate(`window.voksa.tabs.create("voksa://newtab")`);
  await ui.evaluate(
    `window.voksa.tabs.setAudioRoute(${J(wiringTabId)}, "Smoke Wiring Probe Device")`,
  );
  await waitFor(
    'audio route stored on the tab state',
    async () =>
      (await ui.evaluate(`window.voksa.tabs.list()`)).find((t) => t.id === wiringTabId)
        ?.audioRoute === 'Smoke Wiring Probe Device',
    STEP_TIMEOUT_MS,
    'setAudioRoute did not reach TabState.audioRoute (AUDIO_ROUTE_SET / TabManager.setAudioRoute)',
  );
  await ui.evaluate(`window.voksa.tabs.setAudioRoute(${J(wiringTabId)}, null)`);
  await waitFor(
    'audio route cleared on the tab state',
    async () =>
      (await ui.evaluate(`window.voksa.tabs.list()`)).find((t) => t.id === wiringTabId)
        ?.audioRoute === null,
    STEP_TIMEOUT_MS,
  );
  await ui.evaluate(`window.voksa.tabs.close(${J(wiringTabId)})`);

  // Real routable outputs, enumerated in the chrome view (same source the tab
  // context menu uses; labels exposed through the chrome carve-out).
  const outputLabels = await ui.evaluate(`navigator.mediaDevices.enumerateDevices().then(
    (list) => list
      .filter((d) => d.kind === 'audiooutput' && d.deviceId
        && d.deviceId !== 'default' && d.deviceId !== 'communications' && d.label)
      .map((d) => d.label),
  )`);

  const routeTabId = await ui.evaluate(
    `window.voksa.tabs.create(${J(`${probe.origin}/route-audio.html`)})`,
  );
  const routeUrl = `${probe.origin}/route-audio.html`;
  const routeTarget = await waitFor(
    'route-audio page CDP target',
    async () => (await listTargets()).find((t) => t.type === 'page' && t.url === routeUrl),
    STEP_TIMEOUT_MS,
  );
  const routePage = await CdpClient.connect(routeTarget.webSocketDebuggerUrl, 'route-audio page');
  clients.push(routePage);
  await waitFor(
    'route-audio page rendered',
    async () => (await routePage.evaluate(`document.body.innerText`)).includes('ROUTE-AUDIO-PAGE'),
    STEP_TIMEOUT_MS,
  );

  // Anti-vacuity: before any routing, the element sits on the default sink.
  const sinkBefore = await routePage.evaluate(
    `document.getElementById('probe-audio').sinkId`,
  );
  if (sinkBefore !== '') {
    throw new Error(`element already routed before the test: sinkId=${JSON.stringify(sinkBefore)}`);
  }

  if (Array.isArray(outputLabels) && outputLabels.length > 0) {
    const chosenLabel = outputLabels[0];
    await ui.evaluate(`window.voksa.tabs.setAudioRoute(${J(routeTabId)}, ${J(chosenLabel)})`);

    // 1. The attached element is routed (isolated-world sweep).
    await waitFor(
      'attached media element routed to the chosen device',
      async () =>
        (await routePage.evaluate(`document.getElementById('probe-audio').sinkId`)) !== '',
      STEP_TIMEOUT_MS,
      'setSinkId never applied: label matching in the frame (injected/audioRoute.ts), the media ' +
        'permission-check carve-out (stream-mode/permissions.ts), or the AUDIO_ROUTE_APPLY push failed',
    );

    // 2. A DETACHED element created afterwards is routed at play() time by the
    //    main-world patch (no isolated world can ever reach it).
    await routePage.evaluate(`(() => {
      window.__smokeDetached = new Audio();
      window.__smokeDetached.play().catch(() => {});
      return true;
    })()`);
    await waitFor(
      'detached Audio() routed by the main-world play patch',
      async () => (await routePage.evaluate(`window.__smokeDetached.sinkId`)) !== '',
      STEP_TIMEOUT_MS,
      'the main-world patch did not route a detached Audio() (buildAudioRoutePatch play wrap)',
    );

    // 2b. A detached element with AUTOPLAY (playback starts internally,
    //     never through play()): only the wrapped Audio constructor can
    //     remember it. No play() call here, on purpose.
    await routePage.evaluate(`(() => {
      window.__autoAudio = new Audio();
      window.__autoAudio.autoplay = true;
      return true;
    })()`);
    await waitFor(
      'detached autoplay Audio routed by the main-world ctor wrap',
      async () => (await routePage.evaluate(`window.__autoAudio.sinkId`)) !== '',
      STEP_TIMEOUT_MS,
      'the main-world patch did not route a detached autoplay Audio (buildAudioRoutePatch Audio ctor proxy)',
    );

    // 3. An AudioContext created afterwards is routed by the wrapped ctor.
    await routePage.evaluate(`(() => { window.__smokeCtx = new AudioContext(); return true; })()`);
    await waitFor(
      'new AudioContext routed by the main-world ctor patch',
      async () => {
        const sink = await routePage.evaluate(`window.__smokeCtx.sinkId`);
        return typeof sink === 'string' && sink !== '';
      },
      STEP_TIMEOUT_MS,
      'the main-world patch did not route a page AudioContext (buildAudioRoutePatch ctor proxy)',
    );

    // 4. The tab state claims exactly what is applied.
    const routedState = (await ui.evaluate(`window.voksa.tabs.list()`)).find(
      (t) => t.id === routeTabId,
    );
    if (routedState?.audioRoute !== chosenLabel) {
      throw new Error(
        `TabState.audioRoute (${JSON.stringify(routedState?.audioRoute)}) does not match the applied route`,
      );
    }

    // 5. THE core use case: the route survives a reload UNDER Stream Mode.
    //    The new document re-arms at document-start and re-enumerates while
    //    the stream denies camera/microphone: without the permission
    //    carve-out for routed tabs (stream-mode/permissions.ts), labels come
    //    back empty, the label cannot resolve, and the route gets cleared.
    //    Stream OFF would never catch that (the check handler is permissive
    //    when not streaming): this reload is where the carve-out is load-bearing.
    await ui.evaluate(`window.voksa.stream.update({ enabled: true })`);
    await ui.evaluate(`window.voksa.tabs.reload(${J(routeTabId)})`);
    await waitFor(
      'route re-applied after a reload under Stream Mode',
      async () => {
        const sink = await routePage
          .evaluate(`(document.getElementById('probe-audio') || {}).sinkId`)
          .catch(() => null);
        return typeof sink === 'string' && sink !== '';
      },
      STEP_TIMEOUT_MS,
      'the reloaded document did not re-route under stream: AUDIO_ROUTE_GET_SYNC re-arm, or the ' +
        "routed tab's media permission-check carve-out (labels blanked by the stream denies)",
    );
    const routeUnderStream = (await ui.evaluate(`window.voksa.tabs.list()`)).find(
      (t) => t.id === routeTabId,
    );
    if (routeUnderStream?.audioRoute !== chosenLabel) {
      throw new Error(
        `the route was cleared by the reload under stream (fail-visible fired where it should not): ${JSON.stringify(routeUnderStream?.audioRoute)}`,
      );
    }
    // The fixture's inline script played a DETACHED element at document-start,
    // strictly before the async enumeration could resolve. It must be routed
    // anyway: the play wrap remembers unconditionally, precisely so that an
    // early player cannot stay on the system default while the tab claims
    // routed.
    await waitFor(
      'detached element played at document-start routed once the sink resolved',
      async () => {
        const sink = await routePage
          .evaluate(`window.__earlyAudio && window.__earlyAudio.sinkId`)
          .catch(() => null);
        return typeof sink === 'string' && sink !== '';
      },
      STEP_TIMEOUT_MS,
      'an element played before the sink resolved was never routed (unconditional remember in the play wrap)',
    );
    await ui.evaluate(`window.voksa.stream.update({ enabled: false })`);

    // 6. Reset: everything returns to the system default.
    await ui.evaluate(`window.voksa.tabs.setAudioRoute(${J(routeTabId)}, null)`);
    await waitFor(
      'attached element back on the default sink after reset',
      async () =>
        (await routePage.evaluate(`document.getElementById('probe-audio').sinkId`)) === '',
      STEP_TIMEOUT_MS,
    );
  } else {
    // No physical output device: exercise the fail-visible path instead. A
    // label that cannot resolve in the page must CLEAR the route (main reacts
    // to the frame's matched:false), so the UI never claims a dead routing.
    console.log(
      '[smoke] note: no routable audio output on this machine; AUDIO ROUTING reduced to wiring + fail-visible checks',
    );
    await ui.evaluate(
      `window.voksa.tabs.setAudioRoute(${J(routeTabId)}, "Smoke Nonexistent Device")`,
    );
    await waitFor(
      'unresolvable route cleared (fail-visible)',
      async () =>
        (await ui.evaluate(`window.voksa.tabs.list()`)).find((t) => t.id === routeTabId)
          ?.audioRoute === null,
      STEP_TIMEOUT_MS,
      'a route to a nonexistent device was not cleared: AUDIO_ROUTE_STATUS matched:false handling',
    );
  }
  await ui.evaluate(`window.voksa.tabs.close(${J(routeTabId)})`);
  pass('AUDIO ROUTING');

  // --- 26. EXTENSION CONTRACT ------------------------------------------------------
  // The fixture (scripts/fixtures/contract-extension) is built to die exactly
  // where real extensions died in the wild: a MODULE service worker using the
  // native `browser` namespace with top-level listener registrations (uBO
  // Lite's death), tabs.query needing real URLs (its starved popup), the
  // storage.onChanged relay (Bitwarden's frozen vault), and i18n resolving
  // the profile language instead of the extension's default locale. Each
  // assertion maps to a patch guarantee; any regression turns it red.
  const contractExt = await waitFor(
    'contract fixture loaded',
    async () => {
      const list = await ui.evaluate(`window.voksa.extensions.list()`);
      return (list ?? []).find((e) => e.name === 'Voksa Contract Probe');
    },
    STEP_TIMEOUT_MS,
    'the debug seam VOKSA_DEBUG_LOAD_EXTENSION did not load the fixture (src/main/index.ts)',
  );
  const contractId = contractExt.id;

  // 1. THE uBO Lite death class: the module service worker must be running.
  //    A missing browser.* API kills it at module evaluation, silently: no
  //    error anywhere, just no service worker target. On failure, dump the
  //    world as seen from a fixture PAGE (pages outlive a dead worker) so a
  //    platform-specific divergence is diagnosable straight from CI logs;
  //    the [sw-console] relay in the harness output has the worker-side view.
  try {
    await waitFor(
      'fixture module service worker running',
      async () =>
        (await listTargets()).some(
          (t) => t.type !== 'page' && t.url === `chrome-extension://${contractId}/sw.js`,
        ),
      STEP_TIMEOUT_MS,
      'the fixture service worker never started: a browser-namespace API is missing at module ' +
        'evaluation (electron-chrome-extensions patch, browser mirror) or MV3 SW startup broke',
    );
  } catch (err) {
    let world = 'page-world diagnosis unavailable';
    try {
      await ui.evaluate(
        `window.voksa.tabs.create(${J(`chrome-extension://${contractId}/probe.html`)})`,
      );
      const diagTarget = await waitFor(
        'diagnosis page target',
        async () =>
          (await listTargets()).find(
            (t) => t.type === 'page' && t.url === `chrome-extension://${contractId}/probe.html`,
          ),
        STEP_TIMEOUT_MS,
      );
      const diagPage = await CdpClient.connect(diagTarget.webSocketDebuggerUrl, 'contract diagnosis');
      clients.push(diagPage);
      world = String(
        await diagPage.evaluate(`(() => {
          const t = (o, k) => { try { return typeof o[k]; } catch (e) { return 'ERR'; } };
          return 'page world: browser=' + typeof globalThis.browser
            + ' chrome=' + typeof globalThis.chrome
            + ' same=' + (globalThis.browser === globalThis.chrome)
            + ' b.permissions=' + t(globalThis.browser ?? {}, 'permissions')
            + ' c.permissions=' + t(globalThis.chrome ?? {}, 'permissions')
            + ' b.tabs=' + t(globalThis.browser ?? {}, 'tabs')
            + ' c.tabs=' + t(globalThis.chrome ?? {}, 'tabs');
        })()`),
      );
    } catch {
      // keep the placeholder
    }
    throw new Error(`${err.message}\n[diagnosis] ${world}\n[diagnosis] see [sw-console] lines above for the worker-side view`);
  }

  // 2. Probe page, driven from its own extension context.
  await ui.evaluate(
    `window.voksa.tabs.create(${J(`chrome-extension://${contractId}/probe.html`)})`,
  );
  const contractTarget = await waitFor(
    'contract probe page CDP target',
    async () =>
      (await listTargets()).find(
        (t) => t.type === 'page' && t.url === `chrome-extension://${contractId}/probe.html`,
      ),
    STEP_TIMEOUT_MS,
  );
  const contractPage = await CdpClient.connect(contractTarget.webSocketDebuggerUrl, 'contract probe');
  clients.push(contractPage);
  // Body text renders before the script tag executes: wait for the probe API
  // itself, not just the marker, or pokeStorage races the script evaluation.
  await waitFor(
    'contract probe page ready (script evaluated)',
    async () =>
      contractPage.evaluate(
        `document.body.innerText.includes('CONTRACT-PROBE') && typeof window.pokeStorage === 'function' && typeof window.report === 'function'`,
      ),
    STEP_TIMEOUT_MS,
  );

  // 3. storage.onChanged relay: poke storage from the page, the background
  //    must SEE the change (the historic Bitwarden bug).
  await contractPage.evaluate(`window.pokeStorage()`);
  const contract = await waitFor(
    'contract report (service worker reachable, storage change relayed)',
    async () => {
      const r = await contractPage.evaluate(`window.report()`).catch(() => null);
      return r && r.sw && r.sw.swAlive && (r.sw.storageChanges ?? []).length > 0 ? r : null;
    },
    STEP_TIMEOUT_MS,
    'the service worker answered nothing or never received storage.onChanged (patch, synthetic ' +
      'storage.onChanged relay)',
  );

  // 4. The whole contract, assertion by assertion.
  if (contract.sw.error) {
    throw new Error(`fixture service worker reported an error: ${contract.sw.error}`);
  }
  if (contract.page.namespacesUnified !== true || contract.sw.namespacesUnified !== true) {
    throw new Error(
      `browser and chrome namespaces diverged (page: ${contract.page.namespacesUnified}, sw: ${contract.sw.namespacesUnified}): ` +
        'an extension using browser.* gets a poorer API than one using chrome.* (patch, mirror granularity)',
    );
  }
  if (!(contract.page.tabsWithUrl >= 1)) {
    throw new Error(
      `tabs.query returned ${contract.page.tabCount} tab(s) but ${contract.page.tabsWithUrl} carry a url: ` +
        'an extension popup cannot know what site it is on (the uBO Lite starved-popup class)',
    );
  }
  if (contract.page.openOptionsPage !== 'function') {
    throw new Error('runtime.openOptionsPage is not a function: extension settings buttons are dead');
  }
  // 5. i18n: the profile is pinned to FRENCH (see the settings.json seeding at
  //    the top), so the fixture's fr catalog must win over its default_locale
  //    (en), in the page AND in the service worker. The catalog loads
  //    asynchronously in each realm: poll rather than assert a snapshot.
  //    A stable 'english-probe' means getMessage is stuck on the default
  //    locale again (localized getMessage in the patch, or the Chromium lang
  //    switch in index.ts).
  await waitFor(
    'extension i18n resolves the profile language in both realms',
    async () => {
      const r = await contractPage.evaluate(`window.report()`).catch(() => null);
      return r && r.page.i18nMessage === 'sonde-francaise' && r.sw.i18nMessage === 'sonde-francaise';
    },
    STEP_TIMEOUT_MS,
    'getMessage kept answering the default locale: localized getMessage (patch) or the Chromium ' +
      'lang switch (index.ts) broke',
  );
  const contractTabs = await ui.evaluate(`window.voksa.tabs.list()`);
  const contractTab = (contractTabs ?? []).find((t) => (t.url ?? '').includes(contractId));
  if (contractTab) await ui.evaluate(`window.voksa.tabs.close(${J(contractTab.id)})`);
  pass('EXTENSION CONTRACT');

  // --- 27. NO RENDERER EXCEPTIONS -------------------------------------------------
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
  console.error('[smoke] FAILED: global watchdog (240s), run hung');
  closeEverything();
  process.exit(1);
}, 240_000);

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
