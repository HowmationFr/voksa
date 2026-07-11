import { BaseWindow, WebContentsView, screen } from 'electron';
import {
  computeStatusRect,
  estimateStatusWidth,
  type StatusSide,
} from './statusGeometry';

/**
 * Native hover-status bubble (Chrome-style, bottom corner of the window).
 *
 * Why a dedicated WebContentsView instead of the chrome UI: the chromeView
 * only covers the toolbar band when not expanded, so anything it renders is
 * clipped to that band: a `bottom-0` bubble visually lands under the
 * bookmark bar. Expanding the chromeView on hover is not an option either
 * (the transparent view would swallow the page's mouse events). A tiny
 * dedicated view can sit at the true bottom of the window.
 *
 * Zero-leak: this controller is only ever fed by the main process, and the
 * relay in handlers.ts pushes NOTHING while Stream Mode is on; the URL
 * never even reaches this view's renderer.
 *
 * Z-order contract: above the tab views, BELOW the chromeView; curtains,
 * menus and the dim veil all paint over the bubble. Maintained by calling
 * restack() from window.ts's `active-tab-changed` listener, right before
 * the existing chromeView re-add (the chromeView itself keeps its exact
 * current code; CLAUDE.md §4.3).
 */

// Colors mirror the light/dark `bg-elevated` / `fg-muted` / `border` tokens
// of globals.css. Hardcoded hex is the accepted precedent for main-side
// theme syncing (APP_SET_THEME does the same for the native backgrounds).
const BUBBLE_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;background:transparent;overflow:hidden;user-select:none;cursor:default}
  body{--bg:#ffffff;--fg:#606878;--bd:#e4e7ec}
  body.dark{--bg:#1f2126;--fg:#9ca3af;--bd:#2a2d34}
  #b{box-sizing:border-box;height:24px;line-height:22px;padding:0 8px;
     font:12px system-ui,'Segoe UI',sans-serif;white-space:nowrap;
     overflow:hidden;text-overflow:ellipsis;
     background:var(--bg);color:var(--fg);border:1px solid var(--bd)}
  body.left #b{border-left:0;border-bottom:0;border-top-right-radius:8px}
  body.right #b{border-right:0;border-bottom:0;border-top-left-radius:8px;text-align:right}
</style></head><body class="left"><div id="b"></div></body></html>`;

const HIDE_DELAY_MS = 100;

export class StatusViewController {
  readonly view: WebContentsView;

  private theme: 'light' | 'dark' = 'light';
  private side: StatusSide = 'left';
  private lastText = '';
  private visible = false;
  private suspended = false;
  private destroyed = false;
  private hideTimer: NodeJS.Timeout | null = null;

  constructor(private readonly window: BaseWindow) {
    this.view = new WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    this.view.setBackgroundColor('#00000000');
  }

  /** Load the inline document and join the window's view tree (hidden). */
  attach(): void {
    void this.view.webContents.loadURL(
      'data:text/html;charset=utf-8,' + encodeURIComponent(BUBBLE_HTML),
    );
    this.view.setVisible(false);
    this.view.setBounds({ x: 0, y: 0, width: 1, height: 1 });
    this.window.contentView.addChildView(this.view);
  }

  /**
   * Re-assert "above tabs, below chromeView". Called from the
   * active-tab-changed listener only; never touches the chromeView.
   */
  restack(): void {
    if (this.destroyed) return;
    try {
      this.window.contentView.removeChildView(this.view);
    } catch {
      // ignore
    }
    this.window.contentView.addChildView(this.view);
  }

  show(text: string): void {
    if (this.destroyed || this.suspended || !text) return;
    if (this.hideTimer) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
    this.lastText = text;
    this.applyLayout();
    this.pushContent(text);
    if (!this.visible) {
      this.visible = true;
      this.view.setVisible(true);
    }
  }

  /**
   * Hide the bubble. The default is slightly deferred so that moving the
   * mouse from link to link (a burst of ''-then-url target updates) does
   * not flicker; `immediate` is for stream toggles / tab switches.
   */
  hide(opts?: { immediate?: boolean }): void {
    if (this.destroyed) return;
    if (this.hideTimer) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
    const doHide = () => {
      this.hideTimer = null;
      this.visible = false;
      this.view.setVisible(false);
    };
    if (opts?.immediate) doHide();
    else this.hideTimer = setTimeout(doHide, HIDE_DELAY_MS);
  }

  setTheme(theme: 'light' | 'dark'): void {
    this.theme = theme;
    if (!this.destroyed && this.visible) this.pushContent(this.lastText);
  }

  /** HTML5 fullscreen: no browser chrome at all, bubble included. */
  setSuspended(on: boolean): void {
    this.suspended = on;
    if (on) this.hide({ immediate: true });
  }

  handleResize(): void {
    if (this.destroyed || !this.visible) return;
    this.applyLayout();
    // Side may have changed with the new geometry.
    this.pushContent(this.lastText);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.hideTimer) clearTimeout(this.hideTimer);
    try {
      this.view.webContents.close();
    } catch {
      // ignore
    }
  }

  private applyLayout(): void {
    const [width, height] = this.window.getContentSize();
    const textWidth = estimateStatusWidth(this.lastText, Math.floor(width * 0.5));
    const cursor = this.cursorInWindow(width, height);
    const { bounds, side } = computeStatusRect({ width, height }, textWidth, cursor);
    this.side = side;
    this.view.setBounds(bounds);
  }

  /** Cursor position in window-content coordinates, or null off-window. */
  private cursorInWindow(w: number, h: number): { x: number; y: number } | null {
    try {
      const pt = screen.getCursorScreenPoint();
      const content = this.window.getContentBounds();
      const local = { x: pt.x - content.x, y: pt.y - content.y };
      if (local.x < 0 || local.y < 0 || local.x > w || local.y > h) return null;
      return local;
    } catch {
      return null;
    }
  }

  private pushContent(text: string): void {
    const cls = this.side + (this.theme === 'dark' ? ' dark' : '');
    // JSON.stringify makes the injected strings inert (no XSS via URL text).
    void this.view.webContents
      .executeJavaScript(
        `document.getElementById('b').textContent=${JSON.stringify(text)};` +
          `document.body.className=${JSON.stringify(cls)};`,
      )
      .catch(() => {
        /* view mid-load or closing; next show() retries */
      });
  }
}
