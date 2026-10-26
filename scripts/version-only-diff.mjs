// CI scope probe: is the change between two commits NOTHING but a version
// bump? A release PR ("npm version" on package.json + package-lock.json)
// ships byte-for-byte the code its base already proved on all three OSes, and
// the tag build that follows re-packages it anyway; re-running the 3-OS
// build + smoke + packaging on it only makes the release wait.
//
// Usage: node scripts/version-only-diff.mjs <base> <head>
// Prints and, under GitHub Actions, writes `version_only=true|false` to
// $GITHUB_OUTPUT. Fails CLOSED: any doubt (other files touched, a field other
// than "version" changed, a file added or removed, git or JSON errors) answers
// false, so the full pipeline runs.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

const [base, head] = process.argv.slice(2);

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });

// The only places "npm version" writes the version: the root "version" of
// both files, and the root package entry of the lockfile.
function withoutVersion(file, json) {
  delete json.version;
  if (file === 'package-lock.json' && json.packages?.['']) delete json.packages[''].version;
  return json;
}

function versionOnly() {
  if (!base || !head) return false;
  const changed = git('diff', '--name-only', base, head).split('\n').filter(Boolean);
  if (changed.length === 0) return false;
  if (!changed.every((f) => f === 'package.json' || f === 'package-lock.json')) return false;
  return changed.every((file) => {
    const before = JSON.parse(git('show', `${base}:${file}`));
    const after = JSON.parse(git('show', `${head}:${file}`));
    return isDeepStrictEqual(withoutVersion(file, before), withoutVersion(file, after));
  });
}

let result = false;
try {
  result = versionOnly();
} catch (err) {
  console.log(`Scope probe failed, running the full pipeline: ${err.message}`);
}

console.log(`version_only=${result}`);
if (process.env.GITHUB_OUTPUT)
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `version_only=${result}\n`);
