/**
 * scripts/release-due.mjs decides, once a day and with nobody watching,
 * whether a release goes out to every user (auto-release.yml). It is run here
 * exactly as the workflow runs it, in throwaway git repositories: its answer
 * depends on tags, commit dates and three JSON files, which is cheaper to
 * build for real than to mock.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GitFixture, runNodeScript } from './automationHelpers';

// Every scenario builds a git repository: slow on a busy Windows machine.
vi.setConfig({ testTimeout: 60_000 });

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'voksa-release-due-'));

afterAll(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

type Versions = Record<string, string>;
type Lock = { version?: string; packages: Record<string, { version: string }> };

class Repo extends GitFixture {
  constructor(version = '1.4.2') {
    super(sandbox);
    this.writeJson('src/shared/credits.generated.json', [
      { name: 'electron', version: '45.0.0' },
      { name: 'react', version: '18.3.1' },
      { name: 'better-sqlite3', version: '13.0.3' },
      // Not an npm package: listed for the licence page, never in the lockfile.
      { name: 'Chromium', version: null },
    ]);
    this.writeJson('package-lock.json', { packages: { '': { version: '0.0.0' } } });
    this.setVersions({ electron: '45.0.0', react: '18.3.1', 'better-sqlite3': '13.0.3', eslint: '9.39.5' });
    this.setVersion(version);
    this.commit('initial');
  }

  /** Installed versions, as the lockfile records them. */
  setVersions(versions: Versions): void {
    const lock = this.readJson<Lock>('package-lock.json');
    for (const [name, version] of Object.entries(versions)) lock.packages[`node_modules/${name}`] = { version };
    this.writeJson('package-lock.json', lock);
  }

  /** What `npm version` writes: package.json and the lockfile's root entry. */
  setVersion(version: string): void {
    this.writeJson('package.json', { name: 'fixture', version });
    const lock = this.readJson<Lock>('package-lock.json');
    lock.version = version;
    lock.packages[''] = { version };
    this.writeJson('package-lock.json', lock);
  }

  /** A release: the version bump commit, dated `daysAgo` days back, and its tag. */
  release(version: string, daysAgo = 30): this {
    this.setVersion(version);
    this.commit(`chore(release): ${version}`, daysAgo);
    this.git(['tag', `v${version}`]);
    return this;
  }

  /** A dependency update merged since. */
  bump(versions: Versions): this {
    this.setVersions(versions);
    this.commit(`bump ${Object.keys(versions).join(', ')}`);
    return this;
  }

  ask(opts: { args?: string[]; minDays?: string } = {}): Answer {
    const env: Record<string, string> = {};
    if (opts.minDays !== undefined) env.RELEASE_MIN_DAYS = opts.minDays;
    const { status, said, written } = runNodeScript('release-due.mjs', opts.args ?? [], { cwd: this.dir, env });
    return {
      status,
      due: /^due=true$/m.test(written),
      next: /^next=(.+)$/m.exec(written)?.[1] ?? null,
      notes: /notes<<RELEASE_NOTES_EOF\n([\s\S]*?)\nRELEASE_NOTES_EOF/.exec(written)?.[1] ?? '',
      said,
      written,
    };
  }
}

type Answer = {
  status: number | null;
  due: boolean;
  next: string | null;
  notes: string;
  said: string;
  written: string;
};

describe('release-due: what triggers an automatic release', () => {
  it('nothing, when nothing changed since the last release', () => {
    const answer = new Repo().release('1.4.2').ask();
    expect(answer.status).toBe(0);
    expect(answer.due).toBe(false);
    expect(answer.written).toBe('due=false\n');
    expect(answer.said).toContain('nothing that ships changed');
  });

  it('nothing, when only a build tool changed: none of it is in the product', () => {
    const answer = new Repo().release('1.4.2').bump({ eslint: '10.0.0' }).ask();
    expect(answer.due).toBe(false);
  });

  it('an Electron patch release does: that is how Chromium fixes reach users', () => {
    const answer = new Repo().release('1.4.2').bump({ electron: '45.0.1' }).ask();
    expect(answer.due).toBe(true);
    expect(answer.notes).toBe('- `electron` 45.0.0 → 45.0.1');
  });

  it('so does a runtime dependency, and a dev dependency compiled into the bundles', () => {
    expect(new Repo().release('1.4.2').bump({ 'better-sqlite3': '13.0.4' }).ask().due).toBe(true);
    expect(new Repo().release('1.4.2').bump({ react: '18.3.2' }).ask().due).toBe(true);
  });

  it('lists everything that changed, Electron first', () => {
    const answer = new Repo().release('1.4.2').bump({ react: '18.3.2', electron: '45.1.0', eslint: '10.0.0' }).ask();
    expect(answer.notes.split('\n')).toEqual(['- `electron` 45.0.0 → 45.1.0', '- `react` 18.3.1 → 18.3.2']);
  });

  it('compares with the LAST release, not with an older one', () => {
    const repo = new Repo().release('1.4.2', 40).bump({ electron: '45.0.1' }).release('1.4.3', 20);
    expect(repo.ask().due).toBe(false);
    expect(repo.bump({ electron: '45.0.2' }).ask().notes).toBe('- `electron` 45.0.1 → 45.0.2');
  });
});

describe('release-due: the version it picks', () => {
  it('only ever moves the last number', () => {
    expect(new Repo().release('1.4.2').bump({ electron: '45.0.1' }).ask().next).toBe('1.4.3');
    expect(new Repo('0.9.1').release('0.9.1').bump({ electron: '45.0.1' }).ask().next).toBe('0.9.2');
    expect(new Repo('2.0.9').release('2.0.9').bump({ electron: '45.0.1' }).ask().next).toBe('2.0.10');
  });

  it('even for a new Electron MAJOR: the size of the update does not change the rule', () => {
    const answer = new Repo('0.9.1').release('0.9.1').bump({ electron: '46.0.0' }).ask();
    expect(answer.due).toBe(true);
    expect(answer.next).toBe('0.9.2');
  });

  it('continues from a release the maintainer cut by hand', () => {
    const repo = new Repo().release('1.4.2', 40).release('1.5.0', 20).bump({ electron: '45.0.1' });
    expect(repo.ask().next).toBe('1.5.1');
  });
});

describe('release-due: when it must stand aside', () => {
  it('a version bumped by hand and not tagged yet is a manual release in progress', () => {
    const repo = new Repo().release('1.4.2').bump({ electron: '45.0.1' });
    repo.setVersion('1.5.0');
    repo.commit('chore(release): 1.5.0');
    const answer = repo.ask();
    expect(answer.due).toBe(false);
    expect(answer.said).toContain('a manual release is in progress');
  });

  it('a prerelease version is not something to increment blindly', () => {
    const repo = new Repo().release('1.4.2').bump({ electron: '45.0.1' });
    repo.setVersion('1.5.0-beta.1');
    repo.commit('beta');
    repo.git(['tag', 'v1.5.0-beta.1']);
    expect(repo.ask().due).toBe(false);
  });

  it('no release tag at all (a shallow clone) is a doubt, and a doubt is "no"', () => {
    const answer = new Repo().bump({ electron: '45.0.1' }).ask();
    expect(answer.status).toBe(0);
    expect(answer.due).toBe(false);
  });

  it('unreadable inputs are a doubt too, never a crash that looks like a decision', () => {
    const repo = new Repo().release('1.4.2').bump({ electron: '45.0.1' });
    fs.writeFileSync(path.join(repo.dir, 'src/shared/credits.generated.json'), '{ not json');
    repo.commit('corrupt credits');
    const answer = repo.ask();
    expect(answer.status).toBe(0);
    expect(answer.due).toBe(false);
    expect(answer.said).toContain('could not decide');
  });
});

describe('release-due: releases are spaced', () => {
  const pending = (daysAgo: number) => new Repo().release('1.4.2', daysAgo).bump({ electron: '45.0.1' });

  it('holds what is waiting while the last release is too recent', () => {
    for (const daysAgo of [0.2, 1, 3.9]) {
      const answer = pending(daysAgo).ask({ minDays: '4' });
      expect(answer.due, `${daysAgo} days`).toBe(false);
      expect(answer.said, `${daysAgo} days`).toContain('at least 4 days apart');
    }
  });

  it('lets it go once the spacing has passed, with everything that piled up', () => {
    const repo = pending(4.1).bump({ react: '18.3.2' });
    const answer = repo.ask({ minDays: '4' });
    expect(answer.due).toBe(true);
    expect(answer.notes.split('\n')).toHaveLength(2);
  });

  it('follows the configured number of days', () => {
    expect(pending(3.2).ask({ minDays: '3' }).due).toBe(true);
    expect(pending(3.2).ask({ minDays: '7' }).due).toBe(false);
  });

  it('does not apply to a manual run (the workflow passes 0) nor outside CI (unset)', () => {
    expect(pending(0.2).ask({ minDays: '0' }).due).toBe(true);
    expect(pending(0.2).ask().due).toBe(true);
  });

  it('is not jumped by --force on the schedule: forcing is about "nothing changed"', () => {
    expect(pending(1).ask({ minDays: '4', args: ['--force'] }).due).toBe(false);
  });

  it('--force releases when nothing changed, and says so in the notes', () => {
    const answer = new Repo().release('1.4.2').ask({ args: ['--force'] });
    expect(answer.due).toBe(true);
    expect(answer.next).toBe('1.4.3');
    expect(answer.notes).toContain('forced');
  });

  it('a spacing that is not a number stops the job loudly, in either direction', () => {
    // "not due" would look like a quiet day forever; ignoring it would
    // release every day. Both are wrong silently: fail the run instead.
    for (const minDays of ['abc', '-1', '4 days']) {
      const answer = pending(10).ask({ minDays });
      expect(answer.status, minDays).toBe(1);
      expect(answer.written, minDays).toBe('');
      expect(answer.said, minDays).toContain('RELEASE_MIN_DAYS');
    }
  });
});
