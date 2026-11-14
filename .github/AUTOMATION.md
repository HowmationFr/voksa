# How Voksa keeps itself up to date

A browser is only as safe as the Chromium it ships, and Chromium fixes reach
Voksa through Electron releases. This page describes the chain that carries
an update from "the dependency published it" to "users have it" with nobody
in the loop, and the cases where it stops and asks for a person.

## Patch and minor versions

| Step | Who does it | When |
|---|---|---|
| A dependency publishes a patch or minor version | Dependabot opens a pull request (`dependabot.yml`) | weekdays, three days after the release (Dependabot's default cooldown) |
| CI runs on it (types, lint, tests, build, packaging, end-to-end smoke on Windows, macOS, Linux) | `ci.yml` | on the pull request |
| A check fails | `dependabot-ci-retry.yml` re-runs the failed jobs once | on failure |
| It is still red | the same workflow opens an issue and has the update repaired by the agent, as a pull request of its own that merges once green (see below) | on the second failure |
| CI is green | `dependabot-automerge.yml` merges it | immediately |
| `main` moved while a pull request was waiting for its CI | `automerge-keep-current.yml` brings it up to date, so auto-merge can finish | on every push to `main` |
| Something that ships inside a build changed since the last release | `auto-release.yml` opens the release pull request, lets it merge, tags it | checked daily at 14:17 UTC, at most one release every 4 days |
| The tag exists | `release.yml` builds and signs the installers, verifies the draft, and publishes it | on the tag |
| A release is published | every installed copy updates itself (`electron-updater`) | at its next check |

"Something that ships" is decided by `scripts/release-due.mjs` from the list
the project already maintains for its licence page
(`src/shared/credits.generated.json`): Electron, the runtime dependencies and
the dev dependencies compiled into the bundles. A bump of a build tool changes
nothing in the product and releases nothing. An automatic release ships
everything on `main`, which only ever receives pull requests that passed the
full CI, and only ever moves the last number of the version (0.9.1 becomes
0.9.2), whatever was updated.

### When an update stays red

Being told that a security fix is stuck only moves the wait. After the retry,
`dependabot-ci-retry.yml` hands the update to the agent
(`agent-upgrade.yml`, following
[`automation/dependabot-fix.md`](automation/dependabot-fix.md)): the update is
applied on a branch of its own, Claude finds what it breaks and fixes the
code, the workflow re-runs every check, and the repair comes as a pull request
that goes through the same gate as a major upgrade: it merges on its own once
CI is green, or waits for a person for the reasons listed further down. The
issue that reported the red CI closes when the repair merges, and Dependabot
then closes its own pull request (nothing left to update).

One repair per Dependabot pull request, and only for npm updates (an update of
a GitHub Action changes workflow files, which the automation token cannot
push). The agent runs on Linux: a failure that only exists on Windows or
macOS, or a flaky run, it cannot reproduce, and its playbook tells it to say
so and change nothing.

### Pull requests that fall behind

The `main` ruleset only merges a pull request that is up to date with `main`,
and GitHub never updates one by itself: a pull request set to merge would
wait forever, green, behind a later merge. `automerge-keep-current.yml`
updates those on every push to `main`. It only touches pull requests whose
auto-merge is already on (that switch is the decision to merge), never
Dependabot's (it rebases its own), a fork's, or a draft.

### GitHub Actions

The actions the workflows use (`actions/checkout`, `actions/setup-node`...)
are updated by Dependabot too, once a week, in one grouped pull request that
merges on its own like the others, **majors included**: an action is
referenced by its major (`actions/checkout@v7`), so nearly every update of one
is a major, and waiting for a person each time meant waiting every time. CI
on the pull request is what vouches for it, which covers `ci.yml` only: a new
major that breaks `release.yml` or one of the scheduled workflows is found
when that workflow next runs and fails (GitHub mails the failed run).

One exception waits for a person: a major of `anthropics/claude-code-action`,
the action that runs the upgrade agent. What the agent is allowed to do is
passed to it as inputs, and a new major can rename or reinterpret them
without any check noticing. It has its own pull request, so it never holds
the other actions back.

## Major versions

Dependabot ignores major versions of npm packages on purpose: a major usually
needs code changes. Those are made by an agent (Claude, on the maintainer's
subscription), one upgrade at a time:

| What | Workflow | When |
|---|---|---|
| A new Electron major | `electron-major.yml` opens a tracking issue, then has the upgrade done | Mondays, 06:41 UTC |
| A new major of any other direct dependency | `dependency-majors.yml` picks one (`scripts/outdated-majors.mjs`), shipped dependencies first | Wednesdays, 06:41 UTC |

Both hand the work to `agent-upgrade.yml`: the agent adapts the code following
the playbooks in [`automation/`](automation/), the workflow re-runs every
check itself, opens the pull request and sets it to **merge on its own once CI
is green on all three OSes**. From there it is released like any other update.

### When an upgrade waits for a person

The pull request stays open, and a comment says why, when:

- the agent session did not finish, or a check fails on the runner (the pull
  request is then a draft);
- the package did not actually reach the target major;
- the agent's own verdict is not `ready`: its playbook tells it to say `hold`
  whenever it is not sure, and for anything touching the Stream Mode
  guarantee it cannot prove;
- fewer unit tests pass after the upgrade than before it (one was deleted,
  skipped, or no longer runs), or the count could not be read;
- the end-to-end suite lost a scenario it had before the upgrade;
- the agent changed the configuration of a check (linter, type checker, test
  runner), a script CI runs to judge a pull request (the packaged-app check,
  the scope probe), or the npm scripts that launch the checks. Green checks
  only mean something if what judges the change is not part of the change.

The tests are deliberately **not** on that list, neither the unit tests nor
the end-to-end suite (`scripts/smoke.mjs`, `scripts/fixtures/`). A new major
changes what they use nearly every time, so the agent adapts them, and that
alone does not wait for anyone: its report lists what it changed there and
why.

Merge it by hand after reading it, or ask `@claude` in the pull request to fix
what fails. A dependency is attempted once per major: closing its pull request
without merging means "no", and it is not proposed again (the manual trigger
has a `retry` option; a retry switches off the auto-merge of the previous
attempt before pushing anything, so the new attempt is judged on its own).

### How the automation itself is tested

`src/shared/__tests__/automation*.test.ts` run with the unit tests. They run
the two decision scripts (`release-due.mjs`, `version-only-diff.mjs`) in
throwaway git repositories, and the bash of the workflow steps that decide
(what merges on its own, what is tagged, what is published) with `gh`, `npm`
and `git push` replaced by recorders. They do not run GitHub itself: that
auto-merge waits for the required checks, the rulesets and the two secrets are
only proven by the workflows running.

## What a person still decides

- Held upgrades (above).
- Feature releases: bump the version yourself (`npm version minor`), merge
  that pull request and push the tag. A release tagged by hand stops at the
  draft and waits for "Publish release", as before. While `package.json` is
  ahead of the last tag, automatic releases stand aside.
- The two patched extension libraries (pinned, see `dependabot.yml`): a bump
  means porting their patches.
- **Every pull request a person opens.** Nothing above removed a review: the
  `main` ruleset never required an approval, and what merges unattended does
  so because auto-merge was switched on for it, by a workflow that recognises
  its author (Dependabot, the upgrade agent, the release). No workflow
  switches it on for anyone else. A contributor's pull request comes from a
  fork: its CI does not even start before the maintainer allows it (first
  contribution), nothing enables auto-merge on it, and its author cannot
  merge. It waits to be read and merged by the maintainer, whose own pull
  requests merge when the maintainer says so (`gh pr merge --auto --merge`).

## Setup (once)

Two repository secrets, under Settings > Secrets and variables > Actions:

- **`CLAUDE_CODE_OAUTH_TOKEN`**: lets the upgrade agent run on the
  maintainer's Claude subscription. Created by `/install-github-app` in
  Claude Code, or by hand with `claude setup-token`. Upgrades draw on the same
  usage limits as the maintainer's own sessions.
- **`AUTOMATION_TOKEN`**: a fine-grained personal access token of a
  repository admin, limited to this repository, with **Contents: read and
  write** and **Pull requests: read and write**. It exists because GitHub
  starts no workflow for a pull request or a tag created with the default
  `GITHUB_TOKEN` (loop protection): CI would never run on the pull requests
  opened here, and `release.yml` would never start on the tag. The "release
  tags" ruleset also only lets a repository role create `v*` tags, which this
  token inherits from its owner.

  The token expires on the date chosen when creating it. When it does, these
  workflows fail with a message naming this file and GitHub mails the failed
  run: create a new token and update the secret.

Commits made by these workflows carry the identity of the token's owner (their
GitHub noreply address), so the history reads as if the maintainer had made
the change by hand.

## Pausing it

- Automatic releases: set the repository **variable** `AUTO_RELEASE` to `off`
  (Settings > Secrets and variables > Actions > Variables). Delete it, or set
  anything else, to resume.
- Their pace: automatic releases are at least 4 days apart, so that users are
  not handed an update every other day; what merges in between ships together.
  Set the variable `AUTO_RELEASE_MIN_DAYS` to another number to change it.
  Running `auto-release.yml` by hand releases immediately, whatever the
  spacing (an urgent fix).
- Repairs of Dependabot updates that stay red: set the variable
  `DEPENDABOT_REPAIR` to `off`. The retry and the issue stay.
- One release or one upgrade in particular: close its pull request before it
  merges, or turn off auto-merge on it.
- Major upgrades, or anything else: disable the workflow from the Actions tab.

## What this does not protect against

Stated plainly, because everything above runs without review:

- **Code written by an agent can reach users without anyone having read it.**
  What stands between a wrong upgrade and a release is the unit tests, the
  end-to-end suite on three OSes, the agent's own verdict and the "judges
  unchanged" rule. A regression none of them sees ships. The most exposed
  area is the one the tests cannot fully cover: what Stream Mode paints.
- **The agent may rewrite the tests that judge its own work**, the unit tests
  and the end-to-end suite alike, and that merges without review. A test or a
  scenario changed to agree with a regression passes; for Stream Mode the
  end-to-end suite is the only check of what is really painted. What the
  agent cannot do without a person looking: delete or skip a unit test, drop
  an end-to-end scenario, or change the configuration of the checks.
- A dependency that publishes a bad version passes CI and merges like any
  other; the automatic release then ships it. Dependabot's three-day cooldown
  is the only delay.
- The Windows installer is not code-signed, so the updater cannot check who
  published an update there: whoever can publish a release on this repository
  can update every Windows install.
- The upgrade agent runs the project's own commands with its Claude token in
  its environment. Its inputs are this repository and the release notes of
  the package it upgrades; it has no access to `AUTOMATION_TOKEN`.
