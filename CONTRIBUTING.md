# Contributing to Voksa

Thanks for wanting to contribute! Voksa is a privacy-focused Electron browser whose flagship feature is Stream Mode: zero on-screen leakage of sensitive information while streaming or screen sharing.

## Quick start

Prerequisites: Node 20+, Git. On Windows you also need the C++ build tools (the "tools" option of the Node installer) to compile better-sqlite3.

```bash
git clone https://github.com/<your-fork>/voksa.git
cd voksa
npm install        # also applies patches/ (patch-package) and rebuilds better-sqlite3
npm run dev        # esbuild watch + vite + electron
```

Checks that must pass before any push (CI enforces all of them):

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

## Project rules

These rules are non-negotiable: CI enforces some of them, reviewers enforce the rest. The most sensitive areas of the codebase are internal page rendering, Stream Mode (masking, curtain, shroud), Google login (user-agent handling) and view layering; open an issue to validate the approach before restructuring any of them.

- **Every new cross-process API follows the IPC golden rule**: constant in `src/shared/ipcChannels.ts`, handler in `src/main/ipc/handlers.ts`, exposure in `src/preload/voksaApi.ts`, consumption through `voksa.*` in the UI. Never call `ipcRenderer` directly from the UI.
- **No hardcoded hex colors in components**: semantic Tailwind tokens only (`bg-bg`, `text-fg-muted`, `accent`, `stream`...).
- **User-facing strings go through the i18n layer** (French source string as the key, English translation in the dictionary). Never hardcode a raw UI string in a component.
- **Stream Mode is the critical feature**: any change touching masking, the curtain or the shroud must guarantee zero frames of sensitive information on screen. When in doubt, open an issue before writing code.
- **Never claim you tested something you did not run.** Say so in the PR if a code path was not exercised.

## Contribution lifecycle

1. Open an issue (bug or proposal) before large changes, to validate the approach.
2. Fork, create a branch from `main`: `git checkout -b my-feature`.
3. Write the code, keeping commits focused and messages descriptive.
4. Make the 5 checks above pass locally.
5. Open the PR and fill in the template. CI then runs: lint, typecheck, unit tests, build, Windows/macOS/Linux packaging and a real boot smoke test on all three OSes.
6. A maintainer reviews; once CI is green and the review approved, the PR is merged into `main`.

Releases are cut by maintainers from `main`: a `vX.Y.Z` tag (derived from the `package.json` version) triggers the release workflow, which builds and signs the Windows, macOS and Linux artifacts into a draft release that a maintainer then publishes manually.

## License

The project is licensed under **GPL-3.0** (required in particular by the GPL option of `electron-chrome-extensions`). By contributing you agree that your code is distributed under this license.
