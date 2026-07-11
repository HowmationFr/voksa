/**
 * Bridge exposed on the chrome UI's main world by electron-chrome-extensions'
 * preload (injectBrowserAction() in src/preload/ui.ts). Drives the
 * `<button is="browser-action">` customized built-in elements rendered by
 * ExtensionActions.tsx: state must be observed/fetched through this bridge
 * for the elements to have anything to display.
 */
type BrowserActionUpdateListener = (state: unknown) => void;

interface BrowserActionBridge {
  addObserver(partition: string): void;
  removeObserver(partition: string): void;
  getState(partition: string): Promise<unknown>;
  addEventListener(name: 'update', listener: BrowserActionUpdateListener): void;
  removeEventListener(name: 'update', listener: BrowserActionUpdateListener): void;
}

declare global {
  interface Window {
    browserAction?: BrowserActionBridge;
  }
}

export {};
