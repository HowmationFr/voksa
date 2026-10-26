// Page-context half of the contract report, driven from the smoke via CDP.
// Uses the `browser` namespace throughout, like the extensions that broke.
window.report = async () => {
  const swReport = await browser.runtime.sendMessage({ what: 'report' });
  const tabs = await browser.tabs.query({});
  return {
    page: {
      namespacesUnified: browser.tabs === chrome.tabs && browser.runtime === chrome.runtime,
      tabCount: tabs.length,
      // The popup-starvation class: tabs must come back WITH their url, or an
      // extension popup cannot know what site it is on.
      tabsWithUrl: tabs.filter((t) => typeof t.url === 'string' && t.url.length > 0).length,
      openOptionsPage: typeof browser.runtime.openOptionsPage,
      i18nMessage: browser.i18n.getMessage('probeMessage'),
      // Chromium resolves message AND placeholder names case-insensitively.
      i18nCase: browser.i18n.getMessage('PROBECASE'),
      i18nPlaceholder: browser.i18n.getMessage('probePlaceholder', ['x']),
      // escapeLt escapes the message's own '<', never the substitutions.
      i18nEscaped: browser.i18n.getMessage('probeEscape', ['<i>'], { escapeLt: true }),
      // chrome.* events must honor removeListener / hasListener (the patched
      // storage.onChanged used to throw on hasListener and never remove).
      events: (() => {
        try {
          const fn = () => {};
          browser.storage.onChanged.addListener(fn);
          const had = browser.storage.onChanged.hasListener(fn);
          browser.storage.onChanged.removeListener(fn);
          return { had, after: browser.storage.onChanged.hasListener(fn) };
        } catch (e) {
          return { error: String(e) };
        }
      })(),
    },
    sw: swReport,
  };
};

window.pokeStorage = () => chrome.storage.local.set({ contractPing: Date.now() });
