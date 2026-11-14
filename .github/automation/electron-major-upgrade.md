# Playbook: upgrading Voksa to a new Electron major

**Read [`upgrade-rules.md`](upgrade-rules.md) first.** It holds the rules
common to every automated upgrade: what you must not do, the checks to run,
and the report whose first line decides whether your work merges unattended.
This page only adds what is specific to Electron.

The workflow has already bumped `electron` in `package.json` and
`package-lock.json` and installed it.

Electron is not a dependency like the others: it IS the browser. A new major
brings a new Chromium and a new Node.js, and Voksa's promise (nothing
sensitive painted while Stream Mode is on) rests on Chromium behaviours that
do change between majors. Be slower here than anywhere else, and prefer a
`hold` verdict to a guess.

## How to work

1. **Read what changed.** For every major between the old one and the new one
   (all of them, not only the last): the breaking changes page
   (https://www.electronjs.org/docs/latest/breaking-changes) and the release
   notes (https://releases.electronjs.org). Note the Chromium and Node.js
   versions each major ships, and any operating system it stops supporting.
2. **Map each change onto the code.** Search `src/main`, `src/preload`,
   `src/injected`, `scripts` and the config files for every API, event,
   default or behaviour the notes mention.
3. **Go through the places that have bitten this project before** (below).
4. **Move `@types/node` with the bundled Node.js**, not with the latest Node:
   its major should match the Node.js major the new Electron ships.
5. **Adapt the code, run the checks, write the report**, as the common rules
   say.

## Where Electron upgrades have bitten this project

- **User agent** (`src/main/ua.ts`, `src/main/__tests__/ua.test.ts`). Google
  sign-in only works with a user agent that is plausible for the Chromium
  actually bundled. A new Chromium major usually means updating what these
  build and assert.
- **Extensions runtime** (`src/main/extensions/`, `patches/`,
  `src/main/__tests__/webstorePatch.test.ts`, the "EXTENSION" scenarios of the
  smoke suite). The patched libraries reach into Electron's session and
  service-worker APIs.
- **Auto-update** (`src/main/updates.ts`). It routes `electron-updater`
  through the default session by setting an internal field; check the session
  and net APIs it relies on.
- **Windows and views** (`src/main/window.ts`, `src/main/tabs/`). Built on
  `BaseWindow` and `WebContentsView`, with a strict z-order between the tab
  views and the chrome view, HTML fullscreen handling and off-screen layout.
- **Stream Mode** (`src/main/stream-mode/`, `src/injected/`, `src/preload/`).
  The frame guard exists because of electron/electron#34727 (a preload skipped
  in some subframes); permission names and the display-capture flow have
  changed between majors before; the sandboxed `ipcRenderer` changed behaviour
  in 45 (see `src/preload/voksaApi.ts`).
- **Fuses and packaging** (`electron-builder.yml`, `scripts/check-packaged.mjs`).
- **Build targets** (`scripts/build-main.mjs`, `vite.config.ts`). Only raise
  them if something requires it.
- **Minimum OS versions.** `release.yml` stamps a minimum macOS (Darwin)
  version into the update feed, and `README.md` states the supported systems.
  If the new Chromium drops an OS version, the README is yours to update, but
  the workflow is not: that makes this upgrade a `hold`, with the exact edit
  `release.yml` needs written in the report. Shipping without it would update
  users on the dropped system into an application that no longer starts.

## In the report, also

Under **Not verified**, always add what only a person can try: Google sign-in
done by hand, installing an extension from the Chrome Web Store, and updating
from the previous release.
