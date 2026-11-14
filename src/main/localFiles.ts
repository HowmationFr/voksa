/**
 * Disk-side validation of the local files Voksa opens for the user ("Open
 * file…", a file dropped on the window). The type rules live in
 * shared/localFiles.ts; this adds what only the main process can know: the
 * path is absolute, exists, and is a regular file.
 *
 * No electron import, on purpose: the unit tests run it as plain Node.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isOpenableLocalPath } from '../shared/localFiles';

/** A drop of a whole folder's worth of pictures must not spawn 400 renderers. */
export const MAX_FILES_PER_OPEN = 20;

/**
 * The file: URL of `candidate` when it is an absolute path to an existing,
 * regular file of an openable type; null for anything else. `unknown` and
 * never throwing because the value crosses IPC from a renderer.
 */
export function openableFileUrl(candidate: unknown): string | null {
  if (typeof candidate !== 'string' || candidate.length === 0) return null;
  if (!path.isAbsolute(candidate) || !isOpenableLocalPath(candidate)) return null;
  try {
    // statSync follows links: a shortcut to a folder is a folder.
    if (!fs.statSync(candidate).isFile()) return null;
    return pathToFileURL(candidate).href;
  } catch {
    // Missing, unreadable, or a path Node refuses (embedded NUL...).
    return null;
  }
}

/** The openable entries of a list of paths, in order, each once, capped. */
export function openableFileUrls(candidates: unknown): string[] {
  if (!Array.isArray(candidates)) return [];
  const urls: string[] = [];
  for (const candidate of candidates) {
    if (urls.length >= MAX_FILES_PER_OPEN) break;
    const url = openableFileUrl(candidate);
    if (url !== null && !urls.includes(url)) urls.push(url);
  }
  return urls;
}
