import { describe, expect, it } from 'vitest';
import {
  chromeTimeToMs,
  firefoxTimeToMs,
  isImportableUrl,
  parseChromeBookmarks,
  parseFirefoxBookmarks,
  sanitizeHistoryRows,
  type FirefoxBookmarkRow,
} from '../mapping';

describe('timestamp conversion: the classic import bug', () => {
  it('converts Chrome/WebKit time (µs since 1601) to epoch ms', () => {
    // Known vector: 13286545380000000 µs since 1601 = 2022-01-13T10:23:00Z
    // (Unix 1642071780 s). Off-by-epoch would land in year ~422970.
    expect(chromeTimeToMs(13286545380000000)).toBe(1642071780000);
    const asDate = new Date(chromeTimeToMs(13286545380000000) as number);
    expect(asDate.getUTCFullYear()).toBe(2022);
  });

  it('converts Firefox time (µs since Unix epoch) to epoch ms', () => {
    expect(firefoxTimeToMs(1642071780000000)).toBe(1642071780000);
  });

  it('returns null for garbage instead of fabricating a date', () => {
    for (const bad of [0, -5, null, undefined, 'x', NaN, Infinity]) {
      expect(chromeTimeToMs(bad)).toBeNull();
      expect(firefoxTimeToMs(bad)).toBeNull();
    }
  });
});

describe('isImportableUrl', () => {
  it('keeps web pages, drops everything else', () => {
    expect(isImportableUrl('https://example.com/a')).toBe(true);
    expect(isImportableUrl('http://example.com')).toBe(true);
    // Bookmarklets would become a script-execution surface; chrome:// and
    // file:// mean nothing in Voksa.
    expect(isImportableUrl('javascript:alert(1)')).toBe(false);
    expect(isImportableUrl('chrome://settings')).toBe(false);
    expect(isImportableUrl('file:///C:/x.html')).toBe(false);
    expect(isImportableUrl(null)).toBe(false);
  });
});

describe('parseChromeBookmarks', () => {
  const FIXTURE = JSON.stringify({
    roots: {
      bookmark_bar: {
        type: 'folder',
        name: 'Bookmarks bar',
        children: [
          { type: 'url', name: 'Example', url: 'https://example.com/' },
          {
            type: 'folder',
            name: 'Travail',
            children: [
              { type: 'url', name: 'Docs', url: 'https://docs.example.com/' },
              { type: 'folder', name: 'Vide', children: [] },
              { type: 'url', name: 'Marklet', url: 'javascript:alert(1)' },
            ],
          },
        ],
      },
      other: {
        type: 'folder',
        name: 'Other bookmarks',
        children: [{ type: 'url', name: '', url: 'https://no-title.example.com/' }],
      },
      synced: { type: 'folder', name: 'Mobile', children: [] },
    },
  });

  it('flattens folders and bookmarks, re-parenting the fixed roots away', () => {
    const tree = parseChromeBookmarks(FIXTURE);
    expect(tree.bookmarks.map((b) => b.url)).toEqual([
      'https://example.com/',
      'https://docs.example.com/',
      'https://no-title.example.com/',
    ]);
    // The 'Travail' folder survives; the empty 'Vide' folder and the fixed
    // roots do not.
    expect(tree.folders.map((f) => f.name)).toEqual(['Travail']);
    const travail = tree.folders[0];
    expect(travail.parentTempId).toBeNull();
    expect(tree.bookmarks.find((b) => b.url.startsWith('https://docs'))?.folderTempId).toBe(
      travail.tempId,
    );
    // A bookmarklet is dropped, not half-imported.
    expect(tree.bookmarks.some((b) => b.url.startsWith('javascript:'))).toBe(false);
    // An untitled bookmark falls back to its URL, never to an empty string.
    expect(tree.bookmarks.find((b) => b.url.includes('no-title'))?.title).toBe(
      'https://no-title.example.com/',
    );
  });

  it('survives a corrupt file', () => {
    expect(parseChromeBookmarks('not json')).toEqual({ folders: [], bookmarks: [] });
    expect(parseChromeBookmarks('{}')).toEqual({ folders: [], bookmarks: [] });
  });
});

describe('parseFirefoxBookmarks', () => {
  const rows: FirefoxBookmarkRow[] = [
    { id: 1, type: 2, parent: 0, title: '', url: null, guid: 'root________' },
    { id: 3, type: 2, parent: 1, title: 'Barre', url: null, guid: 'toolbar_____' },
    { id: 10, type: 2, parent: 3, title: 'Perso', url: null, guid: 'aaaaaaaaaaaa' },
    { id: 11, type: 1, parent: 10, title: 'Site', url: 'https://ff.example.com/', guid: 'bbbbbbbbbbbb' },
    { id: 12, type: 1, parent: 3, title: null, url: 'https://bare.example.com/', guid: 'cccccccccccc' },
    // A folder with nothing importable beneath it disappears.
    { id: 13, type: 2, parent: 3, title: 'Vide', url: null, guid: 'dddddddddddd' },
    { id: 14, type: 1, parent: 13, title: 'Marklet', url: 'javascript:x', guid: 'eeeeeeeeeeee' },
  ];

  it('maps folders by guid, drops fixed roots and empty folders', () => {
    const tree = parseFirefoxBookmarks(rows);
    expect(tree.folders.map((f) => f.name)).toEqual(['Perso']);
    expect(tree.folders[0].parentTempId).toBeNull();
    expect(tree.bookmarks.map((b) => b.url)).toEqual([
      'https://ff.example.com/',
      'https://bare.example.com/',
    ]);
    expect(tree.bookmarks[0].folderTempId).toBe(tree.folders[0].tempId);
    expect(tree.bookmarks[1].folderTempId).toBeNull();
    expect(tree.bookmarks[1].title).toBe('https://bare.example.com/');
  });
});

describe('sanitizeHistoryRows', () => {
  const NOW = 1_700_000_000_000;

  it('clamps future timestamps and defaults missing ones to now, never to a fabricated past', () => {
    const rows = sanitizeHistoryRows(
      [
        { url: 'https://a.com/', title: 'A', visitCount: 3, lastVisitAt: NOW - 1000 },
        { url: 'https://b.com/', title: 'B', visitCount: 2, lastVisitAt: NOW + 999_999 },
        { url: 'https://c.com/', title: 'C', visitCount: 1, lastVisitAt: null },
      ],
      NOW,
    );
    expect(rows.map((r) => r.lastVisitAt)).toEqual([NOW - 1000, NOW, NOW]);
  });

  it('floors visit counts at 1 and drops non-web URLs', () => {
    const rows = sanitizeHistoryRows(
      [
        { url: 'https://a.com/', title: 'A', visitCount: 0, lastVisitAt: NOW },
        { url: 'https://b.com/', title: 'B', visitCount: 'x', lastVisitAt: NOW },
        { url: 'chrome://flags', title: 'nope', visitCount: 9, lastVisitAt: NOW },
      ],
      NOW,
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.visitCount >= 1)).toBe(true);
  });
});
