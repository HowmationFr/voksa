import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import credits from '../credits.generated.json';

/**
 * credits.generated.json is written by scripts/gen-credits.mjs and committed.
 * A committed artefact can go stale, and a stale credits page is the one bug
 * this feature must not have: it would claim we ship a set of projects that is
 * not the set we ship. These tests are the staleness alarm.
 */

const ROOT = path.resolve(__dirname, '..', '..', '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const byName = new Map(credits.map((entry) => [entry.name, entry]));

describe('credits.generated.json', () => {
  it('credits every runtime dependency (regenerate with `npm run gen:credits`)', () => {
    const missing = Object.keys(pkg.dependencies ?? {}).filter((name) => !byName.has(name));
    expect(missing).toEqual([]);
  });

  it('credits what is bundled into the shipped UI and the runtime itself', () => {
    // Dev deps by package.json's reckoning, but their code IS in the artefact:
    // React and friends are compiled into dist-ui, Electron is the runtime.
    for (const name of ['react', 'react-dom', 'zustand', 'lucide-react', 'electron']) {
      expect(byName.has(name), name).toBe(true);
    }
    // Not npm packages, so nothing local would ever surface them.
    for (const name of ['Chromium', 'Node.js']) {
      expect(byName.has(name), name).toBe(true);
    }
  });

  it('states a licence for every project, and can show it or link to it', () => {
    for (const entry of credits) {
      expect(entry.license, entry.name).toBeTruthy();
      expect(entry.license, entry.name).not.toBe('Unknown');
      // The page must be able to render something legally meaningful: either
      // the verbatim text we ship, or a link to the canonical one.
      expect(Boolean(entry.text || entry.licenseUrl), entry.name).toBe(true);
    }
  });

  it('does not credit build-only tooling (nothing of theirs is distributed)', () => {
    for (const name of ['vite', 'esbuild', 'eslint', 'vitest', 'electron-builder', 'typescript']) {
      expect(byName.has(name), name).toBe(false);
    }
  });
});
