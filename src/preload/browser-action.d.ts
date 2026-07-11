// tsconfig.main.json uses moduleResolution "Node", which ignores package
// `exports` maps : the 'electron-chrome-extensions/browser-action' subpath
// resolves fine for esbuild (which honors exports) but not for tsc. This
// ambient declaration bridges the gap; do NOT switch moduleResolution.
declare module 'electron-chrome-extensions/browser-action' {
  export const injectBrowserAction: () => void;
}
