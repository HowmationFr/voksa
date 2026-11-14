// Is an automatic patch release due? Asked once a day by
// .github/workflows/auto-release.yml.
//
// Security fixes reach `main` on their own (Dependabot + auto-merge), but a
// fix on `main` protects nobody: users run the last RELEASE. A release is due
// when something that ships INSIDE a build changed version since the last
// release tag: Electron first of all (Chromium fixes only travel through its
// patch releases), the runtime dependencies, and the dev dependencies that are
// compiled into the bundles.
//
// "What ships" is not guessed here: it is the list the project already
// maintains for its licence page, src/shared/credits.generated.json. A bump of
// a build tool (eslint, vitest, vite...) changes nothing in the product and
// triggers nothing.
//
// The release ships everything on `main`, not only the dependency change:
// `main` only receives pull requests that passed the full CI, so it is always
// releasable.
//
// Releases are SPACED: with RELEASE_MIN_DAYS set (auto-release.yml sets it on
// its daily schedule), nothing is due until that many days have passed since
// the last release, however much changed. Electron publishes a patch every
// two or three days; shipping each one would have users download an update
// every other day. What piles up meanwhile goes out together in the next
// release. The clock is the last release tag's commit date.
//
// Usage: [RELEASE_MIN_DAYS=4] node scripts/release-due.mjs [--force]
// Prints its reasoning and, under GitHub Actions, writes to $GITHUB_OUTPUT:
//   due=true|false   next=X.Y.Z   notes<<EOF (markdown list of what changed)
// Fails CLOSED: any doubt (no tag, a version bump already in progress, a
// prerelease version, git or JSON errors) answers due=false with the reason.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const force = process.argv.includes('--force');

// The spacing, in days. A value that is not a number is a configuration
// mistake (the AUTO_RELEASE_MIN_DAYS repository variable): it must stop the
// job loudly. Answering "not due" would look like a quiet day, every day,
// while fixes pile up unreleased; ignoring it would release every day.
const minDaysRaw = (process.env.RELEASE_MIN_DAYS ?? '').trim();
const minDays = minDaysRaw === '' ? 0 : Number(minDaysRaw);
if (!Number.isFinite(minDays) || minDays < 0) {
  console.error(`RELEASE_MIN_DAYS must be a number of days, got "${minDaysRaw}".`);
  process.exit(1);
}
const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const readJsonAt = (ref, file) => JSON.parse(git('show', `${ref}:${file}`));

/** Top-level installed version of a package in a lockfile, or null. */
const lockedVersion = (lock, name) => lock.packages?.[`node_modules/${name}`]?.version ?? null;

function decide() {
  let lastTag;
  try {
    lastTag = git('describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*', 'HEAD');
  } catch {
    return { due: false, reason: 'no release tag is reachable from HEAD (shallow clone?)' };
  }

  const pkg = readJsonAt('HEAD', 'package.json');
  const version = String(pkg.version ?? '');
  const parts = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!parts) return { due: false, reason: `version "${version}" is not a plain X.Y.Z` };
  if (`v${version}` !== lastTag) {
    // package.json is ahead of the last tag: someone bumped the version by
    // hand and has not tagged it yet. That release is theirs to finish.
    return {
      due: false,
      reason: `package.json says ${version} but the last tag is ${lastTag}: a manual release is in progress`,
    };
  }
  const next = `${parts[1]}.${parts[2]}.${Number(parts[3]) + 1}`;

  const shipped = readJsonAt('HEAD', 'src/shared/credits.generated.json')
    .filter((entry) => entry && typeof entry.name === 'string' && entry.version)
    .map((entry) => entry.name);
  const before = readJsonAt(lastTag, 'package-lock.json');
  const after = readJsonAt('HEAD', 'package-lock.json');
  const changes = [];
  for (const name of [...new Set(shipped)].sort()) {
    const from = lockedVersion(before, name);
    const to = lockedVersion(after, name);
    if (to && from !== to) changes.push({ name, from, to });
  }
  // Electron leads: it is the reason this job exists.
  changes.sort((a, b) => (b.name === 'electron') - (a.name === 'electron'));

  if (changes.length === 0 && !force) {
    return { due: false, reason: `nothing that ships changed version since ${lastTag}` };
  }
  const notes = changes.length
    ? changes.map((c) => `- \`${c.name}\` ${c.from ?? '(new)'} → ${c.to}`).join('\n')
    : '- (forced: no shipped dependency changed)';

  // Something is waiting to ship: is it too soon after the last release?
  if (minDays > 0) {
    const releasedAt = Number(git('log', '-1', '--format=%ct', lastTag)) * 1000;
    const ageDays = (Date.now() - releasedAt) / 86_400_000;
    if (ageDays < minDays) {
      const notBefore = new Date(releasedAt + minDays * 86_400_000).toISOString().slice(0, 16).replace('T', ' ');
      return {
        due: false,
        reason:
          `${lastTag} went out ${ageDays.toFixed(1)} days ago and releases are at least ${minDays} days apart: ` +
          `${changes.length} change(s) wait until ${notBefore} UTC`,
      };
    }
  }

  return {
    due: true,
    next,
    notes,
    reason: changes.length
      ? `${changes.length} shipped package(s) changed since ${lastTag}`
      : `forced, although nothing that ships changed since ${lastTag}`,
  };
}

let result;
try {
  result = decide();
} catch (err) {
  result = { due: false, reason: `could not decide: ${err instanceof Error ? err.message : err}` };
}

console.log(`release due: ${result.due} (${result.reason})`);
if (result.due) console.log(`next version: ${result.next}\n${result.notes}`);

if (process.env.GITHUB_OUTPUT) {
  const lines = [`due=${result.due}`];
  if (result.due) lines.push(`next=${result.next}`, `notes<<RELEASE_NOTES_EOF\n${result.notes}\nRELEASE_NOTES_EOF`);
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
}
