/**
 * Truthful "is Voksa the default browser?" detection.
 *
 * THE WINDOWS TRAP (lived, v0.5.0): app.isDefaultProtocolClient() checks the
 * LEGACY per-user registration under HKCU\Software\Classes, the very thing
 * app.setAsDefaultProtocolClient() writes. Calling the setter at boot then
 * makes the checker answer "yes" forever, while the association that actually
 * decides which browser opens links on Windows 10+ is the UserChoice ProgId
 * (protected by a hash, only the Settings app can write it). Voksa proudly
 * claimed to be the default while Chrome opened every link.
 *
 * So on Windows we read the real thing: the ProgId under
 * HKCU\...\UrlAssociations\{http,https}\UserChoice, compared to the ProgID
 * our NSIS installer registers (VoksaHTM, resources/installer.nsh). Anything
 * unreadable counts as NOT default: the card must never claim what the OS
 * does not confirm.
 *
 * macOS (LaunchServices) and Linux (xdg-settings check) answer truthfully
 * through app.isDefaultProtocolClient, so they keep using it.
 */
import { execFile } from 'node:child_process';
import { app } from 'electron';

/** ProgID written by resources/installer.nsh: keep the two in sync. */
export const VOKSA_PROG_ID = 'VoksaHTM';

const USER_CHOICE_KEY = (scheme: string) =>
  `HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\${scheme}\\UserChoice`;

/**
 * Extract the ProgId value from `reg query ... /v ProgId` output. The value
 * name and type token are not localized, so this is locale-safe. Null on any
 * shape mismatch (missing key, access denied text, empty output).
 */
export function parseRegProgId(stdout: string): string | null {
  const m = /\bProgId\s+REG_SZ\s+(\S+)/i.exec(stdout);
  return m ? m[1] : null;
}

function queryUserChoiceProgId(scheme: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        'reg',
        ['query', USER_CHOICE_KEY(scheme), '/v', 'ProgId'],
        { windowsHide: true, timeout: 3_000 },
        (err, stdout) => {
          resolve(err ? null : parseRegProgId(String(stdout)));
        },
      );
    } catch {
      resolve(null);
    }
  });
}

/**
 * Is Voksa the browser that will actually open an http/https link right now?
 * Fail-honest: any doubt (unreadable key, dev build) reads as false.
 */
export async function isDefaultBrowser(): Promise<boolean> {
  if (!app.isPackaged) return false;
  if (process.platform === 'win32') {
    const [http, https] = await Promise.all([
      queryUserChoiceProgId('http'),
      queryUserChoiceProgId('https'),
    ]);
    return http === VOKSA_PROG_ID && https === VOKSA_PROG_ID;
  }
  try {
    return app.isDefaultProtocolClient('http') && app.isDefaultProtocolClient('https');
  } catch {
    return false;
  }
}
