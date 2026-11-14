/**
 * Local files Voksa agrees to open on the user's behalf: "Open file…", a file
 * dropped on the window, a path typed in the address bar.
 *
 * PASSIVE TYPES ONLY, and that is a security boundary, not a convenience.
 * Electron grants file:// documents privileges no browser gives them (the
 * grantFileProtocolExtraPrivileges fuse, on by default and required for now
 * because the chrome UI itself is served from file://): a local page can read
 * any other local file and fetch any site without CORS. A document that runs
 * script (HTML, SVG, XML + XSLT) must therefore never be opened by a one-click
 * gesture; an image, a PDF, a text or a media file runs nothing.
 *
 * Chromium picks the type of a file:// document from its EXTENSION, so the
 * extension is the right thing to judge: an HTML payload renamed .png is
 * rendered as a (broken) image, never as a page.
 *
 * Pure module, no runtime dependency: the main process and the tests import
 * it directly.
 */

/** Raster images Chromium displays as an image document. */
export const OPENABLE_IMAGE_EXTENSIONS: readonly string[] = [
  'png',
  'jpg',
  'jpeg',
  'jfif',
  'gif',
  'webp',
  'avif',
  'bmp',
  'ico',
  'apng',
];

/** Everything openable: images, then PDF, plain text, video and audio. */
export const OPENABLE_EXTENSIONS: readonly string[] = [
  ...OPENABLE_IMAGE_EXTENSIONS,
  'pdf',
  'txt',
  'mp4',
  'webm',
  'ogv',
  'mp3',
  'ogg',
  'wav',
  'flac',
  'm4a',
];

const OPENABLE = new Set(OPENABLE_EXTENSIONS);

export type PathPlatform = 'win32' | 'posix';

/** True when the LAST segment of a path (either separator) has an openable extension. */
export function isOpenableLocalPath(pathOrName: string): boolean {
  // A control character has no business in a path, and an embedded NUL is the
  // classic way to make two layers disagree on where a name ends
  // ("page.html\0.png"): refuse rather than reason about it.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(pathOrName)) return false;
  const name = pathOrName.slice(Math.max(pathOrName.lastIndexOf('/'), pathOrName.lastIndexOf('\\')) + 1);
  const dot = name.lastIndexOf('.');
  // dot <= 0: no extension at all, or a dotfile whose whole name is ".png".
  if (dot <= 0) return false;
  return OPENABLE.has(name.slice(dot + 1).toLowerCase());
}

export function isFileUrl(url: string): boolean {
  return /^file:/i.test(url);
}

/** A file: URL whose PATH (never its query or fragment) names an openable file. */
export function isOpenableFileUrl(url: string): boolean {
  if (!isFileUrl(url)) return false;
  try {
    // Decoded, so an escaped dot or separator is judged as what it resolves to.
    return isOpenableLocalPath(decodeURIComponent(new URL(url).pathname));
  } catch {
    return false;
  }
}

/** Escape one path segment: what a URL would cut the path at, and nothing prettier. */
function encodeSegment(segment: string): string {
  return encodeURI(segment).replace(/#/g, '%23').replace(/\?/g, '%3F');
}

/**
 * Turn an absolute local path, as typed or pasted, into a file: URL. Null for
 * anything else: a relative path, a folder, a type that is not openable, a
 * path of the other platform. Syntax only; whether the file exists is the
 * loader's business (a missing file gets the regular error page).
 *
 * One pair of surrounding double quotes is dropped: that is exactly what
 * Explorer's "Copy as path" puts on the clipboard.
 */
export function localPathToFileUrl(input: string, platform: PathPlatform): string | null {
  let text = input.trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) text = text.slice(1, -1).trim();
  if (!text) return null;

  let host = '';
  let path: string;
  if (platform === 'win32') {
    if (/^[a-zA-Z]:[\\/]/.test(text)) {
      path = `/${text.replace(/\\/g, '/')}`;
    } else {
      // \\server\share\file: the server becomes the URL host.
      const unc = /^\\\\([\w.-]+)[\\/](.+)$/.exec(text);
      if (!unc) return null;
      host = unc[1];
      path = `/${unc[2].replace(/\\/g, '/')}`;
    }
  } else {
    // "//host/x" is a protocol-relative URL, not a path.
    if (!text.startsWith('/') || text.startsWith('//')) return null;
    path = text;
  }
  if (!isOpenableLocalPath(path)) return null;
  try {
    return `file://${host}${path.split('/').map(encodeSegment).join('/')}`;
  } catch {
    // encodeURI throws on a lone surrogate: not a path worth opening.
    return null;
  }
}

/**
 * May a PAGE-INITIATED open (a file dropped on a page, a link, window.open)
 * reach `targetUrl`? Everything that is not a local file passes untouched. A
 * local file passes when it is a passive type, or when the page asking is
 * itself an ACTIVE local document (a local HTML page the user opened by its
 * file:// address): links between local pages keep working exactly as before.
 *
 * What is refused is the new door: an active local document dropped onto a
 * web page, or onto a tab showing a passive local file. That second case is
 * why the opener must be active and not merely local: a picture opened with
 * "Open file…" must not become the stepping stone that lets the next dropped
 * .html through.
 */
export function allowsFileOpen(targetUrl: string, openerUrl: string): boolean {
  if (!isFileUrl(targetUrl)) return true;
  if (isOpenableFileUrl(targetUrl)) return true;
  return isFileUrl(openerUrl) && !isOpenableFileUrl(openerUrl);
}
