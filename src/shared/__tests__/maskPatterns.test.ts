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
  maskMacAddresses: true,
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

describe('MAC address masking', () => {
  it('masks the colon, hyphen and Cisco dotted spellings, any case', () => {
    expect(mask('ether a4:83:e7:1f:2c:9b up')).toBe(`ether ${MASK.MAC} up`);
    expect(mask('Physical Address: A4-83-E7-1F-2C-9B')).toBe(`Physical Address: ${MASK.MAC}`);
    expect(mask('mac a483.e71f.2c9b')).toBe(`mac ${MASK.MAC}`);
    expect(mask('HWaddr=00:1A:2b:3C:4d:5E;')).toBe(`HWaddr=${MASK.MAC};`);
  });
  it('masks an all-digit MAC as a MAC, not as a phone number', () => {
    expect(mask('00-11-22-33-44-55')).toBe(MASK.MAC);
  });
  it('requires one separator and exactly six 2-digit groups', () => {
    expect(mask('aa:bb-cc:dd-ee:ff')).toBe('aa:bb-cc:dd-ee:ff');
    expect(mask('aa:bb:cc:dd:ee')).toBe('aa:bb:cc:dd:ee');
    expect(mask('12:34:56')).toBe('12:34:56');
    expect(mask('aab:bb:cc:dd:ee:ff')).toBe('aab:bb:cc:dd:ee:ff');
  });
  it('leaves a bare 12-hex-digit run alone (hash / ID, not provably a MAC)', () => {
    expect(mask('commit a483e71f2c9b')).toBe('commit a483e71f2c9b');
  });
  it('lets IPv6 claim an address first, so no prefix survives', () => {
    expect(mask('2a01:e0a:12:34:56:78:9a:bc')).toBe(MASK.IPV6);
  });
  it('is off when its flag is off', () => {
    expect(mask('a4:83:e7:1f:2c:9b', { maskMacAddresses: false })).toBe('a4:83:e7:1f:2c:9b');
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

describe('custom replacements', () => {
  const NONE: MaskFlags = {
    maskIPv4: false,
    maskIPv6: false,
    maskEmails: false,
    maskPhones: false,
    maskMacAddresses: false,
    maskInternalHostnames: false,
  };
  const rep = (s: string, pairs: { from: string; to: string }[], flags: MaskFlags = NONE) =>
    maskText(s, flags, null, [], pairs);

  it('shows the chosen text instead of each match, case-insensitively', () => {
    expect(rep('Valentin et VALENTIN', [{ from: 'valentin', to: 'Val' }])).toBe('Val et Val');
  });
  it('accepts an empty replacement (erases the string)', () => {
    expect(rep('Projet [Falcon]', [{ from: 'Falcon', to: '' }])).toBe('Projet []');
  });
  it('never re-scans its own output (`to` may contain `from`)', () => {
    expect(rep('Val', [{ from: 'Val', to: 'Valentin' }])).toBe('Valentin');
    expect(rep('ab ab', [{ from: 'ab', to: 'abab' }])).toBe('abab abab');
  });
  it('prefers the longest match at the same position', () => {
    const pairs = [
      { from: 'Jean', to: 'J.' },
      { from: 'Jean Dupont', to: 'Streamer' },
    ];
    expect(rep('Jean Dupont et Jean', pairs)).toBe('Streamer et J.');
  });
  it('first pair wins on a duplicate `from`', () => {
    const pairs = [
      { from: 'acme', to: 'one' },
      { from: 'ACME', to: 'two' },
    ];
    expect(rep('Acme', pairs)).toBe('one');
  });
  it('escapes regex characters and trims `from`', () => {
    expect(rep('a.b.c and axbxc', [{ from: ' a.b.c ', to: 'X' }])).toBe('X and axbxc');
  });
  it('ignores pairs whose `from` is shorter than 2 chars, and malformed entries', () => {
    const junk = [{ from: 'a', to: 'z' }, null, { from: 42 }, { to: 'x' }] as unknown as {
      from: string;
      to: string;
    }[];
    expect(rep('a b c', junk)).toBe('a b c');
    expect(rep('nas01', [{ from: 'nas01', to: undefined as unknown as string }])).toBe('');
  });
  it('runs before the built-in masks: a replaced IP shows the chosen text', () => {
    expect(rep('ping 8.8.8.8', [{ from: '8.8.8.8', to: 'mon-serveur' }], ALL)).toBe(
      'ping mon-serveur',
    );
  });
  it('still masks a replacement that is itself sensitive', () => {
    const out = rep('contact: Bob', [{ from: 'Bob', to: 'bob@example.com' }], ALL);
    expect(out).toBe(`contact: ${MASK.EMAIL}`);
  });
  it('counts for hasAnyMask', () => {
    expect(hasAnyMask(NONE, [], [{ from: 'acme', to: 'x' }])).toBe(true);
    expect(hasAnyMask(NONE, [], [{ from: ' a ', to: 'x' }])).toBe(false);
    expect(hasAnyMask(NONE, [], [])).toBe(false);
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
          maskMacAddresses: false,
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
          maskMacAddresses: false,
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
