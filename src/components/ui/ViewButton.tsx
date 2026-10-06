'use client';

/**
 * ViewButton — the shared compact VIEW control for list rows.
 *
 * The explicit detail-navigation action of every list row (the row content
 * itself never navigates). Uses the existing FUSIONONE row-action language
 * (the Inventory VIEW control): compact, text-visible, uppercase, subtle
 * indigo — the exact classes already used across the app, just declared once.
 */
import { perfViewClick } from '@/platform/perf';

export function ViewButton({
  onClick,
  label = 'View',
}: {
  onClick: () => void;
  /** Overridable text — stays text-visible per the accessibility rules. */
  label?: string;
}) {
  return (
    <button
      type="button"
      onClick={() => {
        perfViewClick(); // dev-only trace start (no-op in production)
        onClick();
      }}
      className="shrink-0 h-7 px-2 text-[10px] font-bold uppercase tracking-wider text-indigo-600 hover:bg-indigo-50 rounded-md transition-colors"
    >
      {label}
    </button>
  );
}
