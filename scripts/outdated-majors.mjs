// Which direct dependencies have a newer MAJOR version? Asked once a week by
// .github/workflows/dependency-majors.yml, which hands the first one to the
// upgrade agent.
//
// Dependabot ignores major versions on purpose (see dependabot.yml): a major
// usually needs code changes, which is the agent's job, not a version bump's.
// Patch and minor versions are Dependabot's and are not looked at here.
//
// Prints one candidate per line, tab-separated, in the order they should be
// attempted:   name <TAB> current major <TAB> latest major <TAB> latest version
// What ships inside a build comes first (the list the licence page is built
// from, src/shared/credits.generated.json: runtime dependencies and the dev
// dependencies compiled into the bundles), then the build and test tools;
// package.json order within each group.
//
// Not candidates, by design:
//   - electron: it has its own workflow, playbook and tracking issue;
//   - the two extension libraries: pinned and patched (patches/), a bump
//     means porting the patches by hand;
//   - @types/* packages: they describe another package and move WITH it (the
//     agent bumps @types/react when it upgrades react). On their own they
//     would be upgraded past the code they describe: @types/node, above all,
//     must match the Node.js that Electron bundles, not the latest Node.
//
// Reads the public npm registry, nothing else. A package the registry cannot
// answer for is skipped with a warning on stderr: one unreachable package
// must not hide the others.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export const NOT_CANDIDATES = new Set(['electron', 'electron-chrome-extensions', 'electron-chrome-web-store']);

const major = (version) => Number(String(version).split('.')[0]);

/** Direct dependencies that may be upgraded, shipped ones first, order kept. */
export function candidateNames(pkg, shippedNames) {
  const shipped = new Set(shippedNames);
  const direct = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})].filter(
    (name) => !NOT_CANDIDATES.has(name) && !name.startsWith('@types/'),
  );
  return [...direct.filter((name) => shipped.has(name)), ...direct.filter((name) => !shipped.has(name))];
}

/**
 * The candidates, in order. `latestByName` maps a package to its latest
 * published version; a package it has no answer for is left out. Pure: the
 * registry is the caller's business, which is what makes this testable.
 */
export function outdatedMajors({ pkg, lock, shippedNames, latestByName }) {
  const out = [];
  for (const name of candidateNames(pkg, shippedNames)) {
    const installed = lock.packages?.[`node_modules/${name}`]?.version;
    const latest = latestByName[name];
    if (!installed || typeof latest !== 'string') continue;
    const from = major(installed);
    const to = major(latest);
    if (Number.isInteger(from) && Number.isInteger(to) && to > from) out.push({ name, from, to, latest });
  }
  return out;
}

/** One candidate as one output line: the format dependency-majors.yml reads. */
export const formatCandidate = (c) => [c.name, c.from, c.to, c.latest].join('\t');

async function latestVersion(name) {
  // The abbreviated document: dist-tags without every version's metadata.
  const res = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2F')}`, {
    headers: { accept: 'application/vnd.npm.install-v1+json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const latest = (await res.json())['dist-tags']?.latest;
  if (typeof latest !== 'string') throw new Error('no "latest" dist-tag');
  return latest;
}

async function main() {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
  const shippedNames = JSON.parse(fs.readFileSync('src/shared/credits.generated.json', 'utf8')).map(
    (entry) => entry?.name,
  );
  const latestByName = {};
  for (const name of candidateNames(pkg, shippedNames)) {
    try {
      latestByName[name] = await latestVersion(name);
    } catch (err) {
      console.error(`skipped ${name}: ${err instanceof Error ? err.message : err}`);
    }
  }
  for (const c of outdatedMajors({ pkg, lock, shippedNames, latestByName })) {
    console.log(formatCandidate(c));
  }
}

// Only when run as a script: the tests import the functions above.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
