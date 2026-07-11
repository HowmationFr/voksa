import { spawn, spawnSync } from 'node:child_process';
import { existsSync, statSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const children = [];
let cleaningUp = false;

function spawnWatched(cmd, args, label, extraEnv = {}) {
  const child = spawn(cmd, args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    // POSIX: make each child its own process-group leader so killTree's
    // `process.kill(-pid)` reaches the real vite/esbuild/electron processes,
    // not just the npx wrapper (otherwise port 5173 stays held after Ctrl+C).
    detached: process.platform !== 'win32',
    env: { ...process.env, FORCE_COLOR: '1', ...extraEnv },
  });
  child.on('exit', (code) => {
    if (!cleaningUp && code !== 0 && code !== null) {
      console.error(`[${label}] exited with code ${code}`);
      // A watcher (esbuild/vite) dying before Electron launches means we'd
      // otherwise point Electron at a dead dev server: abort the whole dev
      // session instead of limping on.
      cleanup();
      process.exit(code);
    }
  });
  children.push(child);
  return child;
}

function killTree(pid) {
  if (pid == null) return;
  if (process.platform === 'win32') {
    // `shell:true` spawns a cmd.exe wrapper; killing only that leaves
    // vite/esbuild/electron orphaned (and port 5173 held). taskkill /T walks
    // the whole process tree.
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  }
}

function cleanup() {
  if (cleaningUp) return;
  cleaningUp = true;
  for (const child of children) {
    killTree(child.pid);
  }
}

process.on('SIGINT', () => {
  cleanup();
  process.exit(0);
});
process.on('SIGTERM', () => {
  cleanup();
  process.exit(0);
});
process.on('exit', cleanup);

async function waitForFreshMarker(marker, startedAt, timeoutMs = 60_000) {
  const start = Date.now();
  while (true) {
    if (existsSync(marker)) {
      try {
        if (statSync(marker).mtimeMs >= startedAt) return;
      } catch {
        // race with the writer: retry
      }
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timeout waiting for a fresh build marker at ${marker}`);
    }
    await delay(150);
  }
}

async function main() {
  // Nuke any previous bundle so a fresh build (not a leftover) satisfies the
  // wait below. build-main.mjs also removes the marker itself, but clearing
  // the whole dir here defends against half-written outputs.
  try {
    rmSync(path.join(root, 'dist-electron'), { recursive: true, force: true });
  } catch {
    // ignore
  }

  const startedAt = Date.now();
  spawnWatched('node', ['scripts/build-main.mjs', '--watch'], 'esbuild-main');
  spawnWatched('npx', ['vite'], 'vite');

  console.log('[dev] waiting for a fresh main-process build…');
  await waitForFreshMarker(path.join(root, 'dist-electron', '.build-ready'), startedAt);

  console.log('[dev] launching Electron');
  const electron = spawnWatched('npx', ['electron', '.'], 'electron', {
    VITE_DEV_SERVER: 'http://localhost:5173',
  });
  electron.on('exit', () => {
    cleanup();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(err);
  cleanup();
  process.exit(1);
});
