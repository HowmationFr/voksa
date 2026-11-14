# How Voksa keeps itself up to date

A browser is only as safe as the Chromium it ships, and Chromium fixes reach
Voksa through Electron releases. This page describes the chain that carries a
fix from "Electron published it" to "users have it" with nobody in the loop,
and the one place where a person is still required.

## The chain

| Step | Who does it | When |
|---|---|---|
| A dependency publishes a patch or minor version | Dependabot opens a pull request (`dependabot.yml`) | daily |
| CI runs on it (types, lint, tests, build, packaging, end-to-end smoke on Windows, macOS, Linux) | `ci.yml` | on the pull request |
| A check fails | `dependabot-ci-retry.yml` re-runs the failed jobs once, then opens an issue if it is still red | on failure |
| CI is green | `dependabot-automerge.yml` merges it | immediately |
| Something that ships inside a build changed since the last release | `auto-release.yml` opens the release pull request, lets it merge, tags it | daily, 14:17 UTC |
| The tag exists | `release.yml` builds and signs the installers, verifies the draft, and publishes it | on the tag |
| A release is published | every installed copy updates itself (`electron-updater`) | at its next check |

"Something that ships" is decided by `scripts/release-due.mjs` from the list
the project already maintains for its licence page
(`src/shared/credits.generated.json`): Electron, the runtime dependencies and
the dev dependencies compiled into the bundles. A bump of a build tool changes
nothing in the product and releases nothing. An automatic release ships
everything on `main`, which only ever receives pull requests that passed the
full CI.

## New Electron majors

Dependabot ignores major versions on purpose. `electron-major.yml` checks once
a week whether a newer stable major exists. If so it opens a tracking issue,
then prepares the upgrade: it bumps Electron on the branch
`automation/electron-<major>`, lets Claude adapt the code following
[`automation/electron-major-upgrade.md`](automation/electron-major-upgrade.md),
re-runs the checks itself and opens a pull request with the agent's report and
the measured results.

**That pull request is the one thing a person must do.** It is never merged
automatically, and it is a draft when a check still fails. Ask `@claude` in
the pull request to look at a failing CI job if needed.

## What a person still decides

- Merging an Electron major upgrade (above).
- Feature releases: bump the version yourself (`npm version minor`), merge
  that pull request and push the tag. A release tagged by hand stops at the
  draft and waits for "Publish release", as before. While `package.json` is
  ahead of the last tag, automatic releases stand aside.
- Anything Dependabot does not touch: the two patched extension libraries
  (pinned, see `dependabot.yml`) and every major version.

## Setup (once)

Two repository secrets, under Settings > Secrets and variables > Actions:

- **`CLAUDE_CODE_OAUTH_TOKEN`**: lets the upgrade agent run on the
  maintainer's Claude subscription. Created by `/install-github-app` in
  Claude Code, or by hand with `claude setup-token`.
- **`AUTOMATION_TOKEN`**: a fine-grained personal access token of a
  repository admin, limited to this repository, with **Contents: read and
  write** and **Pull requests: read and write**. It exists because GitHub
  starts no workflow for a pull request or a tag created with the default
  `GITHUB_TOKEN` (loop protection): CI would never run on the release pull
  request, and `release.yml` would never start on the tag. The "release tags"
  ruleset also only lets a repository role create `v*` tags, which this token
  inherits from its owner.

  The token expires on the date chosen when creating it. When it does, the
  automatic release fails with a message naming this file and GitHub mails the
  failed run: create a new token and update the secret.

Commits made by these workflows carry the identity of the token's owner (their
GitHub noreply address), so the history reads as if the maintainer had cut the
release by hand.

## Pausing it

- Automatic releases: set the repository **variable** `AUTO_RELEASE` to `off`
  (Settings > Secrets and variables > Actions > Variables). Delete it, or set
  anything else, to resume.
- One release in particular: close its pull request before it merges.
- Everything else: disable the workflow from the Actions tab.

## What this does not protect against

- A dependency that publishes a bad version passes CI and merges like any
  other; the automatic release then ships it. The safety net is the end-to-end
  suite, not a human look.
- The Windows installer is not code-signed, so the updater cannot check who
  published an update there: whoever can publish a release on this repository
  can update every Windows install.
- The upgrade agent runs the project's own commands with its Claude token in
  its environment. Its inputs are this repository and Electron's
  documentation; it has no access to `AUTOMATION_TOKEN`.
