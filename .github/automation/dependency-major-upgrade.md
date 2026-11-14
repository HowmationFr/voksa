# Playbook: upgrading a dependency to a new major

**Read [`upgrade-rules.md`](upgrade-rules.md) first.** It holds the rules
common to every automated upgrade: what you must not do, the checks to run,
and the report whose first line decides whether your work merges unattended.
This page only adds how to carry out the bump itself.

You were given one package and a target major. Unlike for Electron, the
workflow has NOT bumped anything: that is your first step, because a
dependency rarely moves alone.

## How to work

1. **Find out what moves with it.** Before installing anything, read the
   package's release notes and migration guide for every major you are
   crossing (its repository on GitHub, its page on npmjs.com), and its peer
   dependencies. Typical families in this project:
   - `react` with `react-dom`, `@types/react`, `@types/react-dom`, and
     possibly `@vitejs/plugin-react`, `eslint-plugin-react`,
     `eslint-plugin-react-hooks`, `zustand`, `lucide-react` if their current
     versions do not accept the new React;
   - `eslint` with `@eslint/js`, `typescript-eslint`,
     `@typescript-eslint/*` and the ESLint plugins;
   - `typescript` with `typescript-eslint` and `@typescript-eslint/*`;
   - `vite` with `@vitejs/plugin-react` and `vitest`;
   - `tailwindcss` with `postcss`, `autoprefixer` and its own config format;
   - any package with its `@types/` package.

   Move the family together, to the versions that work with each other. Do
   not take the opportunity to upgrade anything unrelated.
2. **Bump with npm**, keeping each package where it is in `package.json`
   (`dependencies` or `devDependencies`) and its range style (a caret range
   stays a caret range):

   ```bash
   npm install --save-dev "name@^N.0.0"
   ```

   Use `--save` instead of `--save-dev` for a package listed under
   `dependencies`. If npm refuses because of a peer dependency, that is
   information about the family, not something to force: never use `--force`
   or `--legacy-peer-deps`.
3. **Map the breaking changes onto the code**: search for every API, option,
   default or config format the notes mention, in `src/`, `scripts/` and the
   config files at the repository root.
4. **Know what kind of package it is**, because it changes what can go wrong:
   - one that **ships inside the application** (the runtime dependencies, and
     React, zustand, lucide-react, Tailwind's CSS, the Inter font: the list is
     `src/shared/credits.generated.json`): a regression reaches users. Look
     at what it renders or does at runtime, not only at whether it compiles,
     and run `npm run gen:credits` afterwards;
   - a **build or test tool** (vite, esbuild, vitest, eslint, typescript,
     electron-builder...): nothing of it ships, but it decides what the
     checks mean. A new major of the test runner or the linter that silently
     runs fewer tests or fewer rules makes everything look green. Compare the
     number of tests and of linted files before and after, and say so in the
     report.
5. **Adapt the code, run the checks, write the report**, as the common rules
   say.

## When to stop

Some majors are a project, not a bump: a rewrite of the configuration format
across the whole UI, a change that touches most components, a tool whose new
major drops something this build relies on. If the honest description of the
work is "large and risky", do not push through it to produce a pull request.
Leave the code as you found it apart from what you are sure of, set the
verdict to `hold`, and use the report to say what the migration involves, so
that the maintainer can decide when to do it.
