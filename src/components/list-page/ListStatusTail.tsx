'use client';

/**
 * ListStatusTail — the shared bottom-of-content status region for every
 * scrollable list (table or custom rows). Rendered INSIDE the list
 * viewport, after the last row, it owns:
 *
 *   - the early-prefetch sentinel (present whenever more pages may
 *     exist; its observer is rooted at the enclosing ListViewport);
 *   - ONE fixed-height status row that clearly separates the states:
 *
 *       still loading     → "Loading more…"   (no spinner, no overlay —
 *                           the fallback for when the user outruns the
 *                           early prefetch; rows above never move)
 *       failed            → "Couldn't load more." + Try again
 *                           (loaded rows preserved, cursor untouched)
 *       exhausted         → nothing at all    (the data source has no
 *                           more records — the list simply ends, with
 *                           no terminal message; the internal state
 *                           still stops every further request)
 *       idle, pages left  → nothing           (the sentinel works quietly)
 *
 * The fixed height keeps state changes from shifting any layout, and the
 * states never overlap: a pending request is never reported as the end.
 */
import type { ReactNode } from 'react';
import { RotateCw, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useListViewport } from './ListViewport';
import { usePrefetchSentinel } from './use-list-pagination';
import type { ListPagination } from './use-list-pagination';

/** One quiet, fixed-height status band (the shared footer language). */
function StatusBand({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-10 shrink-0 items-center justify-between gap-3 border-t border-slate-100 bg-slate-50/50 px-4">
      {children}
    </div>
  );
}

export interface ListStatusTailProps {
  pagination: ListPagination;
  /** Rows are on screen (the tail never renders for an empty list). */
  hasRows: boolean;
}

export function ListStatusTail({ pagination, hasRows }: ListStatusTailProps) {
  const viewportRef = useListViewport();
  const sentinelActive =
    hasRows &&
    !pagination.exhausted && // more pages may exist
    !pagination.isFetchingNext &&
    !pagination.loadFailed &&
    !pagination.isLoadingFirst &&
    !pagination.initialFailed;
  const sentinelRef = usePrefetchSentinel(viewportRef, pagination.loadMore, sentinelActive);

  // The first load (and its failure) is owned by the skeleton / error
  // states, never by the pagination tail.
  if (!hasRows || pagination.isLoadingFirst || pagination.initialFailed) return null;

  if (pagination.loadFailed) {
    return (
      <StatusBand>
        <p className="text-xs text-rose-500">Couldn&apos;t load more.</p>
        <Button
          size="sm"
          variant="outline"
          onClick={pagination.retry}
          className="gap-1.5 text-xs h-7"
        >
          <RotateCw className="h-3 w-3" /> Try again
        </Button>
      </StatusBand>
    );
  }

  if (pagination.isFetchingNext) {
    return (
      <StatusBand>
        <p className="text-xs text-slate-400">Loading more…</p>
      </StatusBand>
    );
  }

  // Exhausted — the natural end. The internal state already stops every
  // further request (loadMore is a guarded no-op, the sentinel is
  // disconnected); nothing is displayed: no terminal footer message, the
  // list simply ends and the viewport's soft fade retires by itself.
  if (pagination.exhausted) return null;

  // Idle with more pages available — the quiet prefetch sentinel.
  return <div ref={sentinelRef} aria-hidden="true" className="h-0 w-full shrink-0" />;
}

// ── First-load failure ──────────────────────────────────────────────────────

/**
 * The shared initial-load failure block: the first page's request failed
 * — distinct from an empty list (which is a successful query with zero
 * records) and from a pagination failure (which keeps loaded rows).
 */
export function ListFirstLoadError({
  onRetry,
  message = "Couldn't load the list.",
}: {
  onRetry: () => void;
  message?: string;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-4 py-10 text-center">
      <AlertCircle className="h-6 w-6 text-rose-300 mb-2" />
      <p className="text-xs font-semibold text-slate-500">{message}</p>
      <p className="text-xs text-slate-400 mt-1">Something went wrong. Please try again.</p>
      <Button size="sm" variant="outline" onClick={onRetry} className="gap-1.5 text-xs h-7 mt-3">
        <RotateCw className="h-3 w-3" /> Retry
      </Button>
    </div>
  );
}

/** Re-exported for custom (non-DataTable) lists building their own viewport content. */
export { StatusBand };
