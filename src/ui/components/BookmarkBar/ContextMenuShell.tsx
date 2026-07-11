import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';

type Props = {
  x: number;
  y: number;
  onClose: () => void;
  children: React.ReactNode;
  /** Tailwind width class; the page context menu needs a wider panel. */
  widthClass?: string;
};

/**
 * Positioning + dismissal shell shared by the bookmark-bar context menus.
 *
 * Initial position as-is; we reclamp once the chrome WebContentsView has
 * expanded to full window (the overlay-mode resize happens on the next
 * frame after the menu mounts). A second rAF lets the measured element's
 * own height factor in, too.
 */
export function ContextMenuShell({
  x,
  y,
  onClose,
  children,
  widthClass = 'w-[220px]',
}: Props): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onEsc);
    };
  }, [onClose]);

  const [pos, setPos] = useState<{ left: number; top: number }>({ left: x, top: y });
  useLayoutEffect(() => {
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        const el = ref.current;
        if (!el) return;
        // offsetWidth/offsetHeight: transform-independent, unlike
        // getBoundingClientRect which under-measures mid entry animation.
        const left = Math.max(4, Math.min(x, window.innerWidth - el.offsetWidth - 4));
        const top = Math.max(4, Math.min(y, window.innerHeight - el.offsetHeight - 4));
        setPos({ left, top });
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      if (raf2) cancelAnimationFrame(raf2);
    };
  }, [x, y]);

  return (
    <div
      ref={ref}
      style={{ position: 'fixed', left: pos.left, top: pos.top, zIndex: 9999 }}
      // fade-in, not scale-in: a transform on this panel would become the
      // containing block for the extension flyouts (position:fixed inside
      // this scroller) and clip them while the animation runs.
      className={`${widthClass} bg-bg-elevated border border-border rounded-lg shadow-light-strong py-1 animate-fade-in max-h-[80vh] overflow-y-auto`}
    >
      {children}
    </div>
  );
}

export function ContextMenuItem({
  icon: Icon,
  label,
  onClick,
  danger,
  disabled,
}: {
  icon: React.ComponentType<{ size?: number | string; className?: string }>;
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}): React.ReactElement {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`w-full flex items-center gap-3 px-3 h-9 text-[13px] disabled:opacity-40 disabled:hover:bg-transparent ${
        danger ? 'text-stream hover:bg-stream/10' : 'text-fg hover:bg-bg-hover'
      }`}
    >
      <Icon size={14} className="flex-shrink-0" />
      <span className="flex-1 text-left truncate">{label}</span>
    </button>
  );
}

export function ContextMenuSeparator(): React.ReactElement {
  return <div className="my-1 h-px bg-border mx-2" />;
}
