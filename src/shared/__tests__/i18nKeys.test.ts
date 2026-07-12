/**
 * Locks the English i18n dictionaries to the source code.
 *
 * The FRENCH source string is the dictionary key (see ../i18n/index.ts): a
 * missing EN entry silently falls back to French, so dictionary drift never
 * crashes; it just ships untranslated (forward drift) or orphaned (reverse
 * drift) strings. These tests catch both directions by scanning the raw
 * sources under src/:
 *  - FORWARD: every t('...') literal must be a key of the merged EN map.
 *  - INDIRECTION: some French strings reach t() through a variable, e.g.
 *    t(card.label) over a local config array. Those literals live in fields
 *    of config structures; each such structure is registered in INDIRECTIONS
 *    below and its extracted strings must be keys of the merged EN map too.
 *  - CENSUS: every non-literal t(...) call site in src/ must be accounted
 *    for by NON_LITERAL_T_SITES, so introducing a NEW t(variable) pattern
 *    fails this suite (register its config structure in INDIRECTIONS and the
 *    call site in NON_LITERAL_T_SITES) instead of silently escaping both
 *    checks above.
 *  - REVERSE: every EN key must be reachable through one of those two
 *    channels (a t('...') literal or a registered indirection string);
 *    rewording a French source string orphans its EN entry.
 *  - SHADOWING: two domain files must not translate the same key differently
 *    (the later one in the merge order of index.ts silently wins).
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { enChrome } from '../i18n/en/chrome';
import { enMenus } from '../i18n/en/menus';
import { enPages } from '../i18n/en/pages';
import { enSettings } from '../i18n/en/settings';
import { enStream } from '../i18n/en/stream';
import { enDialogs } from '../i18n/en/dialogs';
import { enMain } from '../i18n/en/main';

// Same merge order as src/shared/i18n/index.ts (later domains win).
const DOMAINS: Array<[name: string, dict: Record<string, string>]> = [
  ['chrome', enChrome],
  ['menus', enMenus],
  ['pages', enPages],
  ['settings', enSettings],
  ['stream', enStream],
  ['dialogs', enDialogs],
  ['main', enMain],
];

const EN: Record<string, string> = Object.assign({}, ...DOMAINS.map(([, dict]) => dict));

const SRC_DIR = fileURLToPath(new URL('../..', import.meta.url));

/**
 * All scannable sources: src/**\/*.{ts,tsx} minus __tests__ and the i18n
 * layer itself (the en/ dicts would match trivially, and the index.ts
 * docblock contains a t('...') usage example that is not a real key).
 */
function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue;
      if (full === path.join(SRC_DIR, 'shared', 'i18n')) continue;
      collectSourceFiles(full, out);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const FILES = collectSourceFiles(SRC_DIR).map((file) => ({
  rel: path.relative(SRC_DIR, file).split(path.sep).join('/'),
  text: fs.readFileSync(file, 'utf8'),
}));

/**
 * Matches t('...') / t("...") where t is a standalone identifier (rejects
 * split('...'), obj.t(...), useT(...)). Tolerates whitespace and newlines
 * between "t(" and the literal, and backslash escapes inside it (French
 * apostrophes are often written \' inside single quotes). Non-literal calls
 * like t(variable) or t(`template`) simply do not match; they are covered by
 * the INDIRECTION + CENSUS tests below.
 */
const T_CALL_RE = /(?<![A-Za-z0-9_$.])t\s*\(\s*('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*")/g;

/** Any single-line quoted string literal, either quote style. */
const STRING_LITERAL_RE = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g;

/** '\x' -> 'x' is enough here: keys never contain control escapes. */
function unquote(literal: string): string {
  return literal.slice(1, -1).replace(/\\(.)/g, '$1');
}

/** Best-guess domain file for a missing key, from the consumer's path. */
function suggestDomain(rel: string): string {
  if (rel.startsWith('main/')) return 'main';
  if (/(PrintDialog|ClearDataDialog|ConfirmDialog|ErrorBoundary)\.tsx$/.test(rel)) return 'dialogs';
  if (/(StreamPage|StreamModeSettings|PermissionPrompt|SiteSettingsPopover)\.tsx$/.test(rel)) return 'stream';
  if (/permissionLabels\.ts$/.test(rel)) return 'stream';
  if (/pages\/Settings\.tsx$/.test(rel)) return 'settings';
  if (rel.includes('components/pages/')) return 'pages';
  if (/(Menu\/|BookmarkBar\/|PageContextMenu|TabContextMenu)/.test(rel)) return 'menus';
  return 'chrome';
}

// ---------------------------------------------------------------------------
// Indirect t(variable) coverage
//
// A handful of components keep their French strings in local config
// structures and render them via t(entry.field). The forward regex cannot
// see those, so each structure is registered here with an extractor that
// pulls the quoted field values out of the raw source. MAINTAINED LIST: when
// you introduce a NEW t(variable) pattern anywhere in src/, the CENSUS test
// goes red; fix it by registering the config structure here (so its strings
// are required in the EN map) and the call site in NON_LITERAL_T_SITES.
//
// Deliberately NOT covered: the dynamic fallback in permissionLabels.ts
// (a template literal interpolating the raw Chromium permission name). It
// cannot be keyed since the permission name is only known at runtime; the
// French wrapper text falls back untranslated for unknown permissions.
// ---------------------------------------------------------------------------

/** Slice a config structure out of a source file, from marker to endRe. */
function sliceBlock(text: string, rel: string, marker: string, endRe: RegExp): string {
  const start = text.indexOf(marker);
  if (start === -1) {
    throw new Error(`indirection block '${marker}' not found in src/${rel}: update INDIRECTIONS`);
  }
  endRe.lastIndex = start + marker.length;
  const end = endRe.exec(text);
  if (!end) {
    throw new Error(`no end of block '${marker}' in src/${rel}: update INDIRECTIONS`);
  }
  return text.slice(start, end.index);
}

/**
 * Quoted values of the given object-literal fields ("label: '...'").
 * Non-literal values (label: t(...), label: p.displayName) and JSX props
 * (label={...}) do not match by construction.
 */
function fieldStrings(text: string, fields: string[]): string[] {
  const re = new RegExp(
    `(?<![A-Za-z0-9_$-])(?:${fields.join('|')})\\s*:\\s*('(?:[^'\\\\\\n]|\\\\.)*'|"(?:[^"\\\\\\n]|\\\\.)*")`,
    'g',
  );
  return [...text.matchAll(re)].map((m) => unquote(m[1]));
}

/** Every quoted literal in the block (for plain string arrays / map values). */
function allStrings(text: string): string[] {
  return [...text.matchAll(STRING_LITERAL_RE)].map((m) => unquote(m[0]));
}

type Indirection = {
  /** File (relative to src/) whose config structure feeds t(variable). */
  file: string;
  /** Extracts the French strings that structure routes into t(). */
  extract: (text: string, rel: string) => string[];
  /**
   * Anti-vacuity floor: at least this many strings must come out, so a
   * field rename or a broken extraction regex goes red instead of silently
   * extracting nothing.
   */
  min: number;
};

const INDIRECTIONS: Indirection[] = [
  {
    // CONTENT_MASKS / ACCESS_MASKS cards, rendered via t(card.label),
    // t(card.description), t(card.demo). 12 cards x 3 fields today.
    file: 'ui/components/pages/StreamPage.tsx',
    extract: (text, rel) => [
      ...fieldStrings(sliceBlock(text, rel, 'const CONTENT_MASKS', /\n\]/g), ['label', 'description', 'demo']),
      ...fieldStrings(sliceBlock(text, rel, 'const ACCESS_MASKS', /\n\]/g), ['label', 'description', 'demo']),
    ],
    min: 30,
  },
  {
    // RANGES (t(r.label)) and TYPES (t(item.label), t(item.description)).
    file: 'ui/components/ClearDataDialog.tsx',
    extract: (text, rel) => [
      ...fieldStrings(sliceBlock(text, rel, 'const RANGES', /\n\]/g), ['label', 'description']),
      ...fieldStrings(sliceBlock(text, rel, 'const TYPES', /\n\]/g), ['label', 'description']),
    ],
    min: 15,
  },
  {
    // Inline orientation options { v, label } rendered via t(o.label). The
    // whole file is scanned: its other label sites are JSX props or
    // non-literal values, which fieldStrings ignores by construction.
    file: 'ui/components/PrintDialog.tsx',
    extract: (text) => fieldStrings(text, ['label']),
    min: 2,
  },
  // NB: Settings.tsx used to route its THEMES labels through t(th.label). The
  // Chrome-style rewrite builds its section/row structure with ALREADY
  // translated strings (t('literal') results, never keys), so it has no
  // indirection left and no non-literal t() call site either.
  {
    // Byte-unit array rendered via t(units[i]) in formatBytes.
    file: 'ui/components/pages/Downloads.tsx',
    extract: (text, rel) => allStrings(sliceBlock(text, rel, 'const units = [', /\]/g)),
    min: 4,
  },
  {
    // MESSAGES map (error code -> French message) rendered via t(known).
    file: 'ui/components/pages/ErrorPage.tsx',
    extract: (text, rel) => allStrings(sliceBlock(text, rel, 'const MESSAGES', /\n\}/g)),
    min: 5,
  },
  {
    // PERMISSIONS meta: name feeds t(permissionName(...)) in
    // SiteSettingsPopover, request feeds t(permissionRequestLabel(...)) in
    // PermissionPrompt. The template-literal fallback of
    // permissionRequestLabel is excluded on purpose (see comment above).
    file: 'ui/lib/permissionLabels.ts',
    extract: (text, rel) => fieldStrings(sliceBlock(text, rel, 'const PERMISSIONS', /\n\}/g), ['name', 'request']),
    min: 14,
  },
];

/**
 * Expected non-literal t(...) call sites per file (comment mentions of
 * "t()" and the t() declaration itself are filtered out by the census).
 * Every file listed here must have its config structure registered in
 * INDIRECTIONS, possibly through another file (PermissionPrompt and
 * SiteSettingsPopover both read src/ui/lib/permissionLabels.ts).
 */
const NON_LITERAL_T_SITES: Record<string, number> = {
  'ui/components/ClearDataDialog.tsx': 3, // t(r.label), t(item.label), t(item.description)
  'ui/components/PermissionPrompt.tsx': 1, // t(permissionRequestLabel(...))
  'ui/components/PrintDialog.tsx': 1, // t(o.label)
  'ui/components/SiteSettingsPopover.tsx': 1, // t(permissionName(...))
  'ui/components/pages/Downloads.tsx': 1, // t(units[i])
  'ui/components/pages/ErrorPage.tsx': 1, // t(known)
  'ui/components/pages/StreamPage.tsx': 3, // t(card.label), t(card.description), t(card.demo)
};

/** Count t(...) call sites whose argument is not a string literal. */
function countNonLiteralTCalls(text: string): number {
  let count = 0;
  for (const m of text.matchAll(/(?<![A-Za-z0-9_$.])t\s*\(/g)) {
    const index = m.index ?? 0;
    // The t() declaration in main/i18n.ts is not a call.
    if (/function\s+$/.test(text.slice(Math.max(0, index - 12), index))) continue;
    const after = text.slice(index + m[0].length);
    // "t()" only ever appears in comments (t always takes a source string).
    if (/^\s*\)/.test(after)) continue;
    // Literal argument: already covered by the FORWARD test.
    if (/^\s*['"]/.test(after)) continue;
    count += 1;
  }
  return count;
}

/** Extracted per registered indirection file; memoized for REVERSE reuse. */
let indirectionCache: Map<string, string[]> | null = null;
function indirectionStrings(): Map<string, string[]> {
  if (indirectionCache) return indirectionCache;
  const map = new Map<string, string[]>();
  for (const { file, extract } of INDIRECTIONS) {
    const source = FILES.find((f) => f.rel === file);
    if (!source) throw new Error(`INDIRECTIONS lists missing file src/${file}`);
    map.set(file, extract(source.text, source.rel));
  }
  indirectionCache = map;
  return map;
}

describe('i18n dictionaries vs source code', () => {
  it('FORWARD: every t(<literal>) call in src has an English entry', () => {
    const missing: string[] = [];
    let extracted = 0;
    for (const { rel, text } of FILES) {
      for (const match of text.matchAll(T_CALL_RE)) {
        extracted += 1;
        const key = unquote(match[1]);
        if (!(key in EN)) {
          missing.push(`'${key}' used in src/${rel}: add it to src/shared/i18n/en/${suggestDomain(rel)}.ts`);
        }
      }
    }
    // Guard against the extractor silently matching nothing (a broken regex
    // would otherwise make this test pass on any codebase). 324 sites today.
    expect(extracted).toBeGreaterThan(300);
    expect(missing).toEqual([]);
  });

  it('INDIRECTION: every French string routed to t() via a config structure has an English entry', () => {
    const missing: string[] = [];
    for (const { file, min } of INDIRECTIONS) {
      const strings = indirectionStrings().get(file) ?? [];
      // Per-file anti-vacuity floor: a silently broken extractor goes red.
      expect(strings.length, `too few strings extracted from src/${file}`).toBeGreaterThanOrEqual(min);
      for (const key of strings) {
        if (!(key in EN)) {
          missing.push(`'${key}' routed to t() via src/${file}: add it to src/shared/i18n/en/${suggestDomain(file)}.ts`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('CENSUS: every non-literal t(...) call site is a known, registered indirection', () => {
    // If this fails on a file you just touched, you introduced a t(variable)
    // pattern: register its config structure in INDIRECTIONS (so its strings
    // are checked against the EN map) and the call site count here.
    const found: Record<string, number> = {};
    for (const { rel, text } of FILES) {
      const count = countNonLiteralTCalls(text);
      if (count > 0) found[rel] = count;
    }
    expect(found).toEqual(NON_LITERAL_T_SITES);
  });

  it('REVERSE: every English key is reachable from a t() literal or a registered indirection', () => {
    // Stricter than a raw corpus.includes() scan: a reworded French source
    // whose old string happens to survive in an unrelated literal or comment
    // is still flagged, because only strings that actually flow into t()
    // count as usage.
    const used = new Set<string>();
    for (const { text } of FILES) {
      for (const match of text.matchAll(T_CALL_RE)) used.add(unquote(match[1]));
    }
    for (const strings of indirectionStrings().values()) {
      for (const key of strings) used.add(key);
    }
    const orphans: string[] = [];
    for (const [domain, dict] of DOMAINS) {
      for (const key of Object.keys(dict)) {
        if (!used.has(key)) {
          orphans.push(`'${key}' in src/shared/i18n/en/${domain}.ts flows into no t() call (reworded source string?)`);
        }
      }
    }
    // Same anti-vacuity guard as above: the dictionaries are known to be big.
    expect(Object.keys(EN).length).toBeGreaterThan(150);
    expect(orphans).toEqual([]);
  });

  it('SHADOWING: no key is translated differently by two domain files', () => {
    // Re-listing a key with the SAME value in several domains is deliberate
    // (each file stays readable per component) and harmless: the merge
    // collapses identical entries. Diverging values are the real hazard: only
    // the last domain in the merge order is ever displayed, so the earlier
    // translation is dead text that someone will edit for nothing.
    const seen = new Map<string, Array<{ domain: string; value: string }>>();
    for (const [domain, dict] of DOMAINS) {
      for (const [key, value] of Object.entries(dict)) {
        const entries = seen.get(key) ?? [];
        entries.push({ domain, value });
        seen.set(key, entries);
      }
    }
    const conflicts: string[] = [];
    for (const [key, entries] of seen) {
      if (entries.length > 1 && new Set(entries.map((e) => e.value)).size > 1) {
        const detail = entries.map((e) => `en/${e.domain}.ts: '${e.value}'`).join(' vs ');
        conflicts.push(`'${key}' diverges (${detail}); the last one wins in the merge`);
      }
    }
    expect(conflicts).toEqual([]);
  });
});
