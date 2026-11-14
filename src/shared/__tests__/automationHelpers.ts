/**
 * Shared by the automation*.test.ts suites, which test the release and
 * upgrade automation under .github/workflows and scripts/ (described in
 * .github/AUTOMATION.md). Not a test file itself.
 *
 * Two ways of testing a workflow, both without a YAML library (none is a
 * dependency of this project):
 *  - its text, like ipcContract.test.ts reads the sources: which tools an
 *    agent gets, which step holds a token;
 *  - its behaviour: the bash of a step is extracted and RUN, in a throwaway
 *    git repository, with `gh`, `npm`... replaced by scripts that record
 *    their calls (runStep). What merges, what is tagged, what is held is
 *    decided by that bash, so that is what is exercised.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const ROOT = path.resolve(__dirname, '..', '..', '..');

// ---------------------------------------------------------------- reading

/** A repository file's text, with \n line endings whatever the checkout did. */
export function readRepoFile(relative: string): string {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8').replace(/\r\n/g, '\n');
}

export function readWorkflow(name: string): string {
  return readRepoFile(`.github/workflows/${name}`);
}

const indentOf = (line: string): number => line.length - line.trimStart().length;

/**
 * The text of one step, from its `- ` line to the line before the next step.
 * The step is the one holding the line `marker` (`id: x`, `name: y`).
 */
export function stepBlock(workflow: string, marker: string): string {
  const lines = workflow.split('\n');
  const at = lines.findIndex((l) => l.trim() === marker || l.trim() === `- ${marker}`);
  if (at === -1) throw new Error(`step "${marker}" not found`);
  let start = at;
  while (start >= 0 && !lines[start].trimStart().startsWith('- ')) start -= 1;
  if (start < 0) throw new Error(`step "${marker}" has no "- " line`);
  const dash = indentOf(lines[start]);
  let end = start + 1;
  while (end < lines.length && (lines[end].trim() === '' || indentOf(lines[end]) > dash)) end += 1;
  return lines.slice(start, end).join('\n');
}

/** Every script a piece of workflow runs: `run: |` blocks and one-line `run:`. */
export function runScripts(text: string): string[] {
  const lines = text.split('\n');
  const scripts: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^(\s*)(?:- )?run: (.*)$/.exec(lines[i]);
    if (!match) continue;
    if (match[2].trim() !== '|') {
      scripts.push(match[2]);
      continue;
    }
    const base = indentOf(lines[i]);
    const body: string[] = [];
    for (i += 1; i < lines.length && (lines[i].trim() === '' || indentOf(lines[i]) > base); i += 1) body.push(lines[i]);
    i -= 1;
    const dedent = Math.min(...body.filter((l) => l.trim() !== '').map(indentOf));
    scripts.push(body.map((l) => l.slice(dedent)).join('\n'));
  }
  return scripts;
}

/** The script of the step holding `marker`, as bash receives it. */
export function stepRun(workflow: string, marker: string): string {
  const scripts = runScripts(stepBlock(workflow, marker));
  if (scripts.length !== 1) throw new Error(`step "${marker}" has ${scripts.length} run scripts`);
  return scripts[0];
}

// -------------------------------------------------------------- processes

/**
 * Settings forced on every git the tests start, so a developer's global
 * configuration can neither change the outcome (line endings) nor block it
 * (a signing prompt).
 */
const GIT_SETTINGS: Record<string, string> = {
  'core.autocrlf': 'false',
  'commit.gpgsign': 'false',
  'tag.gpgsign': 'false',
  'init.defaultBranch': 'main',
};

/**
 * process.env for a child process: without what the automation scripts react
 * to, and without any GIT_* variable. Run from a git hook, the tests inherit
 * GIT_DIR and GIT_INDEX_FILE, which would point the fixtures' git commands at
 * the developer's real repository.
 */
export function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_') || key.startsWith('GITHUB_') || key === 'RELEASE_MIN_DAYS' || key === 'RUNNER_TEMP') {
      delete env[key];
    }
  }
  const settings = Object.entries(GIT_SETTINGS);
  env.GIT_CONFIG_COUNT = String(settings.length);
  settings.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return { ...env, ...extra };
}

/** A throwaway git repository. */
export class GitFixture {
  readonly dir: string;

  constructor(parent: string) {
    this.dir = fs.mkdtempSync(path.join(parent, 'repo-'));
    this.git(['init', '-q', '.']);
  }

  git(args: string[], env: Record<string, string> = {}): string {
    return execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', ...args], {
      cwd: this.dir,
      encoding: 'utf8',
      env: cleanEnv(env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  writeText(file: string, text: string): void {
    const full = path.join(this.dir, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  }

  writeJson(file: string, json: unknown): void {
    this.writeText(file, `${JSON.stringify(json, null, 2)}\n`);
  }

  readJson<T>(file: string): T {
    return JSON.parse(fs.readFileSync(path.join(this.dir, file), 'utf8')) as T;
  }

  remove(file: string): void {
    fs.rmSync(path.join(this.dir, file));
  }

  /** Commits everything, dated `daysAgo` days back. Returns the commit. */
  commit(message: string, daysAgo = 0): string {
    const when = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
    this.git(['add', '-A']);
    // --allow-empty: a commit that changes no file is still a commit a tag
    // can point at.
    this.git(['commit', '-q', '--allow-empty', '-m', message], { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when });
    return this.git(['rev-parse', 'HEAD']).trim();
  }
}

/** What a node script said, and what it wrote to $GITHUB_OUTPUT. */
export type ScriptAnswer = { status: number | null; said: string; written: string };

/** Runs one of scripts/*.mjs the way a workflow does. */
export function runNodeScript(
  script: string,
  args: string[],
  opts: { cwd: string; env?: Record<string, string> },
): ScriptAnswer {
  const output = path.join(opts.cwd, '.github-output');
  fs.rmSync(output, { force: true });
  const res = spawnSync(process.execPath, [path.join(ROOT, 'scripts', script), ...args], {
    cwd: opts.cwd,
    encoding: 'utf8',
    env: cleanEnv({ GITHUB_OUTPUT: output, ...opts.env }),
  });
  const written = fs.existsSync(output) ? fs.readFileSync(output, 'utf8') : '';
  fs.rmSync(output, { force: true });
  return { status: res.status, said: `${res.stdout}${res.stderr}`, written };
}

// ------------------------------------------------------------------- bash

/** Forward slashes: a path both bash and Windows programs accept. */
const slashed = (p: string): string => p.replace(/\\/g, '/');

/**
 * The bash that runs workflow steps. On Windows that is Git's, found next to
 * git itself: a bare `bash` on the PATH may be WSL's, which sees none of the
 * paths used here.
 */
function findBash(): string | null {
  try {
    if (process.platform !== 'win32') {
      return spawnSync('bash', ['--version']).status === 0 ? 'bash' : null;
    }
    const execPath = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim();
    const gitRoot = /^(.*?)[\\/](?:mingw64|mingw32|clangarm64|usr)[\\/]/.exec(execPath)?.[1];
    if (!gitRoot) return null;
    return [path.join(gitRoot, 'bin', 'bash.exe'), path.join(gitRoot, 'usr', 'bin', 'bash.exe')].find((p) => fs.existsSync(p)) ?? null;
  } catch {
    return null;
  }
}

export const BASH = findBash();

/**
 * Whether the suites that run workflow steps can run here. Skipping is for a
 * developer machine without bash only: CI always has one, and there a missing
 * bash must fail, not make the most important tests vanish quietly.
 */
export function canRunSteps(): boolean {
  if (BASH) return true;
  if (process.env.CI) throw new Error('bash was not found: the workflow step tests cannot be skipped in CI');
  return false;
}

/** Where the real git is, as that bash sees it. */
let realGit: string | undefined;
function realGitPath(): string {
  if (realGit === undefined) {
    realGit = execFileSync(BASH as string, ['--noprofile', '--norc', '-c', 'command -v git'], {
      encoding: 'utf8',
      env: cleanEnv(),
    }).trim();
  }
  return realGit;
}

/**
 * A stand-in for git inside a step: everything is the real git, except what
 * would reach the network. A push is recorded, a fetch does nothing;
 * `ls-remote` answers from $FAKE_REMOTE_BRANCHES (space-separated names).
 */
export const FAKE_GIT = `
for arg in "$@"; do
  case "$arg" in
    push)
      echo "git $*" >> "$CALLS"
      exit 0 ;;
    fetch)
      exit 0 ;;
    ls-remote)
      for last in "$@"; do :; done
      case " \${FAKE_REMOTE_BRANCHES:-} " in *" $last "*) exit 0 ;; *) exit 2 ;; esac ;;
  esac
done
exec "$REAL_GIT" "$@"
`;

export type StepResult = {
  status: number | null;
  /** stdout and stderr together. */
  said: string;
  /** $GITHUB_OUTPUT, as written. */
  written: string;
  /** Its `key=value` lines. */
  outputs: Record<string, string>;
  /** $GITHUB_STEP_SUMMARY. */
  summary: string;
  /** One line per recorded call of a stand-in command. */
  calls: string[];
  /** $RUNNER_TEMP, to read the files the step left there. */
  temp: string;
};

/**
 * Runs a step's script the way GitHub does (`bash --noprofile --norc -eo
 * pipefail`), with `fakes` first on the PATH: command name -> bash body. A
 * stand-in appends to "$CALLS" what it wants recorded.
 */
export function runStep(opts: {
  script: string;
  cwd: string;
  env?: Record<string, string>;
  fakes?: Record<string, string>;
  /** Files an earlier step left in $RUNNER_TEMP: name -> content. */
  tempFiles?: Record<string, string>;
}): Promise<StepResult> {
  if (!BASH) throw new Error('runStep needs bash');
  const run = fs.mkdtempSync(path.join(opts.cwd, '..', 'step-'));
  const bin = path.join(run, 'bin');
  const temp = path.join(run, 'temp');
  fs.mkdirSync(bin);
  fs.mkdirSync(temp);
  for (const [name, content] of Object.entries(opts.tempFiles ?? {})) fs.writeFileSync(path.join(temp, name), content);
  for (const [name, body] of Object.entries(opts.fakes ?? {})) {
    const file = path.join(bin, name);
    fs.writeFileSync(file, `#!/usr/bin/env bash\n${body}`);
    fs.chmodSync(file, 0o755);
  }
  // The stand-ins go first on the PATH from INSIDE the script: Git for
  // Windows' bash puts its own directories first when it starts.
  const prelude = 'PATH="$(cygpath -u "$FAKE_BIN" 2> /dev/null || printf \'%s\' "$FAKE_BIN"):$PATH"\n';
  const file = path.join(run, 'step.sh');
  fs.writeFileSync(file, prelude + opts.script);

  const paths = {
    calls: path.join(run, 'calls.log'),
    output: path.join(run, 'output'),
    summary: path.join(run, 'summary'),
  };
  const env = cleanEnv({
    FAKE_BIN: slashed(bin),
    REAL_GIT: realGitPath(),
    CALLS: slashed(paths.calls),
    RUNNER_TEMP: slashed(temp),
    GITHUB_OUTPUT: slashed(paths.output),
    GITHUB_STEP_SUMMARY: slashed(paths.summary),
    GITHUB_REPOSITORY: 'owner/repo',
    GITHUB_REPOSITORY_OWNER: 'owner',
    ...opts.env,
  });
  const read = (p: string): string => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');

  return new Promise((resolve, reject) => {
    const child = spawn(BASH as string, ['--noprofile', '--norc', '-eo', 'pipefail', slashed(file)], {
      cwd: opts.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let said = '';
    child.stdout.on('data', (chunk: Buffer) => (said += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (said += chunk.toString()));
    child.on('error', reject);
    child.on('close', (status) => {
      const written = read(paths.output);
      const outputs: Record<string, string> = {};
      for (const line of written.split('\n')) {
        const eq = line.indexOf('=');
        if (eq > 0) outputs[line.slice(0, eq)] = line.slice(eq + 1);
      }
      resolve({
        status,
        said,
        written,
        outputs,
        summary: read(paths.summary),
        calls: read(paths.calls).split('\n').filter(Boolean),
        temp,
      });
    });
  });
}
