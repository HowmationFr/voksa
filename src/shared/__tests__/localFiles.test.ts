import { describe, it, expect } from 'vitest';
import {
  OPENABLE_EXTENSIONS,
  OPENABLE_IMAGE_EXTENSIONS,
  allowsFileOpen,
  isFileUrl,
  isOpenableFileUrl,
  isOpenableLocalPath,
  localPathToFileUrl,
} from '../localFiles';

describe('openable types', () => {
  it('accepts passive files only: images, PDF, text, audio, video', () => {
    for (const name of ['a.png', 'photo.JPG', 'x.jpeg', 'x.webp', 'x.gif', 'doc.pdf', 'notes.txt', 'clip.mp4', 'song.mp3']) {
      expect(isOpenableLocalPath(name), name).toBe(true);
    }
  });

  it('NEVER accepts a scriptable document (it would run with file:// privileges)', () => {
    for (const name of ['page.html', 'page.htm', 'logo.svg', 'feed.xml', 'doc.xhtml', 'page.HTML', 'run.js']) {
      expect(isOpenableLocalPath(name), name).toBe(false);
    }
    for (const ext of ['html', 'htm', 'svg', 'xml', 'xhtml', 'mhtml', 'js']) {
      expect(OPENABLE_EXTENSIONS).not.toContain(ext);
    }
  });

  it('reads the extension of the LAST segment only', () => {
    expect(isOpenableLocalPath('C:\\pics.png\\readme')).toBe(false);
    expect(isOpenableLocalPath('/home/me/archive.png/page.html')).toBe(false);
    expect(isOpenableLocalPath('C:\\Users\\me\\My pic.final.png')).toBe(true);
    expect(isOpenableLocalPath('no-extension')).toBe(false);
    expect(isOpenableLocalPath('.png')).toBe(false);
    expect(isOpenableLocalPath('')).toBe(false);
  });

  it('every image extension is openable', () => {
    for (const ext of OPENABLE_IMAGE_EXTENSIONS) expect(OPENABLE_EXTENSIONS).toContain(ext);
  });
});

describe('file URLs', () => {
  it('recognises the file scheme, any case', () => {
    expect(isFileUrl('file:///C:/a.png')).toBe(true);
    expect(isFileUrl('FILE:///C:/a.png')).toBe(true);
    expect(isFileUrl('https://example.com/a.png')).toBe(false);
    expect(isFileUrl('voksa://newtab')).toBe(false);
    expect(isFileUrl('')).toBe(false);
  });

  it('judges a file URL by its path, not its query or fragment', () => {
    expect(isOpenableFileUrl('file:///C:/Users/me/My%20pic.png')).toBe(true);
    expect(isOpenableFileUrl('file:///home/me/doc.pdf#page=2')).toBe(true);
    expect(isOpenableFileUrl('file:///C:/x/page.html?x=.png')).toBe(false);
    expect(isOpenableFileUrl('file:///C:/x/page.html#a.png')).toBe(false);
    expect(isOpenableFileUrl('file:///C:/Users/me/')).toBe(false);
    expect(isOpenableFileUrl('https://example.com/a.png')).toBe(false);
    expect(isOpenableFileUrl('not a url')).toBe(false);
  });

  it('judges an escaped name by what it decodes to, and refuses control characters', () => {
    // An embedded NUL makes two layers disagree on where the name ends.
    expect(isOpenableFileUrl('file:///C:/x/evil.html%00.png')).toBe(false);
    expect(isOpenableLocalPath('C:\\x\\evil.html\u0000.png')).toBe(false);
    expect(isOpenableLocalPath('C:\\x\\a\nb.png')).toBe(false);
    // An escaped separator is a separator: ".png" alone is not a file name.
    expect(isOpenableFileUrl('file:///C:/x/evil.html%2F.png')).toBe(false);
    expect(isOpenableFileUrl('file:///C:/x/evil.html%5C.png')).toBe(false);
    // An escaped dot is a dot.
    expect(isOpenableFileUrl('file:///C:/x/page%2Ehtml')).toBe(false);
    expect(isOpenableFileUrl('file:///C:/x/photo%2Epng')).toBe(true);
  });
});

describe('localPathToFileUrl', () => {
  it('turns a Windows drive path into a file URL', () => {
    expect(localPathToFileUrl('C:\\Users\\me\\photo.png', 'win32')).toBe('file:///C:/Users/me/photo.png');
    expect(localPathToFileUrl('d:/pics/photo.JPG', 'win32')).toBe('file:///d:/pics/photo.JPG');
  });

  it('keeps spaces and accents addressable', () => {
    expect(localPathToFileUrl('C:\\Users\\me\\Mes images\\été 2026.png', 'win32')).toBe(
      'file:///C:/Users/me/Mes%20images/%C3%A9t%C3%A9%202026.png',
    );
  });

  it('escapes the characters that would truncate the path in a URL', () => {
    expect(localPathToFileUrl('C:\\x\\a#b%.png', 'win32')).toBe('file:///C:/x/a%23b%25.png');
    expect(localPathToFileUrl('C:\\x\\what?.png', 'win32')).toBe('file:///C:/x/what%3F.png');
  });

  it('accepts the quoted form Windows "Copy as path" produces', () => {
    expect(localPathToFileUrl('"C:\\Users\\me\\My pic.png"', 'win32')).toBe(
      'file:///C:/Users/me/My%20pic.png',
    );
    expect(localPathToFileUrl('  "C:\\a.png"  ', 'win32')).toBe('file:///C:/a.png');
  });

  it('turns a UNC path into a host-qualified file URL', () => {
    expect(localPathToFileUrl('\\\\nas\\photos\\2026\\a.png', 'win32')).toBe('file://nas/photos/2026/a.png');
  });

  it('turns a POSIX absolute path into a file URL', () => {
    expect(localPathToFileUrl('/home/me/My pics/a.png', 'posix')).toBe('file:///home/me/My%20pics/a.png');
  });

  it('refuses a path of the other platform', () => {
    expect(localPathToFileUrl('/home/me/a.png', 'win32')).toBeNull();
    expect(localPathToFileUrl('C:\\Users\\me\\a.png', 'posix')).toBeNull();
    expect(localPathToFileUrl('\\\\nas\\photos\\a.png', 'posix')).toBeNull();
  });

  it('refuses everything that is not an absolute path to an openable file', () => {
    for (const input of [
      'C:\\x\\page.html',
      'C:\\x\\logo.svg',
      'C:\\Users\\me\\Pictures\\',
      'C:\\Users\\me\\Pictures',
      'photo.png',
      '.\\photo.png',
      'C:photo.png',
      '',
      '   ',
      'hello world',
      'example.com/a.png',
    ]) {
      expect(localPathToFileUrl(input, 'win32'), input).toBeNull();
    }
    for (const input of ['//cdn.example.com/a.png', '/r/programming', 'a.png', '~/a.png', '/home/me/page.html']) {
      expect(localPathToFileUrl(input, 'posix'), input).toBeNull();
    }
  });
});

describe('allowsFileOpen (page-initiated opens: drops, links, window.open)', () => {
  const WEB = 'https://example.com/';
  it('lets every non-file target through untouched', () => {
    expect(allowsFileOpen('https://example.com/a', WEB)).toBe(true);
    expect(allowsFileOpen('voksa://settings', WEB)).toBe(true);
    expect(allowsFileOpen('about:blank', '')).toBe(true);
  });

  it('lets a passive local file open from anywhere', () => {
    expect(allowsFileOpen('file:///C:/a.png', WEB)).toBe(true);
    expect(allowsFileOpen('file:///C:/a.pdf', '')).toBe(true);
  });

  it('blocks an active local file dropped on a web or blank page', () => {
    expect(allowsFileOpen('file:///C:/page.html', WEB)).toBe(false);
    expect(allowsFileOpen('file:///C:/logo.svg', 'about:blank')).toBe(false);
    expect(allowsFileOpen('file:///C:/Users/me/', '')).toBe(false);
  });

  it('keeps links between local pages working, as before', () => {
    expect(allowsFileOpen('file:///C:/site/other.html', 'file:///C:/site/index.html')).toBe(true);
    expect(allowsFileOpen('file:///C:/site/sub/', 'file:///C:/site/')).toBe(true);
  });

  it('NEVER lets a passive local file be the stepping stone for an active one', () => {
    // A picture opened with "Open file…", then an .html dropped onto it: the
    // opener is local, but it is not a page the user chose to trust.
    for (const opener of [
      'file:///C:/Users/me/Pictures/x.png',
      'file:///C:/Users/me/doc.pdf',
      'file:///C:/Users/me/notes.txt',
      'file:///C:/Users/me/clip.mp4',
    ]) {
      expect(allowsFileOpen('file:///C:/Users/me/Downloads/evil.html', opener), opener).toBe(false);
      expect(allowsFileOpen('file:///C:/Users/me/Downloads/logo.svg', opener), opener).toBe(false);
      expect(allowsFileOpen('file:///C:/Users/me/', opener), opener).toBe(false);
      // Another passive file is still fine from there.
      expect(allowsFileOpen('file:///C:/Users/me/Pictures/y.png', opener), opener).toBe(true);
    }
  });
});
