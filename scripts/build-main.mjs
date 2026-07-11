import { build, context } from 'esbuild';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const watch = process.argv.includes('--watch');

// Marker written after every batch of fresh builds completes, so `dev.mjs`
// can gate the Electron launch on an up-to-date bundle instead of a stale
// one left over from a previous run.
const readyMarker = path.join(root, 'dist-electron', '.build-ready');

const commonExternal = [
  'electron',
  'electron-chrome-web-store',
  'electron-chrome-extensions',
  'electron-updater',
  'better-sqlite3',
];

const targets = [
  {
    label: 'main',
    entry: path.join(root, 'src/main/index.ts'),
    outfile: path.join(root, 'dist-electron/main/index.js'),
    platform: 'node',
    format: 'cjs',
    external: commonExternal,
  },
  {
    label: 'preload-ui',
    entry: path.join(root, 'src/preload/ui.ts'),
    outfile: path.join(root, 'dist-electron/preload/ui.js'),
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
  },
  {
    label: 'preload-page',
    entry: path.join(root, 'src/preload/page.ts'),
    outfile: path.join(root, 'dist-electron/preload/page.js'),
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
  },
  {
    // Stream Mode fallback masker: NOT a preload. It is read as text by the
    // main process (frameGuard.ts) and injected with executeJavaScript into the
    // MAIN world of frames Electron refused to give a preload to
    // (electron/electron#34727). Hence a self-contained browser IIFE with no
    // externals: nothing may be require()d where it runs.
    label: 'injected-fallback',
    entry: path.join(root, 'src/injected/fallbackMask.ts'),
    outfile: path.join(root, 'dist-electron/injected/fallbackMask.js'),
    platform: 'browser',
    format: 'iife',
    external: [],
  },
];

let builtCount = 0;
const markerPlugin = {
  name: 'ready-marker',
  setup(pluginBuild) {
    pluginBuild.onEnd((result) => {
      if (result.errors.length > 0) return;
      builtCount += 1;
      // Once every target has produced at least one successful build, touch
      // the marker. Subsequent rebuilds keep refreshing it.
      if (builtCount >= targets.length) {
        try {
          fs.mkdirSync(path.dirname(readyMarker), { recursive: true });
          fs.writeFileSync(readyMarker, String(Date.now()));
        } catch {
          // non-fatal
        }
      }
    });
  },
};

async function run() {
  // Remove a stale marker so dev.mjs never sees a previous run's readiness.
  try {
    fs.rmSync(readyMarker, { force: true });
  } catch {
    // ignore
  }

  for (const t of targets) {
    const opts = {
      entryPoints: [t.entry],
      outfile: t.outfile,
      bundle: true,
      platform: t.platform,
      format: t.format,
      target: ['node20', 'chrome128'],
      external: t.external,
      // Inline maps in dev for debuggability; NO maps in prod so the packaged
      // asar never ships our TypeScript sources.
      sourcemap: watch ? 'inline' : false,
      minify: !watch,
      logLevel: 'info',
      plugins: watch ? [markerPlugin] : [],
    };
    if (watch) {
      const ctx = await context(opts);
      await ctx.watch();
      console.log(`[esbuild] watching ${t.label}`);
    } else {
      await build(opts);
      console.log(`[esbuild] built ${t.label}`);
    }
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
