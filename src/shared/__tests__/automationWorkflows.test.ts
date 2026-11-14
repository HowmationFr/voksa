/**
 * The rest of the unattended chain (.github/AUTOMATION.md), in two parts:
 *
 *  - what the workflow files must keep saying for the chain to be safe (the
 *    agent never holds a token that can push, what it may run, which files
 *    count as "judges"). Read as text: a rule lost in an edit fails here.
 *  - the release chain run for real, step by step: the release pull request
 *    auto-release.yml opens is exactly the one ci.yml fast-tracks and the one
 *    release.yml publishes on its own, and nothing else is.
 *
 * Not covered here: GitHub itself (rulesets, required checks, what a token
 * may do) and electron-builder. Those are only proven by a real run.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  FAKE_GIT,
  GitFixture,
  ROOT,
  canRunSteps,
  readRepoFile,
  readWorkflow,
  runNodeScript,
  runScripts,
  runStep,
  stepBlock,
  stepRun,
  type StepResult,
} from './automationHelpers';

vi.setConfig({ testTimeout: 120_000 });

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'voksa-workflows-'));
afterAll(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const workflowNames = fs.readdirSync(path.join(ROOT, '.github', 'workflows')).filter((name) => name.endsWith('.yml'));
const agentUpgrade = readWorkflow('agent-upgrade.yml');
const autoRelease = readWorkflow('auto-release.yml');
const release = readWorkflow('release.yml');
const ci = readWorkflow('ci.yml');

/** The steps of a single-job workflow, one string each. */
const stepsOf = (workflow: string): string[] => workflow.split(/\n(?= {6}- )/).slice(1);

/** One job of a workflow, from its name to the next job. */
function jobBlock(workflow: string, job: string): string {
  const start = workflow.indexOf(`\n  ${job}:\n`);
  if (start === -1) throw new Error(`job "${job}" not found`);
  const rest = workflow.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[A-Za-z0-9_-]+:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

describe('every workflow: scripts take their inputs from the environment', () => {
  // `${{ }}` is pasted into the script BEFORE bash reads it: a branch name,
  // a title or a package name written there is a way to run commands.
  it.each(workflowNames)('%s has no ${{ }} inside a script', (name) => {
    const offenders = runScripts(readWorkflow(name)).filter((script) => script.includes('${{'));
    expect(offenders).toEqual([]);
  });

  it.each(workflowNames)('%s does not pass values to later steps through $GITHUB_ENV', (name) => {
    expect(readWorkflow(name)).not.toContain('GITHUB_ENV');
  });
});

describe('agent-upgrade.yml: the agent cannot push, merge or publish', () => {
  const steps = stepsOf(agentUpgrade);
  const agent = stepBlock(agentUpgrade, 'id: agent');
  const indexOf = (marker: string): number => steps.findIndex((step) => step.includes(marker));

  it('the token that can push exists only before the agent (a presence check) and after it', () => {
    const holders = steps.filter((step) => step.includes('secrets.AUTOMATION_TOKEN'));
    expect(holders.map((step) => /name: (.*)/.exec(step)?.[1])).toEqual([
      'Both secrets must be configured',
      'Commit, push, open the pull request, decide the merge',
    ]);
    // Not at job level either, where every step would inherit it.
    const jobEnv = agentUpgrade.slice(agentUpgrade.indexOf('\n    env:\n'), agentUpgrade.indexOf('\n    steps:\n'));
    expect(jobEnv).toContain('PACKAGE: ${{ inputs.package }}');
    expect(jobEnv).not.toContain('secrets.');
  });

  it('the agent step is given the Claude token and nothing else', () => {
    expect(agent).toContain('claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}');
    expect(agent.match(/secrets\./g)).toHaveLength(1);
    expect(agent).not.toContain('github_token');
    expect(agent).not.toMatch(/^\s+env:/m);
  });

  it('the checks that run the upgraded code hold no secret either', () => {
    expect(stepBlock(agentUpgrade, 'id: checks')).not.toContain('secrets.');
    expect(stepBlock(agentUpgrade, 'id: start')).not.toContain('secrets.');
  });

  it('the checkout leaves no credential in the git configuration', () => {
    // Found by name, not by version: Dependabot bumps the version.
    const checkouts = steps.filter((step) => /uses: actions\/checkout@/.test(step));
    expect(checkouts).toHaveLength(1);
    expect(checkouts[0]).toContain('persist-credentials: false');
  });

  it('the workflow token cannot write to the repository contents', () => {
    expect(agentUpgrade).not.toMatch(/contents: write/);
    expect(agentUpgrade).toMatch(/\npermissions:\n {2}contents: read\n/);
  });

  it('runs only when called by another workflow', () => {
    const triggers = agentUpgrade.slice(agentUpgrade.indexOf('\non:\n'), agentUpgrade.indexOf('\npermissions:\n'));
    expect(triggers).toContain('workflow_call:');
    for (const trigger of ['schedule:', 'workflow_dispatch:', 'pull_request', 'push:', 'issue_comment']) {
      expect(triggers).not.toContain(trigger);
    }
  });

  describe('what the agent may run', () => {
    const allowed = /--allowedTools "([^"]+)"/.exec(agent)?.[1].split(',') ?? [];
    const bash = allowed.filter((tool) => tool.startsWith('Bash')).map((tool) => /^Bash\((.+):\*\)$/.exec(tool)?.[1]);
    const web = allowed.filter((tool) => tool.startsWith('Web'));

    it('an explicit list, in the mode that refuses what is not on it', () => {
      expect(allowed.length).toBeGreaterThan(10);
      expect(agent).toContain('--permission-mode acceptEdits');
      expect(agent).not.toMatch(/bypassPermissions|dangerously/);
    });

    it('no shell at large: each Bash entry names one command', () => {
      expect(bash.length).toBeGreaterThan(0);
      expect(bash).not.toContain(undefined);
      for (const command of bash as string[]) {
        expect(command).toMatch(/^(npm|npx|node|xvfb-run|git (status|diff|log|show))$/);
      }
    });

    it('git is read-only, and there is no `gh`: branch, commit, push and merge are the workflow\'s', () => {
      const git = (bash as string[]).filter((command) => command.startsWith('git'));
      expect(git.sort()).toEqual(['git diff', 'git log', 'git show', 'git status']);
      expect(allowed.join(',')).not.toMatch(/\bgh\b|push|commit|checkout|switch|reset|curl|wget|sudo/);
    });

    it('the web is limited to named sites: no open fetch, no search', () => {
      expect(web.length).toBeGreaterThan(0);
      for (const tool of web) expect(tool).toMatch(/^WebFetch\(domain:[a-z0-9.-]+\)$/);
    });

    it('nothing else than file tools, those commands and those sites', () => {
      const others = allowed.filter((tool) => !tool.startsWith('Bash(') && !tool.startsWith('WebFetch('));
      expect(others.sort()).toEqual(['Edit', 'Glob', 'Grep', 'LS', 'MultiEdit', 'Read', 'Write']);
    });
  });

  describe('the gate is fed what the workflow measured', () => {
    const pr = stepBlock(agentUpgrade, 'id: pr');

    it('the steps come in the order the gate relies on', () => {
      const order = ['id: start', 'id: agent', 'id: checks', 'id: pr', 'name: Tell the maintainer'].map(indexOf);
      expect(order).not.toContain(-1);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
    });

    it('a dead agent session does not stop the run, and is seen as dead', () => {
      expect(agent).toContain('continue-on-error: true');
      // `conclusion` is always "success" under continue-on-error.
      expect(pr).toContain('AGENT_OUTCOME: ${{ steps.agent.outcome }}');
      expect(agentUpgrade).not.toContain('steps.agent.conclusion');
    });

    it('the results and both test counts come from the workflow\'s own steps', () => {
      expect(pr).toContain('CHECKS_FAILED: ${{ steps.checks.outputs.failed }}');
      expect(pr).toContain('TESTS_BEFORE: ${{ steps.start.outputs.tests }}');
      expect(pr).toContain('TESTS_AFTER: ${{ steps.checks.outputs.tests }}');
      expect(stepBlock(agentUpgrade, 'id: checks')).toContain('TESTS_BEFORE: ${{ steps.start.outputs.tests }}');
    });

    it('the checks run even when the agent failed, so the draft says what is broken', () => {
      for (const marker of ['id: checks', 'id: pr']) {
        expect(stepBlock(agentUpgrade, marker)).not.toMatch(/^\s+if:/m);
      }
    });
  });

  describe('the instructions and the gate agree', () => {
    const rules = readRepoFile('.github/automation/upgrade-rules.md');
    const prScript = stepRun(agentUpgrade, 'id: pr');

    it('on the verdict line and on where the report goes', () => {
      expect(prScript).toContain('!= "Verdict: ready"');
      expect(rules).toMatch(/^Verdict: ready$/m);
      expect(rules).toMatch(/^Verdict: hold$/m);
      expect(agent).toContain('Verdict: ready');
      expect(prScript).toContain('UPGRADE_REPORT.md');
      expect(rules).toContain('`UPGRADE_REPORT.md`');
    });

    it('every playbook handed to the agent exists and starts from the common rules', () => {
      const playbooks = ['electron-major.yml', 'dependency-majors.yml'].map(
        (name) => /^\s+playbook: (\S+)$/m.exec(readWorkflow(name))?.[1],
      );
      expect(playbooks).not.toContain(undefined);
      for (const playbook of playbooks as string[]) {
        expect(readRepoFile(playbook), playbook).toContain('upgrade-rules.md');
      }
    });
  });
});

describe('the callers of agent-upgrade.yml', () => {
  const declared = [...agentUpgrade.matchAll(/^ {6}([a-z_]+):\n {8}description:/gm)].map((m) => m[1]);
  const required = [...agentUpgrade.matchAll(/^ {6}([a-z_]+):\n(?: {8}.*\n)*? {8}required: true/gm)]
    .map((m) => m[1])
    .filter((name) => declared.includes(name));
  /** The inputs one caller passes, by job. */
  const inputsOf = (name: string, jobName: string): string[] => {
    const job = jobBlock(readWorkflow(name), jobName);
    return [...job.slice(job.indexOf('\n    with:\n')).matchAll(/^ {6}([a-z_]+):/gm)].map((m) => m[1]);
  };

  it('the inputs are read (a guard for the parsing above)', () => {
    expect(declared.sort()).toEqual([
      'branch', 'from', 'install', 'issue', 'merge_ref', 'package', 'playbook', 'task', 'title', 'to',
    ]);
    expect(required.sort()).toEqual(['branch', 'package', 'playbook']);
  });

  it.each([
    ['electron-major.yml', 'upgrade'],
    ['dependency-majors.yml', 'upgrade'],
    ['dependabot-ci-retry.yml', 'repair'],
  ])('%s gives it what it needs', (name, jobName) => {
    const job = jobBlock(readWorkflow(name), jobName);
    expect(job).toContain('uses: ./.github/workflows/agent-upgrade.yml');
    expect(job).toContain('secrets: inherit');
    // A called workflow gets at most the caller's permissions.
    for (const permission of ['contents: read', 'issues: write', 'pull-requests: write', 'id-token: write']) {
      expect(job).toContain(permission);
    }
    const given = inputsOf(name, jobName);
    for (const input of required) expect(given, input).toContain(input);
    for (const input of given) expect(declared, input).toContain(input);
    // Never two of the same kind at once.
    expect(readWorkflow(name)).toMatch(/concurrency:\n\s+group: [a-z-]+\n\s+cancel-in-progress: false\n/);
  });

  it('an upgrade names its target major (checked after the agent), a repair names the branch to repair', () => {
    for (const name of ['electron-major.yml', 'dependency-majors.yml']) {
      expect(inputsOf(name, 'upgrade')).toEqual(expect.arrayContaining(['from', 'to']));
      expect(inputsOf(name, 'upgrade')).not.toContain('merge_ref');
    }
    const repair = inputsOf('dependabot-ci-retry.yml', 'repair');
    expect(repair).toEqual(expect.arrayContaining(['merge_ref', 'title', 'task', 'issue']));
    expect(repair).not.toContain('to');
    expect(jobBlock(readWorkflow('dependabot-ci-retry.yml'), 'repair')).toContain(
      'playbook: .github/automation/dependabot-fix.md',
    );
  });

  it('an upgrade gets its title from its inputs, a repair brings its own', () => {
    expect(agentUpgrade).toContain(
      `TITLE: "\${{ inputs.title || format('chore(deps): upgrade {0} from {1} to {2}', inputs.package, inputs.from, inputs.to) }}"`,
    );
    expect(stepRun(agentUpgrade, 'id: pr')).toContain('title="$TITLE"');
    expect(agentUpgrade).toContain('MERGE_REF: ${{ inputs.merge_ref }}');
    // The branch to repair is fetched by the checkout, which still has
    // credentials then; the agent's environment never does.
    expect(agentUpgrade).toContain("fetch-depth: ${{ inputs.merge_ref != '' && '0' || '1' }}");
  });

  it('Electron goes first in the week, the other dependencies after it', () => {
    const day = (name: string): number => Number(/cron: '\d+ \d+ \* \* (\d)'/.exec(readWorkflow(name))?.[1]);
    expect(day('electron-major.yml')).toBeGreaterThanOrEqual(1);
    expect(day('dependency-majors.yml')).toBeGreaterThan(day('electron-major.yml'));
  });
});

describe('what judges a change must not be part of it: the list matches this repository', () => {
  const source = /grep -E '([^']+)' \|\| true/.exec(stepRun(agentUpgrade, 'id: pr'))?.[1] ?? '';
  const isJudge = (file: string): boolean => new RegExp(source).test(file);

  function walk(dir: string): string[] {
    return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
      const relative = `${dir}/${entry.name}`;
      return entry.isDirectory() ? walk(relative) : [relative];
    });
  }

  it('the list is read from the workflow', () => {
    expect(source.length).toBeGreaterThan(20);
    expect(isJudge('scripts/check-packaged.mjs')).toBe(true);
  });

  // The maintainer's decision: a major upgrade needs its unit tests adapted
  // nearly every time, so that alone must not wait for a person.
  it('unit tests are NOT on it: the agent adapts them and the upgrade still merges on its own', () => {
    const tests = walk('src').filter((file) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(file) || file.includes('/__tests__/'));
    expect(tests.length).toBeGreaterThan(20);
    expect(tests.filter(isJudge)).toEqual([]);
  });

  it('what watches them instead: the number of tests that PASS, before and after the agent', () => {
    // Passing, not total: a skipped test still counts in the total.
    expect(stepRun(agentUpgrade, 'id: start')).toContain('.numPassedTests');
    expect(stepRun(agentUpgrade, 'id: checks')).toContain('.numPassedTests');
    expect(agentUpgrade).not.toContain('numTotalTests');
    expect(stepRun(agentUpgrade, 'id: pr')).toContain('! [ "$TESTS_AFTER" -ge "$TESTS_BEFORE" ]');
  });

  it('the configuration of every check is on it', () => {
    const configs = fs
      .readdirSync(ROOT)
      .filter((name) => /^(eslint\.config\.|\.eslintrc|vitest\.config\.|vitest\.workspace\.|tsconfig)/.test(name));
    expect(configs).toEqual(expect.arrayContaining(['eslint.config.mjs', 'vitest.config.ts', 'tsconfig.main.json', 'tsconfig.ui.json']));
    expect(configs.filter((file) => !isJudge(file))).toEqual([]);
  });

  it('so is every script CI runs to judge a pull request, except the end-to-end suite', () => {
    const scripts = [...new Set([...ci.matchAll(/node (scripts\/[\w.-]+\.mjs)/g)].map((m) => m[1]))].sort();
    expect(scripts).toEqual(['scripts/check-packaged.mjs', 'scripts/smoke.mjs', 'scripts/version-only-diff.mjs']);
    for (const file of scripts) expect(fs.existsSync(path.join(ROOT, file)), file).toBe(true);
    // The maintainer's decision again: the agent adapts the end-to-end suite
    // and its fixtures, and the upgrade still merges on its own.
    expect(scripts.filter((file) => !isJudge(file))).toEqual(['scripts/smoke.mjs']);
    expect(walk('scripts/fixtures').filter(isJudge)).toEqual([]);
  });

  it('what watches the end-to-end suite instead: none of its scenarios may disappear', () => {
    // The workflow's own pattern, applied to the real suite: it must see
    // every scenario, or a dropped one would go unnoticed.
    const pattern = /grep -oE "([^"]+)" "\$1"/.exec(stepRun(agentUpgrade, 'id: pr'))?.[1] ?? '';
    expect(pattern).toContain('pass');
    const smoke = readRepoFile('scripts/smoke.mjs');
    const listed = smoke.match(new RegExp(pattern.replace(/\[\[:space:\]\]/g, '\\s'), 'gm')) ?? [];
    const names = listed.map((call) => call.trim());
    expect(names.length).toBeGreaterThan(30);
    expect(names).toContain("pass('PANIC')");
    expect(names).toContain("pass('LOCAL FILE IN A TAB')");
    // Every call site of the suite is one the pattern lists: no scenario
    // named through a variable, none sharing a line with other code.
    expect(smoke.match(/\bpass\(/g)).toHaveLength(names.length);
  });

  it('the checks themselves are launched through npm scripts, which the gate compares', () => {
    const scripts = (JSON.parse(readRepoFile('package.json')) as { scripts: Record<string, string> }).scripts;
    for (const name of ['typecheck', 'lint', 'test', 'build']) expect(scripts[name], name).toBeTruthy();
    const checks = stepRun(agentUpgrade, 'id: checks');
    for (const command of ['npm run typecheck', 'npm run lint', 'npm test', 'npm run build', 'node scripts/smoke.mjs']) {
      expect(checks).toContain(`check "${command}"`);
    }
  });

  it('what an upgrade normally touches is not on it', () => {
    for (const file of [
      'package.json',
      'package-lock.json',
      'src/main/main.ts',
      'src/ui/App.tsx',
      'src/shared/__tests__/urlUtils.test.ts',
      'scripts/smoke.mjs',
      'scripts/fixtures/contract-extension/manifest.json',
      'scripts/build-main.mjs',
      'vite.config.ts',
    ]) {
      expect(isJudge(file), file).toBe(false);
    }
  });
});

describe.runIf(canRunSteps())('dependabot-automerge.yml: which Dependabot updates merge on their own', () => {
  const automerge = readWorkflow('dependabot-automerge.yml');
  const script = stepRun(automerge, 'id: decide');
  const NPM = 'dependabot/npm_and_yarn/electron-45.3.0';
  const ACTIONS = 'dependabot/github_actions/actions-640176b5ab';
  const PR_URL = 'https://github.com/owner/repo/pull/9';
  const PATCH = 'version-update:semver-patch';
  const MINOR = 'version-update:semver-minor';
  const MAJOR = 'version-update:semver-major';

  /** Runs the decision; true when auto-merge was enabled on the pull request. */
  async function merges(branch: string, updateType: string, dependencies: string): Promise<boolean> {
    const cwd = fs.mkdtempSync(path.join(sandbox, 'automerge-'));
    const result = await runStep({
      script,
      cwd,
      fakes: { gh: 'echo "gh $*" >> "$CALLS"\n' },
      env: { HEAD_REF: branch, UPDATE_TYPE: updateType, DEPENDENCIES: dependencies, PR_URL },
    });
    expect(result.status, result.said).toBe(0);
    const merged = result.calls.includes(`gh pr merge --auto --squash ${PR_URL}`);
    // Either that one call, or nothing at all.
    expect(result.calls).toHaveLength(merged ? 1 : 0);
    expect(result.summary).toContain(merged ? 'Merges on its own' : 'Waits for a person');
    return merged;
  }

  it.each<[string, string, string, string]>([
    ['an npm patch (an Electron patch release: Chromium fixes)', NPM, PATCH, 'electron'],
    ['a group of npm minors', NPM, MINOR, 'react, nanoid, zustand'],
    ['a GitHub Action minor', ACTIONS, MINOR, 'actions/setup-node'],
    // An action is referenced by its major: nearly every update of one is a
    // "major", and waiting for a person each time meant waiting every time.
    ['a GitHub Action major (actions/checkout 4 to 7)', ACTIONS, MAJOR, 'actions/checkout'],
    ['a group of actions with a major among them', ACTIONS, MAJOR, 'actions/checkout, actions/setup-node, dependabot/fetch-metadata'],
    ['a minor of the action that runs the upgrade agent', ACTIONS, MINOR, 'anthropics/claude-code-action'],
    ['a major of an action that only resembles it', ACTIONS, MAJOR, 'someone/anthropics/claude-code-action-next, anthropics/claude-code-action-base'],
  ])('merges on its own: %s', async (_name, branch, updateType, dependencies) => {
    expect(await merges(branch, updateType, dependencies)).toBe(true);
  });

  it.each<[string, string, string, string]>([
    // What the agent may do is passed to that action as inputs: a new major
    // can rename or reinterpret them without any check noticing.
    ['a major of the action that runs the upgrade agent', ACTIONS, MAJOR, 'anthropics/claude-code-action'],
    ['the same, even grouped with other actions', ACTIONS, MAJOR, 'actions/checkout, anthropics/claude-code-action'],
    ['a major of an npm package (the upgrade agent does those)', NPM, MAJOR, 'react'],
    ['an update type it does not know', ACTIONS, 'version-update:semver-epoch', 'actions/checkout'],
    ['no update type at all (the metadata step said nothing)', NPM, '', 'electron'],
    ['a major on a branch that only resembles Dependabot\'s', 'feature/dependabot/github_actions/x', MAJOR, 'actions/checkout'],
  ])('waits for a person: %s', async (_name, branch, updateType, dependencies) => {
    expect(await merges(branch, updateType, dependencies)).toBe(false);
  });

  it('only acts on Dependabot\'s own pull requests, with what Dependabot says about them', () => {
    expect(automerge).toContain("if: github.actor == 'dependabot[bot]'");
    const step = stepBlock(automerge, 'id: decide');
    expect(step).toContain('HEAD_REF: ${{ github.head_ref }}');
    expect(step).toContain('UPDATE_TYPE: ${{ steps.metadata.outputs.update-type }}');
    expect(step).toContain('DEPENDENCIES: ${{ steps.metadata.outputs.dependency-names }}');
    expect(step).not.toMatch(/^\s+if:/m);
  });

  it('the action it holds back is the one the upgrade agent runs on, and has its own pull request', () => {
    const agentAction = /uses: (anthropics\/[\w-]+)@/.exec(agentUpgrade)?.[1] ?? '';
    expect(agentAction).not.toBe('');
    expect(script).toContain(`*,${agentAction},*)`);
    // Alone in its pull request, so its majors never hold the other actions.
    const actions = readRepoFile('.github/dependabot.yml').split('- package-ecosystem: github-actions')[1] ?? '';
    expect(actions).toMatch(new RegExp(`exclude-patterns:\\n\\s+- ${agentAction}\\n`));
  });
});

describe.runIf(canRunSteps())('automerge-keep-current.yml: a pull request set to merge does not wait behind main', () => {
  const keeper = readWorkflow('automerge-keep-current.yml');
  const script = stepRun(keeper, 'id: update');

  /** One line of the listing: number, state against main, auto-merge, fork, draft, bot. */
  const row = (number: number, state: string, auto = 'true', fork = 'false', draft = 'false', bot = 'false'): string =>
    [number, state, auto, fork, draft, bot].join('\\t');
  const listing = (...rows: string[]): string => rows.map((r) => `${r}\\n`).join('');

  /** `gh pr list` answers $FAKE_PRS, after $FAKE_UNKNOWN_ROUNDS answers of $FAKE_PRS_FIRST. */
  const FAKE_GH_LIST = `
echo "gh $1 $2 $3" >> "$CALLS"
case "$1 $2" in
  "pr list")
    asked="$(cat "$RUNNER_TEMP/asked" 2> /dev/null || echo 0)"
    echo $((asked + 1)) > "$RUNNER_TEMP/asked"
    if [ "$asked" -lt "\${FAKE_UNKNOWN_ROUNDS:-0}" ]; then printf '%b' "$FAKE_PRS_FIRST"; else printf '%b' "$FAKE_PRS"; fi ;;
  "pr update-branch")
    case " \${FAKE_CONFLICT:-} " in *" $3 "*) exit 1 ;; esac ;;
esac
exit 0
`;

  function keep(env: Record<string, string>): Promise<StepResult> {
    const cwd = fs.mkdtempSync(path.join(sandbox, 'keep-'));
    return runStep({ script, cwd, fakes: { gh: FAKE_GH_LIST, sleep: 'exit 0\n' }, env: { GH_TOKEN: 'x', ...env } });
  }
  const updates = (result: StepResult): string[] => result.calls.filter((call) => call.startsWith('gh pr update-branch'));

  it('brings up to date the one that fell behind while its CI ran', async () => {
    const result = await keep({ FAKE_PRS: listing(row(41, 'BEHIND')) });
    expect(result.status, result.said).toBe(0);
    expect(updates(result)).toEqual(['gh pr update-branch 41']);
    expect(result.outputs.updated).toBe('1');
  });

  it.each<[string, string]>([
    ['is up to date and waiting for its checks', row(41, 'BLOCKED')],
    ['is ready to merge', row(41, 'CLEAN')],
    ['conflicts with main (a person has to resolve it)', row(41, 'DIRTY')],
    // Auto-merge is the decision to merge: without it, nothing is touched.
    ['is behind but was not set to merge on its own', row(41, 'BEHIND', 'false')],
    ['is Dependabot\'s (it rebases itself, and stops once someone else pushes)', row(41, 'BEHIND', 'true', 'false', 'false', 'true')],
    ['comes from a fork', row(41, 'BEHIND', 'true', 'true')],
    ['is a draft', row(41, 'BEHIND', 'true', 'false', 'true')],
  ])('leaves alone a pull request that %s', async (_name, pr) => {
    const result = await keep({ FAKE_PRS: listing(pr) });
    expect(result.status, result.said).toBe(0);
    expect(updates(result)).toEqual([]);
    expect(result.outputs.updated).toBe('0');
  });

  it('updates every one that qualifies, and one that cannot be updated does not stop the others', async () => {
    const result = await keep({
      FAKE_PRS: listing(row(40, 'BEHIND'), row(41, 'BEHIND'), row(42, 'CLEAN'), row(43, 'BEHIND')),
      FAKE_CONFLICT: '41',
    });
    expect(result.status, result.said).toBe(0);
    expect(updates(result)).toEqual(['gh pr update-branch 40', 'gh pr update-branch 41', 'gh pr update-branch 43']);
    expect(result.outputs.updated).toBe('2');
    expect(result.said).toContain('#41 is behind main and could not be updated');
  });

  it('asks again while GitHub has not worked out yet whether it is behind', async () => {
    const result = await keep({
      FAKE_PRS_FIRST: listing(row(41, 'UNKNOWN')),
      FAKE_UNKNOWN_ROUNDS: '2',
      FAKE_PRS: listing(row(41, 'BEHIND')),
    });
    expect(result.status, result.said).toBe(0);
    expect(result.calls.filter((call) => call.startsWith('gh pr list'))).toHaveLength(3);
    expect(updates(result)).toEqual(['gh pr update-branch 41']);
  });

  it('gives up quietly when GitHub never says (the next push to main asks again)', async () => {
    const result = await keep({ FAKE_PRS: listing(row(41, 'UNKNOWN')) });
    expect(result.status, result.said).toBe(0);
    expect(result.calls.filter((call) => call.startsWith('gh pr list'))).toHaveLength(6);
    expect(updates(result)).toEqual([]);
  });

  it('nothing open: nothing to do', async () => {
    const result = await keep({ FAKE_PRS: '' });
    expect(result.status, result.said).toBe(0);
    expect(result.outputs.updated).toBe('0');
  });

  it('fails loudly without the token that makes CI run on the update', async () => {
    const result = await keep({ GH_TOKEN: '', FAKE_PRS: listing(row(41, 'BEHIND')) });
    expect(result.status).not.toBe(0);
    expect(result.calls).toEqual([]);
  });

  it('runs when main moves, as the maintainer (an update pushed with the default token starts no CI)', () => {
    expect(keeper).toMatch(/\non:\n {2}push:\n {4}branches: \[main\]\n/);
    expect(keeper).toContain('GH_TOKEN: ${{ secrets.AUTOMATION_TOKEN }}');
    expect(keeper).toMatch(/\npermissions:\n {2}contents: read\n/);
  });
});

describe.runIf(canRunSteps())('dependabot-ci-retry.yml: a Dependabot update that stays red gets repaired', () => {
  const retry = readWorkflow('dependabot-ci-retry.yml');
  const script = stepRun(retry, 'id: report');
  const NPM = 'dependabot/npm_and_yarn/electron-45.3.0';

  const FAKE_GH_REPORT = `
echo "gh $*" >> "$CALLS"
case "$1 $2" in
  "pr view") echo "chore(deps-dev): bump electron from 45.2.3 to 45.3.0" ;;
  "pr list") echo "\${FAKE_REPAIR_PRS:-0}" ;;
  "api repos/owner/repo/git/ref/heads/"*) [ "\${FAKE_REPAIR_BRANCH:-}" = "1" ] || exit 1 ;;
  "issue list") printf '%s\\n' "\${FAKE_OPEN_ISSUE:-}" ;;
  "issue create") echo "https://github.com/owner/repo/issues/31" ;;
esac
exit 0
`;

  async function report(env: Record<string, string> = {}): Promise<StepResult & { issueBody: string; comment: string }> {
    const cwd = fs.mkdtempSync(path.join(sandbox, 'report-'));
    const result = await runStep({
      script,
      cwd,
      fakes: { gh: FAKE_GH_REPORT },
      env: {
        GH_TOKEN: 'x',
        RUN_ID: '9001',
        RUN_URL: 'https://github.com/owner/repo/actions/runs/9001',
        ATTEMPT: '2',
        PR: '129',
        HEAD_BRANCH: NPM,
        REPAIR: '',
        ...env,
      },
    });
    const read = (name: string): string => {
      const file = path.join(result.temp, name);
      return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    };
    return { ...result, issueBody: read('issue.md'), comment: read('comment.md') };
  }

  it('an npm update: the maintainer is told, and Claude is asked to repair it', async () => {
    const result = await report();
    expect(result.status, result.said).toBe(0);
    expect(result.outputs).toEqual({
      repair: 'yes',
      pr: '129',
      head: NPM,
      branch: 'automation/fix-dependabot-129',
      issue: '31',
      title: 'chore(deps-dev): bump electron from 45.2.3 to 45.3.0',
    });
    expect(result.calls.filter((call) => call.startsWith('gh issue create'))).toHaveLength(1);
    expect(result.issueBody).toContain('@owner CI failed twice in a row on #129');
    expect(result.issueBody).toContain('https://github.com/owner/repo/actions/runs/9001');
    expect(result.issueBody).toContain('Claude repairs it on the branch `automation/fix-dependabot-129`');
  });

  it.each<[string, Record<string, string>, string]>([
    [
      'an update of a GitHub Action (the agent cannot push workflow files)',
      { HEAD_BRANCH: 'dependabot/github_actions/actions-640176b5ab' },
      'it is not an npm update',
    ],
    ['repairs switched off by the repository variable', { REPAIR: 'off' }, 'repairs are switched off'],
    ['a repair that was already attempted (its pull request exists)', { FAKE_REPAIR_PRS: '1' }, 'already attempted'],
    ['a repair that was already attempted (its branch exists)', { FAKE_REPAIR_BRANCH: '1' }, 'already attempted'],
    ['a branch that only resembles Dependabot\'s', { HEAD_BRANCH: 'feature/dependabot/npm_and_yarn/x' }, 'it is not an npm update'],
  ])('no repair, but still an issue that says why: %s', async (_name, env, why) => {
    const result = await report(env);
    expect(result.status, result.said).toBe(0);
    expect(result.outputs.repair).toBe('no');
    expect(result.outputs.issue).toBe('31');
    expect(result.issueBody).toContain('Nobody repairs this one automatically');
    expect(result.issueBody).toContain(why);
    expect(result.issueBody).not.toContain('Claude repairs it');
  });

  it('one issue per pull request: a later red run comments on it instead of opening another', async () => {
    const result = await report({ FAKE_OPEN_ISSUE: '27', ATTEMPT: '3' });
    expect(result.status, result.said).toBe(0);
    expect(result.calls.filter((call) => call.startsWith('gh issue create'))).toEqual([]);
    expect(result.calls.some((call) => call.startsWith('gh issue comment 27 '))).toBe(true);
    expect(result.comment).toContain('Still failing after another run (attempt 3)');
    expect(result.outputs.issue).toBe('27');
    // The repair itself is still due if it never started.
    expect(result.outputs.repair).toBe('yes');
  });

  it('a run with no pull request attached: nothing to report, nothing to repair', async () => {
    const result = await report({ PR: '' });
    expect(result.status, result.said).toBe(0);
    expect(result.written).toBe('');
    expect(result.calls).toEqual([]);
  });

  it('only for Dependabot\'s own pull requests, after the retry, and the repair only when decided', () => {
    const job = jobBlock(retry, 'retry');
    expect(job).toContain("github.event.workflow_run.conclusion == 'failure' &&");
    expect(job).toContain("github.event.workflow_run.actor.login == 'dependabot[bot]'");
    expect(stepBlock(retry, 'name: First failure, re-run the failed jobs')).toContain(
      'if: github.event.workflow_run.run_attempt == 1',
    );
    expect(stepBlock(retry, 'id: report')).toContain('if: github.event.workflow_run.run_attempt > 1');
    expect(job).toContain('REPAIR: ${{ vars.DEPENDABOT_REPAIR }}');
    expect(job).toContain('HEAD_BRANCH: ${{ github.event.workflow_run.head_branch }}');
    const repair = jobBlock(retry, 'repair');
    expect(repair).toContain('needs: retry');
    expect(repair).toContain("if: needs.retry.outputs.repair == 'yes'");
    expect(repair).toContain('merge_ref: ${{ needs.retry.outputs.head }}');
    expect(repair).toContain('branch: ${{ needs.retry.outputs.branch }}');
    expect(repair).toContain('issue: ${{ needs.retry.outputs.issue }}');
  });
});

describe('claude-code-review.yml: the automatic review', () => {
  const review = readWorkflow('claude-code-review.yml');

  it('skips what it cannot or need not review: Dependabot, release bumps, pull requests from forks', () => {
    const job = jobBlock(review, 'claude-review');
    expect(job).toContain("github.actor != 'dependabot[bot]'");
    expect(job).toContain("!startsWith(github.head_ref, 'release/')");
    // A fork gets no secrets: the review could only fail there.
    expect(job).toContain('github.event.pull_request.head.repo.full_name == github.repository');
  });

  it('can comment, and nothing else: it never merges', () => {
    expect(review).not.toMatch(/gh pr merge|contents: write/);
  });
});

describe('auto-release.yml and release.yml, as written', () => {
  it('automatic releases can be paused without editing the workflow', () => {
    expect(jobBlock(autoRelease, 'release')).toContain("if: vars.AUTO_RELEASE != 'off'");
  });

  it('the spacing applies to the schedule (4 days unless configured), not to a manual run', () => {
    expect(stepBlock(autoRelease, 'id: due')).toContain(
      "RELEASE_MIN_DAYS: ${{ github.event_name == 'schedule' && (vars.AUTO_RELEASE_MIN_DAYS || '4') || '0' }}",
    );
  });

  it('nothing happens after the question unless the answer is yes', () => {
    const steps = stepsOf(autoRelease);
    const after = steps.slice(steps.findIndex((step) => step.includes('id: due')) + 1);
    expect(after.length).toBeGreaterThanOrEqual(4);
    for (const step of after) expect(step).toContain("if: steps.due.outputs.due == 'true'");
  });

  it('merges through auto-merge and never past the branch protection', () => {
    for (const workflow of [autoRelease, agentUpgrade, readWorkflow('dependabot-automerge.yml')]) {
      expect(workflow).not.toMatch(/--admin|gh api [^\n]*\/merge/);
    }
  });

  it('only the last job of release.yml publishes, after the draft was verified, and only for [auto]', () => {
    const publish = jobBlock(release, 'publish');
    expect(publish).toContain('needs: [guard, verify]');
    expect(publish).toContain("if: needs.guard.outputs.auto == 'true'");
    expect(publish).toContain('--draft=false');
    expect(release.split('--draft=false')).toHaveLength(2);
    expect(jobBlock(release, 'guard')).toContain('auto: ${{ steps.kind.outputs.auto }}');
    expect(jobBlock(release, 'verify')).toContain('needs: artifacts');
  });
});

// --------------------------------------------- the release chain, for real

const FAKE_GH = `
echo "gh $*" >> "$CALLS"
case "$1 $2" in
  "pr list") printf '%s\\n' "\${FAKE_OPEN_PR:-}" ;;
  "pr create") echo "https://github.com/owner/repo/pull/77" ;;
esac
exit 0
`;

/** `gh pr view`: the pull request goes through $FAKE_STATES, one per poll. */
const FAKE_GH_POLL = `
echo "gh $*" >> "$CALLS"
case "$*" in
  *"--json state"*)
    polls="$(cat "$RUNNER_TEMP/polls" 2> /dev/null || echo 0)"
    echo $((polls + 1)) > "$RUNNER_TEMP/polls"
    set -- $FAKE_STATES
    shift "$(( polls < $# ? polls : $# - 1 ))"
    echo "$1" ;;
  *"--json mergeCommit"*) echo 0123abc ;;
  *"--json mergeStateStatus"*) echo "\${FAKE_MERGE_STATE:-CLEAN}" ;;
esac
exit 0
`;

/** A repository whose 1.4.2 was released `daysAgo` days back, with the real release-due.mjs. */
function releasedRepo(daysAgo = 30): GitFixture {
  const repo = new GitFixture(sandbox);
  repo.writeJson('package.json', { name: 'fixture', version: '1.4.2' });
  repo.writeJson('package-lock.json', {
    name: 'fixture',
    version: '1.4.2',
    lockfileVersion: 3,
    requires: true,
    packages: { '': { name: 'fixture', version: '1.4.2' }, 'node_modules/electron': { version: '45.0.0' } },
  });
  repo.writeJson('src/shared/credits.generated.json', [{ name: 'electron', version: '45.0.0' }]);
  repo.writeText('scripts/release-due.mjs', readRepoFile('scripts/release-due.mjs'));
  repo.commit('chore(release): 1.4.2', daysAgo);
  repo.git(['tag', 'v1.4.2']);
  return repo;
}

function bumpElectron(repo: GitFixture): void {
  const lock = repo.readJson<{ packages: Record<string, { version: string }> }>('package-lock.json');
  lock.packages['node_modules/electron'].version = '45.0.1';
  repo.writeJson('package-lock.json', lock);
  repo.commit('build(deps-dev): bump electron from 45.0.0 to 45.0.1');
}

describe.runIf(canRunSteps())('auto-release.yml: is a release due?', () => {
  const script = stepRun(autoRelease, 'id: due');
  const ask = (repo: GitFixture, env: Record<string, string>): Promise<StepResult> =>
    runStep({ script, cwd: repo.dir, env: { RELEASE_MIN_DAYS: '0', FORCE: '', ...env } });

  it('yes when something that ships changed, with the next version', async () => {
    const repo = releasedRepo();
    bumpElectron(repo);
    const result = await ask(repo, {});
    expect(result.status, result.said).toBe(0);
    expect(result.outputs.due).toBe('true');
    expect(result.outputs.next).toBe('1.4.3');
  });

  it('no when nothing changed, unless the manual run ticks "force"', async () => {
    const repo = releasedRepo();
    expect((await ask(repo, {})).outputs.due).toBe('false');
    expect((await ask(repo, { FORCE: 'false' })).outputs.due).toBe('false');
    expect((await ask(repo, { FORCE: 'true' })).outputs.due).toBe('true');
  });

  it('no while the last release is too recent', async () => {
    const repo = releasedRepo(1);
    bumpElectron(repo);
    expect((await ask(repo, { RELEASE_MIN_DAYS: '4' })).outputs.due).toBe('false');
    expect((await ask(repo, { RELEASE_MIN_DAYS: '0' })).outputs.due).toBe('true');
  });

  it('a spacing that is not a number fails the run instead of answering', async () => {
    const repo = releasedRepo();
    bumpElectron(repo);
    const result = await ask(repo, { RELEASE_MIN_DAYS: 'four' });
    expect(result.status).not.toBe(0);
    expect(result.written).toBe('');
  });
});

describe.runIf(canRunSteps())('the release pull request, from auto-release.yml to release.yml', () => {
  const openScript = stepRun(autoRelease, 'id: pr');
  const kindScript = stepRun(release, 'id: kind');
  const tagMatchScript = stepRun(release, 'name: Tag must match package.json version');
  const onMainScript = stepRun(release, 'name: Tagged commit must be on main');

  /** Runs "Open (or refresh) the release pull request" with the real npm. */
  async function open(env: Record<string, string> = {}): Promise<StepResult & { repo: GitFixture }> {
    const repo = releasedRepo();
    bumpElectron(repo);
    // "Commit as the token's owner", the step before.
    repo.git(['config', 'user.name', 'tester']);
    repo.git(['config', 'user.email', '4242+tester@users.noreply.github.com']);
    const result = await runStep({
      script: openScript,
      cwd: repo.dir,
      fakes: { gh: FAKE_GH, git: FAKE_GIT },
      env: { NEXT: '1.4.3', NOTES: '- `electron` 45.0.0 → 45.0.1', ...env },
    });
    return { ...result, repo };
  }
  const kind = (repo: GitFixture, sha: string): Promise<StepResult> =>
    runStep({ script: kindScript, cwd: repo.dir, env: { GITHUB_SHA: sha } });

  it('opens it, sets it to merge on its own, and says what ships', async () => {
    const result = await open();
    expect(result.status, result.said).toBe(0);
    expect(result.outputs.number).toBe('77');
    expect(result.calls).toContain('git push --force origin release/v1.4.3');
    expect(result.calls).toContain('gh pr merge 77 --auto --squash');
    const create = result.calls.find((call) => call.startsWith('gh pr create')) ?? '';
    expect(create).toContain('--base main --head release/v1.4.3 --title chore(release): 1.4.3 [auto]');
    expect(fs.readFileSync(path.join(result.temp, 'release-pr.md'), 'utf8')).toContain('- `electron` 45.0.0 → 45.0.1');
  });

  it('reuses the pull request of a run that died half-way', async () => {
    const result = await open({ FAKE_OPEN_PR: '55' });
    expect(result.status, result.said).toBe(0);
    expect(result.calls.filter((call) => call.startsWith('gh pr create'))).toEqual([]);
    expect(result.calls).toContain('gh pr merge 55 --auto --squash');
    expect(result.outputs.number).toBe('55');
  });

  it('its commit is the pure version bump CI fast-tracks: nothing but the version moved', async () => {
    const { repo } = await open();
    expect(repo.readJson<{ version: string }>('package.json').version).toBe('1.4.3');
    expect(repo.git(['show', '--name-only', '--format=', 'HEAD']).trim().split('\n').sort()).toEqual([
      'package-lock.json',
      'package.json',
    ]);
    expect(runNodeScript('version-only-diff.mjs', ['HEAD^1', 'HEAD'], { cwd: repo.dir }).written).toBe('version_only=true\n');
  });

  it('its commit is the one release.yml publishes on its own, and its tag passes the guard', async () => {
    const { repo } = await open();
    const sha = repo.git(['rev-parse', 'HEAD']).trim();
    expect(repo.git(['log', '-1', '--format=%s']).trim()).toBe('chore(release): 1.4.3 [auto]');
    expect((await kind(repo, sha)).outputs.auto).toBe('true');
    const tagged = (tag: string): Promise<StepResult> =>
      runStep({ script: tagMatchScript, cwd: repo.dir, env: { GITHUB_REF_NAME: tag } });
    expect((await tagged('v1.4.3')).status).toBe(0);
    expect((await tagged('v1.4.4')).status).not.toBe(0);
    expect((await tagged('1.4.3')).status).not.toBe(0);
  });

  it('release.yml publishes on its own for that commit title and for nothing else', async () => {
    const repo = new GitFixture(sandbox);
    const expected: Record<string, string> = {
      // What auto-release.yml produces, as committed and as squash-merged.
      'chore(release): 0.7.2 [auto]': 'true',
      'chore(release): 0.7.2 [auto] (#131)': 'true',
      'chore(release): 12.0.10 [auto] (#9)': 'true',
      // A release cut by hand stops at the draft.
      'chore(release): 0.7.2': 'false',
      'chore(release): 0.7.2 (#130)': 'false',
      // Mentioning the marker is not enough.
      'chore(release): 0.7.2 [auto] and a fix': 'false',
      'chore(release): 0.7.2 [auto] (#131) (#132)': 'false',
      'fix: handle the [auto] marker': 'false',
      'Revert "chore(release): 0.7.2 [auto]"': 'false',
      'chore(release): 0.7.2-beta.1 [auto]': 'false',
      'chore(release): v0.7.2 [auto]': 'false',
      'chore(release): 0.7 [auto]': 'false',
      ' chore(release): 0.7.2 [auto]': 'false',
    };
    const subjects = Object.keys(expected);
    const shas = subjects.map((subject) => repo.commit(subject));
    // The marker in the BODY of a commit does not count either.
    repo.git(['commit', '-q', '--allow-empty', '-m', 'feat: something', '-m', 'chore(release): 0.7.2 [auto]']);
    const bodyOnly = repo.git(['rev-parse', 'HEAD']).trim();

    const results = await Promise.all(shas.map((sha) => kind(repo, sha)));
    const got = Object.fromEntries(subjects.map((subject, i) => [subject, results[i].outputs.auto]));
    expect(got).toEqual(expected);
    expect((await kind(repo, bodyOnly)).outputs.auto).toBe('false');
  });

  it('release.yml refuses a tag whose commit is not on main', async () => {
    const repo = new GitFixture(sandbox);
    const first = repo.commit('one');
    const second = repo.commit('two');
    repo.git(['update-ref', 'refs/remotes/origin/main', second]);
    repo.git(['switch', '-q', '-c', 'side']);
    const side = repo.commit('not merged');
    const onMain = (sha: string): Promise<StepResult> =>
      runStep({ script: onMainScript, cwd: repo.dir, env: { GITHUB_SHA: sha, GITHUB_REF_NAME: 'v9.9.9' } });
    expect((await onMain(second)).status).toBe(0);
    expect((await onMain(first)).status).toBe(0);
    expect((await onMain(side)).status).not.toBe(0);
  });
});

describe.runIf(canRunSteps())('auto-release.yml: nothing is tagged unless the pull request merged', () => {
  const waitScript = stepRun(autoRelease, 'id: merged');
  const tagScript = stepRun(autoRelease, 'name: Tag the merge commit (this starts release.yml)');

  function wait(env: Record<string, string>, fakes: Record<string, string> = {}): Promise<StepResult> {
    const cwd = fs.mkdtempSync(path.join(sandbox, 'wait-'));
    return runStep({
      script: waitScript,
      cwd,
      env: { PR: '77', ...env },
      fakes: { gh: FAKE_GH_POLL, sleep: 'exit 0\n', ...fakes },
    });
  }

  it('merged: hands the merge commit to the tag step', async () => {
    const result = await wait({ FAKE_STATES: 'OPEN OPEN MERGED' });
    expect(result.status, result.said).toBe(0);
    expect(result.outputs.sha).toBe('0123abc');
    expect(result.calls.filter((call) => call.includes('--json state'))).toHaveLength(3);
  });

  it('closed without merging: the run fails and there is no commit to tag', async () => {
    const result = await wait({ FAKE_STATES: 'OPEN CLOSED' });
    expect(result.status).not.toBe(0);
    expect(result.written).toBe('');
  });

  it('still open when the wait runs out: the run fails and there is no commit to tag', async () => {
    const result = await wait({ FAKE_STATES: 'OPEN' }, { seq: 'echo "1 2 3"\n' });
    expect(result.status).not.toBe(0);
    expect(result.written).toBe('');
    expect(result.calls.filter((call) => call.includes('--json state'))).toHaveLength(3);
  });

  it('main moved meanwhile: the branch is brought up to date instead of waiting forever', async () => {
    const result = await wait({ FAKE_STATES: 'OPEN MERGED', FAKE_MERGE_STATE: 'BEHIND' });
    expect(result.status, result.said).toBe(0);
    expect(result.calls).toContain('gh pr update-branch 77');
  });

  it('the tag step only runs after a successful wait, on the commit it was given', async () => {
    const block = stepBlock(autoRelease, 'name: Tag the merge commit (this starts release.yml)');
    expect(block).toContain('SHA: ${{ steps.merged.outputs.sha }}');
    // No status function in its condition: GitHub then requires every
    // earlier step to have succeeded.
    expect(block).not.toMatch(/always\(\)|failure\(\)|cancelled\(\)|continue-on-error/);
    expect(stepBlock(autoRelease, 'id: merged')).not.toContain('continue-on-error');

    const repo = new GitFixture(sandbox);
    const merged = repo.commit('chore(release): 1.4.3 [auto] (#77)');
    repo.commit('something merged right after');
    const result = await runStep({ script: tagScript, cwd: repo.dir, fakes: { git: FAKE_GIT }, env: { NEXT: '1.4.3', SHA: merged } });
    expect(result.status, result.said).toBe(0);
    expect(repo.git(['rev-parse', 'v1.4.3^{commit}']).trim()).toBe(merged);
    expect(result.calls).toEqual(['git push origin v1.4.3']);
  });
});
