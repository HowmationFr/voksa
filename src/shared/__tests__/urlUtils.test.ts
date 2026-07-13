import { describe, it, expect } from 'vitest';
import { normalizeInput, isUrlLike } from '../urlUtils';
import { SEARCH_ENGINES } from '../searchEngines';

const GOOGLE = SEARCH_ENGINES.google;
const DDG = SEARCH_ENGINES.duckduckgo;

describe('normalizeInput', () => {
  it('keeps explicit schemes', () => {
    expect(normalizeInput('https://example.com', GOOGLE)).toBe('https://example.com');
    expect(normalizeInput('voksa://settings', GOOGLE)).toBe('voksa://settings');
    expect(normalizeInput('about:blank', GOOGLE)).toBe('about:blank');
  });
  it('returns the voksa://newtab default for empty input', () => {
    expect(normalizeInput('', GOOGLE)).toBe('voksa://newtab');
    expect(normalizeInput('   ', GOOGLE)).toBe('voksa://newtab');
  });
  it('rewrites the legacy hbb:// alias to voksa:// (pre-rename profiles)', () => {
    expect(normalizeInput('hbb://settings', GOOGLE)).toBe('voksa://settings');
    // Case-insensitive on the scheme, like real address-bar input.
    expect(normalizeInput('HBB://newtab', GOOGLE)).toBe('voksa://newtab');
    // isUrlLike still treats the legacy scheme as navigable, not a query.
    expect(isUrlLike('hbb://history')).toBe(true);
  });
  it('prefixes bare domains with https', () => {
    expect(normalizeInput('example.com', GOOGLE)).toBe('https://example.com');
    expect(normalizeInput('sub.example.com/path', GOOGLE)).toBe('https://sub.example.com/path');
  });
  it('prefixes IPs and localhost with http', () => {
    expect(normalizeInput('192.168.1.1', GOOGLE)).toBe('http://192.168.1.1');
    expect(normalizeInput('localhost:3000', GOOGLE)).toBe('http://localhost:3000');
  });
  it('honours the configured search engine for plain queries', () => {
    expect(normalizeInput('hello world', GOOGLE)).toBe(
      'https://www.google.com/search?q=hello%20world',
    );
    expect(normalizeInput('hello world', DDG)).toBe(
      'https://duckduckgo.com/?q=hello%20world',
    );
    expect(normalizeInput('hello world', SEARCH_ENGINES.brave)).toBe(
      'https://search.brave.com/search?q=hello%20world',
    );
  });
  it('does not treat view-source as a navigation', () => {
    expect(normalizeInput('view-source:https://x.com', GOOGLE)).toContain('search?q=');
  });

  it('NEVER lets an engine keyword hijack what the user typed', () => {
    // Tab-to-search is a MODE the address bar holds, not something inferred
    // from the text. So a phrase that happens to start with an engine's domain
    // is just a phrase: it searches the DEFAULT engine, whole and untruncated.
    // Inferring it here meant "bing.com vs google" searched Bing for
    // "vs google", silently, with no way to ask for the real thing.
    expect(normalizeInput('bing.com vs google', GOOGLE)).toBe(
      'https://www.google.com/search?q=bing.com%20vs%20google',
    );
    expect(normalizeInput('qwant.com avis', DDG)).toBe(
      'https://duckduckgo.com/?q=qwant.com%20avis',
    );
    // And a search engine's own address still opens the site.
    expect(normalizeInput('duckduckgo.com', GOOGLE)).toBe('https://duckduckgo.com');
    expect(normalizeInput('google.com/maps', GOOGLE)).toBe('https://google.com/maps');
  });

  it('agrees with isUrlLike about what a URL is (a path has no spaces)', () => {
    // These two must never diverge: the dropdown offers what isUrlLike says,
    // Enter does what normalizeInput says. They used to disagree on this one,
    // so the suggestion offered to SEARCH a string that Enter NAVIGATED to.
    expect(isUrlLike('example.com/a b')).toBe(false);
    expect(normalizeInput('example.com/a b', GOOGLE)).toContain('search?q=');
    expect(isUrlLike('example.com/a-b')).toBe(true);
    expect(normalizeInput('example.com/a-b', GOOGLE)).toBe('https://example.com/a-b');
  });
});

describe('isUrlLike', () => {
  it('detects URLs, domains, IPs', () => {
    expect(isUrlLike('https://a.com')).toBe(true);
    expect(isUrlLike('a.com')).toBe(true);
    expect(isUrlLike('8.8.8.8')).toBe(true);
    expect(isUrlLike('localhost:8080')).toBe(true);
  });
  it('rejects plain queries', () => {
    expect(isUrlLike('hello world')).toBe(false);
    expect(isUrlLike('how to code')).toBe(false);
  });
  it('still calls a file: path with spaces an address', () => {
    // The one place a space is not ambiguous: nobody searches for file:///.
    expect(isUrlLike('file:///C:/Users/me/My Documents/a.pdf')).toBe(true);
  });
});

describe('isUrlLike and normalizeInput can never disagree', () => {
  // They MUST agree on every input, because the dropdown asks the first what to
  // offer and Enter asks the second what to do. They did not: isUrlLike rejected
  // anything with a space before it ever looked at the scheme, while
  // normalizeInput's scheme and localhost branches had no space check at all. So
  // the dropdown offered to SEARCH strings that Enter silently NAVIGATED to.
  const CASES = [
    'https://api.example.com/v1 returned 500',
    'about:blank x',
    'localhost:3000 cors error',
    'voksa://settings is broken',
    'hbb://history and stuff',
    '8.8.8.8 is down',
    'example.com/a b',
    'file:///C:/Users/me/My Documents/a.pdf',
    'https://example.com',
    'hello world',
    'localhost',
  ];

  for (const input of CASES) {
    it(`agrees on ${JSON.stringify(input)}`, () => {
      const url = normalizeInput(input, GOOGLE);
      const isSearch = url.startsWith(GOOGLE.searchUrl.split('%s')[0]);
      // isUrlLike said "address" <=> normalizeInput did NOT send it to search.
      expect(isUrlLike(input)).toBe(!isSearch);
    });
  }

  it('sends a scheme-prefixed phrase to search rather than to a broken URL', () => {
    expect(normalizeInput('https://api.example.com/v1 returned 500', GOOGLE)).toContain(
      'search?q=',
    );
    expect(normalizeInput('localhost:3000 cors error', GOOGLE)).toContain('search?q=');
  });
});
