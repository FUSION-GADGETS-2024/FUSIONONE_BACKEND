'use client';

import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Check } from 'lucide-react';
import { cn } from '@/components/ui/utils';
import { useAnchoredOverlay } from '@/components/ui/anchored-overlay';
import { useFieldError } from '@/components/ui/form';

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  error?: boolean;
  className?: string;
  /** 'md' (default) matches the Input form field (h-10, text-sm); 'sm' is the compact filter size. */
  size?: 'sm' | 'md';
}

/**
 * Fully custom dropdown — same interaction pattern as the Header FY picker.
 * The option list renders in a fixed-position portal layer anchored to the
 * trigger (useAnchoredOverlay), so it is never clipped by dialog or scroll
 * containers, follows the trigger while its ancestors scroll, and flips
 * above the trigger when the viewport has more room there.
 */
export function Select({
  value,
  onChange,
  options,
  placeholder = 'Select…',
  disabled = false,
  error = false,
  className,
  size = 'md',
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  // Inside a Field with an error, self-wire the error state (Input's).
  const fieldError = useFieldError();
  const invalid = error || !!fieldError;
  const { triggerRef, overlayRef, style } = useAnchoredOverlay<HTMLButtonElement, HTMLDivElement>({
    open,
    matchWidth: true,
    gap: 4,
  });

  // Close on outside click. The option list lives in a portal, so its clicks
  // are outside this wrapper in the DOM — the portal layer must count as
  // "inside" or option clicks would close the list before registering.
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (
        wrapperRef.current?.contains(e.target as Node) ||
        overlayRef.current?.contains(e.target as Node)
      ) return;
      setOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open, overlayRef]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open]);

  const selected = options.find(o => o.value === value);
  const displayLabel = selected ? selected.label : placeholder;
  const isPlaceholder = !selected;

  return (
    <div ref={wrapperRef} className={cn('relative w-full', className)}>
      {/* Trigger */}
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => !disabled && setOpen(v => !v)}
        aria-invalid={invalid ? true : undefined}
        aria-describedby={fieldError ? fieldError.errorId : undefined}
        className={cn(
          'flex w-full items-center justify-between gap-2 border bg-white text-left transition-colors',
          'focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent',
          'disabled:cursor-not-allowed disabled:opacity-50',
          size === 'md'
            ? 'h-10 rounded-md px-3 text-sm'
            : 'rounded-lg px-3 py-2 text-xs',
          open
            ? 'border-indigo-400 ring-2 ring-indigo-500 ring-offset-0'
            : invalid
            ? 'border-rose-400 hover:border-rose-500'
            : 'border-slate-300 hover:border-slate-400',
        )}
      >
        <span className={cn('truncate', isPlaceholder ? 'text-slate-400' : 'text-slate-900 font-medium')}>
          {displayLabel}
        </span>
        <ChevronDown
          className={cn(
            'h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform duration-150',
            open && 'rotate-180',
          )}
        />
      </button>

      {/* Option list — portal layer anchored to the trigger */}
      {open && typeof window !== 'undefined' && createPortal(
        <div
          ref={overlayRef}
          style={style ?? undefined}
          className={cn(
            'z-[60] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg menu-fade-in',
            !style && 'invisible',
          )}
        >
          <div className="max-h-52 overflow-y-auto py-1">
            {options.map(opt => {
              const isSelected = opt.value === value;
              const isEmpty = opt.value === '';
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => {
                    onChange(opt.value);
                    setOpen(false);
                  }}
                  className={cn(
                    'flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition-colors',
                    size === 'md' ? 'text-sm' : 'text-xs',
                    isSelected
                      ? 'bg-indigo-50 text-indigo-700'
                      : isEmpty
                      ? 'text-slate-400 hover:bg-slate-50'
                      : 'text-slate-700 hover:bg-slate-50',
                  )}
                >
                  <span className={cn('truncate', isSelected && 'font-semibold')}>
                    {opt.label}
                  </span>
                  {isSelected && !isEmpty && (
                    <Check className="h-3 w-3 shrink-0 text-indigo-600" />
                  )}
                </button>
              );
            })}
            {options.length === 0 && (
              <div className="px-3 py-2 text-xs text-slate-400">No options available</div>
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
