# Playbook: upgrading Voksa to a new Electron major

You are run by `.github/workflows/electron-major.yml`, unattended, on a GitHub
runner. Nobody is there to answer questions. The workflow has already created
the branch, bumped `electron` in `package.json` / `package-lock.json` and
installed it. Your job is the part that needs judgment: find out what the new
major breaks in THIS codebase, adapt the code, prove what you can, and write
down honestly what you could not.

A maintainer reviews the pull request afterwards. It is never merged
automatically. Your report is what they read first: an accurate "this fails
and here is why" is worth more to them than a green result they cannot trust.

## What you must not do

- **No git writes.** Do not commit, push, create branches or open pull
  requests: the workflow does all of that after you finish.
- **Do not edit `.github/workflows/`.** The token that pushes your work cannot
  update workflow files, so the push would be rejected. If a workflow needs a
  change, say exactly what in the report (see "Workflow changes needed").
- **Do not weaken a test to make it pass.** No deleting, skipping, loosening
  an assertion or raising a timeout to get to green. A test that fails because
  the behaviour really changed is a finding: fix the code, or explain in the
  report why the expectation itself is now wrong and change it deliberately.
- **Do not bump `electron-chrome-extensions` or `electron-chrome-web-store`.**
  Both are pinned and patched (`patches/`, applied by `patch-package
  --error-on-fail`). If a patch no longer applies or the libraries do not work
  with the new Electron, stop there and report it: porting those patches is a
  human decision.
- **Do not change other dependency versions** unless the upgrade strictly
  requires it (a tool that refuses the new Electron). Say which and why.
- **Do not trade the Stream Mode guarantee for a passing build.** When Stream
  Mode is on, nothing sensitive may be painted, not for one frame. Any change
  under `src/main/stream-mode/`, `src/injected/` or `src/preload/page.ts` must
  keep that property; if you are not sure it does, do not make the change and
  report the question instead.

## How to work

1. **Read what changed.** For every major between the old one and the new one
   (all of them, not only the last): the breaking changes page
   (https://www.electronjs.org/docs/latest/breaking-changes) and the release
   notes (https://releases.electronjs.org). Note the Chromium and Node.js
   versions each major ships, and any operating system it stops supporting.
2. **Map each change onto the code.** Search `src/main`, `src/preload`,
   `src/injected`, `scripts` and the config files for every API, event,
   default or behaviour the notes mention. "Not used here" is a valid answer;
   write it down so the reviewer knows it was checked.
3. **Go through the places that have bitten this project before** (below).
4. **Adapt the code**, following the project rules in `CONTRIBUTING.md`: the
   IPC golden rule, user-facing strings through the i18n layer with a French
   key and an English entry, no hard-coded colours, focused changes.
5. **Run the checks, in this order, and fix what they show:**

   ```bash
   npm run typecheck
   npm run lint
   npm test
   npm run build
   xvfb-run -a node scripts/smoke.mjs
   ```

   The smoke suite needs the build, takes a few minutes and drives a real
   browser; one of its popup scenarios is occasionally flaky, so a failure
   there deserves one re-run before you conclude anything. Other failures are
   real until proven otherwise.
6. **Regenerate what is generated:** `npm run gen:credits` (the licence page
   lists Electron and what it bundles).
7. **Write the report** (format below), then stop.

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
  If the new Chromium drops an OS version, the README is yours to update; the
  workflow change goes in the report.

## The report

Write it to `ELECTRON_UPGRADE_REPORT.md` at the repository root (the workflow
moves it into the pull request description; it is not committed). Plain
Markdown, in English, with exactly these sections:

1. **Summary**: two or three sentences. Does it build, do the checks pass, and
   what is the one thing the reviewer must look at.
2. **Breaking changes reviewed**: one line per change, grouped by major:
   what it is, whether it applies here, and where you handled it.
3. **Code changes**: each file you touched and why.
4. **Checks**: every command you ran with its real outcome. If something
   failed and you could not fix it, the failing output and your best
   understanding of the cause.
5. **Not verified**: what this run could not exercise. Always list at least:
   the smoke suite on Windows and macOS (CI on the pull request runs it), the
   packaged applications, Google sign-in done by hand, installing an extension
   from the Chrome Web Store, and updating from the previous release.
6. **Needs a human decision**: anything you chose not to do, and why.
7. **Workflow changes needed**: exact edits to files under
   `.github/workflows/`, or "none".

Never write that something works unless you ran it in this session and saw
it pass. "Not run" and "failed" are acceptable answers; a wrong "passed" is
not.
