/**
 * Pure matching/parsing for the recorder-detection watcher (no electron or
 * child_process imports, unit-testable). The watcher polls the OS process
 * list; when a known recording/streaming app shows up, Stream Mode is
 * auto-enabled (config flag `autoStreamOnRecorder`).
 */

/**
 * Known recorder / streaming-suite process names, lowercased, without
 * extension. Matching is EXACT on the normalized process name: no
 * substring matching, so generic words ('action') can't false-positive on
 * unrelated processes that merely contain them.
 *
 * Deliberately excluded: NVIDIA Share/ShadowPlay and Windows Game Bar
 * (resident on many machines even when idle; they would force Stream Mode
 * permanently), ffmpeg (spawned by countless non-recording apps).
 */
const RECORDER_PROCESS_NAMES = new Set<string>([
  // OBS Studio
  'obs',
  'obs32',
  'obs64',
  // Streamlabs
  'streamlabs obs',
  'streamlabs desktop',
  // XSplit
  'xsplit.core',
  'xsplitbroadcaster',
  'xsplit gamecaster',
  // vMix
  'vmix',
  'vmix64',
  // Others
  'wirecast',
  'twitchstudio',
  'twitch studio',
  'bandicam',
  'bdcam', // Bandicam's actual executable
  'action', // Mirillis Action!
  'camtasia',
  'camtasiastudio',
  'camtasia recorder',
]);

/** Normalize one raw process name: basename, lowercase, strip .exe/.app. */
export function normalizeProcessName(raw: string): string {
  const base = raw.trim().replace(/^.*[\\/]/, '');
  return base.replace(/\.(exe|app)$/i, '').toLowerCase();
}

/** First known recorder found in the list of raw process names, or null. */
export function findRecorder(processNames: readonly string[]): string | null {
  for (const raw of processNames) {
    const name = normalizeProcessName(raw);
    if (RECORDER_PROCESS_NAMES.has(name)) return name;
  }
  return null;
}

/**
 * Parse `tasklist /FO CSV /NH` output (Windows): one CSV row per process,
 * image name is the first quoted field.
 */
export function parseTasklistCsv(output: string): string[] {
  const names: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const m = /^"([^"]+)"/.exec(line.trim());
    if (m) names.push(m[1]);
  }
  return names;
}

/** Parse `ps` comm-only output (macOS/Linux): one process name per line. */
export function parsePsOutput(output: string): string[] {
  return output
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}
