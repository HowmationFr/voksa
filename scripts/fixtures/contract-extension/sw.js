// Deliberately the exact pattern that killed uBO Lite in the wild: a MODULE
// service worker, using the native `browser` namespace, registering listeners
// at top-level module evaluation. If any of these APIs is missing on
// `browser`, evaluation throws, the worker dies, and the smoke scenario sees
// no service worker target: that is the point of this fixture.
const seen = { storageChanges: [] };

browser.permissions.onRemoved.addListener(() => {});
browser.tabs.onRemoved.addListener(() => {});

// Historic patch behaviour (Bitwarden frozen-vault bug): storage.onChanged
// must actually be delivered to the background context.
browser.storage.onChanged.addListener((changes, area) => {
  seen.storageChanges.push({ area, keys: Object.keys(changes) });
});

browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.what !== 'report') return undefined;
  Promise.resolve(browser.tabs.query({}))
    .then((tabs) => {
      sendResponse({
        swAlive: true,
        namespacesUnified: browser.tabs === chrome.tabs && browser.runtime === chrome.runtime,
        tabsSeen: tabs.length,
        i18nMessage: browser.i18n.getMessage('probeMessage'),
        storageChanges: seen.storageChanges,
      });
    })
    .catch((e) => sendResponse({ swAlive: true, error: String(e) }));
  return true;
});
