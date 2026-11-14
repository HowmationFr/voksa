/**
 * scripts/version-only-diff.mjs is what lets CI skip the build, the smoke
 * suite and the packaging on all three OSes (ci.yml, "Scope"). It exists for
 * the release pull request, a pure version bump. A wrong "yes" on anything
 * else would let a change merge, automatically, with none of those checks
 * run: every answer but the exact version bump must be "no".
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GitFixture, readWorkflow, runNodeScript, stepBlock } from './automationHelpers';

vi.setConfig({ testTimeout: 60_000 });

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'voksa-ci-scope-'));

afterAll(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

type Pkg = { name: string; version: string; scripts: Record<string, string>; devDependencies: Record<string, string> };
type Lock = {
  name: string;
  version: string;
  packages: Record<string, { version: string; devDependencies?: Record<string, string> }>;
};

/** A repository at 1.4.2, and `change` applied on top of it. */
function scope(change: (repo: GitFixture) => void, refs?: [string?, string?]): { answer: string; said: string; status: number | null } {
  const repo = new GitFixture(sandbox);
  repo.writeJson('package.json', {
    name: 'fixture',
    version: '1.4.2',
    scripts: { test: 'vitest run' },
    devDependencies: { electron: '^45.0.0' },
  });
  repo.writeJson('package-lock.json', {
    name: 'fixture',
    version: '1.4.2',
    packages: {
      '': { version: '1.4.2', devDependencies: { electron: '^45.0.0' } },
      'node_modules/electron': { version: '45.0.0' },
    },
  });
  repo.writeText('src/app.ts', 'export const a = 1;\n');
  repo.commit('base');
  change(repo);
  repo.commit('change');
  const args = (refs ?? ['HEAD^1', 'HEAD']).filter((ref): ref is string => ref !== undefined);
  const { status, said, written } = runNodeScript('version-only-diff.mjs', args, { cwd: repo.dir });
  return { answer: written, said, status };
}

/** Exactly what `npm version X --no-git-tag-version` writes. */
function npmVersion(repo: GitFixture, version: string): void {
  const pkg = repo.readJson<Pkg>('package.json');
  pkg.version = version;
  repo.writeJson('package.json', pkg);
  const lock = repo.readJson<Lock>('package-lock.json');
  lock.version = version;
  lock.packages[''].version = version;
  repo.writeJson('package-lock.json', lock);
}

const YES = 'version_only=true\n';
const NO = 'version_only=false\n';

describe('version-only-diff: the one change that may skip the heavy CI jobs', () => {
  it('the release pull request: a version bump in package.json and the lockfile', () => {
    expect(scope((repo) => npmVersion(repo, '1.4.3')).answer).toBe(YES);
  });

  it('whatever the size of the bump', () => {
    expect(scope((repo) => npmVersion(repo, '2.0.0')).answer).toBe(YES);
  });
});

describe('version-only-diff: everything else runs the full pipeline', () => {
  const cases: Array<[string, (repo: GitFixture) => void]> = [
    ['a source file changed along with the version', (repo) => {
      npmVersion(repo, '1.4.3');
      repo.writeText('src/app.ts', 'export const a = 2;\n');
    }],
    ['a source file changed alone', (repo) => repo.writeText('src/app.ts', 'export const a = 2;\n')],
    ['a file was added', (repo) => {
      npmVersion(repo, '1.4.3');
      repo.writeText('src/new.ts', 'export const b = 1;\n');
    }],
    ['a file was removed', (repo) => {
      npmVersion(repo, '1.4.3');
      repo.remove('src/app.ts');
    }],
    ['a dependency range changed in package.json', (repo) => {
      npmVersion(repo, '1.4.3');
      const pkg = repo.readJson<Pkg>('package.json');
      pkg.devDependencies.electron = '^46.0.0';
      repo.writeJson('package.json', pkg);
    }],
    ['an installed version changed in the lockfile (a Dependabot update)', (repo) => {
      const lock = repo.readJson<Lock>('package-lock.json');
      lock.packages['node_modules/electron'].version = '45.0.1';
      repo.writeJson('package-lock.json', lock);
    }],
    ['the same, hidden behind a version bump', (repo) => {
      npmVersion(repo, '1.4.3');
      const lock = repo.readJson<Lock>('package-lock.json');
      lock.packages['node_modules/electron'].version = '46.0.0';
      repo.writeJson('package-lock.json', lock);
    }],
    ['the root entry of the lockfile changed beyond its version', (repo) => {
      npmVersion(repo, '1.4.3');
      const lock = repo.readJson<Lock>('package-lock.json');
      lock.packages[''].devDependencies = { electron: '^46.0.0' };
      repo.writeJson('package-lock.json', lock);
    }],
    ['an npm script changed: that is how the checks are launched', (repo) => {
      npmVersion(repo, '1.4.3');
      const pkg = repo.readJson<Pkg>('package.json');
      pkg.scripts.test = 'true';
      repo.writeJson('package.json', pkg);
    }],
    ['a package was added to the lockfile', (repo) => {
      npmVersion(repo, '1.4.3');
      const lock = repo.readJson<Lock>('package-lock.json');
      lock.packages['node_modules/left-pad'] = { version: '1.3.0' };
      repo.writeJson('package-lock.json', lock);
    }],
    ['nothing changed at all', () => {}],
    ['package.json is no longer valid JSON', (repo) => repo.writeText('package.json', '{ "version": "1.4.3", ')],
    ['a workflow changed', (repo) => {
      npmVersion(repo, '1.4.3');
      repo.writeText('.github/workflows/ci.yml', 'name: CI\n');
    }],
  ];

  it.each(cases)('%s', (_name, change) => {
    const result = scope(change);
    expect(result.answer).toBe(NO);
    expect(result.status).toBe(0);
  });

  it('a commit it cannot read is a doubt, and a doubt is "no"', () => {
    const result = scope((repo) => npmVersion(repo, '1.4.3'), ['no-such-ref', 'HEAD']);
    expect(result.answer).toBe(NO);
    expect(result.status).toBe(0);
    expect(result.said).toContain('running the full pipeline');
  });

  it('so is a missing argument', () => {
    expect(scope((repo) => npmVersion(repo, '1.4.3'), ['HEAD^1']).answer).toBe(NO);
    expect(scope((repo) => npmVersion(repo, '1.4.3'), []).answer).toBe(NO);
  });
});

describe('ci.yml uses the answer the safe way round', () => {
  const ci = readWorkflow('ci.yml');

  it('heavy steps run unless the answer is exactly "true" (a failed probe runs them)', () => {
    const job = ci.slice(ci.indexOf('\n  packages:'));
    const conditions = [...job.matchAll(/^\s+if: (.*version_only.*)$/gm)].map((m) => m[1]);
    expect(conditions.length).toBeGreaterThan(5);
    for (const condition of conditions) {
      expect(condition).toContain("steps.scope.outputs.version_only != 'true'");
      expect(condition).not.toContain("== 'false'");
    }
  });

  it('compares the pull request with its base, and only for pull requests', () => {
    const step = stepBlock(ci, 'id: scope');
    expect(step).toContain('run: node scripts/version-only-diff.mjs HEAD^1 HEAD');
    expect(step).toContain("if: github.event_name == 'pull_request'");
  });

  it('the unit tests, the linter and the type checker are never skipped', () => {
    const checks = ci.slice(ci.indexOf('\n  checks:'), ci.indexOf('\n  packages:'));
    expect(checks).toContain('run: npm run typecheck');
    expect(checks).toContain('run: npm run lint');
    expect(checks).toContain('run: npm test');
    expect(checks).not.toContain('version_only');
  });
});
