import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useExtensionsStore } from '../stores/extensionsStore';
import { useTabsStore } from '../stores/tabsStore';
import { voksa } from '../lib/bridge';

/**
 * Row of extension action icons in the toolbar.
 *
 * Each icon is a standalone `<button is="browser-action">`, the customized
 * built-in element registered in the main world by electron-chrome-extensions'
 * preload (injectBrowserAction() in src/preload/ui.ts). The element itself
 * handles icon rendering (crx://), the badge, left-click (popup or
 * chrome.action.onClicked dispatch) and right-click (native extension
 * context menu) through the library.
 *
 * We render the elements ourselves instead of using <browser-action-list>
 * so the row follows the user-defined order (settings extensionOrder) and
 * supports drag-and-drop reordering.
 *
 * Standalone elements do NOT self-subscribe to action state (only the list
 * element does), so this component drives the observation lifecycle via the
 * `window.browserAction` bridge and re-pokes the elements (re-setting the
 * `tab` attribute triggers their attributeChangedCallback → refresh) when
 * the state or the active tab changes.
 */

const PARTITION = '_self';

export function ExtensionActions(): React.ReactElement | null {
  const extensions = useExtensionsStore((s) => s.extensions);
  const activeWcId = useTabsStore(
    (s) => s.tabs.find((t) => t.isActive)?.wcId ?? -1,
  );
  const withAction = extensions.filter((e) => e.hasAction);
  const hasActions = withAction.length > 0;

  const containerRef = useRef<HTMLDivElement>(null);
  const activeWcIdRef = useRef(activeWcId);
  activeWcIdRef.current = activeWcId;

  // Mount the buttons only once the first action state has been fetched;
  // before that, the elements would render with no data.
  const [ready, setReady] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  const syncElements = useCallback(() => {
    const nodes =
      containerRef.current?.querySelectorAll('button[is="browser-action"]') ?? [];
    for (const node of Array.from(nodes)) {
      node.setAttribute('tab', String(activeWcIdRef.current));
    }
  }, []);

  useEffect(() => {
    const bridge = window.browserAction;
    if (!bridge || !hasActions) return;
    bridge.addObserver(PARTITION);
    void bridge.getState(PARTITION).then(() => setReady(true));
    const onUpdate = () => syncElements();
    bridge.addEventListener('update', onUpdate);
    return () => {
      bridge.removeEventListener('update', onUpdate);
      bridge.removeObserver(PARTITION);
    };
  }, [hasActions, syncElements]);

  // The elements' very first update cycle can race the initial state fetch
  // (observed: blank icon on a fresh boot until any attribute poke). One
  // poke on the next frame plus a late backup makes the first paint
  // reliable; steady-state refreshes come from the 'update' listener above.
  useEffect(() => {
    if (!ready) return;
    const raf = requestAnimationFrame(() => syncElements());
    const timer = window.setTimeout(() => syncElements(), 400);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
    };
  }, [ready, syncElements]);

  const handleDrop = (targetId: string) => {
    if (!dragId || dragId === targetId) return;
    const ids = withAction.map((e) => e.id);
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(targetId);
    if (from === -1 || to === -1) return;
    ids.splice(to, 0, ...ids.splice(from, 1));
    // Rebuild the full order (shared with the Settings page list) keeping
    // extensions without a toolbar action at their current positions.
    const actionIds = new Set(ids);
    let k = 0;
    const fullOrder = extensions.map((e) => (actionIds.has(e.id) ? ids[k++] : e.id));
    void voksa.extensions.reorder(fullOrder);
  };

  if (!hasActions || !ready) return null;

  return (
    <div ref={containerRef} className="flex items-center gap-0.5">
      {withAction.map((ext) => (
        <div
          key={ext.id}
          draggable
          onDragStart={(e) => {
            setDragId(ext.id);
            e.dataTransfer.effectAllowed = 'move';
          }}
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            if (overId !== ext.id) setOverId(ext.id);
          }}
          onDragLeave={() => setOverId((cur) => (cur === ext.id ? null : cur))}
          onDrop={(e) => {
            e.preventDefault();
            handleDrop(ext.id);
            setDragId(null);
            setOverId(null);
          }}
          onDragEnd={() => {
            setDragId(null);
            setOverId(null);
          }}
          className={`no-drag rounded-lg transition-opacity ${
            dragId === ext.id ? 'opacity-40' : ''
          } ${
            overId === ext.id && dragId && dragId !== ext.id
              ? 'ring-1 ring-accent'
              : ''
          }`}
        >
          <button
            is="browser-action"
            // All attributes go through the ref: React ≤18 does not map
            // className→class (nor reliably other props) on custom elements,
            // so setAttribute is the only dependable path. The inline ref
            // runs on every commit, keeping `tab` in sync with the active
            // tab; push updates (badge changes with no React render) are
            // covered by the 'update' listener.
            ref={(el) => {
              if (!el) return;
              el.setAttribute('id', ext.id);
              el.setAttribute('class', 'voksa-ext-action');
              el.setAttribute('tab', String(activeWcId));
            }}
          />
        </div>
      ))}
    </div>
  );
}
