import { describe, it, expect } from 'vitest';
import {
  BUILTIN_ENGINES,
  DEFAULT_SEARCH_ENGINE,
  MAX_CUSTOM_ENGINES,
  SEARCH_ENGINES,
  SEARCH_ENGINE_ORDER,
  buildSearchUrl,
  findEngineByKeyword,
  getEngine,
  isBuiltinEngineId,
  newCustomEngineId,
  normalizeKeyword,
  resolveEngines,
  sanitizeCustomEngines,
  searchUrlFor,
  suggestUrlFor,
  validateCustomEngine,
  type CustomSearchEngine,
} from '../searchEngines';

const WIKI: CustomSearchEngine = {
  id: 'custom:1',
  name: 'Wikipédia',
  keyword: 'wikipedia.org',
  searchUrl: 'https://fr.wikipedia.org/w/index.php?search=%s',
};

describe('the built-in registry', () => {
  it('lists every engine exactly once, in a display order that matches the table', () => {
    // The bug this catches: adding an engine to SEARCH_ENGINES and forgetting
    // SEARCH_ENGINE_ORDER. The engine would then exist, be selectable through a
    // hand-edited settings file, and be invisible everywhere in the UI.
    expect([...SEARCH_ENGINE_ORDER].sort()).toEqual(Object.keys(SEARCH_ENGINES).sort());
    expect(new Set(SEARCH_ENGINE_ORDER).size).toBe(SEARCH_ENGINE_ORDER.length);
  });

  it('gives every engine a name, a unique keyword, and an https template with %s', () => {
    const keywords = new Set<string>();
    for (const engine of BUILTIN_ENGINES) {
      expect(engine.name.trim(), engine.id).not.toBe('');
      expect(engine.keyword, engine.id).toMatch(/^[a-z0-9.-]+$/);
      expect(keywords.has(engine.keyword), `${engine.id}: duplicate keyword`).toBe(false);
      keywords.add(engine.keyword);
      expect(engine.searchUrl, engine.id).toMatch(/^https:\/\//);
      expect(engine.searchUrl, engine.id).toContain('%s');
      if (engine.suggestUrl !== null) {
        expect(engine.suggestUrl, engine.id).toMatch(/^https:\/\//);
        expect(engine.suggestUrl.split('{q}').length - 1, engine.id).toBe(1);
      }
    }
  });

  it('defaults to a shipped engine', () => {
    expect(isBuiltinEngineId(DEFAULT_SEARCH_ENGINE)).toBe(true);
  });
});

describe('buildSearchUrl', () => {
  it('substitutes the encoded query for %s', () => {
    expect(buildSearchUrl(WIKI as never, 'chats & chiens')).toBe(
      'https://fr.wikipedia.org/w/index.php?search=chats%20%26%20chiens',
    );
  });

  it('appends the query when the template has no %s (a pasted search prefix)', () => {
    const bare = { ...WIKI, searchUrl: 'https://example.com/?q=' };
    expect(buildSearchUrl(bare as never, 'x')).toBe('https://example.com/?q=x');
  });

  it('encodes the query', () => {
    expect(searchUrlFor('duckduckgo', 'chats & chiens')).toBe(
      'https://duckduckgo.com/?q=chats%20%26%20chiens',
    );
  });
});

describe('getEngine / suggestUrlFor', () => {
  it('falls back to the default engine when the id is unknown', () => {
    // A settings.json can say anything; nothing downstream may throw.
    expect(getEngine('askjeeves').id).toBe(DEFAULT_SEARCH_ENGINE);
    expect(searchUrlFor('askjeeves', 'x')).toBe(searchUrlFor(DEFAULT_SEARCH_ENGINE, 'x'));
  });

  it('returns null for an engine with no autocomplete endpoint', () => {
    expect(suggestUrlFor('startpage', 'x')).toBeNull();
    expect(suggestUrlFor('qwant', 'x')).toBeNull();
    expect(suggestUrlFor('google', 'a b')).toContain('a%20b');
  });
});

describe('custom engines', () => {
  it('lives alongside the built-ins, and is findable by its keyword', () => {
    const engines = resolveEngines([WIKI]);
    expect(engines).toHaveLength(BUILTIN_ENGINES.length + 1);
    expect(getEngine('custom:1', engines).name).toBe('Wikipédia');
    expect(findEngineByKeyword('wikipedia.org', engines)?.id).toBe('custom:1');
    expect(buildSearchUrl(getEngine('custom:1', engines), 'Voksa')).toBe(
      'https://fr.wikipedia.org/w/index.php?search=Voksa',
    );
    // We cannot know a custom engine's autocomplete endpoint, and inventing one
    // would 404 on every keystroke.
    expect(getEngine('custom:1', engines).suggestUrl).toBeNull();
  });

  it('refuses what it cannot honour', () => {
    const ok = { name: 'X', keyword: 'x.com', searchUrl: 'https://x.com/?q=%s' };
    expect(validateCustomEngine(ok, BUILTIN_ENGINES)).toBeNull();

    expect(validateCustomEngine({ ...ok, name: '  ' }, BUILTIN_ENGINES)).toBe('name');
    expect(validateCustomEngine({ ...ok, keyword: '' }, BUILTIN_ENGINES)).toBe('keyword');
    // A keyword already used would make tab-to-search ambiguous.
    expect(validateCustomEngine({ ...ok, keyword: 'google.com' }, BUILTIN_ENGINES)).toBe(
      'keyword-taken',
    );
    expect(validateCustomEngine({ ...ok, searchUrl: 'ftp://x/%s' }, BUILTIN_ENGINES)).toBe('url');
    // No %s means we would have to GUESS where the query goes, and guessing
    // wrong sends what the user typed to the wrong place.
    expect(validateCustomEngine({ ...ok, searchUrl: 'https://x.com/' }, BUILTIN_ENGINES)).toBe(
      'url-placeholder',
    );
  });

  it('lets an engine keep its own keyword while being edited', () => {
    const engines = resolveEngines([WIKI]);
    expect(
      validateCustomEngine(
        { name: 'Wiki', keyword: 'wikipedia.org', searchUrl: 'https://x/%s' },
        engines,
        'custom:1',
      ),
    ).toBeNull();
  });

  it('drops junk instead of half-honouring it', () => {
    const engines = resolveEngines([
      WIKI,
      { id: 'custom:2', name: '', keyword: 'a.com', searchUrl: 'https://a/%s' },
      { id: 'custom:3', name: 'No placeholder', keyword: 'b.com', searchUrl: 'https://b/' },
      { id: 'custom:4', name: 'Stolen', keyword: 'google.com', searchUrl: 'https://c/%s' },
      { id: 'custom:1', name: 'Duplicate id', keyword: 'd.com', searchUrl: 'https://d/%s' },
    ] as CustomSearchEngine[]);
    expect(engines.filter((e) => e.custom).map((e) => e.id)).toEqual(['custom:1']);
  });

  it('normalizes the keyword the way the address bar compares it: case and edges only', () => {
    expect(normalizeKeyword('  WIKIPEDIA.ORG ')).toBe('wikipedia.org');
    const engines = resolveEngines([{ ...WIKI, keyword: ' WIKIPEDIA.ORG ' }]);
    expect(findEngineByKeyword('wikipedia.org', engines)?.id).toBe('custom:1');
  });

  it('refuses a keyword with a space instead of silently rewriting it', () => {
    // normalizeKeyword used to strip inner spaces, so "my wiki" was quietly
    // persisted as `mywiki`: a keyword the user never chose. And because the
    // same function normalized the TYPED text, the comparison became fuzzy.
    expect(normalizeKeyword('my wiki')).toBe('my wiki');
    expect(
      validateCustomEngine(
        { name: 'Wiki', keyword: 'my wiki', searchUrl: 'https://x/%s' },
        BUILTIN_ENGINES,
      ),
    ).toBe('keyword-space');
    // Fail closed: a hand-edited settings.json carrying one is dropped, not
    // half-honoured into some other keyword.
    expect(
      resolveEngines([{ ...WIKI, keyword: 'my wiki' }]).filter((e) => e.custom),
    ).toEqual([]);
  });

  it('caps the list and keeps ids unique', () => {
    const many: CustomSearchEngine[] = Array.from({ length: 80 }, (_, i) => ({
      id: `custom:${i + 1}`,
      name: `E${i}`,
      keyword: `e${i}.com`,
      searchUrl: 'https://e/%s',
    }));
    expect(sanitizeCustomEngines(many)).toHaveLength(MAX_CUSTOM_ENGINES);
    expect(newCustomEngineId(resolveEngines([WIKI]))).not.toBe('custom:1');
  });

  it('survives a settings file that lies', () => {
    expect(sanitizeCustomEngines(undefined)).toEqual([]);
    expect(sanitizeCustomEngines('nope')).toEqual([]);
    expect(sanitizeCustomEngines([null, 42, {}])).toEqual([]);
  });
});

describe('findEngineByKeyword: the tab-to-search trigger', () => {
  it('matches a keyword, and only a keyword', () => {
    expect(findEngineByKeyword('duckduckgo.com')?.id).toBe('duckduckgo');
    expect(findEngineByKeyword('  bing.com  ')?.id).toBe('bing');
    expect(findEngineByKeyword('DuckDuckGo.COM')?.id).toBe('duckduckgo');
    expect(findEngineByKeyword('example.com')).toBeNull();
    expect(findEngineByKeyword('')).toBeNull();
  });

  it('never matches typed text whose SPACES are what make it look like a keyword', () => {
    // The regression this pins: findEngineByKeyword ran the typed text through a
    // canonicalizer that stripped inner whitespace, so a phrase collapsed into a
    // keyword. With a custom engine keyed `github`, typing "git hub " armed the
    // chip and WIPED "git hub" from the address bar; whatever came next was sent
    // to GitHub instead of the user's default engine. The mode was still state,
    // but the trigger had silently become an inference -- the exact failure the
    // keyword-as-state design exists to prevent.
    const engines = resolveEngines([
      { id: 'custom:1', name: 'GitHub', keyword: 'github', searchUrl: 'https://github.com/s?q=%s' },
    ]);
    expect(findEngineByKeyword('github', engines)?.id).toBe('custom:1');
    expect(findEngineByKeyword('git hub ', engines)).toBeNull();
    expect(findEngineByKeyword('git hub', engines)).toBeNull();
    // Built-ins are reachable the same way, and must be just as safe.
    expect(findEngineByKeyword('goo gle.com ')).toBeNull();
    expect(findEngineByKeyword('bing. com')).toBeNull();
  });

  it('is NOT a line parser: a phrase that merely starts with a keyword is not a match', () => {
    // The trap this avoids: inferring the mode from the whole line meant
    // "bing.com vs google" searched Bing for "vs google", silently, with no way
    // to ask for what was actually typed. Keyword mode is a MODE the address bar
    // enters on a keystroke (keyword, then Space), never a re-reading of text.
    expect(findEngineByKeyword('bing.com vs google')).toBeNull();
    expect(findEngineByKeyword('qwant.com avis')).toBeNull();
    expect(findEngineByKeyword('ecosia.org arnaque')).toBeNull();
  });
});
