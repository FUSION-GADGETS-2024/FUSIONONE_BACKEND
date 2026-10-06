'use client';

/**
 * ActionMenu — the shared ⋮ quick-action menu used by the invoice lists.
 *
 * One implementation of the trigger button, open state, outside-click and
 * Escape handling, the portal layer, and the anchored positioning (flips
 * above the trigger when the viewport has more room there). The pages only
 * declare their menu items.
 *
 * Event isolation (the list rows are clickable): both the trigger and the
 * portal layer stop propagation, so opening the menu or running an action
 * never bubbles into the row's navigation onClick.
 */
import { useState, useEffect } from 'react';
import type { ComponentType } from 'react';
import { createPortal } from 'react-dom';
import { MoreVertical } from 'lucide-react';
import { cn } from '@/components/ui/utils';
import { useAnchoredOverlay } from '@/components/ui/anchored-overlay';

export interface ActionMenuItem {
  icon: ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
  /**
   * 'warning' renders the destructive style — amber text, semibold, with a
   * top separator (used by Cancel Invoice).
   */
  tone?: 'default' | 'warning';
}

export function ActionMenu({ items }: { items: ActionMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const { triggerRef, overlayRef, style } = useAnchoredOverlay<HTMLButtonElement, HTMLDivElement>({
    open,
    align: 'right',
    gap: 4,
  });

  // Close on outside click. The menu lives in a portal, so its clicks are
  // outside the trigger in the DOM — the portal layer must count as "inside".
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (
        triggerRef.current?.contains(e.target as Node) ||
        overlayRef.current?.contains(e.target as Node)
      ) return;
      setOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open, triggerRef, overlayRef]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        onClick={e => {
          e.stopPropagation();
          setOpen(v => !v);
        }}
        aria-label="More actions"
        title="More actions"
        className={cn(
          'shrink-0 h-7 w-7 flex items-center justify-center rounded-md transition-colors',
          open ? 'bg-slate-100 text-slate-700' : 'text-slate-400 hover:text-slate-700 hover:bg-slate-100',
        )}
      >
        <MoreVertical className="h-3.5 w-3.5" />
      </button>

      {open && typeof window !== 'undefined' && createPortal(
        <div
          ref={overlayRef}
          onClick={e => e.stopPropagation()}
          style={style ?? undefined}
          className={cn(
            'z-[60] w-44 bg-white border border-slate-200 rounded-xl shadow-xl overflow-hidden menu-fade-in',
            !style && 'invisible',
          )}
        >
          {items.map((item, i) => (
            <button
              key={i}
              onClick={() => {
                setOpen(false);
                item.onClick();
              }}
              className={cn(
                'w-full flex items-center gap-2.5 px-3.5 py-2.5 text-xs transition-colors',
                item.tone === 'warning'
                  ? 'font-semibold text-amber-700 hover:bg-amber-50 border-t border-slate-100'
                  : 'font-medium text-slate-700 hover:bg-slate-50',
              )}
            >
              <item.icon className={cn('h-3.5 w-3.5', item.tone !== 'warning' && 'text-slate-400')} />
              {item.label}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
