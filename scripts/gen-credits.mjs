#!/usr/bin/env node
/**
 * Generates src/shared/credits.generated.json: every open-source project that
 * ends up INSIDE a Voksa build, with its licence text.
 *
 * "Inside a build" is the whole point, and it is not the same list as
 * package.json's `dependencies`:
 *  - runtime deps ship as-is in app.asar (better-sqlite3, electron-updater...);
 *  - some devDependencies are COMPILED INTO the shipped bundles (React, zustand,
 *    lucide-react, the Inter font files, Tailwind's preflight CSS). They are dev
 *    deps only because they are not `require`d at runtime, but their code is in
 *    the product and their licences must be honoured;
 *  - Electron, and through it Chromium and Node.js, are the runtime itself.
 *
 * Build tools that leave no trace in the artefact (vite, esbuild, eslint,
 * vitest...) are deliberately NOT credited: nothing of theirs is distributed.
 *
 * Run it with `npm run gen:credits` after touching dependencies. The output is
 * committed so a plain `npm run build` never depends on the npm tree being in
 * any particular state.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'src', 'shared', 'credits.generated.json');

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

/**
 * devDependencies bundled INTO dist-ui by Vite. Their runtime dependencies are
 * bundled too (react pulls scheduler, loose-envify...), so they are walked
 * transitively like a runtime dependency.
 */
const BUNDLED_DEV = ['react', 'react-dom', 'zustand', 'lucide-react'];

/**
 * Shipped, but their own dependency tree is NOT: only build-time machinery
 * lives under them and none of it reaches the artefact. Crediting postcss and
 * chokidar because Tailwind needs them to compile would be padding, not
 * attribution: what ships is Tailwind's preflight CSS, Electron's binary and
 * the Inter woff2 files, nothing under them.
 */
const SELF_ONLY = [
  'electron', // the runtime itself (and, through it, Chromium and Node.js)
  'tailwindcss', // its preflight/base CSS is emitted into our stylesheet
  '@fontsource-variable/inter', // woff2 files are served from dist-ui/assets
];

/**
 * Projects we ship but that are not npm packages, so nothing local describes
 * them. We do NOT transcribe their licence text (a hand-copied licence is a
 * licence you can get wrong): the page links to the canonical file instead.
 */
const NON_NPM = [
  {
    name: 'Chromium',
    version: null,
    license: 'BSD-3-Clause',
    homepage: 'https://www.chromium.org/Home/',
    licenseUrl: 'https://chromium.googlesource.com/chromium/src/+/refs/heads/main/LICENSE',
    text: null,
  },
  {
    name: 'Node.js',
    version: null,
    license: 'MIT',
    homepage: 'https://nodejs.org/',
    licenseUrl: 'https://github.com/nodejs/node/blob/main/LICENSE',
    text: null,
  },
];

/** Filenames a package may use for its licence, in order of preference. */
const LICENSE_FILES = [
  'LICENSE',
  'LICENSE.md',
  'LICENSE.txt',
  'LICENCE',
  'LICENCE.md',
  'LICENCE.txt',
  'license',
  'license.md',
  'License',
  'LICENSE-MIT',
  'LICENSE-MIT.txt',
  'COPYING',
  'COPYING.md',
];

/** Node's resolution order: nearest node_modules, then up to the root. */
function resolvePackageDir(name, fromDir) {
  let cur = fromDir;
  for (;;) {
    const candidate = path.join(cur, 'node_modules', name, 'package.json');
    if (fs.existsSync(candidate)) return path.dirname(candidate);
    const up = path.dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
}

function readLicenseText(dir) {
  for (const file of LICENSE_FILES) {
    const p = path.join(dir, file);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return fs.readFileSync(p, 'utf8').trim();
  }
  // Last resort: anything that looks like a licence file (LICENSE-APACHE, ...).
  const found = fs
    .readdirSync(dir)
    .find((f) => /^(licen[cs]e|copying)/i.test(f) && fs.statSync(path.join(dir, f)).isFile());
  return found ? fs.readFileSync(path.join(dir, found), 'utf8').trim() : null;
}

/** package.json's `license` has had three shapes over the years. */
function readLicenseId(json) {
  if (typeof json.license === 'string') return json.license;
  if (json.license && typeof json.license.type === 'string') return json.license.type;
  if (Array.isArray(json.licenses) && json.licenses[0]?.type) return json.licenses[0].type;
  return null;
}

function readHomepage(json) {
  if (typeof json.homepage === 'string') return json.homepage;
  const repo = typeof json.repository === 'string' ? json.repository : json.repository?.url;
  if (!repo) return null;
  return repo
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/^ssh:\/\/git@/, 'https://')
    .replace(/\.git$/, '');
}

/** Canonical text of a plain SPDX id ("MIT"); null for an expression or junk. */
function spdxUrl(id) {
  if (!id || !/^[A-Za-z0-9.+-]+$/.test(id)) return null;
  return `https://spdx.org/licenses/${id}.html`;
}

const collected = new Map();
const problems = [];

function walk(name, fromDir, { deep }) {
  if (collected.has(name)) return;
  const dir = resolvePackageDir(name, fromDir);
  if (!dir) {
    problems.push(`${name}: not installed (cannot credit what we cannot read)`);
    return;
  }
  const json = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const license = readLicenseId(json);
  const text = readLicenseText(dir);
  if (!license && !text) problems.push(`${name}: no licence id and no licence file`);

  collected.set(name, {
    name,
    version: json.version ?? null,
    license: license ?? 'Unknown',
    homepage: readHomepage(json),
    // A handful of packages declare a licence in package.json but ship no
    // licence file (dlv, keyv, lazy-val...). Rather than leave the page with
    // nothing to show, point at the canonical SPDX text of the licence they
    // declared. We do not transcribe it: we would get someone's copyright line
    // wrong, and a wrong copyright line is worse than a link.
    licenseUrl: text ? null : spdxUrl(license),
    text,
  });

  if (!deep) return;
  for (const dep of Object.keys(json.dependencies ?? {})) walk(dep, dir, { deep: true });
}

for (const name of [...Object.keys(pkg.dependencies ?? {}), ...BUNDLED_DEV]) {
  walk(name, ROOT, { deep: true });
}
for (const name of SELF_ONLY) walk(name, ROOT, { deep: false });

const entries = [...collected.values(), ...NON_NPM].sort((a, b) =>
  a.name.toLowerCase().localeCompare(b.name.toLowerCase(), 'en'),
);

fs.writeFileSync(OUT, `${JSON.stringify(entries, null, 2)}\n`, 'utf8');

const bytes = entries.reduce((n, e) => n + (e.text?.length ?? 0), 0);
console.log(`[credits] ${entries.length} projects, ${Math.round(bytes / 1024)} KB of licence text`);
console.log(`[credits] wrote ${path.relative(ROOT, OUT)}`);
if (problems.length) {
  // Not fatal: a missing licence file is common (the id in package.json is the
  // legal statement). Printed so it is a decision, not an oversight.
  console.log(`[credits] ${problems.length} package(s) with no licence file:`);
  for (const p of problems) console.log(`[credits]   - ${p}`);
}
