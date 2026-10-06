'use client';

/**
 * SegmentedTabs — the application's ONE segmented tab selector.
 *
 * The exact visual language of the Payments page's "Payments In / Payments
 * Out" control (originally the Party Detail pattern): a compact slate track
 * with white active pills. Extracted as a shared primitive so every page
 * level tab navigation (Payments, Settings …) renders the identical control
 * — one source of truth for the tab geometry, active state, and responsive
 * behavior (the track wraps naturally on narrow widths).
 */
import { cn } from '@/components/ui/utils';

export interface SegmentedTabItem<T extends string> {
  value: T;
  label: string;
}

export interface SegmentedTabsProps<T extends string> {
  tabs: ReadonlyArray<SegmentedTabItem<T>>;
  value: T;
  onChange: (value: T) => void;
  /** Accessible name for the tablist (required — the control is not a form). */
  'aria-label': string;
  className?: string;
}

export function SegmentedTabs<T extends string>({
  tabs,
  value,
  onChange,
  className,
  ...aria
}: SegmentedTabsProps<T>) {
  return (
    <div
      className={cn('inline-flex items-center rounded-lg bg-slate-100 p-0.5', className)}
      role="tablist"
      aria-label={aria['aria-label']}
    >
      {tabs.map((tab) => {
        const isActive = tab.value === value;
        return (
          <button
            key={tab.value}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(tab.value)}
            className={cn(
              'h-7 px-3.5 rounded-md text-xs font-semibold transition-colors',
              isActive
                ? 'bg-white text-slate-900 shadow-sm'
                : 'text-slate-500 hover:text-slate-700',
            )}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
