import { describe, expect, it, vi } from 'vitest';

// defaultBrowser.ts imports { app } from 'electron', unavailable under vitest:
// stub the module surface the pure parser does not touch.
vi.mock('electron', () => ({
  app: { isPackaged: false, isDefaultProtocolClient: () => false },
}));

const { parseRegProgId, VOKSA_PROG_ID } = await import('../defaultBrowser');

// Verbatim shape of `reg query HKCU\...\UserChoice /v ProgId` on Windows 10/11
// (header line, then indented columns). The value name and the REG_SZ token
// are not localized; the surrounding text may be.
const REG_OUTPUT = (progId: string) => `\r\n` +
  `HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice\r\n` +
  `    ProgId    REG_SZ    ${progId}\r\n` +
  `\r\n`;

describe('parseRegProgId', () => {
  it('extracts the ProgId from real reg query output', () => {
    expect(parseRegProgId(REG_OUTPUT('ChromeHTML'))).toBe('ChromeHTML');
    expect(parseRegProgId(REG_OUTPUT('VoksaHTM'))).toBe(VOKSA_PROG_ID);
    expect(parseRegProgId(REG_OUTPUT('MSEdgeHTM'))).toBe('MSEdgeHTM');
  });

  it('tolerates tab separators and case differences in the value name', () => {
    expect(parseRegProgId('\tProgId\tREG_SZ\tFirefoxURL-308046B0AF4A39CB')).toBe(
      'FirefoxURL-308046B0AF4A39CB',
    );
    expect(parseRegProgId('    progid    REG_SZ    VoksaHTM')).toBe('VoksaHTM');
  });

  it('returns null on anything that is not a ProgId line (fail-honest)', () => {
    // A missing key prints an error message, localized: no ProgId line.
    expect(parseRegProgId('ERROR: The system was unable to find the specified registry key or value.')).toBeNull();
    expect(parseRegProgId('')).toBeNull();
    // A different value type must not match.
    expect(parseRegProgId('    ProgId    REG_DWORD    0x1')).toBeNull();
  });

  it('VOKSA_PROG_ID matches the ProgID written by resources/installer.nsh', async () => {
    // The two live in different languages (TS / NSIS): this pin is the only
    // thing keeping them from drifting apart silently.
    const fs = await import('node:fs');
    const url = await import('node:url');
    const path = await import('node:path');
    const root = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..', '..');
    const nsh = fs.readFileSync(path.join(root, 'resources', 'installer.nsh'), 'utf8');
    expect(nsh).toContain(`"http" "${VOKSA_PROG_ID}"`);
    expect(nsh).toContain(`"https" "${VOKSA_PROG_ID}"`);
  });
});
