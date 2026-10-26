import { describe, expect, it } from 'vitest';
import {
  WEBSTORE_ORIGIN,
  installDisplayName,
  installPermissionLines,
  isValidExtensionId,
  isWebStoreOrigin,
} from '../extensions/webstoreGuards';

// A real store id (uBlock Origin Lite) and the shapes an attacker would send.
const REAL_ID = 'ddkjiahejlhfcafbddmgiahcphecmpfh';

describe('isValidExtensionId', () => {
  it('accepts 32 characters in a-p', () => {
    expect(isValidExtensionId(REAL_ID)).toBe(true);
    expect(isValidExtensionId('a'.repeat(32))).toBe(true);
    expect(isValidExtensionId('p'.repeat(32))).toBe(true);
  });

  it.each([
    ['path traversal', '../../../../Documents'],
    ['traversal padded to 32 chars', '../../aaaaaaaaaaaaaaaaaaaaaaaaaaa'],
    ['absolute path', 'C:\\Users\\someone\\Documents'],
    ['posix absolute path', '/home/someone/Documents'],
    ['letter outside a-p', 'q'.repeat(32)],
    ['uppercase', REAL_ID.toUpperCase()],
    ['too short', REAL_ID.slice(1)],
    ['too long', `${REAL_ID}a`],
    ['trailing newline', `${REAL_ID}\n`],
    ['separator inside', `${REAL_ID.slice(0, 31)}/`],
    ['empty', ''],
  ])('rejects %s', (_label, id) => {
    expect(isValidExtensionId(id)).toBe(false);
  });

  it.each([undefined, null, 42, {}, [REAL_ID]])('rejects non-string %j', (id) => {
    expect(isValidExtensionId(id)).toBe(false);
  });
});

describe('isWebStoreOrigin', () => {
  it('accepts exactly the store origin', () => {
    expect(isWebStoreOrigin('https://chromewebstore.google.com')).toBe(true);
    expect(isWebStoreOrigin(WEBSTORE_ORIGIN)).toBe(true);
  });

  it.each([
    // The prefix-match bypass of electron-chrome-web-store 0.13.0.
    'https://chromewebstore.google.com.evil.example',
    'https://chromewebstore.google.com.evil.example:443',
    'https://chromewebstore.google.com:8443',
    'http://chromewebstore.google.com',
    'https://evil.chromewebstore.google.com',
    'https://chromewebstore.google.co',
    'https://chromewebstore.google.com/',
    'null',
    '',
  ])('rejects %s', (origin) => {
    expect(isWebStoreOrigin(origin)).toBe(false);
  });

  it.each([undefined, null, 0])('rejects non-string %j', (origin) => {
    expect(isWebStoreOrigin(origin)).toBe(false);
  });
});

describe('installPermissionLines', () => {
  it('lists API permissions, host permissions and content script hosts, deduplicated', () => {
    const { lines, more } = installPermissionLines({
      permissions: ['storage', 'tabs', 'storage'],
      host_permissions: ['<all_urls>'],
      content_scripts: [
        { matches: ['https://*.example.com/*', '<all_urls>'] },
        { js: ['no-matches.js'] },
      ],
    });
    expect(lines).toEqual(['storage', 'tabs', '<all_urls>', 'https://*.example.com/*']);
    expect(more).toBe(0);
  });

  it('ignores non-string entries and malformed fields', () => {
    expect(
      installPermissionLines({
        permissions: ['storage', 42, null, { name: 'x' }, '  '],
        host_permissions: 'https://*/*',
        content_scripts: [null, 'x', { matches: 'not-an-array' }],
      }),
    ).toEqual({ lines: ['storage'], more: 0 });
    expect(installPermissionLines(null)).toEqual({ lines: [], more: 0 });
    expect(installPermissionLines('{"permissions":["tabs"]}')).toEqual({ lines: [], more: 0 });
  });

  it('caps the list and the length of each entry', () => {
    const permissions = Array.from({ length: 40 }, (_, i) => `perm${i}`);
    const { lines, more } = installPermissionLines({
      permissions: [...permissions, 'x'.repeat(500)],
    });
    expect(lines).toHaveLength(15);
    expect(more).toBe(26);
    const long = installPermissionLines({ permissions: ['x'.repeat(500)] }).lines[0];
    expect(long.length).toBe(120);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('installDisplayName', () => {
  it('prefers the store localized name, then the manifest name, then the id', () => {
    expect(installDisplayName('uBlock Origin Lite', { name: 'uBOL' }, REAL_ID)).toBe(
      'uBlock Origin Lite',
    );
    expect(installDisplayName('', { name: 'uBOL' }, REAL_ID)).toBe('uBOL');
    expect(installDisplayName(undefined, {}, REAL_ID)).toBe(REAL_ID);
  });

  it('skips unresolved __MSG_ placeholders', () => {
    expect(installDisplayName('__MSG_extName__', { name: '__MSG_extName__' }, REAL_ID)).toBe(
      REAL_ID,
    );
  });

  it('clips very long names', () => {
    expect(installDisplayName('n'.repeat(1000), null, REAL_ID)).toHaveLength(120);
  });
});
