import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_FILES_PER_OPEN, openableFileUrl, openableFileUrls } from '../localFiles';

let dir = '';
const at = (name: string) => path.join(dir, name);

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voksa-local-files-'));
  for (const name of ['photo.png', 'My pic #1 (été) 100%.JPG', 'page.html', 'logo.svg', 'notes.txt']) {
    fs.writeFileSync(at(name), 'x');
  }
  fs.mkdirSync(at('folder.png'));
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('openableFileUrl', () => {
  it('turns an existing openable file into its file URL', () => {
    const url = openableFileUrl(at('photo.png'));
    expect(url).toMatch(/^file:\/\/\/.+\/photo\.png$/);
    expect(fileURLToPath(url!)).toBe(at('photo.png'));
  });

  it('round-trips a name full of URL-hostile characters to the same file', () => {
    const name = 'My pic #1 (été) 100%.JPG';
    const url = openableFileUrl(at(name));
    expect(url).not.toBeNull();
    // The whole point: '#' and '%' must not cut or corrupt the path.
    expect(fileURLToPath(url!)).toBe(at(name));
  });

  it('refuses a scriptable document even though it exists', () => {
    expect(openableFileUrl(at('page.html'))).toBeNull();
    expect(openableFileUrl(at('logo.svg'))).toBeNull();
  });

  it('refuses a folder, even one named like an image', () => {
    expect(openableFileUrl(at('folder.png'))).toBeNull();
    expect(openableFileUrl(dir)).toBeNull();
  });

  it('refuses a missing file and a relative path', () => {
    expect(openableFileUrl(at('nope.png'))).toBeNull();
    expect(openableFileUrl('photo.png')).toBeNull();
    expect(openableFileUrl(path.join('.', 'photo.png'))).toBeNull();
  });

  it('never throws on what a renderer could send instead of a path', () => {
    for (const junk of [undefined, null, 42, {}, [], '', 'a\0b.png', 'file:///C:/a.png']) {
      expect(openableFileUrl(junk)).toBeNull();
    }
  });
});

describe('openableFileUrls', () => {
  it('keeps the openable entries, in order, and drops the rest', () => {
    const urls = openableFileUrls([at('notes.txt'), at('page.html'), 7, at('photo.png'), at('nope.png')]);
    expect(urls.map((u) => path.basename(fileURLToPath(u)))).toEqual(['notes.txt', 'photo.png']);
  });

  it('opens each file once', () => {
    expect(openableFileUrls([at('photo.png'), at('photo.png')])).toHaveLength(1);
  });

  it(`stops at ${MAX_FILES_PER_OPEN} files`, () => {
    const many = Array.from({ length: MAX_FILES_PER_OPEN + 15 }, (_, i) => {
      const p = at(`bulk-${i}.png`);
      fs.writeFileSync(p, 'x');
      return p;
    });
    expect(openableFileUrls(many)).toHaveLength(MAX_FILES_PER_OPEN);
  });

  it('answers an empty list for anything that is not an array', () => {
    for (const junk of [undefined, null, 'C:\\a.png', { length: 1, 0: at('photo.png') }]) {
      expect(openableFileUrls(junk)).toEqual([]);
    }
  });
});
