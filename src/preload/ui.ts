import { injectBrowserAction } from 'electron-chrome-extensions/browser-action';
import { exposeVoksaApi, type VoksaApi } from './voksaApi';

exposeVoksaApi();

// Registers the <browser-action-list> custom element (extension toolbar
// icons, badges, click → onClicked dispatch, anchored popups) in the chrome
// UI page. esbuild bundles the module into ui.js (a sandboxed preload
// cannot require() from node_modules at runtime).
injectBrowserAction();

export type { VoksaApi };
