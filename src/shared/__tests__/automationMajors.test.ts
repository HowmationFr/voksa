/**
 * Which major upgrade is handed to the agent, and when: the list
 * (scripts/outdated-majors.mjs), the weekly pick (dependency-majors.yml) and
 * the Electron check (electron-major.yml). The steps are run for real, with
 * `gh`, `npm` and the network side of git replaced (see automationHelpers).
 *
 * Not covered here: the `--jq` filters, which the real `gh` evaluates.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  FAKE_GIT,
  ROOT,
  canRunSteps,
  readRepoFile,
  readWorkflow,
  runStep,
  stepRun,
  type StepResult,
} from './automationHelpers';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

type Candidate = { name: string; from: number; to: number; latest: string };
type Manifest = { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
type MajorsScript = {
  NOT_CANDIDATES: Set<string>;
  candidateNames: (pkg: Manifest, shippedNames: unknown[]) => string[];
  outdatedMajors: (input: {
    pkg: Manifest;
    lock: { packages?: Record<string, { version?: string }> };
    shippedNames: unknown[];
    latestByName: Record<string, unknown>;
  }) => Candidate[];
  formatCandidate: (c: Candidate) => string;
};

let majors: MajorsScript;
beforeAll(async () => {
  majors = (await import(pathToFileURL(path.join(ROOT, 'scripts', 'outdated-majors.mjs')).href)) as MajorsScript;
});

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'voksa-majors-'));
afterAll(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const lockOf = (versions: Record<string, string>) => ({
  packages: Object.fromEntries(Object.entries(versions).map(([name, version]) => [`node_modules/${name}`, { version }])),
});

describe('outdated-majors: what may be upgraded', () => {
  const pkg: Manifest = {
    dependencies: { 'better-sqlite3': '^13.0.0', 'electron-chrome-extensions': '4.10.0', 'electron-chrome-web-store': '0.13.0' },
    devDependencies: {
      '@types/node': '^24.0.0',
      '@types/react': '^18.0.0',
      electron: '^45.0.0',
      eslint: '^9.0.0',
      react: '^18.0.0',
      vitest: '^4.0.0',
    },
  };

  it('never Electron (it has its own workflow) nor the two patched libraries', () => {
    const names = majors.candidateNames(pkg, []);
    expect(names).not.toContain('electron');
    expect(names).not.toContain('electron-chrome-extensions');
    expect(names).not.toContain('electron-chrome-web-store');
  });

  it('never a @types package on its own: it follows the package it describes', () => {
    expect(majors.candidateNames(pkg, []).filter((name) => name.startsWith('@types/'))).toEqual([]);
  });

  it('what ships in the application first, then the tools, package.json order in each', () => {
    expect(majors.candidateNames(pkg, ['react', 'better-sqlite3', 'Chromium'])).toEqual([
      'better-sqlite3',
      'react',
      'eslint',
      'vitest',
    ]);
  });

  it('a manifest without dependencies has no candidates', () => {
    expect(majors.candidateNames({}, ['react'])).toEqual([]);
  });
});

describe('outdated-majors: what counts as a newer major', () => {
  const pkg: Manifest = { devDependencies: { react: '^18.0.0', eslint: '^9.0.0', vitest: '^4.0.0', nanoid: '^5.0.0' } };
  const ask = (installed: Record<string, string>, latestByName: Record<string, unknown>) =>
    majors.outdatedMajors({ pkg, lock: lockOf(installed), shippedNames: ['react'], latestByName });

  it('a newer major is a candidate, with the versions the workflow needs', () => {
    expect(ask({ react: '18.3.1' }, { react: '19.2.0' })).toEqual([{ name: 'react', from: 18, to: 19, latest: '19.2.0' }]);
  });

  it('a newer minor or patch is not: those are Dependabot\'s', () => {
    expect(ask({ react: '18.3.1', eslint: '9.1.0' }, { react: '18.9.0', eslint: '9.1.7' })).toEqual([]);
  });

  it('0.x to 1.x is a major, and several majors behind is one jump to the latest', () => {
    expect(ask({ nanoid: '0.4.1', eslint: '7.2.0' }, { nanoid: '1.0.0', eslint: '10.1.0' })).toEqual([
      { name: 'eslint', from: 7, to: 10, latest: '10.1.0' },
      { name: 'nanoid', from: 0, to: 1, latest: '1.0.0' },
    ]);
  });

  it('never proposes a downgrade (installed from a pre-release channel)', () => {
    expect(ask({ vitest: '5.0.0-beta.2' }, { vitest: '4.9.0' })).toEqual([]);
  });

  it('a package the registry did not answer for is skipped, the others are kept', () => {
    expect(ask({ react: '18.3.1', eslint: '9.1.0' }, { eslint: '10.0.0' })).toEqual([
      { name: 'eslint', from: 9, to: 10, latest: '10.0.0' },
    ]);
  });

  it('so is a package that is not installed, or an answer that is not a version', () => {
    expect(ask({ eslint: '9.1.0' }, { react: '19.0.0', eslint: 'latest', vitest: 5 })).toEqual([]);
  });

  it('keeps the order: shipped first', () => {
    const all = ask(
      { react: '18.3.1', eslint: '9.1.0', vitest: '4.1.0' },
      { react: '19.0.0', eslint: '10.0.0', vitest: '5.0.0' },
    );
    expect(all.map((c) => c.name)).toEqual(['react', 'eslint', 'vitest']);
  });
});

describe('outdated-majors against this repository', () => {
  const pkg = JSON.parse(readRepoFile('package.json')) as Manifest;
  const shipped = (JSON.parse(readRepoFile('src/shared/credits.generated.json')) as Array<{ name?: string }>).map((e) => e.name);
  const patched = fs
    .readdirSync(path.join(ROOT, 'patches'))
    .filter((file) => file.endsWith('.patch'))
    // patch-package names: name+version.patch, @scope+name+version.patch.
    .map((file) => file.replace(/\.patch$/, '').split('+').slice(0, -1).join('/'));

  it('every package patched in patches/ is excluded: bumping one breaks its patch', () => {
    expect(patched.length).toBeGreaterThan(0);
    for (const name of patched) expect(majors.NOT_CANDIDATES.has(name), name).toBe(true);
    expect(majors.candidateNames(pkg, shipped).filter((name) => patched.includes(name))).toEqual([]);
  });

  it('Dependabot leaves those same packages alone, and every major to the agent', () => {
    const dependabot = readRepoFile('.github/dependabot.yml');
    for (const name of patched) expect(dependabot, name).toContain(`- dependency-name: ${name}\n`);
    expect(dependabot).toMatch(/- dependency-name: "\*"\n\s+update-types: \["version-update:semver-major"\]/);
  });

  it('proposes only direct dependencies, each once', () => {
    const direct = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]);
    const names = majors.candidateNames(pkg, shipped);
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(direct.has(name), name).toBe(true);
    expect(names).not.toContain('electron');
  });
});

// ------------------------------------------------- the weekly pick, for real

const FAKE_GH = `
echo "gh $*" >> "$CALLS"
case "$*" in
  "pr list --state open --json headRefName"*) echo "\${FAKE_OPEN_UPGRADES:-0}" ;;
  "pr list --head "*)
    case " \${FAKE_ATTEMPTED:-} " in *" $4 "*) echo 1 ;; *) echo 0 ;; esac ;;
esac
exit 0
`;

describe.runIf(canRunSteps())('dependency-majors.yml: one dependency a week', () => {
  const script = stepRun(readWorkflow('dependency-majors.yml'), 'id: pick');
  const listed: Candidate[] = [
    { name: 'react', from: 18, to: 19, latest: '19.2.0' },
    { name: '@vitejs/plugin-react', from: 5, to: 6, latest: '6.0.1' },
    { name: 'eslint', from: 9, to: 10, latest: '10.1.0' },
  ];

  /** Runs the step in a directory whose outdated-majors.mjs prints `candidates`. */
  function pick(env: Record<string, string> = {}, candidates = listed): Promise<StepResult> {
    const cwd = fs.mkdtempSync(path.join(sandbox, 'pick-'));
    fs.mkdirSync(path.join(cwd, 'scripts'));
    // The real script's own line format, so the workflow is tested against
    // what it will really be given.
    const lines = candidates.map((c) => majors.formatCandidate(c));
    fs.writeFileSync(
      path.join(cwd, 'scripts', 'outdated-majors.mjs'),
      `for (const line of ${JSON.stringify(lines)}) console.log(line);\n`,
    );
    return runStep({ script, cwd, env: { WANTED: '', RETRY: 'false', ...env }, fakes: { gh: FAKE_GH, git: FAKE_GIT } });
  }

  it('picks the first candidate and names its branch after the target major', async () => {
    const result = await pick();
    expect(result.status).toBe(0);
    expect(result.outputs).toEqual({ package: 'react', from: '18', to: '19', branch: 'automation/upgrade-react-19' });
  });

  it('picks nothing while another automated upgrade is still open', async () => {
    const result = await pick({ FAKE_OPEN_UPGRADES: '1' });
    expect(result.status).toBe(0);
    expect(result.written).toBe('');
  });

  it('does not propose again what was already attempted: a closed pull request is a "no"', async () => {
    const result = await pick({ FAKE_ATTEMPTED: 'automation/upgrade-react-19' });
    expect(result.outputs.package).toBe('@vitejs/plugin-react');
    expect(result.outputs.branch).toBe('automation/upgrade-vitejs-plugin-react-6');
  });

  it('a branch left on the remote counts as an attempt too', async () => {
    const result = await pick({ FAKE_REMOTE_BRANCHES: 'automation/upgrade-react-19 automation/upgrade-vitejs-plugin-react-6' });
    expect(result.outputs.package).toBe('eslint');
  });

  it('a NEW major of a dependency that was declined is proposed again', async () => {
    const result = await pick({ FAKE_ATTEMPTED: 'automation/upgrade-react-18' });
    expect(result.outputs.package).toBe('react');
  });

  it('picks nothing once everything was attempted, or when nothing is outdated', async () => {
    const all = 'automation/upgrade-react-19 automation/upgrade-vitejs-plugin-react-6 automation/upgrade-eslint-10';
    expect((await pick({ FAKE_ATTEMPTED: all })).written).toBe('');
    const none = await pick({}, []);
    expect(none.status).toBe(0);
    expect(none.written).toBe('');
  });

  it('the manual trigger can ask for one dependency, and only gets that one', async () => {
    expect((await pick({ WANTED: 'eslint' })).outputs.package).toBe('eslint');
    expect((await pick({ WANTED: 'not-a-dependency' })).written).toBe('');
    expect((await pick({ WANTED: 'react', FAKE_ATTEMPTED: 'automation/upgrade-react-19' })).written).toBe('');
  });

  it('`retry` insists: past attempts and open upgrades no longer stop it', async () => {
    const result = await pick({ RETRY: 'true', FAKE_OPEN_UPGRADES: '1', FAKE_ATTEMPTED: 'automation/upgrade-react-19' });
    expect(result.outputs.package).toBe('react');
  });
});

// ----------------------------------------------------- the Electron check

describe.runIf(canRunSteps())('electron-major.yml: is a newer Electron major out?', () => {
  const workflow = readWorkflow('electron-major.yml');
  const versionsScript = stepRun(workflow, 'id: versions');
  const planScript = stepRun(workflow, 'id: plan');

  function versions(latest: string, wanted = '', range = '^45.2.3'): Promise<StepResult> {
    const cwd = fs.mkdtempSync(path.join(sandbox, 'electron-'));
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ devDependencies: { electron: range } }));
    return runStep({
      script: versionsScript,
      cwd,
      env: { WANTED: wanted, FAKE_LATEST: latest },
      fakes: { npm: 'echo "$FAKE_LATEST"\n' },
    });
  }

  function plan(env: Record<string, string>): Promise<StepResult> {
    const cwd = fs.mkdtempSync(path.join(sandbox, 'plan-'));
    return runStep({
      script: planScript,
      cwd,
      env: { CURRENT: '45', TARGET: '46', BRANCH: 'automation/electron-46', RETRY: 'false', ...env },
      fakes: { gh: FAKE_GH, git: FAKE_GIT },
    });
  }

  it('reads both majors and names the branch after the target', async () => {
    const result = await versions('46.0.1');
    expect(result.status).toBe(0);
    expect(result.outputs).toEqual({ current: '45', latest: '46.0.1', target: '46', branch: 'automation/electron-46' });
  });

  it('reads the current major whatever the range prefix', async () => {
    expect((await versions('46.0.1', '', '45.2.3')).outputs.current).toBe('45');
    expect((await versions('46.0.1', '', '~45.2.3')).outputs.current).toBe('45');
  });

  it('the manual trigger can name another major', async () => {
    expect((await versions('47.0.0', '46')).outputs.target).toBe('46');
  });

  it('stops loudly when a major cannot be read, instead of guessing', async () => {
    for (const [latest, wanted] of [['', ''], ['not a version', ''], ['46.0.1', 'next']]) {
      const result = await versions(latest, wanted);
      expect(result.status, `latest="${latest}" wanted="${wanted}"`).not.toBe(0);
      expect(result.written, `latest="${latest}" wanted="${wanted}"`).toBe('');
    }
  });

  it('a newer major is prepared once', async () => {
    expect((await plan({})).outputs.migrate).toBe('true');
    expect((await plan({ FAKE_ATTEMPTED: 'automation/electron-46' })).outputs.migrate).toBe('false');
    expect((await plan({ FAKE_REMOTE_BRANCHES: 'automation/electron-46' })).outputs.migrate).toBe('false');
  });

  it('`retry` prepares it again', async () => {
    expect((await plan({ RETRY: 'true', FAKE_ATTEMPTED: 'automation/electron-46' })).outputs.migrate).toBe('true');
  });

  it('nothing is prepared when Voksa is already on the latest major, or ahead of the target', async () => {
    expect((await plan({ TARGET: '45', BRANCH: 'automation/electron-45' })).outputs.migrate).toBe('false');
    expect((await plan({ TARGET: '44', BRANCH: 'automation/electron-44', RETRY: 'true' })).outputs.migrate).toBe('false');
  });

  it('the scripted bump keeps a caret range, so Dependabot keeps bringing patches', () => {
    expect(workflow).toContain('install: npm install --save-dev "electron@^${{ needs.detect.outputs.target }}.0.0"');
  });
});
