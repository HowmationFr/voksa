# Rules for every automated upgrade

You are run by `.github/workflows/agent-upgrade.yml`, unattended, on a GitHub
runner. Nobody is there to answer questions, and **nobody reviews your work
before it ships**: when the checks pass and your verdict is `ready`, the pull
request merges on its own and the next automatic release sends it to every
user. Read that sentence again before each decision you are tempted to make
quickly.

The workflow has already created the branch and installed the dependencies.
Your job is the part that needs judgment: find out what the new major changes
for THIS codebase, adapt the code, prove what you can, and say honestly what
you could not.

## What you must not do

- **No git writes.** Do not commit, push, create branches or open pull
  requests: the workflow does all of that after you finish.
- **Do not edit `.github/`.** The token that pushes your work cannot update
  workflow files, so the push would be rejected. If a workflow or this
  automation needs a change, describe it in the report and set the verdict to
  `hold`.
- **Do not weaken a test to make it pass.** No deleting, skipping, loosening
  an assertion or raising a timeout to get to green. If a test fails because
  the behaviour really changed, fix the code. Adapting unit tests to the new
  major is part of the job (a renamed API, a different mock, a new type): it
  does not hold the merge, and nobody reads those changes before they ship.
  That is exactly why each test you touch must keep checking what it checked
  before. List every test file you changed in the report, with what changed
  and why. The workflow counts the unit tests that pass before and after you:
  fewer afterwards holds the merge.
- **Leave the other judges alone.** The end-to-end suite (`scripts/smoke.mjs`,
  `scripts/fixtures/`), the scripts CI judges a pull request with
  (`scripts/check-packaged.mjs`, `scripts/version-only-diff.mjs`), the
  configuration of a check (`eslint.config.mjs`, `tsconfig*.json`,
  `vitest.config.ts`) and the `scripts` section of `package.json`. An upgrade
  of that very tool may legitimately need one of them changed: do it
  deliberately, explain it in the report and say `hold` yourself, because
  touching any of these holds the merge for a person anyway.
- **Do not bump `electron-chrome-extensions` or `electron-chrome-web-store`.**
  Both are pinned and patched (`patches/`, applied by `patch-package
  --error-on-fail`). If a patch no longer applies or they stop working, stop
  and report it with a `hold` verdict: porting those patches is a human
  decision.
- **Do not change dependency versions beyond what this upgrade requires.**
  Packages that must move together with the one you were given are part of
  the upgrade (say which and why); anything else is not.
- **Do not trade the Stream Mode guarantee for a passing build.** When Stream
  Mode is on, nothing sensitive may be painted, not for one frame. Any change
  under `src/main/stream-mode/`, `src/injected/` or `src/preload/page.ts` must
  keep that property. If you are not certain it does, do not make the change:
  report the question and set the verdict to `hold`.

## Project rules

`CONTRIBUTING.md` applies to you like to any contributor: the IPC golden rule,
user-facing strings through the i18n layer with a French key and an English
entry, no hard-coded colours in components, focused changes.

## The checks

Run them in this order, and fix what they show:

```bash
npm run typecheck
npm run lint
npm test
npm run build
xvfb-run -a node scripts/smoke.mjs
```

The smoke suite needs the build, takes a few minutes and drives a real
browser. One of its popup scenarios is occasionally flaky, so a failure there
deserves one re-run before you conclude anything. Every other failure is real
until proven otherwise. The workflow runs all five again after you: a check
you report as passing and that then fails only costs you credibility.

If a generated file depends on what you changed, regenerate it: `npm run
gen:credits` rewrites the licence page data whenever a package that ships
inside the application changes version.

## The report

Write it to `UPGRADE_REPORT.md` at the repository root. The workflow moves it
into the pull request description; it is not committed. Plain Markdown, in
English.

**Its first line is your verdict, and it decides whether this merges
unattended.** It must be exactly one of:

```
Verdict: ready
```

```
Verdict: hold
```

Say `ready` only if all of this is true: every check above passed in this
session; every unit test you changed still checks what it checked before, and
none was deleted or skipped; you touched none of the other judges listed
above; nothing in the release notes is left that you did not understand or
could not check against the code; you would be
comfortable seeing this change reach every user tonight without anyone having
read it. Anything else is `hold`. A `hold` is not a failure: it sends the
pull request to the maintainer with your explanation, which is the right
outcome whenever you are not sure.

After the verdict line, exactly these sections:

1. **Summary**: two or three sentences. What changed, whether it builds and
   passes, and, for a `hold`, the one reason.
2. **Breaking changes reviewed**: one line per change in the release notes:
   what it is, whether it applies here, and where you handled it. "Not used
   here" is a valid answer; write it so the reader knows it was checked.
3. **Code changes**: each file you touched and why, including every other
   package you bumped with it.
4. **Checks**: every command you ran with its real outcome. For anything
   that failed and that you could not fix, the failing output and your best
   understanding of the cause.
5. **Not verified**: what this run could not exercise. Always list at least:
   the smoke suite on Windows and macOS (CI on the pull request runs it) and
   the packaged applications.
6. **Needs a human decision**: anything you chose not to do, and why, or
   "nothing".

Never write that something works unless you ran it in this session and saw
it pass. "Not run" and "failed" are acceptable answers; a wrong "passed" is
not.
