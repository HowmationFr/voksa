import { describe, expect, it } from 'vitest';
import { runPreflight, type PreflightTab } from '../preflight';
import type { MaskFlags } from '../maskPatterns';

const FLAGS: MaskFlags = {
  maskIPv4: true,
  maskIPv6: true,
  maskEmails: true,
  maskPhones: true,
  maskInternalHostnames: false,
};

function tab(over: Partial<PreflightTab>): PreflightTab {
  return {
    id: 'x',
    title: 'Clean page',
    url: 'https://example.com/',
    isAudible: false,
    isActive: false,
    isInternal: false,
    ...over,
  };
}

describe('runPreflight', () => {
  it('flags a tab whose title carries an email, with a MASKED preview', () => {
    const report = runPreflight(
      [tab({ id: 't1', title: 'Inbox: me@example.com' })],
      FLAGS,
      null,
      [],
    );
    expect(report.findings).toHaveLength(1);
    const f = report.findings[0];
    expect(f.kind).toBe('sensitive-text');
    expect(f.tabId).toBe('t1');
    // The preview must NOT reprint the email it warns about.
    expect(f.label).not.toContain('me@example.com');
    expect(f.label).toContain('xxx');
  });

  it('flags a public IP in the URL and reports where it is', () => {
    const report = runPreflight(
      [tab({ id: 't2', title: 'Server', url: 'https://203.0.113.7/admin' })],
      FLAGS,
      null,
      [],
    );
    expect(report.findings[0].kind).toBe('sensitive-text');
    expect((report.findings[0] as { where: string }).where).toBe('url');
  });

  it('flags a custom keyword and reports both when title AND url hit', () => {
    const report = runPreflight(
      [tab({ id: 't3', title: 'ProjectNeon roadmap', url: 'https://projectneon.example/' })],
      FLAGS,
      null,
      ['ProjectNeon'],
    );
    expect((report.findings[0] as { where: string }).where).toBe('both');
  });

  it('flags a background audible tab, but not the active one', () => {
    const report = runPreflight(
      [
        tab({ id: 'bg', title: 'Radio', isAudible: true, isActive: false }),
        tab({ id: 'fg', title: 'On camera', isAudible: true, isActive: true }),
      ],
      FLAGS,
      null,
      [],
    );
    const audible = report.findings.filter((f) => f.kind === 'audible');
    expect(audible).toHaveLength(1);
    expect(audible[0].tabId).toBe('bg');
  });

  it('skips internal pages and counts what it scanned', () => {
    const report = runPreflight(
      [
        tab({ id: 'i', title: 'Settings', url: 'voksa://settings', isInternal: true }),
        tab({ id: 'a', title: 'Clean' }),
      ],
      FLAGS,
      null,
      [],
    );
    expect(report.scanned).toBe(1);
    expect(report.findings).toHaveLength(0);
  });

  it('returns nothing for a clean profile (anti-vacuity anchor)', () => {
    const report = runPreflight([tab({ id: 'a' }), tab({ id: 'b' })], FLAGS, null, []);
    expect(report.findings).toHaveLength(0);
    expect(report.scanned).toBe(2);
  });
});
