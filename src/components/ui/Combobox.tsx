'use client';

/**
 * Combobox — the application's ONE searchable, progressively-loaded select.
 *
 * Looks and behaves like a normal FUSION ONE input; opens into an anchored
 * portal dropdown (useAnchoredOverlay — never clipped by dialogs/scroll
 * containers) with:
 *
 *   - type-to-search (the consumer debounces and filters server-side),
 *   - full keyboard interaction (arrows / Enter / Escape, aria combobox),
 *   - silent incremental loading: an IntersectionObserver sentinel prefetches
 *     the next page BEFORE the user reaches the end — no "Load More" button,
 *     no spinner row, no layout movement; the list simply keeps growing,
 *   - an optional pinned action row (e.g. "+ New Party"), always reachable,
 *     including from an empty result set.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Plus, Search, X } from 'lucide-react';
import { cn } from '@/components/ui/utils';
import { useAnchoredOverlay } from '@/components/ui/anchored-overlay';
import { useSkeletonDelay } from '@/components/ui/Skeleton';
import { useFieldError } from '@/components/ui/form';

export interface ComboboxOption {
  value: string;
  label: string;
  /** Secondary text on the option row (e.g. the party's phone number). */
  hint?: string;
}

export interface ComboboxProps {
  value: string;
  onChange: (value: string, option: ComboboxOption | null) => void;
  options: ComboboxOption[];
  /** Resolved display for the current value when it is not in `options`. */
  selected?: ComboboxOption | null;
  placeholder?: string;
  emptyMessage?: string;
  disabled?: boolean;
  error?: boolean;
  /** First page is loading — shows silent skeleton rows. */
  isLoading?: boolean;
  /** More pages exist; the sentinel prefetches them as the user scrolls. */
  hasMore?: boolean;
  onLoadMore?: () => void;
  /** Raw search text (the CONSUMER owns debouncing + server filtering). */
  onSearchChange?: (search: string) => void;
  /** Pinned footer action (e.g. "+ New Party"). */
  action?: { label: string; onSelect: () => void };
  /** Notified on every open/close (lets data hooks enable only while open). */
  onOpenChange?: (open: boolean) => void;
  /** 'md' (default) matches the Input form field; 'sm' is the filter size. */
  size?: 'sm' | 'md';
  /** Show a clear (X) affordance when a value is selected. */
  allowClear?: boolean;
  className?: string;
  id?: string;
  'aria-label'?: string;
}

const TRIGGER_BASE =
  'flex w-full items-center gap-2 border bg-white text-left transition-colors ' +
  'focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent ' +
  'disabled:cursor-not-allowed disabled:opacity-50';

export function Combobox({
  value,
  onChange,
  options,
  selected,
  placeholder = 'Search…',
  emptyMessage = 'No matches found.',
  disabled = false,
  error = false,
  isLoading = false,
  hasMore = false,
  onLoadMore,
  onSearchChange,
  action,
  onOpenChange,
  size = 'md',
  allowClear = false,
  className,
  id,
  ...aria
}: ComboboxProps) {
  const [open, setOpen] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [activeIndex, setActiveIndex] = useState(-1);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const listboxId = useId();
  const selectedOption = useMemo(
    () => selected ?? options.find(o => o.value === value) ?? null,
    [selected, options, value],
  );

  const { triggerRef, overlayRef, style } = useAnchoredOverlay<HTMLDivElement, HTMLDivElement>({
    open,
    matchWidth: true,
    gap: 4,
  });

  const close = useCallback(() => {
    setOpen(false);
    setSearchText('');
    setActiveIndex(-1);
    onSearchChange?.('');
  }, [onSearchChange]);

  const openList = useCallback(() => {
    if (disabled) return;
    setOpen(true);
    setSearchText('');
    const idx = options.findIndex(o => o.value === value);
    setActiveIndex(idx);
  }, [disabled, options, value]);

  // Mirror the open state for consumers (e.g. to gate data hooks).
  useEffect(() => {
    onOpenChange?.(open);
  }, [open, onOpenChange]);

  // Focus the search input whenever the dropdown opens.
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Keep the keyboard highlight valid as the option set changes (search
  // results swap in, next pages append).
  useEffect(() => {
    if (activeIndex >= options.length) setActiveIndex(options.length > 0 ? options.length - 1 : -1);
  }, [options.length, activeIndex]);

  // Scroll the highlighted option into view (keyboard navigation).
  useEffect(() => {
    if (activeIndex < 0) return;
    document.getElementById(`${listboxId}-opt-${activeIndex}`)?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, listboxId]);

  // Outside click closes (the portal layer counts as inside). Close on Escape.
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (
        wrapperRef.current?.contains(e.target as Node) ||
        overlayRef.current?.contains(e.target as Node)
      ) return;
      close();
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') close();
    }
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open, overlayRef, close]);

  // Silent prefetch — the sentinel loads the next page before the user
  // reaches the end of the list. No visible spinner, no layout movement.
  useEffect(() => {
    if (!open || !hasMore || !onLoadMore || options.length === 0) return;
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      entries => {
        if (entries.some(entry => entry.isIntersecting)) onLoadMore();
      },
      { root: listRef.current, rootMargin: '200px 0px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [open, hasMore, onLoadMore, options.length]);

  const select = useCallback(
    (option: ComboboxOption) => {
      onChange(option.value, option);
      close();
    },
    [onChange, close],
  );

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (options.length > 0) setActiveIndex(i => Math.min(i + 1, options.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (options.length > 0) setActiveIndex(i => (i <= 0 ? options.length - 1 : i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeIndex >= 0 && options[activeIndex]) select(options[activeIndex]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  };

  const sizeClasses = size === 'md' ? 'h-10 rounded-md px-3 text-sm' : 'rounded-lg px-3 py-2 text-xs';
  const initialPulsing = useSkeletonDelay(isLoading && options.length === 0);
  const showInitialSkeleton = isLoading && options.length === 0;
  // Inside a Field with an error, self-wire the error state (Input's).
  const fieldError = useFieldError();
  const invalid = error || !!fieldError;

  return (
    <div ref={wrapperRef} className={cn('relative w-full', className)}>
      {/* Trigger — a button when closed, the live search input when open. */}
      <div ref={triggerRef}>
        {open ? (
          <div className={cn(TRIGGER_BASE, sizeClasses, 'border-indigo-400 ring-2 ring-indigo-500')}>
            <Search className="h-3.5 w-3.5 shrink-0 text-slate-400" />
            <input
              ref={inputRef}
              id={id}
              type="text"
              role="combobox"
              aria-expanded={true}
              aria-controls={listboxId}
              aria-autocomplete="list"
              aria-activedescendant={activeIndex >= 0 ? `${listboxId}-opt-${activeIndex}` : undefined}
              aria-label={aria['aria-label']}
              value={searchText}
              placeholder={placeholder}
              onChange={e => {
                setSearchText(e.target.value);
                setActiveIndex(-1);
                onSearchChange?.(e.target.value);
              }}
              onKeyDown={handleSearchKeyDown}
              className="w-full bg-transparent text-slate-900 placeholder:text-slate-400 focus:outline-none min-w-0"
            />
          </div>
        ) : (
          <button
            type="button"
            disabled={disabled}
            onClick={openList}
            aria-invalid={invalid ? true : undefined}
            aria-describedby={fieldError ? fieldError.errorId : undefined}
            className={cn(
              TRIGGER_BASE,
              sizeClasses,
              invalid ? 'border-rose-400 hover:border-rose-500' : 'border-slate-300 hover:border-slate-400',
            )}
          >
            <span className={cn('flex-1 truncate', selectedOption ? 'text-slate-900 font-medium' : 'text-slate-400')}>
              {selectedOption ? selectedOption.label : placeholder}
            </span>
            {allowClear && selectedOption ? (
              <span
                role="button"
                tabIndex={0}
                aria-label="Clear selection"
                title="Clear"
                onClick={e => {
                  e.stopPropagation();
                  onChange('', null);
                }}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.stopPropagation();
                    e.preventDefault();
                    onChange('', null);
                  }
                }}
                className="shrink-0 p-0.5 text-slate-400 hover:text-slate-600 rounded"
              >
                <X className="h-3.5 w-3.5" />
              </span>
            ) : (
              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-400" />
            )}
          </button>
        )}
      </div>

      {/* Dropdown — portal layer anchored to the trigger */}
      {open && typeof window !== 'undefined' && createPortal(
        <div
          ref={overlayRef}
          style={style ?? undefined}
          className={cn(
            'z-[60] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl menu-fade-in',
            !style && 'invisible',
          )}
        >
          <div ref={listRef} className="max-h-64 overflow-y-auto py-1" role="listbox" id={listboxId} aria-label={aria['aria-label'] ?? 'Options'}>
            {showInitialSkeleton ? (
              [...Array(3)].map((_, i) => (
                <div key={i} className={cn('mx-3 my-1.5 h-8 rounded-md bg-slate-100', initialPulsing && 'animate-pulse')} />
              ))
            ) : options.length === 0 ? (
              <div className="px-3 py-6 text-center text-xs text-slate-400">{emptyMessage}</div>
            ) : (
              <>
                {options.map((option, i) => {
                  const isSelected = option.value === value;
                  const isActive = i === activeIndex;
                  return (
                    <button
                      key={option.value}
                      id={`${listboxId}-opt-${i}`}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      onClick={() => select(option)}
                      onMouseEnter={() => setActiveIndex(i)}
                      className={cn(
                        'flex w-full items-center gap-2 px-3 py-2 text-left transition-colors',
                        size === 'md' ? 'text-sm' : 'text-xs',
                        isSelected
                          ? 'bg-indigo-50 text-indigo-700'
                          : isActive
                          ? 'bg-slate-50 text-slate-900'
                          : 'text-slate-700',
                      )}
                    >
                      <span className="flex-1 truncate font-medium">{option.label}</span>
                      {option.hint && (
                        <span className={cn('shrink-0 tabular-nums', isSelected ? 'text-indigo-500' : 'text-slate-400')}>
                          {option.hint}
                        </span>
                      )}
                      {isSelected && <Check className="h-3 w-3 shrink-0 text-indigo-600" />}
                    </button>
                  );
                })}
                {/* Prefetch sentinel — visually silent (1px, aria-hidden). */}
                {hasMore && <div ref={sentinelRef} aria-hidden="true" className="h-px w-full" />}
              </>
            )}
          </div>
          {action && (
            <button
              type="button"
              onClick={() => {
                close();
                action.onSelect();
              }}
              className="w-full flex items-center gap-2 px-3 py-2.5 text-left text-xs font-semibold text-indigo-600 hover:bg-indigo-50 border-t border-slate-100 transition-colors"
            >
              <Plus className="h-3.5 w-3.5" />
              {action.label}
            </button>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
