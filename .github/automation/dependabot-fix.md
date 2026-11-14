# Repairing a dependency update that does not pass

Read [`upgrade-rules.md`](upgrade-rules.md) first: everything in it applies
here (what you must not touch, the checks, the report and its verdict line).

## The situation

Dependabot opened a pull request for a patch or minor update, and CI failed on
it twice in a row. Updates of that size normally merge and ship on their own;
this one is stuck, and if it carries an Electron patch, users stay on an older
Chromium until it is sorted out.

The workflow has applied that update to your working tree, on top of the
current `main`, **uncommitted**: `git diff HEAD -- package.json` shows which
packages moved and to which versions. Your job is to make the project pass
with those versions.

## What to do

1. **See what fails.** Run the checks of `upgrade-rules.md`, in order. Do not
   guess from the package names.
2. **Find out why**, in the release notes of the packages that moved (their
   GitHub releases or changelog, between the two versions). A patch or minor
   that breaks something is usually a deprecation that became an error, a
   stricter type, a changed default, or a bug in the new version.
3. **Fix the cause in this repository's code.** The smallest change that is
   correct, not the smallest that turns the check green.
4. **Run every check again**, all five, even those that passed before.

## What you must not do here

- **Do not undo the update.** Putting a dependency back to its old version,
  pinning it, or adding an `overrides` entry is not a repair: the update is
  the point. If the new version is itself broken (a regression upstream, a
  bad release), that is a `hold`: say which package and version, what breaks,
  and link the upstream issue if there is one.
- **Do not move other dependencies**, unless the release notes say one must
  move with the update. Say which and why.
- The update is not a major: if what you find calls for a migration, stop and
  say `hold`.

## When nothing fails here

CI runs on Windows, macOS and Linux; you run on Linux only. If every check
passes on your side, the failure is specific to another OS, or the end-to-end
suite was flaky. You cannot verify a fix for something you cannot reproduce:
change nothing, say `hold`, and write what you ran and what you saw. The
maintainer re-runs CI or takes over.

## The report

As in `upgrade-rules.md`, with "Breaking changes reviewed" listing what
changed between the old and the new version of each package that moved, and
which of those changes caused the failure.
