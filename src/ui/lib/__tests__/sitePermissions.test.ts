import { describe, it, expect } from 'vitest';
import {
  clearOriginPermissions,
  nextSitePermissions,
  type SitePermissions,
} from '../sitePermissions';

const ORIGIN = 'https://example.com';

describe('nextSitePermissions', () => {
  it('stores an explicit allow/deny decision', () => {
    const next = nextSitePermissions({}, ORIGIN, 'geolocation', 'allow');
    expect(next).toEqual({ [ORIGIN]: { geolocation: 'allow' } });
  });

  it('overwrites an existing decision without touching siblings', () => {
    const current: SitePermissions = {
      [ORIGIN]: { geolocation: 'allow', media: 'deny' },
    };
    const next = nextSitePermissions(current, ORIGIN, 'geolocation', 'deny');
    expect(next[ORIGIN]).toEqual({ geolocation: 'deny', media: 'deny' });
  });

  it("'ask' removes the entry", () => {
    const current: SitePermissions = {
      [ORIGIN]: { geolocation: 'allow', media: 'deny' },
    };
    const next = nextSitePermissions(current, ORIGIN, 'geolocation', 'ask');
    expect(next[ORIGIN]).toEqual({ media: 'deny' });
  });

  it("'ask' on the last entry drops the origin key entirely", () => {
    const current: SitePermissions = { [ORIGIN]: { geolocation: 'allow' } };
    const next = nextSitePermissions(current, ORIGIN, 'geolocation', 'ask');
    expect(next).toEqual({});
  });

  it('does not mutate the input map', () => {
    const current: SitePermissions = { [ORIGIN]: { geolocation: 'allow' } };
    nextSitePermissions(current, ORIGIN, 'geolocation', 'deny');
    expect(current[ORIGIN].geolocation).toBe('allow');
  });
});

describe('clearOriginPermissions', () => {
  it('removes every decision for the origin, leaving others intact', () => {
    const current: SitePermissions = {
      [ORIGIN]: { geolocation: 'allow' },
      'https://other.com': { media: 'deny' },
    };
    const next = clearOriginPermissions(current, ORIGIN);
    expect(next).toEqual({ 'https://other.com': { media: 'deny' } });
  });

  it('is a no-op for unknown origins', () => {
    const current: SitePermissions = { [ORIGIN]: { geolocation: 'allow' } };
    expect(clearOriginPermissions(current, 'https://nope.com')).toBe(current);
  });
});
