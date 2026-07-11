import { execFile } from 'node:child_process';
import { findRecorder, parsePsOutput, parseTasklistCsv } from './recorderPatterns';

/**
 * Polls the OS process list and reports RISING EDGES of "a recorder app is
 * running" (OBS, Streamlabs, XSplit…). Edge semantics matter: the callback
 * fires when a recorder appears (including one already open at startup),
 * then not again until every recorder has quit and one relaunches. So a
 * user who manually turns Stream Mode OFF while OBS keeps running is not
 * fought by the watcher.
 */

const POLL_INTERVAL_MS = 5000;
const EXEC_TIMEOUT_MS = 4000;

function listProcesses(): Promise<string[]> {
  return new Promise((resolve) => {
    const done = (err: Error | null, stdout: string) => {
      if (err) {
        resolve([]);
        return;
      }
      resolve(
        process.platform === 'win32' ? parseTasklistCsv(stdout) : parsePsOutput(stdout),
      );
    };
    if (process.platform === 'win32') {
      execFile(
        'tasklist',
        ['/FO', 'CSV', '/NH'],
        { timeout: EXEC_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
        done,
      );
    } else {
      // -e: all processes; -o comm=: bare command name, no header. Works on
      // both macOS and Linux (on Linux comm is truncated to 15 chars, which
      // still matches our exact names like 'obs').
      execFile(
        'ps',
        ['-eo', 'comm='],
        { timeout: EXEC_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
        done,
      );
    }
  });
}

export class RecorderWatcher {
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private wasPresent = false;

  constructor(private readonly onRecorderAppeared: (name: string) => void) {}

  start(): void {
    if (this.timer) return;
    void this.poll(); // immediate check: a recorder already open at startup counts
    this.timer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
    // Don't keep the app alive just for the watcher.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const names = await listProcesses();
      if (names.length === 0) return; // listing failed, keep previous state
      const recorder = findRecorder(names);
      const present = recorder !== null;
      if (present && !this.wasPresent) this.onRecorderAppeared(recorder as string);
      this.wasPresent = present;
    } finally {
      this.polling = false;
    }
  }
}
