import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  ChevronRight,
  ClipboardPaste,
  Copy,
  Download,
  ExternalLink,
  Image as ImageIcon,
  Link2,
  PictureInPicture2,
  RotateCw,
  Scissors,
  Search,
  SearchCode,
  TextCursorInput,
  Trash2,
} from 'lucide-react';
import type { PageMenuExtensionItem, PageMenuPayload } from '../../shared/types';
import { voksa } from '../lib/bridge';
import { useT } from '../lib/i18n';
import { useMaskedText } from '../lib/masking';
import { MaskedText } from './MaskedText';
import {
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShell,
} from './BookmarkBar/ContextMenuShell';

type Props = {
  payload: PageMenuPayload;
  onClose: () => void;
};

/**
 * The page right-click menu, in React: follows the app theme (the native
 * Electron popup stayed dark in light mode), gets a proper width, and can
 * mask stream-sensitive text. Section order mirrors Chrome; extension items
 * (chrome.contextMenus) sit between page actions and Inspect.
 */
export function PageContextMenu({ payload, onClose }: Props): React.ReactElement {
  const t = useT();
  const act = (action: string, arg?: number | string) => {
    void voksa.pageMenu.action(payload.token, action, arg);
    onClose();
  };

  const selection = payload.selectionText.trim();
  const shortSelection = selection.length > 30 ? selection.slice(0, 30) + '…' : selection;
  // The DOM is already masked while streaming, but belt-and-suspenders: the
  // label goes through the same mask patterns as every chrome-UI string.
  const maskedSelection = useMaskedText(shortSelection);

  const hasLink = payload.linkURL !== '';
  const isImage = payload.mediaType === 'image' && payload.srcURL !== '';
  const isVideo = payload.mediaType === 'video' && payload.srcURL !== '';
  const pageLevel =
    !hasLink && !payload.isEditable && !selection && payload.mediaType === 'none';

  return (
    <ContextMenuShell x={payload.x} y={payload.y} onClose={onClose} widthClass="w-[280px]">
      {hasLink && (
        <>
          <ContextMenuItem
            icon={ExternalLink}
            label={t('Ouvrir le lien dans un nouvel onglet')}
            onClick={() => act('open-link-bg')}
          />
          <ContextMenuItem
            icon={ExternalLink}
            label={t('Ouvrir dans un nouvel onglet actif')}
            onClick={() => act('open-link')}
          />
          <ContextMenuItem
            icon={Link2}
            label={t('Copier l’adresse du lien')}
            onClick={() => act('copy-link')}
          />
          <ContextMenuSeparator />
        </>
      )}

      {isImage && (
        <>
          <ContextMenuItem
            icon={ImageIcon}
            label={t('Ouvrir l’image dans un nouvel onglet')}
            onClick={() => act('open-image')}
          />
          <ContextMenuItem icon={Copy} label={t('Copier l’image')} onClick={() => act('copy-image')} />
          <ContextMenuItem
            icon={Link2}
            label={t('Copier l’adresse de l’image')}
            onClick={() => act('copy-image-url')}
          />
          <ContextMenuItem
            icon={Download}
            label={t('Enregistrer l’image sous…')}
            onClick={() => act('save-image')}
          />
          <ContextMenuSeparator />
        </>
      )}

      {isVideo && (
        <>
          <ContextMenuItem
            icon={PictureInPicture2}
            label={t('Image dans l’image')}
            onClick={() => act('pip')}
          />
          <ContextMenuSeparator />
        </>
      )}

      {payload.isEditable && (
        <>
          {payload.dictionarySuggestions.map((suggestion, i) => (
            <ContextMenuItem
              key={`${suggestion}-${i}`}
              icon={TextCursorInput}
              label={suggestion}
              onClick={() => act('replace-misspelling', i)}
            />
          ))}
          {payload.dictionarySuggestions.length > 0 && <ContextMenuSeparator />}
          <ContextMenuItem icon={Scissors} label={t('Couper')} onClick={() => act('cut')} />
          <ContextMenuItem icon={Copy} label={t('Copier')} onClick={() => act('copy')} />
          <ContextMenuItem icon={ClipboardPaste} label={t('Coller')} onClick={() => act('paste')} />
          <ContextMenuItem
            icon={TextCursorInput}
            label={t('Tout sélectionner')}
            onClick={() => act('select-all')}
          />
          <ContextMenuSeparator />
        </>
      )}

      {!payload.isEditable && selection && (
        <>
          <ContextMenuItem icon={Copy} label={t('Copier')} onClick={() => act('copy')} />
          <ContextMenuItem
            icon={Search}
            label={t('Rechercher « {selection} »', { selection: maskedSelection })}
            onClick={() => act('search-selection')}
          />
          <ContextMenuSeparator />
        </>
      )}

      {pageLevel && (
        <>
          <ContextMenuItem
            icon={ArrowLeft}
            label={t('Précédent')}
            disabled={!payload.canGoBack}
            onClick={() => act('back')}
          />
          <ContextMenuItem
            icon={ArrowRight}
            label={t('Suivant')}
            disabled={!payload.canGoForward}
            onClick={() => act('forward')}
          />
          <ContextMenuItem icon={RotateCw} label={t('Recharger')} onClick={() => act('reload')} />
          <ContextMenuSeparator />
        </>
      )}

      {payload.extensions.length > 0 && (
        <>
          <ExtensionEntries items={payload.extensions} onAction={act} />
          <ContextMenuSeparator />
        </>
      )}

      <ContextMenuItem
        icon={Trash2}
        label={t('Vider le cache et actualiser')}
        onClick={() => act('clear-cache-reload')}
      />
      <ContextMenuItem icon={SearchCode} label={t('Inspecter')} onClick={() => act('inspect')} />
    </ContextMenuShell>
  );
}

type FlyoutAnchor = { left: number; top: number; right: number; bottom: number };

const FLYOUT_WIDTH = 280;
const SUBMENU_HOVER_DELAY_MS = 150;

/**
 * Extension items (chrome.contextMenus) with Chrome-style cascading
 * submenus: hovering a submenu row opens a flyout to its right (flipping
 * left near the window edge, like FolderDropdown), recursively. One open
 * child per level. The shared timer tracks WHAT it will commit
 * (pendingRef), so a submenu row's mouseleave only cancels its own
 * pending open and never swallows a close armed elsewhere. Closing is
 * driven by a document-level watcher: hovering anything outside this
 * block (built-in rows, separators, the veil) schedules the flyout
 * closed; entering the flyout cancels an armed close (diagonal paths
 * cross the gap and the rows below). Labels go through MaskedText:
 * extension menus routinely embed emails/accounts (e.g. Bitwarden
 * autofill entries).
 */
function ExtensionEntries({
  items,
  preferLeft = false,
  onAction,
}: {
  items: PageMenuExtensionItem[];
  /** Once a level flips to the left, the whole descendant chain opens left. */
  preferLeft?: boolean;
  onAction: (action: string, arg?: string) => void;
}): React.ReactElement {
  const blockRef = useRef<HTMLDivElement>(null);
  const [openChild, setOpenChild] = useState<{ id: string; rect: FlyoutAnchor } | null>(null);
  const hoverTimer = useRef<number | null>(null);
  const pendingRef = useRef<{ next: { id: string; rect: FlyoutAnchor } | null } | null>(null);

  const cancelPending = () => {
    if (hoverTimer.current !== null) {
      window.clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
    pendingRef.current = null;
  };
  const schedule = (next: { id: string; rect: FlyoutAnchor } | null) => {
    cancelPending();
    pendingRef.current = { next };
    hoverTimer.current = window.setTimeout(() => {
      hoverTimer.current = null;
      pendingRef.current = null;
      setOpenChild(next);
    }, SUBMENU_HOVER_DELAY_MS);
  };
  useEffect(() => cancelPending, []);

  useEffect(() => {
    if (!openChild) return;
    const onOver = (e: MouseEvent) => {
      if (blockRef.current?.contains(e.target as Node)) return;
      if (pendingRef.current && pendingRef.current.next === null) return;
      schedule(null);
    };
    document.addEventListener('mouseover', onOver);
    return () => document.removeEventListener('mouseover', onOver);
    // schedule/pendingRef are ref-stable; only the open state gates the watcher.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openChild]);

  const openItem = openChild ? items.find((i) => i.id === openChild.id) : undefined;

  return (
    <div ref={blockRef}>
      {items.map((item) => {
        if (item.type === 'separator') return <ContextMenuSeparator key={item.id} />;
        if (item.type === 'submenu') {
          return (
            <ExtensionSubmenuRow
              key={item.id}
              item={item}
              isOpen={openChild?.id === item.id}
              onHover={(rect) => schedule({ id: item.id, rect })}
              onHoverEnd={() => {
                if (pendingRef.current?.next?.id === item.id) cancelPending();
              }}
              onActivate={(rect) => {
                cancelPending();
                setOpenChild((cur) => (cur?.id === item.id ? null : { id: item.id, rect }));
              }}
            />
          );
        }
        return (
          <ExtensionLeafRow
            key={item.id}
            item={item}
            onHover={() => openChild && schedule(null)}
            onAction={onAction}
          />
        );
      })}
      {openChild && openItem?.children && (
        <ExtensionFlyout
          key={openChild.id}
          items={openItem.children}
          anchor={openChild.rect}
          preferLeft={preferLeft}
          onMouseEnter={() => {
            if (pendingRef.current && pendingRef.current.next === null) cancelPending();
          }}
          onAction={onAction}
        />
      )}
    </div>
  );
}

function ExtensionSubmenuRow({
  item,
  isOpen,
  onHover,
  onHoverEnd,
  onActivate,
}: {
  item: PageMenuExtensionItem;
  isOpen: boolean;
  onHover: (rect: FlyoutAnchor) => void;
  onHoverEnd: () => void;
  onActivate: (rect: FlyoutAnchor) => void;
}): React.ReactElement {
  const maskedLabel = useMaskedText(item.label);
  const rectOf = (e: React.MouseEvent): FlyoutAnchor => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  };
  return (
    <button
      disabled={!item.enabled}
      onMouseEnter={(e) => onHover(rectOf(e))}
      onMouseLeave={onHoverEnd}
      onClick={(e) => onActivate(rectOf(e))}
      title={maskedLabel}
      className={`w-full flex items-center gap-3 px-3 h-9 text-[13px] text-fg hover:bg-bg-hover disabled:opacity-40 disabled:hover:bg-transparent ${
        isOpen ? 'bg-bg-hover' : ''
      }`}
    >
      <span className="flex-1 min-w-0 truncate text-left">
        <MaskedText text={item.label} />
      </span>
      <ChevronRight size={13} className="flex-shrink-0 text-fg-subtle" />
    </button>
  );
}

function ExtensionLeafRow({
  item,
  onHover,
  onAction,
}: {
  item: PageMenuExtensionItem;
  onHover: () => void;
  onAction: (action: string, arg?: string) => void;
}): React.ReactElement {
  const maskedLabel = useMaskedText(item.label);
  return (
    <button
      onClick={() => item.enabled && onAction('extension', item.id)}
      onMouseEnter={onHover}
      disabled={!item.enabled}
      title={maskedLabel}
      className="w-full flex items-center gap-3 px-3 h-9 text-[13px] text-fg hover:bg-bg-hover disabled:opacity-40 disabled:hover:bg-transparent"
    >
      <span className="flex-1 min-w-0 truncate text-left">
        <MaskedText text={item.label} />
      </span>
    </button>
  );
}

/**
 * One cascading panel. Rendered INSIDE the shell's subtree on purpose:
 * the shell's click-outside test is ref.contains(target), so a portal to
 * body would dismiss the whole menu on mousedown in a flyout. Menu panels
 * animate with opacity only (animate-fade-in): a transform, even a 130ms
 * scale-in, makes the animating panel the containing block for these
 * position:fixed children, which mispositions and overflow-clips a flyout
 * opened by CLICK during that window (hover waits 150ms, click does not).
 */
function ExtensionFlyout({
  items,
  anchor,
  preferLeft,
  onMouseEnter,
  onAction,
}: {
  items: PageMenuExtensionItem[];
  anchor: FlyoutAnchor;
  preferLeft: boolean;
  onMouseEnter: () => void;
  onAction: (action: string, arg?: string) => void;
}): React.ReactElement {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({
    left: preferLeft ? anchor.left - FLYOUT_WIDTH - 2 : anchor.right + 2,
    top: anchor.top - 4,
  });
  const [flippedLeft, setFlippedLeft] = useState(preferLeft);

  // Double-rAF like FolderDropdown: measure our real size, then clamp
  // vertically and flip to the left of the anchor row if we'd overflow.
  // offsetWidth/offsetHeight, not getBoundingClientRect: the latter is
  // transform-inclusive and under-measures by ~4% mid entry animation.
  useLayoutEffect(() => {
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        const el = ref.current;
        if (!el) return;
        const w = el.offsetWidth;
        const h = el.offsetHeight;
        let left = preferLeft ? anchor.left - w - 2 : anchor.right + 2;
        let flipped = preferLeft;
        if (!flipped && left + w > window.innerWidth - 4) {
          left = anchor.left - w - 2;
          flipped = true;
        }
        left = Math.max(4, left);
        const top = Math.max(4, Math.min(anchor.top - 4, window.innerHeight - h - 4));
        setPos({ left, top });
        setFlippedLeft(flipped);
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      if (raf2) cancelAnimationFrame(raf2);
    };
  }, [anchor.left, anchor.right, anchor.top, anchor.bottom, preferLeft, items.length]);

  return (
    <div
      ref={ref}
      style={{ position: 'fixed', left: pos.left, top: pos.top, width: FLYOUT_WIDTH, zIndex: 9999 }}
      className="bg-bg-elevated border border-border rounded-lg shadow-light-strong py-1 animate-fade-in max-h-[70vh] overflow-y-auto"
      onMouseEnter={onMouseEnter}
    >
      {items.length === 0 ? (
        <div className="px-3 h-9 flex items-center text-[12px] text-fg-subtle select-none">{t('(vide)')}</div>
      ) : (
        <ExtensionEntries items={items} preferLeft={flippedLeft} onAction={onAction} />
      )}
    </div>
  );
}
