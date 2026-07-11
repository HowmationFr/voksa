import { describe, it, expect } from 'vitest';
import { pageRangesToString, parsePageRanges } from '../printUtils';

describe('parsePageRanges', () => {
  it('parses single pages and ranges (Chrome syntax)', () => {
    expect(parsePageRanges('1-5, 8, 11-13')).toEqual([
      { from: 1, to: 5 },
      { from: 8, to: 8 },
      { from: 11, to: 13 },
    ]);
  });

  it('drops invalid chunks but keeps valid ones', () => {
    expect(parsePageRanges('abc, 3-1, 0, 2, 4-6x, 7-9')).toEqual([
      { from: 2, to: 2 },
      { from: 7, to: 9 },
    ]);
  });

  it('returns [] for empty/garbage input (meaning: all pages)', () => {
    expect(parsePageRanges('')).toEqual([]);
    expect(parsePageRanges('n importe quoi')).toEqual([]);
  });

  it('tolerates spaces around dashes', () => {
    expect(parsePageRanges('2 - 4')).toEqual([{ from: 2, to: 4 }]);
  });
});

describe('pageRangesToString', () => {
  it('round-trips to the printToPDF string form', () => {
    expect(pageRangesToString(parsePageRanges('1-5, 8'))).toBe('1-5,8');
  });
});
