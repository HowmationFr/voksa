// Deliberately the exact pattern that killed uBO Lite in the wild: a MODULE
// service worker, using the native `browser` namespace, registering listeners
// at top-level module evaluation. If any of these APIs is missing on
// `browser`, evaluation throws, the worker dies, and the smoke scenario sees
// no service worker target: that is the point of this fixture.
const seen = { storageChanges: [] };

// Forensic line, BEFORE the killer registrations: when the worker dies at
// evaluation on some platform, the harness's [sw-console] relay shows the
// exact world it died in (which namespaces exist, whether they diverge, and
// the property descriptor of the first API the killer line dereferences).
try {
  const d = (o, k) => {
    try {
      const desc = Object.getOwnPropertyDescriptor(o, k);
      return desc ? `{${typeof desc.value},cfg:${desc.configurable},get:${!!desc.get}}` : 'absent';
    } catch (e) {
      return 'ERR:' + e.message;
    }
  };
  console.log(
    'CONTRACT-SW-WORLD'
    + ' browser=' + typeof globalThis.browser
    + ' chrome=' + typeof globalThis.chrome
    + ' same=' + (globalThis.browser === globalThis.chrome)
    + ' b.permissions=' + (typeof globalThis.browser === 'undefined' ? 'n/a' : typeof browser.permissions)
    + ' c.permissions=' + (typeof globalThis.chrome === 'undefined' ? 'n/a' : typeof chrome.permissions)
    + ' b.tabs=' + (typeof globalThis.browser === 'undefined' ? 'n/a' : typeof browser.tabs)
    + ' c.tabs=' + (typeof globalThis.chrome === 'undefined' ? 'n/a' : typeof chrome.tabs)
    + ' desc(b,permissions)=' + (typeof globalThis.browser === 'undefined' ? 'n/a' : d(browser, 'permissions'))
    + ' desc(b,tabs)=' + (typeof globalThis.browser === 'undefined' ? 'n/a' : d(browser, 'tabs')),
  );
} catch (e) {
  console.log('CONTRACT-SW-WORLD probe failed: ' + e.message);
}

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
