// CI guard for the electron-builder output (run after `electron-builder`):
// every packaged app under build/ must ship what it needs and nothing else.
//   - app.asar holds only the app (dist-electron, dist-ui, package.json, the
//     runtime icon) and node_modules: a bad `files` pattern once shipped the
//     whole repository (sources, scripts, patches) without failing anything;
//   - better-sqlite3 has EXACTLY its target's prebuild unpacked
//     (<platform>-<arch>.node), and no node-gyp leftovers: a missing prebuild
//     only shows up at boot, on the one platform CI never boots packaged.
//
// Usage: node scripts/check-packaged.mjs [buildDir]   (default: build)
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const asar = require('@electron/asar'); // ships with electron-builder

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = path.resolve(root, process.argv[2] ?? 'build');

const ASAR_TOP_LEVEL = new Set(['dist-electron', 'dist-ui', 'node_modules', 'package.json', 'resources']);
const ASAR_RESOURCES = new Set(['resources', 'resources/icon.png']);
/** What the app cannot boot (or show its window icon) without. */
const ASAR_REQUIRED = [
  'package.json',
  'dist-electron/main/index.js',
  'dist-electron/preload/ui.js',
  'dist-electron/preload/page.js',
  'dist-electron/injected/fallbackMask.js',
  'dist-ui/index.html',
  'resources/icon.png',
  'node_modules/better-sqlite3/lib/binding.js',
  'node_modules/electron-chrome-extensions/dist/chrome-extension-api.preload.js',
  'node_modules/electron-chrome-web-store/dist/chrome-web-store.preload.js',
];

/** electron-builder output dir name -> the platform/arch it was packed for. */
function targetOf(dir) {
  const name = path.basename(dir);
  const arch = /arm64/.test(name) ? 'arm64' : 'x64';
  if (name.startsWith('win')) return { platform: 'win32', arch };
  if (name.startsWith('mac')) return { platform: 'darwin', arch };
  if (name.startsWith('linux')) return { platform: 'linux', arch };
  return null;
}

/** Every `resources` dir that holds an app.asar, with its output dir. */
function findApps() {
  const apps = [];
  if (!fs.existsSync(buildDir)) return apps;
  for (const entry of fs.readdirSync(buildDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const outDir = path.join(buildDir, entry.name);
    const candidates = [path.join(outDir, 'resources')];
    for (const sub of fs.readdirSync(outDir)) {
      if (sub.endsWith('.app')) candidates.push(path.join(outDir, sub, 'Contents', 'Resources'));
    }
    for (const res of candidates) {
      if (fs.existsSync(path.join(res, 'app.asar'))) apps.push({ outDir, resources: res });
    }
  }
  return apps;
}

const problems = [];
const apps = findApps();
if (apps.length === 0) problems.push(`no packaged app (app.asar) found under ${buildDir}`);

for (const { outDir, resources } of apps) {
  const label = path.relative(root, outDir) || outDir;
  const target = targetOf(outDir);
  if (!target) {
    problems.push(`${label}: cannot tell the target platform/arch from the directory name`);
    continue;
  }

  const entries = asar
    .listPackage(path.join(resources, 'app.asar'))
    .map((p) => p.replace(/\\/g, '/').replace(/^\//, ''));
  const stray = entries.filter((p) => {
    const top = p.split('/')[0];
    if (!ASAR_TOP_LEVEL.has(top)) return true;
    return top === 'resources' && !ASAR_RESOURCES.has(p);
  });
  if (stray.length > 0) {
    problems.push(`${label}: app.asar ships files outside the app: ${stray.slice(0, 8).join(', ')}${stray.length > 8 ? ` (+${stray.length - 8} more)` : ''}`);
  }
  const present = new Set(entries);
  const missing = ASAR_REQUIRED.filter((p) => !present.has(p));
  if (missing.length > 0) problems.push(`${label}: app.asar lacks ${missing.join(', ')}`);

  const sqlite = path.join(resources, 'app.asar.unpacked', 'node_modules', 'better-sqlite3');
  const prebuildsDir = path.join(sqlite, 'prebuilds');
  const prebuilds = fs.existsSync(prebuildsDir) ? fs.readdirSync(prebuildsDir) : [];
  const expected = `${target.platform}-${target.arch}.node`;
  if (prebuilds.length !== 1 || prebuilds[0] !== expected) {
    problems.push(`${label}: better-sqlite3 prebuilds are [${prebuilds.join(', ')}], expected exactly [${expected}]`);
  }
  const buildLeftovers = fs.existsSync(path.join(sqlite, 'build'))
    ? fs.readdirSync(path.join(sqlite, 'build'), { recursive: true }).filter((f) => !String(f).endsWith('.node') && /\.\w+$/.test(String(f)))
    : [];
  if (buildLeftovers.length > 0) {
    problems.push(`${label}: better-sqlite3/build ships node-gyp leftovers: ${buildLeftovers.slice(0, 5).join(', ')}`);
  }

  console.log(`[check-packaged] ${label}: ${entries.length} asar entries, prebuild ${prebuilds.join(', ') || 'NONE'}`);
}

if (problems.length > 0) {
  for (const p of problems) console.error(`::error::${p}`);
  process.exit(1);
}
console.log(`[check-packaged] OK (${apps.length} app${apps.length === 1 ? '' : 's'})`);
