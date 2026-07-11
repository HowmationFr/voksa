import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Static-analysis guard for the IPC golden rule (CLAUDE.md section 6). It
// scans the SOURCE TEXT of src/main and src/preload (comments stripped first,
// so a commented-out call never satisfies an assertion) and cross-checks every
// channel against src/shared/ipcChannels.ts, so a half-wired channel fails CI
// with the exact file to fix instead of breaking silently at runtime.

const GOLDEN_RULE =
  'Golden rule (CLAUDE.md section 6): (1) constant in src/shared/ipcChannels.ts, ' +
  '(2) handler in src/main/ipc/handlers.ts, (3) exposure in src/preload/voksaApi.ts, ' +
  '(4) consumption in the UI via voksa.*';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// Identifiers after which a `/` opens a regex literal even though the previous
// char is a word char (`return /x/` is a regex, `total / x` is a division).
const REGEX_PREFIX_KEYWORDS = new Set([
  'return',
  'typeof',
  'case',
  'do',
  'else',
  'in',
  'of',
  'instanceof',
  'new',
  'delete',
  'void',
  'throw',
  'yield',
  'await',
]);

/**
 * Blanks out // and slash-star comments while copying string, template and
 * regex literal bodies verbatim: 'https://x' in a string and /\/\//i in a
 * regex must survive, but a commented-out `.send(IPC.X)` must disappear.
 * Newlines are preserved so the output keeps the original line structure.
 */
function stripComments(text: string): string {
  type Mode = 'code' | 'line' | 'block' | 'single' | 'double' | 'template' | 'regex' | 'class';
  let mode: Mode = 'code';
  let out = '';
  let prev = ''; // last non-whitespace char emitted while in code mode
  let word = ''; // identifier ending at prev (whitespace does not reset it)
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1] ?? '';
    if (mode === 'code') {
      if (c === '/' && (next === '/' || next === '*')) {
        mode = next === '/' ? 'line' : 'block';
        out += '  ';
        i += 2;
        continue;
      }
      if (c === '/') {
        // A slash right after a value (identifier, ')' or ']') is a division,
        // unless that identifier is a keyword; anything else opens a regex
        // literal whose body must be skipped opaquely.
        const afterValue = /[\w$)\]]/.test(prev) && !REGEX_PREFIX_KEYWORDS.has(word);
        if (!afterValue) mode = 'regex';
      } else if (c === "'") mode = 'single';
      else if (c === '"') mode = 'double';
      else if (c === '`') mode = 'template';
      if (/[A-Za-z0-9_$]/.test(c)) word += c;
      else if (!/\s/.test(c)) word = '';
      if (!/\s/.test(c)) prev = c;
      out += c;
      i += 1;
      continue;
    }
    if (mode === 'line') {
      if (c === '\n') {
        mode = 'code';
        out += '\n';
      } else {
        out += ' ';
      }
      i += 1;
      continue;
    }
    if (mode === 'block') {
      if (c === '*' && next === '/') {
        mode = 'code';
        out += '  ';
        i += 2;
        continue;
      }
      out += c === '\n' ? '\n' : ' ';
      i += 1;
      continue;
    }
    // Literal bodies (single/double/template/regex/class) are copied verbatim.
    if (c === '\\') {
      out += c + next;
      i += 2;
      continue;
    }
    if (
      (mode === 'single' && c === "'") ||
      (mode === 'double' && c === '"') ||
      (mode === 'template' && c === '`') ||
      (mode === 'regex' && c === '/')
    ) {
      mode = 'code';
      prev = ')'; // a closed literal counts as a value for the division check
      word = '';
    } else if (mode === 'regex' && c === '[') {
      mode = 'class'; // '/' inside a character class does not end the regex
    } else if (mode === 'class' && c === ']') {
      mode = 'regex';
    }
    out += c;
    i += 1;
  }
  return out;
}

interface SourceFile {
  path: string; // repo-relative with forward slashes, for stable messages
  text: string;
}

function collectTsFiles(dir: string, out: SourceFile[] = []): SourceFile[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') collectTsFiles(full, out);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      out.push({
        path: relative(ROOT, full).replace(/\\/g, '/'),
        text: stripComments(readFileSync(full, 'utf8')),
      });
    }
  }
  return out;
}

const mainFiles = collectTsFiles(join(ROOT, 'src', 'main'));
const preloadFiles = collectTsFiles(join(ROOT, 'src', 'preload'));

/** Channel key (e.g. TAB_CREATE) to the set of files where the pattern matched. */
type Usage = Map<string, Set<string>>;

function scan(files: SourceFile[], re: RegExp): Usage {
  const usage: Usage = new Map();
  for (const file of files) {
    for (const match of file.text.matchAll(re)) {
      const key = match[1];
      if (!usage.has(key)) usage.set(key, new Set());
      usage.get(key)!.add(file.path);
    }
  }
  return usage;
}

// Subscriptions: ipcRenderer.on(IPC.X directly (page.ts) or voksaApi's local
// on<T>(IPC.X helper; \bon matches both (the dot before "on" is a word
// boundary) and the optional generic tolerates one level of nesting
// (on<Map<string, X>>(IPC.Y) as well as on<T>(IPC.Y)).
const SUBSCRIBE_RE = /\bon(?:<(?:[^<>]|<[^<>]*>)*>)?\s*\(\s*IPC\.([A-Z0-9_]+)/g;

// \s* between the call and IPC.X spans newlines, so multi-line registrations
// like `ipcMain.handle(\n  IPC.FIND_START,` are captured too.
const mainHandles = scan(mainFiles, /ipcMain\.handle\s*\(\s*IPC\.([A-Z0-9_]+)/g);
const mainOns = scan(mainFiles, /ipcMain\.on\s*\(\s*IPC\.([A-Z0-9_]+)/g);
// Main-to-renderer pushes: chromeView.webContents.send, frame.send, wc.send...
const mainSends = scan(mainFiles, /\.send\s*\(\s*IPC\.([A-Z0-9_]+)/g);
// Frame-targeted pushes (frame.send over mainFrame.framesInSubtree): the only
// delivery that reaches SUBFRAME preloads; a webContents-level send reaches
// the main frame alone. The receiver must end in "frame"/"Frame".
const mainFrameSends = scan(mainFiles, /\b[\w$]*[fF]rame\.send\s*\(\s*IPC\.([A-Z0-9_]+)/g);
const preloadInvokes = scan(preloadFiles, /ipcRenderer\.invoke\s*\(\s*IPC\.([A-Z0-9_]+)/g);
const preloadSends = scan(preloadFiles, /ipcRenderer\.send(?:Sync)?\s*\(\s*IPC\.([A-Z0-9_]+)/g);
const preloadSubscribes = scan(preloadFiles, SUBSCRIBE_RE);

// Channels subscribed by the PAGE preload specifically: page.ts runs in every
// frame of every tab (nodeIntegrationInSubFrames), so its subscriptions need
// the stronger frame-targeted delivery asserted below. Derived by scanning
// page.ts itself: a future page.ts subscription inherits the requirement.
const PAGE_PRELOAD = 'src/preload/page.ts';
const pageSubscribes = scan(
  preloadFiles.filter((f) => f.path === PAGE_PRELOAD),
  SUBSCRIBE_RE,
);

// Declared constants: KEY -> channel string.
const channelsSource = stripComments(readFileSync(join(ROOT, 'src', 'shared', 'ipcChannels.ts'), 'utf8'));
const declared = new Map<string, string>();
for (const m of channelsSource.matchAll(/^\s*([A-Z][A-Z0-9_]*):\s*'([^']+)'/gm)) {
  declared.set(m[1], m[2]);
}

function label(key: string): string {
  const value = declared.get(key);
  return value ? `IPC.${key} ('${value}')` : `IPC.${key}`;
}

function fileList(usage: Usage, key: string): string {
  return [...(usage.get(key) ?? [])].join(', ');
}

describe('IPC contract (static analysis of src/main + src/preload)', () => {
  it('scanner sanity: constants parsed and every usage kind found at least once', () => {
    // If any of these hit zero, a regex (or the codebase layout) rotted and
    // the real assertions below would pass vacuously.
    expect(declared.size).toBeGreaterThan(50);
    const usages = [
      mainHandles,
      mainOns,
      mainSends,
      mainFrameSends,
      preloadInvokes,
      preloadSends,
      preloadSubscribes,
      pageSubscribes,
    ];
    for (const usage of usages) {
      expect(usage.size).toBeGreaterThan(0);
    }
  });

  it('comment stripper: blanks comments, keeps strings and regex literals intact', () => {
    // Guards the pre-pass itself: if it ever eats real code (regex literals
    // are the classic hazard), the usage scans above would silently shrink.
    const stripped = stripComments(
      [
        "wc.send(IPC.KEPT); // wc.send(IPC.LINE_COMMENTED)",
        "/* wc.send(IPC.BLOCK_COMMENTED) */",
        "const url = 'https://example.com'; wc.send(IPC.AFTER_STRING);",
        "if (/^https?:\\/\\//i.test(u)) wc.send(IPC.AFTER_REGEX);",
        "return /x\\/[/]y/.source; wc.send(IPC.AFTER_KEYWORD_REGEX);",
      ].join('\n'),
    );
    for (const kept of ['KEPT', 'AFTER_STRING', 'AFTER_REGEX', 'AFTER_KEYWORD_REGEX', 'https://example.com']) {
      expect(stripped).toContain(kept);
    }
    expect(stripped).not.toContain('LINE_COMMENTED');
    expect(stripped).not.toContain('BLOCK_COMMENTED');
    expect(stripped.split('\n')).toHaveLength(5); // line structure preserved
  });

  it('never references a channel by raw string literal', () => {
    // Channel-shaped literals ('word:word' with optional extra ':'/'-'/'_'
    // segments) as first arg of a call on an IPC-ish receiver (ipcMain,
    // ipcRenderer, a webContents, a frame, event.sender). Plain EventEmitters
    // may legitimately use colon-y event names, so they are not matched.
    const rawLiteral =
      /\b(?:ipcMain|ipcRenderer|wc|sender|contents|[\w$]*[wW]ebContents|[\w$]*[fF]rame)\.(?:handle|on|once|invoke|send|sendSync|sendToFrame)\s*\(\s*(['"`])([a-z][\w-]*:[\w-]+(?::[\w-]+)*)\1/g;
    const problems: string[] = [];
    for (const file of [...mainFiles, ...preloadFiles]) {
      for (const m of file.text.matchAll(rawLiteral)) {
        problems.push(`${file.path} uses raw channel literal '${m[2]}'; reference it as IPC.X instead. ${GOLDEN_RULE}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('every ipcRenderer.invoke() channel is registered via ipcMain.handle()', () => {
    const problems: string[] = [];
    for (const key of preloadInvokes.keys()) {
      if (mainHandles.has(key)) continue;
      const hint = mainOns.has(key)
        ? 'it is registered with ipcMain.on(), but invoke() resolves only through ipcMain.handle()'
        : 'no ipcMain.handle() found anywhere in src/main';
      problems.push(
        `${label(key)} is invoked from ${fileList(preloadInvokes, key)} but ${hint}; fix src/main/ipc/handlers.ts. ${GOLDEN_RULE}`,
      );
    }
    expect(problems).toEqual([]);
  });

  it('every ipcMain.handle() channel is invoked by some preload', () => {
    // Reverse direction: a handler nobody calls is dead weight, or (worse) the
    // preload exposure was renamed/removed while the handler stayed behind.
    const problems: string[] = [];
    for (const key of mainHandles.keys()) {
      if (preloadInvokes.has(key)) continue;
      problems.push(
        `${label(key)} is handled in ${fileList(mainHandles, key)} but no preload ever invoke()s it ` +
          `(dead handler); expose it in src/preload/voksaApi.ts or remove the handler. ${GOLDEN_RULE}`,
      );
    }
    expect(problems).toEqual([]);
  });

  it('every ipcRenderer.send()/sendSync() channel is registered via ipcMain.on()', () => {
    const problems: string[] = [];
    for (const key of preloadSends.keys()) {
      if (mainOns.has(key)) continue;
      const hint = mainHandles.has(key)
        ? 'it is registered with ipcMain.handle(), but send()/sendSync() are only delivered to ipcMain.on()'
        : 'no ipcMain.on() found anywhere in src/main';
      problems.push(
        `${label(key)} is sent from ${fileList(preloadSends, key)} but ${hint}; fix src/main/ipc/handlers.ts. ${GOLDEN_RULE}`,
      );
    }
    expect(problems).toEqual([]);
  });

  it('every channel subscribed in a preload is pushed by a .send() in src/main', () => {
    const problems: string[] = [];
    for (const key of preloadSubscribes.keys()) {
      if (mainSends.has(key)) continue;
      problems.push(
        `${label(key)} is subscribed in ${fileList(preloadSubscribes, key)} but src/main never .send()s it; ` +
          `wire the push in src/main/ipc/handlers.ts (or the owning controller). ${GOLDEN_RULE}`,
      );
    }
    expect(problems).toEqual([]);
  });

  it('every channel pushed by src/main is subscribed by some preload', () => {
    // Reverse direction: a push nobody listens to lands nowhere, usually
    // because the preload listener was removed while the send stayed behind.
    const problems: string[] = [];
    for (const key of mainSends.keys()) {
      if (preloadSubscribes.has(key)) continue;
      problems.push(
        `${label(key)} is sent from ${fileList(mainSends, key)} but no preload subscribes to it ` +
          `(push lands nowhere); add the listener in src/preload/voksaApi.ts or page.ts, or drop the send. ${GOLDEN_RULE}`,
      );
    }
    expect(problems).toEqual([]);
  });

  it('every channel subscribed in page.ts has a frame-targeted push in src/main', () => {
    // page.ts runs in EVERY frame of every tab (nodeIntegrationInSubFrames).
    // The generic subscribe/send pairing above is audience-blind: for
    // STREAM_CONFIG_CHANGED it would stay green if the framesInSubtree loop in
    // handlers.ts were deleted, because the chromeView send alone satisfies
    // it (and "two distinct send sites" would not help either: handlers.ts
    // already has two chromeView sends for that channel). So pin the delivery
    // that actually reaches page.ts: a frame.send(IPC.X) whose receiver ends
    // in "frame"/"Frame", i.e. the per-frame loop with its wc.send fallback.
    const problems: string[] = [];
    for (const key of pageSubscribes.keys()) {
      if (mainFrameSends.has(key)) continue;
      problems.push(
        `${label(key)} is subscribed in ${PAGE_PRELOAD} (which runs in every tab frame) but src/main has no ` +
          `frame-targeted push; a webContents-level send only reaches main frames, starving subframe maskers. ` +
          `Push it via frame.send(IPC.${key}) over wc.mainFrame.framesInSubtree (see the stream config ` +
          `broadcast in src/main/ipc/handlers.ts). ${GOLDEN_RULE}`,
      );
    }
    expect(problems).toEqual([]);
  });

  it('every declared channel is used, and every used channel is declared', () => {
    const used = new Set<string>();
    for (const usage of [mainHandles, mainOns, mainSends, preloadInvokes, preloadSends, preloadSubscribes]) {
      for (const key of usage.keys()) used.add(key);
    }
    const problems: string[] = [];
    for (const key of declared.keys()) {
      if (!used.has(key)) {
        problems.push(
          `${label(key)} is declared in src/shared/ipcChannels.ts but never handled, sent, invoked ` +
            `or subscribed in src/main or src/preload (dead channel); remove it or wire it. ${GOLDEN_RULE}`,
        );
      }
    }
    // Any IPC.X token (even outside the call shapes above) must be declared:
    // catches references to renamed or deleted constants.
    for (const file of [...mainFiles, ...preloadFiles]) {
      for (const m of file.text.matchAll(/\bIPC\.([A-Z][A-Z0-9_]*)\b/g)) {
        if (!declared.has(m[1])) {
          problems.push(`IPC.${m[1]} referenced in ${file.path} is not declared in src/shared/ipcChannels.ts. ${GOLDEN_RULE}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});
