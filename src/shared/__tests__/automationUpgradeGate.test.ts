/**
 * The gate of the unattended upgrades (agent-upgrade.yml): once the agent is
 * done, bash decides whether its work merges on its own and ships to every
 * user, or waits for a person. That bash is run here for real, on throwaway
 * repositories, with `gh`, `npm` and `git push` replaced by recorders (see
 * automationHelpers). One property matters above all: nothing merges on its
 * own unless EVERYTHING is in order, and whatever is unknown counts as not
 * in order.
 *
 * Not covered here: GitHub itself (that auto-merge waits for the required
 * checks, that a draft cannot merge) and the agent's session.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  FAKE_GIT,
  GitFixture,
  canRunSteps,
  readWorkflow,
  runStep,
  stepBlock,
  stepRun,
  type StepResult,
} from './automationHelpers';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 300_000 });

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'voksa-upgrade-gate-'));
afterAll(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const workflow = readWorkflow('agent-upgrade.yml');
const TOKEN = 'not-a-real-token';

/** Runs `jobs` at most `limit` at a time: each one spawns dozens of processes. */
async function pooled<T>(jobs: Array<() => Promise<T>>, limit = 6): Promise<T[]> {
  const results: T[] = new Array<T>(jobs.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < jobs.length) {
      const index = next;
      next += 1;
      results[index] = await jobs[index]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
  return results;
}

// ------------------------------------------------------------ the decision

const FAKE_GH = `
echo "gh $*" >> "$CALLS"
case "$1 $2" in
  "api user") case "$*" in *.login*) echo tester ;; *) echo 4242 ;; esac ;;
  "pr list") printf '%s\\n' "\${FAKE_OPEN_PR:-}" ;;
  "pr view") printf '%s\\n' "\${FAKE_AUTO_MERGE-false}" ;;
  "pr create") echo "https://github.com/owner/repo/pull/77" ;;
esac
case " \${FAKE_FAIL:-} " in *" $1-$2 "*) echo "gh $1 $2: refused" >&2; exit 1 ;; esac
exit 0
`;

const PACKAGE_JSON = {
  name: 'fixture',
  version: '1.0.0',
  scripts: { test: 'vitest run', lint: 'eslint .' },
  devDependencies: { somepkg: '^1.0.0' },
};
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** An end-to-end suite the way scripts/smoke.mjs is written: one pass('NAME') per scenario. */
const SMOKE = [
  '// end-to-end suite',
  "const pass = (name) => console.log(`[smoke] ${name}: OK`);",
  'async function main() {',
  '  await boot();',
  "  pass('BOOT');",
  '  await streamMode();',
  "  pass('STREAM MODE: masked before paint');",
  '  await panic();',
  "  pass('PANIC');",
  '}',
  '',
].join('\n');

/** The repository before the agent: one of every kind of file the gate tells apart. */
const BASE: Record<string, string> = {
  'package.json': json(PACKAGE_JSON),
  'package-lock.json': json({ packages: { 'node_modules/somepkg': { version: '1.4.0' } } }),
  'src/app.ts': 'export const a = 1;\n',
  'src/__tests__/app.test.ts': 'it works\n',
  'src/ui/Button.test.tsx': 'it renders\n',
  'eslint.config.mjs': 'export default [];\n',
  'vitest.config.ts': 'export default {};\n',
  'tsconfig.main.json': '{}\n',
  'scripts/smoke.mjs': SMOKE,
  'scripts/check-packaged.mjs': '// packaged app check\n',
  'scripts/version-only-diff.mjs': '// CI scope probe\n',
  'scripts/fixtures/page.html': '<p>fixture</p>\n',
  'scripts/build-main.mjs': '// build\n',
  '.github/workflows/ci.yml': 'name: CI\n',
};

/** What a clean upgrade changes: the manifest, the lockfile, some source. */
const UPGRADE: Record<string, string> = {
  'package.json': json({ ...PACKAGE_JSON, devDependencies: { somepkg: '^2.0.0' } }),
  'package-lock.json': json({ packages: { 'node_modules/somepkg': { version: '2.1.0' } } }),
  'src/app.ts': 'export const a = 2;\n',
};

const READY = 'Verdict: ready\n\n## Summary\n\nAll good.\n';

type Scenario = {
  /** UPGRADE_REPORT.md; undefined, the agent left none. */
  report?: string;
  /** Files the agent wrote on top of BASE (null, it deleted the file). */
  files?: Record<string, string | null>;
  env?: Record<string, string>;
  /** Files that differ from BASE in the repository the branch starts from. */
  base?: Record<string, string>;
};

type Outcome = StepResult & {
  /** `gh pr merge <n> --auto`: it will merge with nobody looking. */
  merges: boolean;
  draft: boolean;
  pushes: string[];
  /** Why it is held, as the maintainer is told (empty when it is not). */
  hold: string;
  /** The pull request description. */
  body: string;
  commit: { author: string; subject: string; files: string[] } | null;
  repo: GitFixture;
};

const prScript = stepRun(workflow, 'id: pr');

async function decide(scenario: Scenario): Promise<Outcome> {
  const repo = new GitFixture(sandbox);
  for (const [file, content] of Object.entries({ ...BASE, ...scenario.base })) repo.writeText(file, content);
  repo.commit('base');
  repo.git(['switch', '-q', '-c', 'automation/test']);
  for (const [file, content] of Object.entries(scenario.files ?? UPGRADE)) {
    if (content === null) repo.remove(file);
    else repo.writeText(file, content);
  }
  if (scenario.report !== undefined) repo.writeText('UPGRADE_REPORT.md', scenario.report);

  const result = await runStep({
    script: prScript,
    cwd: repo.dir,
    fakes: { gh: FAKE_GH, git: FAKE_GIT },
    tempFiles: { 'checks.md': '| Check (Linux runner) | Result |\n|---|---|\n| `npm test` | passed |\n' },
    env: {
      PACKAGE: 'somepkg',
      FROM: '1',
      TO: '2',
      BRANCH: 'automation/test',
      // What the job computes from its inputs (checked in automationWorkflows).
      TITLE: 'chore(deps): upgrade somepkg from 1 to 2',
      ISSUE: '',
      AUTOMATION_TOKEN: TOKEN,
      GH_TOKEN: TOKEN,
      AGENT_OUTCOME: 'success',
      CHECKS_FAILED: '0',
      TESTS_BEFORE: '531',
      TESTS_AFTER: '531',
      ...scenario.env,
    },
  });
  const tempFile = (name: string): string => {
    const file = path.join(result.temp, name);
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  };
  const committed = repo.git(['log', '-1', '--format=%an <%ae>%n%s']).trim().split('\n');
  return {
    ...result,
    merges: result.calls.some((call) => /^gh pr merge \d+ --auto\b/.test(call)),
    draft: result.calls.some((call) => call.startsWith('gh pr create') && call.includes('--draft')),
    pushes: result.calls.filter((call) => /^git .*\bpush\b/.test(call)),
    hold: tempFile('hold.md'),
    body: tempFile('pr.md'),
    commit:
      committed[1] === 'base'
        ? null
        : { author: committed[0], subject: committed[1], files: repo.git(['show', '--name-only', '--format=', 'HEAD']).trim().split('\n') },
    repo,
  };
}

const withUpgrade = (extra: Record<string, string | null>): Record<string, string | null> => ({ ...UPGRADE, ...extra });

/** Everything in order: the only scenarios allowed to merge unattended. */
const MERGES: Record<string, Scenario> = {
  'everything in order': { report: READY },
  'the verdict line ends with a Windows line ending': { report: 'Verdict: ready\r\n\r\nAll good.\r\n' },
  'more unit tests pass than before': { report: READY, env: { TESTS_AFTER: '540' } },
  // Adapting unit tests is part of an upgrade (a new major changes the APIs
  // they use nearly every time): it does not wait for a person.
  'unit tests were adapted to the new major': {
    report: READY,
    files: withUpgrade({
      'src/__tests__/app.test.ts': 'it works, with the new API\n',
      'src/ui/Button.test.tsx': 'it renders, with the new API\n',
    }),
  },
  'a unit test was added': {
    report: READY,
    files: withUpgrade({ 'src/ui/New.test.ts': 'it is new\n' }),
    env: { TESTS_AFTER: '532' },
  },
  // The end-to-end suite and its fixtures too (an Electron major changes
  // what the suite drives), as long as every scenario is still there.
  'the end-to-end suite was adapted, every scenario kept': {
    report: READY,
    files: withUpgrade({
      'scripts/smoke.mjs': SMOKE.replace('  await panic();', '  await panicThroughTheNewApi();').replace(
        '}\n',
        "  pass('A NEW SCENARIO');\n}\n",
      ),
      'scripts/fixtures/page.html': '<p>adapted</p>\n',
    }),
  },
  'a build script was adapted (it is not a judge)': {
    report: READY,
    files: withUpgrade({ 'scripts/build-main.mjs': '// build, adapted\n' }),
  },
  'a retry on a pull request left by a previous attempt': { report: READY, env: { FAKE_OPEN_PR: '41' } },
  // The repair of a Dependabot update that did not pass: same gate, its own
  // title, and the issue that reported it closes with the merge.
  'the repair of a Dependabot update': {
    report: READY,
    env: { TITLE: 'fix(deps): make the Dependabot update of #129 pass', FROM: '', TO: '', ISSUE: '12' },
  },
};

/** One thing out of order each: held, as an ordinary pull request. */
const HELD: Record<string, Scenario & { says: string }> = {
  'the agent says hold': { report: 'Verdict: hold\n\nNot sure about the updater.\n', says: 'verdict is not' },
  'the agent left no report': { says: 'verdict is not' },
  'the report is empty': { report: '', says: 'verdict is not' },
  'the verdict is not on the first line': { report: '# Report\n\nVerdict: ready\n', says: 'verdict is not' },
  'the verdict line says more than "ready"': { report: 'Verdict: ready, mostly\n', says: 'verdict is not' },
  'the verdict is spelled differently': { report: 'verdict: ready\n', says: 'verdict is not' },
  'the verdict line is indented': { report: '  Verdict: ready\n', says: 'verdict is not' },
  // What still watches the unit tests the agent may edit: how many pass.
  'a unit test was deleted, so fewer pass': {
    report: READY,
    files: withUpgrade({ 'src/__tests__/app.test.ts': null }),
    env: { TESTS_AFTER: '530' },
    says: 'before: 531, after: 530',
  },
  'the linter configuration was edited': {
    report: READY,
    files: withUpgrade({ 'eslint.config.mjs': 'export default [{ ignores: ["src"] }];\n' }),
    says: '`eslint.config.mjs`',
  },
  'the test runner configuration was edited': {
    report: READY,
    files: withUpgrade({ 'vitest.config.ts': 'export default { include: [] };\n' }),
    says: '`vitest.config.ts`',
  },
  'the type checker configuration was edited': {
    report: READY,
    files: withUpgrade({ 'tsconfig.main.json': '{ "include": [] }\n' }),
    says: '`tsconfig.main.json`',
  },
  // What still watches the end-to-end suite the agent may edit: its scenarios.
  'an end-to-end scenario was removed': {
    report: READY,
    files: withUpgrade({ 'scripts/smoke.mjs': SMOKE.replace("  await panic();\n  pass('PANIC');\n", '') }),
    says: '  - `PANIC`',
  },
  'an end-to-end scenario was commented out': {
    report: READY,
    files: withUpgrade({ 'scripts/smoke.mjs': SMOKE.replace("  pass('PANIC');", "  // pass('PANIC');") }),
    says: '  - `PANIC`',
  },
  'an end-to-end scenario was renamed': {
    report: READY,
    files: withUpgrade({ 'scripts/smoke.mjs': SMOKE.replace('STREAM MODE: masked before paint', 'STREAM MODE') }),
    says: '  - `STREAM MODE: masked before paint`',
  },
  'the end-to-end suite was deleted': {
    report: READY,
    files: withUpgrade({ 'scripts/smoke.mjs': null }),
    says: '  - `BOOT`',
  },
  'the scenarios of the suite it started from cannot be listed': {
    report: READY,
    base: { 'scripts/smoke.mjs': '// scenarios declared some other way\n' },
    says: 'could not be listed',
  },
  'the packaged-app check was edited': {
    report: READY,
    files: withUpgrade({ 'scripts/check-packaged.mjs': '// nothing\n' }),
    says: '`scripts/check-packaged.mjs`',
  },
  'the script that lets CI skip its heavy jobs was edited': {
    report: READY,
    files: withUpgrade({ 'scripts/version-only-diff.mjs': 'console.log("version_only=true")\n' }),
    says: '`scripts/version-only-diff.mjs`',
  },
  'an npm script was rewritten': {
    report: READY,
    files: withUpgrade({ 'package.json': json({ ...PACKAGE_JSON, scripts: { test: 'true', lint: 'eslint .' } }) }),
    says: 'npm scripts',
  },
  'an npm script was removed': {
    report: READY,
    files: withUpgrade({ 'package.json': json({ ...PACKAGE_JSON, scripts: { test: 'vitest run' } }) }),
    says: 'npm scripts',
  },
  'package.json can no longer be read': {
    report: READY,
    files: withUpgrade({ 'package.json': '{ "scripts": ' }),
    says: 'npm scripts',
  },
  'fewer unit tests pass than before (one was skipped)': {
    report: READY,
    files: withUpgrade({ 'src/__tests__/app.test.ts': 'it.skip works\n' }),
    env: { TESTS_AFTER: '530' },
    says: 'before: 531, after: 530',
  },
  'the test count after the upgrade is unknown': { report: READY, env: { TESTS_AFTER: '' }, says: 'after: unknown' },
  'the test count before the upgrade is unknown': { report: READY, env: { TESTS_BEFORE: '' }, says: 'before: unknown' },
  'the test count is not a number': { report: READY, env: { TESTS_AFTER: 'undefined' }, says: 'after: undefined' },
  'no test ran, before or after': { report: READY, env: { TESTS_BEFORE: '0', TESTS_AFTER: '0' }, says: 'before: 0' },
  'the agent edited a workflow': {
    report: READY,
    files: withUpgrade({ '.github/workflows/ci.yml': 'name: no checks\n', '.github/workflows/new.yml': 'name: new\n' }),
    says: 'were discarded',
  },
  'a retry that now ends in a hold': {
    report: 'Verdict: hold\n',
    env: { FAKE_OPEN_PR: '41', FAKE_AUTO_MERGE: 'true' },
    says: 'verdict is not',
  },
  'several things at once': {
    report: 'Verdict: hold\n',
    files: withUpgrade({
      'scripts/smoke.mjs': '// end-to-end suite, shorter\n',
      'eslint.config.mjs': 'export default [{ ignores: ["src"] }];\n',
      '.github/workflows/ci.yml': 'name: no checks\n',
    }),
    env: { TESTS_AFTER: '12' },
    says: 'verdict is not',
  },
};

/** Not even a candidate for review yet: held, as a DRAFT. */
const DRAFTS: Record<string, Scenario & { says: string }> = {
  'a check fails on the runner': { report: READY, env: { CHECKS_FAILED: '1' }, says: 'a check fails' },
  'the checks never reported': { report: READY, env: { CHECKS_FAILED: '' }, says: 'a check fails' },
  'the agent session failed': { report: READY, env: { AGENT_OUTCOME: 'failure' }, says: 'outcome: `failure`' },
  'the agent session was cancelled': { report: READY, env: { AGENT_OUTCOME: 'cancelled' }, says: 'outcome: `cancelled`' },
  'the agent step was skipped': { report: READY, env: { AGENT_OUTCOME: 'skipped' }, says: 'outcome: `skipped`' },
  'the agent outcome is unknown': { report: READY, env: { AGENT_OUTCOME: '' }, says: 'did not finish cleanly' },
};

/** Nothing to open a pull request with, or no way to do it safely: the run fails. */
const FAILS: Record<string, Scenario> = {
  'the agent changed nothing': { report: READY, files: {} },
  'the agent only wrote its report': { report: 'Verdict: hold\n', files: {} },
  'the agent only edited workflows': { report: READY, files: { '.github/workflows/ci.yml': 'name: no checks\n' } },
  'auto-merge of the previous attempt cannot be switched off': {
    report: READY,
    env: { FAKE_OPEN_PR: '41', FAKE_AUTO_MERGE: 'true', FAKE_FAIL: 'pr-merge' },
  },
};

describe.runIf(canRunSteps())('agent-upgrade.yml: does this upgrade merge on its own?', () => {
  const outcomes = new Map<string, Outcome>();
  const all: Record<string, Scenario> = { ...MERGES, ...HELD, ...DRAFTS, ...FAILS };
  const of = (name: string): Outcome => {
    const outcome = outcomes.get(name);
    if (!outcome) throw new Error(`scenario "${name}" did not run`);
    return outcome;
  };

  beforeAll(async () => {
    const names = Object.keys(all);
    const results = await pooled(names.map((name) => () => decide(all[name])));
    names.forEach((name, i) => outcomes.set(name, results[i]));
  });

  describe('it does when everything is in order', () => {
    it.each(Object.keys(MERGES))('%s', (name) => {
      const outcome = of(name);
      expect(outcome.status, outcome.said).toBe(0);
      expect(outcome.merges).toBe(true);
      expect(outcome.hold).toBe('');
      expect(outcome.draft).toBe(false);
      expect(outcome.body).toContain('Merges on its own');
      expect(outcome.summary).toContain('will merge on its own');
    });

    it('with a squash, through GitHub auto-merge: never before the required checks', () => {
      const outcome = of('everything in order');
      expect(outcome.calls).toContain('gh pr merge 77 --auto --squash');
      expect(outcome.outputs.number).toBe('77');
    });
  });

  describe('it waits for a person as soon as one thing is not', () => {
    it.each(Object.keys(HELD))('%s', (name) => {
      const outcome = of(name);
      expect(outcome.status, outcome.said).toBe(0);
      expect(outcome.merges).toBe(false);
      expect(outcome.hold).toContain(HELD[name].says);
      // Still a pull request the maintainer can merge with one click.
      expect(outcome.draft).toBe(false);
      expect(outcome.pushes).toHaveLength(1);
      expect(outcome.body).toContain('Held for a person');
      expect(outcome.body).toContain(HELD[name].says);
      expect(outcome.summary).toContain('is held for a person');
    });

    it.each(Object.keys(DRAFTS))('%s (opened as a draft)', (name) => {
      const outcome = of(name);
      expect(outcome.status, outcome.said).toBe(0);
      expect(outcome.merges).toBe(false);
      expect(outcome.hold).toContain(DRAFTS[name].says);
      expect(outcome.draft).toBe(true);
    });

    it('gives every reason at once, not only the first one found', () => {
      const { hold } = of('several things at once');
      for (const reason of [
        'verdict is not',
        'before: 531, after: 12',
        'were discarded',
        'lost scenarios',
        '  - `BOOT`',
        '`eslint.config.mjs`',
      ]) {
        expect(hold).toContain(reason);
      }
      // One reason, one line, when only one thing is wrong.
      expect(of('the agent says hold').hold.trim().split('\n')).toHaveLength(1);
    });
  });

  describe('it opens nothing when there is nothing safe to open', () => {
    it.each(Object.keys(FAILS))('%s', (name) => {
      const outcome = of(name);
      expect(outcome.status).not.toBe(0);
      expect(outcome.pushes).toEqual([]);
      expect(outcome.merges).toBe(false);
      expect(outcome.calls.filter((call) => call.startsWith('gh pr create') || call.startsWith('gh pr edit'))).toEqual([]);
      expect(outcome.commit).toBeNull();
    });
  });

  it('NOTHING but the scenarios where everything is in order merges on its own', () => {
    const merging = [...outcomes].filter(([, outcome]) => outcome.merges).map(([name]) => name);
    expect(merging.sort()).toEqual(Object.keys(MERGES).sort());
  });

  describe('a retry starts from scratch', () => {
    it('auto-merge left by the previous attempt is switched off BEFORE the push', () => {
      const { calls } = of('a retry that now ends in a hold');
      const off = calls.indexOf('gh pr merge 41 --disable-auto');
      const push = calls.findIndex((call) => /^git .*\bpush\b/.test(call));
      expect(off).toBeGreaterThan(-1);
      expect(push).toBeGreaterThan(off);
      expect(calls.filter((call) => call.startsWith('gh pr merge'))).toEqual(['gh pr merge 41 --disable-auto']);
    });

    it('if it cannot be switched off, nothing new reaches that pull request', () => {
      const outcome = of('auto-merge of the previous attempt cannot be switched off');
      expect(outcome.calls).toContain('gh pr merge 41 --disable-auto');
      expect(outcome.pushes).toEqual([]);
    });

    it('the pull request is reused, taken out of draft, and set to merge again', () => {
      const { calls, outputs } = of('a retry on a pull request left by a previous attempt');
      expect(calls.filter((call) => call.startsWith('gh pr create'))).toEqual([]);
      expect(calls.some((call) => call.startsWith('gh pr edit 41 '))).toBe(true);
      expect(calls.indexOf('gh pr ready 41')).toBeGreaterThan(-1);
      expect(calls.indexOf('gh pr merge 41 --auto --squash')).toBeGreaterThan(calls.indexOf('gh pr ready 41'));
      expect(outputs.number).toBe('41');
    });

    it('a held retry is not taken out of draft', () => {
      expect(of('a retry that now ends in a hold').calls).not.toContain('gh pr ready 41');
    });
  });

  describe('what is committed and pushed', () => {
    it('one commit, in the name of the token owner, titled like a dependency update', () => {
      for (const name of [...Object.keys(MERGES), ...Object.keys(HELD), ...Object.keys(DRAFTS)]) {
        const { commit } = of(name);
        expect(commit?.subject, name).toBe(all[name].env?.TITLE ?? 'chore(deps): upgrade somepkg from 1 to 2');
        expect(commit?.author, name).toBe('tester <4242+tester@users.noreply.github.com>');
      }
    });

    it('a repair carries its own title, and closes the issue that reported the red CI', () => {
      const repair = of('the repair of a Dependabot update');
      expect(repair.commit?.subject).toBe('fix(deps): make the Dependabot update of #129 pass');
      const create = repair.calls.find((call) => call.startsWith('gh pr create')) ?? '';
      expect(create).toContain('--title fix(deps): make the Dependabot update of #129 pass');
      expect(repair.body).toContain('**fix(deps): make the Dependabot update of #129 pass**');
      expect(repair.body).toContain('\nCloses #12\n');
      // No tracking issue, nothing to close.
      expect(of('everything in order').body).not.toContain('Closes #');
    });

    it('the report is the pull request description, never a committed file', () => {
      const outcome = of('everything in order');
      expect(outcome.commit?.files).toEqual(['package-lock.json', 'package.json', 'src/app.ts']);
      expect(fs.existsSync(path.join(outcome.repo.dir, 'UPGRADE_REPORT.md'))).toBe(false);
      expect(outcome.body).toContain('## Agent report');
      expect(outcome.body).toContain('All good.');
      expect(outcome.body).toContain('| `npm test` | passed |');
    });

    it('whatever the agent wrote under .github/ is dropped, on disk too', () => {
      const outcome = of('the agent edited a workflow');
      expect(outcome.commit?.files).toEqual(['package-lock.json', 'package.json', 'src/app.ts']);
      expect(fs.readFileSync(path.join(outcome.repo.dir, '.github/workflows/ci.yml'), 'utf8')).toBe('name: CI\n');
      expect(fs.existsSync(path.join(outcome.repo.dir, '.github/workflows/new.yml'))).toBe(false);
    });

    it('pushes once, to the upgrade branch only, as the automation token', () => {
      for (const name of [...Object.keys(MERGES), ...Object.keys(HELD), ...Object.keys(DRAFTS)]) {
        const { pushes } = of(name);
        expect(pushes, name).toHaveLength(1);
        expect(pushes[0], name).toContain(`https://x-access-token:${TOKEN}@github.com/owner/repo.git HEAD:refs/heads/automation/test`);
        // No credential inherited from the checkout or the agent's action.
        expect(pushes[0], name).toContain('http.https://github.com/.extraheader=');
      }
    });

    it('the token appears nowhere else: not in the description, the comment, the outputs or the log', () => {
      for (const [name, outcome] of outcomes) {
        for (const text of [outcome.body, outcome.hold, outcome.summary, outcome.written, outcome.said]) {
          expect(text, name).not.toContain(TOKEN);
        }
      }
    });

    it('never forces a merge past the branch protection', () => {
      for (const [name, outcome] of outcomes) {
        expect(outcome.calls.filter((call) => /--admin|--force-with|gh api .*merge/.test(call)), name).toEqual([]);
      }
    });
  });
});

// ------------------------------------------------- the checks the gate reads

const FAKE_NPM = `
echo "npm $*" >> "$CALLS"
case "|\${FAKE_FAIL:-}|" in *"|npm $*|"*) echo "npm $*: failed"; exit 1 ;; esac
exit 0
`;
/** `npx vitest run --reporter=json --outputFile=...`: writes $FAKE_REPORT there. */
const FAKE_NPX = `
echo "npx $*" >> "$CALLS"
for arg in "$@"; do
  case "$arg" in --outputFile=*) out="\${arg#--outputFile=}" ;; esac
done
if [ -n "\${FAKE_REPORT:-}" ]; then printf '%s' "$FAKE_REPORT" > "$out"; fi
exit "\${FAKE_NPX_STATUS:-0}"
`;
const FAKE_XVFB = `
echo "xvfb-run $*" >> "$CALLS"
exit "\${FAKE_SMOKE_STATUS:-0}"
`;
/** Not on every developer machine; the real one only adds a time limit. */
const FAKE_TIMEOUT = 'shift\nexec "$@"\n';
const CHECK_FAKES = { npm: FAKE_NPM, npx: FAKE_NPX, 'xvfb-run': FAKE_XVFB, timeout: FAKE_TIMEOUT };

describe.runIf(canRunSteps())('agent-upgrade.yml: the checks are measured by the workflow, not reported by the agent', () => {
  const script = stepRun(workflow, 'id: checks');

  function check(env: Record<string, string> = {}, installed: string | null = '2.1.0'): Promise<StepResult> {
    const cwd = fs.mkdtempSync(path.join(sandbox, 'checks-'));
    const packages = installed === null ? {} : { 'node_modules/somepkg': { version: installed } };
    fs.writeFileSync(path.join(cwd, 'package-lock.json'), json({ packages }));
    return runStep({
      script,
      cwd,
      fakes: CHECK_FAKES,
      env: { PACKAGE: 'somepkg', TO: '2', TESTS_BEFORE: '531', FAKE_REPORT: '{"numPassedTests":531}', ...env },
    });
  }
  const table = (result: StepResult): string => fs.readFileSync(path.join(result.temp, 'checks.md'), 'utf8');

  it('all green: nothing failed, and the five checks really ran', async () => {
    const result = await check();
    expect(result.status, result.said).toBe(0);
    expect(result.outputs).toEqual({ failed: '0', tests: '531' });
    for (const call of ['npm run typecheck', 'npm run lint', 'npm test', 'npm run build', 'xvfb-run -a node scripts/smoke.mjs']) {
      expect(result.calls).toContain(call);
    }
    expect(table(result)).not.toContain('FAILED');
    expect(table(result)).toContain('| unit tests passing | 531 before, 531 after |');
  });

  it.each([
    ['the type checker', { FAKE_FAIL: 'npm run typecheck' }, '`npm run typecheck`'],
    ['the linter', { FAKE_FAIL: 'npm run lint' }, '`npm run lint`'],
    ['the unit tests', { FAKE_FAIL: 'npm test' }, '`npm test`'],
    ['the build', { FAKE_FAIL: 'npm run build' }, '`npm run build`'],
    ['the end-to-end suite', { FAKE_SMOKE_STATUS: '1' }, '`node scripts/smoke.mjs`'],
  ])('%s failing is reported, and the other checks still run', async (_name, env, row) => {
    const result = await check(env);
    // The step itself succeeds: the pull request must still be opened (held).
    expect(result.status, result.said).toBe(0);
    expect(result.outputs.failed).toBe('1');
    expect(table(result)).toContain(`| ${row} | **FAILED** |`);
    expect(table(result).match(/\| passed \|/g)).toHaveLength(5);
    expect(result.calls).toContain('xvfb-run -a node scripts/smoke.mjs');
  });

  it('a repair has no target major to check: the update is whatever Dependabot made', async () => {
    const result = await check({ TO: '' }, null);
    expect(result.status, result.said).toBe(0);
    expect(result.outputs.failed).toBe('0');
    expect(table(result)).not.toContain('is at major');
    expect(table(result).match(/\| passed \|/g)).toHaveLength(5);
  });

  it.each([
    ['still at the old major', '1.9.0'],
    ['past the target major', '3.0.0'],
    ['at a major that only starts with the target (20 for 2)', '20.1.0'],
    ['no longer installed', null],
  ])('the package %s is a failed check: the upgrade did not happen', async (_name, installed) => {
    const result = await check({}, installed);
    expect(result.status, result.said).toBe(0);
    expect(result.outputs.failed).toBe('1');
    expect(table(result)).toContain('| `somepkg is at major 2` | **FAILED** |');
  });

  it.each([
    ['the test runner wrote no report', { FAKE_REPORT: '' }, ''],
    ['the report is not JSON', { FAKE_REPORT: 'RUN v5.0.0' }, ''],
    ['the report has no count (a new format)', { FAKE_REPORT: '{"tests":531}' }, 'undefined'],
  ])('%s: the count is passed on as it is, for the gate to refuse', async (_name, env, tests) => {
    const result = await check(env);
    expect(result.status, result.said).toBe(0);
    expect(result.outputs.tests).toBe(tests);
  });

  it('counts the tests that PASS: one skipped to get to green is one fewer', async () => {
    const result = await check({ FAKE_REPORT: '{"numTotalTests":531,"numPassedTests":529,"numPendingTests":2}' });
    expect(result.status, result.said).toBe(0);
    expect(result.outputs.tests).toBe('529');
  });

  it('counts with the test runner even when its run fails', async () => {
    const result = await check({ FAKE_NPX_STATUS: '1', FAKE_REPORT: '{"numPassedTests":12}' });
    expect(result.status, result.said).toBe(0);
    expect(result.outputs.tests).toBe('12');
  });
});

describe.runIf(canRunSteps())('agent-upgrade.yml: before the agent starts', () => {
  const script = stepRun(workflow, 'id: start');

  function start(
    env: Record<string, string>,
    prepare: (repo: GitFixture) => void = () => {},
  ): Promise<StepResult & { repo: GitFixture }> {
    const repo = new GitFixture(sandbox);
    repo.writeText('.github/automation/playbook.md', '# Playbook\n');
    repo.writeText('package.json', json({ devDependencies: { electron: '^45.2.3', vitest: '^4.0.0' } }));
    repo.commit('base');
    prepare(repo);
    return runStep({
      script,
      cwd: repo.dir,
      fakes: { npm: FAKE_NPM, npx: FAKE_NPX, git: FAKE_GIT },
      env: {
        PLAYBOOK: '.github/automation/playbook.md',
        BRANCH: 'automation/test',
        INSTALL: '',
        MERGE_REF: '',
        FAKE_REPORT: '{"numPassedTests":531}',
        ...env,
      },
    }).then((result) => ({ ...result, repo }));
  }

  /** A Dependabot branch, as the checkout fetches it: origin/dependabot/npm_and_yarn/electron. */
  const DEPENDABOT = 'dependabot/npm_and_yarn/electron-45.3.0';
  function dependabotBranch(repo: GitFixture): void {
    repo.git(['switch', '-q', '-c', 'bump']);
    repo.writeText('package.json', json({ devDependencies: { electron: '^45.3.0', vitest: '^4.0.0' } }));
    const tip = repo.commit('chore(deps-dev): bump electron from 45.2.3 to 45.3.0');
    repo.git(['update-ref', `refs/remotes/origin/${DEPENDABOT}`, tip]);
    repo.git(['switch', '-q', 'main']);
    repo.git(['branch', '-q', '-D', 'bump']);
  }

  describe('a repair starts from the update that does not pass', () => {
    it('applies it on top of main, uncommitted, after the test count was taken on code that passes', async () => {
      const result = await start({ MERGE_REF: DEPENDABOT }, dependabotBranch);
      expect(result.status, result.said).toBe(0);
      expect(result.outputs.tests).toBe('531');
      expect(result.repo.git(['branch', '--show-current']).trim()).toBe('automation/test');
      // The update is in the working tree...
      expect(result.repo.readJson<{ devDependencies: Record<string, string> }>('package.json').devDependencies.electron).toBe('^45.3.0');
      // ...and not committed: the pull request will carry update and fix as one commit.
      expect(result.repo.git(['log', '-1', '--format=%s']).trim()).toBe('base');
      expect(result.repo.git(['diff', '--cached', '--name-only']).trim()).toBe('package.json');
      // Counted BEFORE the update, installed again AFTER it.
      expect(result.calls.map((call) => call.split(' ').slice(0, 2).join(' '))).toEqual(['npm ci', 'npx vitest', 'npm ci']);
    });

    it('stops when the update no longer applies on main (Dependabot rebases it, the next red run retries)', async () => {
      const result = await start({ MERGE_REF: DEPENDABOT }, (repo) => {
        dependabotBranch(repo);
        repo.writeText('package.json', json({ devDependencies: { electron: '^46.0.0', vitest: '^4.0.0' } }));
        repo.commit('main moved on the same line');
      });
      expect(result.status).not.toBe(0);
      expect(result.said).toContain('does not apply on main any more');
    });

    it('stops when the branch to repair does not exist', async () => {
      const result = await start({ MERGE_REF: 'dependabot/npm_and_yarn/gone' });
      expect(result.status).not.toBe(0);
    });
  });

  it('counts the unit tests on the untouched code, then bumps', async () => {
    const result = await start({ INSTALL: 'npm install --save-dev "electron@^46.0.0"' });
    expect(result.status, result.said).toBe(0);
    expect(result.outputs.tests).toBe('531');
    expect(result.repo.git(['branch', '--show-current']).trim()).toBe('automation/test');
    const order = result.calls.map((call) => call.split(' ').slice(0, 2).join(' '));
    expect(order).toEqual(['npm ci', 'npx vitest', 'npm install']);
    expect(result.calls).toContain('npm install --save-dev electron@^46.0.0');
  });

  it('leaves the bump to the agent when no command is given', async () => {
    const result = await start({});
    expect(result.status, result.said).toBe(0);
    expect(result.calls.filter((call) => call.startsWith('npm install'))).toEqual([]);
  });

  it('a baseline it cannot count is passed on as unknown (the gate then holds)', async () => {
    const result = await start({ FAKE_REPORT: '', FAKE_NPX_STATUS: '1' });
    expect(result.status, result.said).toBe(0);
    expect(result.outputs.tests).toBe('');
  });

  it('stops before anything else when the playbook is missing', async () => {
    const result = await start({ PLAYBOOK: '.github/automation/missing.md' });
    expect(result.status).not.toBe(0);
    expect(result.calls).toEqual([]);
    expect(result.repo.git(['branch', '--show-current']).trim()).not.toBe('automation/test');
  });

  it('stops when the scripted bump fails', async () => {
    const result = await start({ INSTALL: 'npm install nope', FAKE_FAIL: 'npm install nope' });
    expect(result.status).not.toBe(0);
  });
});

// ------------------------------------------------ what the maintainer is told

describe.runIf(canRunSteps())('agent-upgrade.yml: a held upgrade does not sit there unnoticed', () => {
  const block = stepBlock(workflow, 'name: Tell the maintainer');
  const script = stepRun(workflow, 'name: Tell the maintainer');
  const recorder = 'echo "gh $*" >> "$CALLS"\n';

  function tell(env: Record<string, string>, hold?: string): Promise<StepResult> {
    const cwd = fs.mkdtempSync(path.join(sandbox, 'tell-'));
    return runStep({
      script,
      cwd,
      fakes: { gh: recorder },
      tempFiles: hold === undefined ? {} : { 'hold.md': hold },
      env: { PR: '77', ISSUE: '', ...env },
    });
  }

  it('a hold is a comment that mentions the maintainer and gives the reasons', async () => {
    const result = await tell({}, '- the agent\'s verdict is not `ready`\n');
    expect(result.status, result.said).toBe(0);
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]).toMatch(/^gh pr comment 77 -R owner\/repo --body-file /);
    const comment = fs.readFileSync(path.join(result.temp, 'comment.md'), 'utf8');
    expect(comment).toContain('@owner this upgrade is **not** merging on its own');
    expect(comment).toContain('verdict is not `ready`');
  });

  it('an upgrade that merges on its own gets no comment', async () => {
    const result = await tell({});
    expect(result.status, result.said).toBe(0);
    expect(result.calls).toEqual([]);
  });

  it('the tracking issue is told which of the two it is', async () => {
    const held = await tell({ ISSUE: '12' }, '- a check fails\n');
    expect(held.calls[1]).toContain('gh issue comment 12 -R owner/repo');
    expect(held.calls[1]).toContain('#77; it is held for you');
    const merging = await tell({ ISSUE: '12' });
    expect(merging.calls).toHaveLength(1);
    expect(merging.calls[0]).toContain('#77; it merges on its own once CI is green');
  });

  it('speaks with the workflow\'s own token: GitHub does not notify you of your own comments', () => {
    expect(block).toContain('GH_TOKEN: ${{ github.token }}');
    expect(block).not.toContain('AUTOMATION_TOKEN');
    expect(block).toContain("if: steps.pr.outputs.number != ''");
  });
});
