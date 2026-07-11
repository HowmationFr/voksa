import { describe, it, expect } from 'vitest';
import {
  findRecorder,
  normalizeProcessName,
  parsePsOutput,
  parseTasklistCsv,
} from '../recorderPatterns';

describe('normalizeProcessName', () => {
  it('strips path, extension and case', () => {
    expect(normalizeProcessName('C:\\Program Files\\obs-studio\\bin\\obs64.exe')).toBe('obs64');
    expect(normalizeProcessName('/Applications/OBS.app')).toBe('obs');
    expect(normalizeProcessName('Streamlabs OBS.exe')).toBe('streamlabs obs');
  });
});

describe('findRecorder', () => {
  it('detects OBS among ordinary processes', () => {
    expect(findRecorder(['explorer.exe', 'chrome.exe', 'obs64.exe'])).toBe('obs64');
  });

  it('detects the short linux comm name', () => {
    expect(findRecorder(['systemd', 'bash', 'obs'])).toBe('obs');
  });

  it('matches exactly, never by substring', () => {
    // 'actionneur' contains 'action'; 'my-obs-helper' contains 'obs'.
    expect(findRecorder(['actionneur.exe', 'my-obs-helper.exe', 'vmixer.exe'])).toBeNull();
  });

  it('ignores resident capture services excluded on purpose', () => {
    expect(findRecorder(['NVIDIA Share.exe', 'GameBar.exe', 'ffmpeg.exe'])).toBeNull();
  });

  it('returns null on an empty list', () => {
    expect(findRecorder([])).toBeNull();
  });
});

describe('parseTasklistCsv', () => {
  it('extracts the image name from each CSV row', () => {
    const out =
      '"obs64.exe","1234","Console","1","250 000 K"\r\n' +
      '"chrome.exe","77","Console","1","1 000 K"\r\n';
    expect(parseTasklistCsv(out)).toEqual(['obs64.exe', 'chrome.exe']);
  });

  it('ignores malformed lines', () => {
    expect(parseTasklistCsv('INFO: no tasks running\r\n')).toEqual([]);
  });
});

describe('parsePsOutput', () => {
  it('splits and trims one name per line', () => {
    expect(parsePsOutput(' systemd \nobs\n\nbash\n')).toEqual(['systemd', 'obs', 'bash']);
  });
});
