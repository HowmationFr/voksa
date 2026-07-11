import React from 'react';
import { Bookmark, Clock, Globe, Search } from 'lucide-react';
import type { Suggestion } from '../../../shared/types';
import { MaskedText } from '../MaskedText';

type Props = {
  items: Suggestion[];
  selectedIndex: number;
  onSelect: (s: Suggestion) => void;
  onHover: (index: number) => void;
};

const ICONS: Record<Suggestion['kind'], React.ComponentType<{ size?: number | string; className?: string }>> = {
  history: Clock,
  bookmark: Bookmark,
  search: Search,
  url: Globe,
};

export function Suggestions({ items, selectedIndex, onSelect, onHover }: Props): React.ReactElement {
  return (
    <div className="absolute left-0 right-0 top-full mt-2 bg-bg-elevated border border-border rounded-xl shadow-float overflow-hidden z-50 animate-scale-in p-1">
      {items.map((s, i) => {
        const Icon = ICONS[s.kind];
        const selected = i === selectedIndex;
        return (
          <button
            key={i}
            onMouseDown={(e) => {
              e.preventDefault();
              onSelect(s);
            }}
            onMouseEnter={() => onHover(i)}
            className={`w-full flex items-center gap-3 px-3 h-10 text-left text-sm rounded-lg transition-colors ${
              selected ? 'bg-accent/10 text-fg' : 'text-fg hover:bg-bg-hover'
            }`}
          >
            <Icon size={15} className={`flex-shrink-0 ${selected ? 'text-accent' : 'text-fg-muted'}`} />
            <span className="flex-1 truncate">
              <MaskedText text={s.label} />
            </span>
            {s.subtitle && (
              <span className="flex-shrink-0 text-fg-subtle text-[12px] truncate max-w-[260px]">
                <MaskedText text={s.subtitle} />
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
