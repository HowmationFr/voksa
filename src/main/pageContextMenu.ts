import {
  clipboard,
  webContents,
  type ContextMenuParams,
  type MenuItem,
  type WebContentsView,
} from 'electron';
import { IPC } from '../shared/ipcChannels';
import type { PageMenuExtensionItem, PageMenuPayload } from '../shared/types';
import { getExtensionContextMenuItems } from './extensions/webstore';
import { buildSearchUrl } from '../shared/searchEngines';
import { defaultEngine } from './search/engines';
import type { TabManager } from './tabs/TabManager';

/**
 * Page right-click menu, rendered by the CHROME UI (React) instead of a
 * native Electron Menu: native popups ignore the app theme (black panel in
 * light mode) and their width/typography can't be styled.
 *
 * Security model: the renderer only ever sends back an action identifier
 * (+ a validated index for spell suggestions / extension items). Every URL,
 * coordinate and text comes from the main-side copy of the click params;
 * a compromised chrome renderer can't make us navigate or download an
 * arbitrary URL through this channel.
 */

const PIP_SCRIPT =
  `(() => { const v=[...document.querySelectorAll('video')].find(v=>!v.paused)||document.querySelector('video');` +
  ` if(v&&v.requestPictureInPicture) v.requestPictureInPicture().catch(()=>{}); })();`;

type PendingMenu = {
  token: number;
  wcId: number;
  params: ContextMenuParams;
  extensionItems: Map<string, MenuItem>;
};

export class PageMenuController {
  private pending: PendingMenu | null = null;
  private nextToken = 1;
  private detachEscape: (() => void) | null = null;

  constructor(
    private readonly chromeView: WebContentsView,
    private readonly tabs: TabManager,
  ) {}

  /** Build the payload for a click in `wc` and hand it to the chrome UI. */
  show(wc: Electron.WebContents, params: ContextMenuParams, windowX: number, windowY: number): void {
    const registry = new Map<string, MenuItem>();
    const extensions = serializeExtensionItems(
      getExtensionContextMenuItems(wc, params),
      '',
      registry,
    );

    const token = this.nextToken++;
    this.pending = { token, wcId: wc.id, params, extensionItems: registry };
    this.watchEscape(wc);

    const nav = wc.navigationHistory;
    const payload: PageMenuPayload = {
      token,
      x: windowX,
      y: windowY,
      linkURL: params.linkURL,
      srcURL: params.srcURL,
      mediaType: params.mediaType,
      isEditable: params.isEditable,
      selectionText: params.selectionText,
      dictionarySuggestions: params.dictionarySuggestions.slice(0, 4),
      canGoBack: nav.canGoBack(),
      canGoForward: nav.canGoForward(),
      extensions,
    };
    this.chromeView.webContents.send(IPC.PAGE_MENU_SHOW, payload);
  }

  /**
   * Escape must close the menu, but the keyboard focus stays on the PAGE
   * webContents after a right-click (the chromeView only paints the menu,
   * it never takes focus). So the main process watches the page's input
   * and tells the chrome UI to dismiss. The listener is dropped on the
   * first Escape or on the next show; a mousedown dismissal leaves it
   * attached until then, in which case the close push is a UI no-op.
   */
  private watchEscape(wc: Electron.WebContents): void {
    this.detachEscape?.();
    const onInput = (_e: Electron.Event, input: Electron.Input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') {
        detach();
        if (!this.chromeView.webContents.isDestroyed()) {
          this.chromeView.webContents.send(IPC.PAGE_MENU_CLOSE);
        }
      }
    };
    const detach = () => {
      if (this.detachEscape === detach) this.detachEscape = null;
      if (!wc.isDestroyed()) wc.off('before-input-event', onInput);
    };
    wc.on('before-input-event', onInput);
    this.detachEscape = detach;
  }

  async handleAction(token: number, action: string, arg?: number | string): Promise<void> {
    const pending = this.pending;
    if (!pending || pending.token !== token) return;
    this.pending = null;
    this.detachEscape?.();

    const wc = webContents.fromId(pending.wcId);
    if (!wc || wc.isDestroyed()) return;
    const { params } = pending;

    switch (action) {
      case 'open-link':
      case 'open-link-bg':
        if (params.linkURL) this.tabs.create(params.linkURL, { activate: action === 'open-link' });
        break;
      case 'copy-link':
        if (params.linkURL) clipboard.writeText(params.linkURL);
        break;
      case 'open-image':
        if (params.srcURL) this.tabs.create(params.srcURL);
        break;
      case 'copy-image':
        wc.copyImageAt(params.x, params.y);
        break;
      case 'copy-image-url':
        if (params.srcURL) clipboard.writeText(params.srcURL);
        break;
      case 'save-image':
        if (params.srcURL) {
          try {
            wc.downloadURL(params.srcURL);
          } catch {
            // ignore
          }
        }
        break;
      case 'pip':
        void wc.executeJavaScript(PIP_SCRIPT).catch(() => {});
        break;
      case 'cut':
        wc.cut();
        break;
      case 'copy':
        wc.copy();
        break;
      case 'paste':
        wc.paste();
        break;
      case 'select-all':
        wc.selectAll();
        break;
      case 'replace-misspelling': {
        const idx = typeof arg === 'number' ? arg : -1;
        const suggestion = params.dictionarySuggestions[idx];
        if (suggestion) wc.replaceMisspelling(suggestion);
        break;
      }
      case 'search-selection': {
        const text = params.selectionText.trim();
        if (text) {
          this.tabs.create(buildSearchUrl(defaultEngine(), text));
        }
        break;
      }
      case 'back':
        wc.navigationHistory.goBack();
        break;
      case 'forward':
        wc.navigationHistory.goForward();
        break;
      case 'reload':
        wc.reload();
        break;
      case 'clear-cache-reload':
        // Chrome's "Empty cache and hard reload" (Ctrl+F5 on steroids).
        try {
          await wc.session.clearCache();
        } catch {
          // ignore; still hard-reload
        }
        wc.reloadIgnoringCache();
        break;
      case 'inspect':
        wc.inspectElement(params.x, params.y);
        break;
      case 'extension': {
        const item = typeof arg === 'string' ? pending.extensionItems.get(arg) : undefined;
        if (item) {
          try {
            // MenuItem.click(event, focusedWindow, focusedWebContents); the
            // extension runtime's handlers read the webContents argument.
            (item.click as (e?: unknown, w?: unknown, c?: unknown) => void)(
              undefined,
              undefined,
              wc,
            );
          } catch {
            // ignore
          }
        }
        break;
      }
    }
  }
}

function serializeExtensionItems(
  items: MenuItem[],
  pathPrefix: string,
  registry: Map<string, MenuItem>,
): PageMenuExtensionItem[] {
  const out: PageMenuExtensionItem[] = [];
  items.forEach((item, index) => {
    if (item.visible === false) return;
    const id = pathPrefix + index;
    registry.set(id, item);
    const children = item.submenu
      ? serializeExtensionItems(item.submenu.items, `${id}.`, registry)
      : undefined;
    out.push({
      id,
      label: item.label ?? '',
      enabled: item.enabled !== false,
      type: item.type === 'separator' ? 'separator' : children ? 'submenu' : 'normal',
      children,
    });
  });
  return out;
}
