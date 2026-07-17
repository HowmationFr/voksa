/**
 * Go-Live Preflight (pure scanner). Before going live, list what a viewer
 * could catch: tab titles or URLs carrying an email / IP / phone / custom
 * keyword, and background tabs playing sound. Each finding is something the
 * user can fix in one click (close the tab, mute it).
 *
 * The detector reuses maskText: if masking a string would CHANGE it, the
 * string contains something the mask targets. So the scanner is exactly as
 * accurate as the masker, by construction, and the preview it returns is the
 * MASKED form (naming the risk without reprinting it).
 *
 * Honest scope, stated in the UI: this audits VOKSA. It cannot see a Discord
 * window, a desktop notification, or the rest of the screen.
 */
import { maskText, type MaskFlags } from './maskPatterns';

export type PreflightTab = {
  id: string;
  title: string;
  url: string;
  isAudible: boolean;
  isActive: boolean;
  isInternal: boolean;
};

export type PreflightFinding =
  | {
      kind: 'sensitive-text';
      tabId: string;
      /** Masked title, safe to display. */
      label: string;
      /** Where the sensitive text is: the title, the URL, or both. */
      where: 'title' | 'url' | 'both';
    }
  | {
      kind: 'audible';
      tabId: string;
      label: string;
    };

export type PreflightReport = {
  findings: PreflightFinding[];
  /** Tabs scanned (internal pages excluded): lets the UI say "N tabs, all clear". */
  scanned: number;
};

/**
 * Scan the given tabs against the mask config. `flags`/`hostname`/`customMasks`
 * are the SAME inputs the masker uses, so a finding here is precisely what
 * Stream Mode would mask on the page.
 */
export function runPreflight(
  tabs: readonly PreflightTab[],
  flags: MaskFlags,
  hostname: string | null,
  customMasks: readonly string[],
): PreflightReport {
  const findings: PreflightFinding[] = [];
  let scanned = 0;

  for (const tab of tabs) {
    // Internal pages hold no viewer-facing external content worth flagging
    // (they are already masked in the chrome the same way).
    if (tab.isInternal) continue;
    scanned += 1;

    const maskedTitle = maskText(tab.title, flags, hostname, customMasks);
    const maskedUrl = maskText(tab.url, flags, hostname, customMasks);
    const titleHit = maskedTitle !== tab.title;
    const urlHit = maskedUrl !== tab.url;
    if (titleHit || urlHit) {
      findings.push({
        kind: 'sensitive-text',
        tabId: tab.id,
        label: maskedTitle || maskedUrl,
        where: titleHit && urlHit ? 'both' : titleHit ? 'title' : 'url',
      });
    }

    // A background tab making sound is a DMCA / distraction risk on stream.
    // The active tab is the content being shown, so its audio is intended.
    if (tab.isAudible && !tab.isActive) {
      findings.push({ kind: 'audible', tabId: tab.id, label: maskedTitle || maskedUrl });
    }
  }

  return { findings, scanned };
}
