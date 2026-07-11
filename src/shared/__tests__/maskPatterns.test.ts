import { describe, it, expect } from 'vitest';
import {
  maskText,
  isLikelyPhone,
  isPrivateIPv4,
  isPrivateIPv6,
  hasAnyMask,
  MASK,
  type MaskFlags,
} from '../maskPatterns';

const ALL: MaskFlags = {
  maskIPv4: true,
  maskIPv6: true,
  maskEmails: true,
  maskPhones: true,
  maskInternalHostnames: false,
};

const mask = (s: string, flags: Partial<MaskFlags> = {}, custom: string[] = []) =>
  maskText(s, { ...ALL, ...flags }, 'my-machine', custom);

describe('IPv4 masking', () => {
  it('masks public IPv4', () => {
    expect(mask('server 8.8.8.8 up')).toBe(`server ${MASK.IPV4} up`);
    expect(mask('203.0.113.42')).toBe(MASK.IPV4);
  });
  it('keeps private / local IPv4', () => {
    for (const ip of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '172.16.4.4', '169.254.1.1']) {
      expect(mask(ip)).toBe(ip);
    }
  });
  it('does not touch version-looking dotted numbers that are not valid IPs', () => {
    // 999.1.1.1 is not a valid octet → not matched
    expect(mask('v999.1.1.1')).toContain('999');
  });
});

describe('IPv6 masking', () => {
  it('masks public IPv6 forms', () => {
    expect(mask('2001:4860:4860::8888')).toBe(MASK.IPV6);
    expect(mask('addr 2606:4700:4700::1111 ok')).toBe(`addr ${MASK.IPV6} ok`);
  });
  it('keeps local IPv6', () => {
    expect(isPrivateIPv6('::1')).toBe(true);
    expect(isPrivateIPv6('fe80::1')).toBe(true);
    expect(isPrivateIPv6('fd00::1')).toBe(true);
  });
});

describe('email masking', () => {
  it('masks emails', () => {
    expect(mask('write to john.doe+tag@example.co.uk please')).toBe(
      `write to ${MASK.EMAIL} please`,
    );
  });
});

describe('phone masking (tightened)', () => {
  it('masks real phone numbers', () => {
    expect(isLikelyPhone('+33 6 12 34 56 78')).toBe(true);
    expect(isLikelyPhone('06 12 34 56 78')).toBe(true);
    expect(isLikelyPhone('(+1) 415-555-0132')).toBe(true);
    expect(isLikelyPhone('00 44 20 7946 0958')).toBe(true);
    expect(mask('call +33 6 12 34 56 78 now')).toBe(`call ${MASK.PHONE} now`);
  });
  it('does NOT mask dates', () => {
    expect(isLikelyPhone('2024-01-15')).toBe(false);
    expect(isLikelyPhone('01/15/2024')).toBe(false);
    expect(mask('meeting 2024-01-15 at noon')).toBe('meeting 2024-01-15 at noon');
  });
  it('does NOT mask prices or bare IDs', () => {
    expect(mask('order 123456789 shipped')).toBe('order 123456789 shipped');
    expect(mask('total 1234.56 eur')).toBe('total 1234.56 eur');
    // NB: a 4-octet "1.2.3.4" is a valid routable IPv4 and IS masked by
    // design (zero-leak). A 3-part semver is not an IP and must survive.
    expect(mask('version 18.16.0 released')).toBe('version 18.16.0 released');
  });
});

describe('custom masks', () => {
  it('bullets out custom substrings (>=2 chars, case-insensitive)', () => {
    const out = mask('Project Falcon is secret', {}, ['Falcon']);
    expect(out).not.toContain('Falcon');
    expect(out).toContain('•');
  });
  it('ignores 1-char custom masks (would bullet everything)', () => {
    expect(mask('a b c', {}, ['a'])).toBe('a b c');
  });
});

describe('internal hostname masking', () => {
  it('masks *.local and the machine hostname when enabled', () => {
    const out = maskText(
      'ssh my-machine and printer.local',
      { ...ALL, maskInternalHostnames: true },
      'my-machine',
      [],
    );
    expect(out).not.toContain('my-machine');
    expect(out).toContain(`${MASK.HOSTNAME}.local`);
  });
});

describe('hasAnyMask', () => {
  it('is false when everything off and no custom masks', () => {
    expect(
      hasAnyMask(
        {
          maskIPv4: false,
          maskIPv6: false,
          maskEmails: false,
          maskPhones: false,
          maskInternalHostnames: false,
        },
        [],
      ),
    ).toBe(false);
  });
  it('is true when only custom masks are set', () => {
    expect(
      hasAnyMask(
        {
          maskIPv4: false,
          maskIPv6: false,
          maskEmails: false,
          maskPhones: false,
          maskInternalHostnames: false,
        },
        ['secret'],
      ),
    ).toBe(true);
  });
});

describe('isPrivateIPv4 edge cases', () => {
  it('treats malformed input as private (fail-closed)', () => {
    expect(isPrivateIPv4('999.999.999.999')).toBe(true);
  });
});
