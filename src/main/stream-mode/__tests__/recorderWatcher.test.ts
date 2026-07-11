import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RecorderWatcher } from '../recorderWatcher';

// recorderWatcher shells out through execFile; script its result per call so
// each poll of the loop sees a chosen process listing (or a failure).
const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));

vi.mock('node:child_process', () => ({ execFile: execFileMock }));

// Keep in sync with POLL_INTERVAL_MS in recorderWatcher.ts.
const POLL_MS = 5000;

type ExecStep = { err?: Error; stdout?: string };
type ExecCallback = (err: Error | null, stdout: string) => void;

/** Build `tasklist /FO CSV /NH` output for the given image names (win32 branch). */
function tasklistCsv(...names: string[]): string {
  return names.map((n) => `"${n}","123","Console","1","10 000 K"`).join('\r\n') + '\r\n';
}

const platformDesc = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor;

/** listProcesses reads process.platform at call time, so a stub per test works. */
function stubPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { ...platformDesc, value });
}

describe('RecorderWatcher', () => {
  let script: ExecStep[];
  let onAppeared: ReturnType<typeof vi.fn>;
  let watcher: RecorderWatcher | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    // Deterministic branch whatever OS the test runner is on.
    stubPlatform('win32');
    script = [];
    execFileMock
      .mockReset()
      .mockImplementation((_cmd: string, _args: string[], _opts: object, cb: ExecCallback) => {
        // An exhausted script means an empty listing, so a stray extra poll
        // cannot throw inside the promise executor; call counts are asserted
        // separately where they matter.
        const step = script.shift() ?? { stdout: '' };
        cb(step.err ?? null, step.stdout ?? '');
      });
    onAppeared = vi.fn();
    watcher = undefined;
  });

  afterEach(() => {
    watcher?.stop();
    Object.defineProperty(process, 'platform', platformDesc);
    vi.useRealTimers();
  });

  /** start() runs an immediate poll; flush its microtasks before asserting. */
  async function start(): Promise<RecorderWatcher> {
    watcher = new RecorderWatcher(onAppeared);
    watcher.start();
    await vi.advanceTimersByTimeAsync(0);
    return watcher;
  }

  it('fires once when a recorder is already running at the very first poll', async () => {
    script.push({ stdout: tasklistCsv('explorer.exe', 'obs64.exe') });
    await start();
    expect(execFileMock).toHaveBeenCalledTimes(1); // exactly the one scripted poll
    expect(onAppeared).toHaveBeenCalledTimes(1);
    expect(onAppeared).toHaveBeenCalledWith('obs64');
    // The win32 branch shells out to tasklist with exactly the CSV args the
    // parser is format-coupled to, and hides the console window.
    expect(execFileMock.mock.calls[0].slice(0, 2)).toEqual(['tasklist', ['/FO', 'CSV', '/NH']]);
    expect(execFileMock.mock.calls[0][2]).toMatchObject({ windowsHide: true });
  });

  it('does not fire again while the recorder keeps running', async () => {
    script.push(
      { stdout: tasklistCsv('obs64.exe') },
      { stdout: tasklistCsv('obs64.exe') },
      { stdout: tasklistCsv('obs64.exe') },
    );
    await start();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(execFileMock).toHaveBeenCalledTimes(3); // the loop DID poll again
    expect(onAppeared).toHaveBeenCalledTimes(1); // but the edge fired only once
  });

  it('fires again exactly once when the recorder quits then relaunches', async () => {
    script.push(
      { stdout: tasklistCsv('obs64.exe') }, // poll 1: present, first edge
      { stdout: tasklistCsv('explorer.exe') }, // poll 2: gone (listing still valid)
      { stdout: tasklistCsv('obs64.exe') }, // poll 3: relaunched, second edge
      { stdout: tasklistCsv('obs64.exe') }, // poll 4: still running, no edge
    );
    await start();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(execFileMock).toHaveBeenCalledTimes(4); // every scripted poll consumed
    expect(onAppeared).toHaveBeenCalledTimes(2);
  });

  it('never fires when the listing fails or comes back empty', async () => {
    script.push(
      { err: new Error('spawn failed') }, // execFile error: resolves to []
      { stdout: '' }, // empty stdout: parses to []
      { stdout: 'INFO: no tasks are running\r\n' }, // no CSV rows: parses to []
    );
    await start();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(execFileMock).toHaveBeenCalledTimes(3);
    expect(onAppeared).not.toHaveBeenCalled();
  });

  it('keeps wasPresent across failed listings: no spurious re-edge', async () => {
    script.push(
      { stdout: tasklistCsv('obs64.exe') }, // poll 1: present, edge fires
      { err: new Error('tasklist timed out') }, // poll 2: FAILED, state must be kept
      { stdout: '' }, // poll 3: empty output, same guard (names.length === 0 skip)
      { stdout: tasklistCsv('obs64.exe') }, // poll 4: same OBS run, NOT a rising edge
    );
    await start();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(execFileMock).toHaveBeenCalledTimes(4); // every scripted poll consumed
    // If a failed listing were read as "recorder gone", poll 4 would re-fire.
    expect(onAppeared).toHaveBeenCalledTimes(1);
  });

  it('skips the interval tick while a listing is still in flight (no overlap)', async () => {
    // Defer completion: capture callbacks instead of answering synchronously,
    // so the first poll stays pending across the next interval tick.
    const pending: ExecCallback[] = [];
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: object, cb: ExecCallback) => {
        pending.push(cb);
      },
    );
    await start();
    expect(execFileMock).toHaveBeenCalledTimes(1);
    // The tick fires while poll 1 is unresolved: the re-entrancy guard must
    // swallow it without issuing a second execFile.
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(execFileMock).toHaveBeenCalledTimes(1);
    // Resolve the stalled listing; the poll finishes normally.
    pending[0]!(null, tasklistCsv('obs64.exe'));
    await vi.advanceTimersByTimeAsync(0);
    expect(onAppeared).toHaveBeenCalledTimes(1);
    expect(onAppeared).toHaveBeenCalledWith('obs64');
    // Guard released: the next tick polls again (synchronous empty listing).
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: object, cb: ExecCallback) => cb(null, ''),
    );
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it('uses ps on non-Windows and reports the normalized name', async () => {
    stubPlatform('linux');
    script.push({ stdout: 'systemd\nbash\nobs\n' });
    await start();
    // The POSIX branch shells out to ps with exactly the bare-comm args the
    // parser is format-coupled to.
    expect(execFileMock.mock.calls[0].slice(0, 2)).toEqual(['ps', ['-eo', 'comm=']]);
    expect(onAppeared).toHaveBeenCalledTimes(1);
    expect(onAppeared).toHaveBeenCalledWith('obs');
  });

  it('stop() halts the loop: no more listings, no more callbacks', async () => {
    script.push(
      { stdout: tasklistCsv('explorer.exe') }, // poll 1: nothing yet
      { stdout: tasklistCsv('obs64.exe') }, // would be an edge, but never polled
    );
    const w = await start();
    expect(execFileMock).toHaveBeenCalledTimes(1);
    w.stop();
    await vi.advanceTimersByTimeAsync(POLL_MS * 4);
    expect(execFileMock).toHaveBeenCalledTimes(1); // interval cleared, no further polls
    expect(onAppeared).not.toHaveBeenCalled();
  });
});
