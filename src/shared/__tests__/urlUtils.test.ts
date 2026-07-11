import { describe, it, expect } from 'vitest';
import { normalizeInput, isUrlLike } from '../urlUtils';

describe('normalizeInput', () => {
  it('keeps explicit schemes', () => {
    expect(normalizeInput('https://example.com', 'google')).toBe('https://example.com');
    expect(normalizeInput('voksa://settings', 'google')).toBe('voksa://settings');
    expect(normalizeInput('about:blank', 'google')).toBe('about:blank');
  });
  it('returns the voksa://newtab default for empty input', () => {
    expect(normalizeInput('', 'google')).toBe('voksa://newtab');
    expect(normalizeInput('   ', 'google')).toBe('voksa://newtab');
  });
  it('rewrites the legacy hbb:// alias to voksa:// (pre-rename profiles)', () => {
    expect(normalizeInput('hbb://settings', 'google')).toBe('voksa://settings');
    // Case-insensitive on the scheme, like real address-bar input.
    expect(normalizeInput('HBB://newtab', 'google')).toBe('voksa://newtab');
    // isUrlLike still treats the legacy scheme as navigable, not a query.
    expect(isUrlLike('hbb://history')).toBe(true);
  });
  it('prefixes bare domains with https', () => {
    expect(normalizeInput('example.com', 'google')).toBe('https://example.com');
    expect(normalizeInput('sub.example.com/path', 'google')).toBe('https://sub.example.com/path');
  });
  it('prefixes IPs and localhost with http', () => {
    expect(normalizeInput('192.168.1.1', 'google')).toBe('http://192.168.1.1');
    expect(normalizeInput('localhost:3000', 'google')).toBe('http://localhost:3000');
  });
  it('honours the configured search engine for plain queries', () => {
    expect(normalizeInput('hello world', 'google')).toBe(
      'https://www.google.com/search?q=hello%20world',
    );
    expect(normalizeInput('hello world', 'duckduckgo')).toBe(
      'https://duckduckgo.com/?q=hello%20world',
    );
    expect(normalizeInput('hello world', 'brave')).toBe(
      'https://search.brave.com/search?q=hello%20world',
    );
  });
  it('does not treat view-source as a navigation', () => {
    expect(normalizeInput('view-source:https://x.com', 'google')).toContain('search?q=');
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
});
