'use client';

/**
 * tables.tsx — the application's ONE table/list foundation.
 *
 * Every structured business list renders through `DataTable`:
 *
 *   - the table shell (card surface, toolbar band, scroll container),
 *   - the header/cell rhythm (one density: px-4 py-2.5, text-xs cells,
 *     micro-uppercase headers, tabular money, row hover, dividers),
 *   - the loading skeleton (geometry-matched rows + action reserve),
 *   - the empty state,
 *   - the responsive behavior (desktop table / mobile cards that reuse the
 *     SAME cell renders, so typography hierarchy is identical everywhere).
 *
 * Pages provide only what is genuinely theirs: columns (header + render +
 * alignment), row data, actions, and navigation behavior.
 */
import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { Search } from 'lucide-react';
import { cn } from '@/components/ui/utils';
import { useSkeletonDelay } from '@/components/ui/Skeleton';
import { ListViewport } from '@/components/list-page/ListViewport';
import { ListFirstLoadError, ListStatusTail } from '@/components/list-page/ListStatusTail';
import type { ListPagination } from '@/components/list-page/use-list-pagination';

// ── Column model ─────────────────────────────────────────────────────────────

/** Where a column's content lands in the mobile card layout. */
export type MobileColumnRole = 'identity' | 'secondary' | 'amount' | 'meta' | 'actions';

export interface DataTableColumn<T> {
  id: string;
  header?: ReactNode;
  /** Text alignment for the desktop column. Default 'left'. */
  align?: 'left' | 'right' | 'center';
  /** Tailwind width class applied to the header cell (e.g. 'w-[15%]'). */
  width?: string;
  /** Extra classes merged onto every body cell of this column. */
  cellClassName?: string;
  /** The cell content — the SAME render is reused by the mobile card. */
  render: (row: T) => ReactNode;
  /**
   * Role in the mobile card layout. Default false (column is hidden on
   * mobile — mobile content is always a conscious choice):
   *
   *   identity   top-left primary line (first wins, one per table)
   *   secondary  lines stacked under the identity
   *   amount     right-aligned stack (order = column order), with an
   *              optional tiny label via `mobileLabel`
   *   meta       bottom chip row (dates, status pills, links)
   *   actions    bottom-right action group
   */
  mobile?: MobileColumnRole | false;
  /** Tiny uppercase label rendered beside an amount on mobile (e.g. "Due"). */
  mobileLabel?: string;
  /** Skeleton geometry: 1 = single bar, 2 = two-line cell. Default 1. */
  skeletonLines?: 1 | 2;
}

// ── Cell content helpers (the shared cell typography) ───────────────────────

/**
 * The standard two-line cell (primary + secondary), truncating both lines so
 * long content can never stretch the row: primary `text-xs`, secondary
 * `text-[11px] text-slate-400`, fixed line-heights.
 */
export function CellLines({
  primary,
  secondary,
  primaryClassName,
  secondaryClassName,
}: {
  primary: ReactNode;
  secondary?: ReactNode;
  primaryClassName?: string;
  secondaryClassName?: string;
}) {
  return (
    <div className="min-w-0 space-y-0.5">
      <div className={cn('text-xs leading-4 font-medium text-slate-900 truncate', primaryClassName)}>{primary}</div>
      {secondary !== undefined && secondary !== null && secondary !== '' && (
        <div className={cn('text-[11px] leading-4 text-slate-400 truncate', secondaryClassName)}>{secondary}</div>
      )}
    </div>
  );
}

/**
 * The stable row-action group — a fixed, non-shrinking cluster at the cell's
 * edge. Keeps [VIEW][⋮] / [VIEW][pencil] / custom actions aligned across
 * every table; the group never wraps or yields space to content.
 */
export function RowActions({
  children,
  align = 'end',
}: {
  children: ReactNode;
  align?: 'end' | 'center';
}) {
  return (
    <div className={cn('flex flex-nowrap items-center gap-1', align === 'end' ? 'justify-end' : 'justify-center')}>
      {children}
    </div>
  );
}

// ── Toolbar pieces ──────────────────────────────────────────────────────────

/** The table's ONE search control (h-8, icon, the shared input classes). */
export function TableSearchInput({
  value,
  onChange,
  placeholder,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <div className={cn('relative flex-1 max-w-xs', className)}>
      <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400 pointer-events-none" />
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder ?? 'Search'}
        className="w-full h-8 pl-8 pr-3 text-xs border border-slate-200 rounded-lg bg-white text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
      />
    </div>
  );
}

/** The standard list-page heading skeleton (title + subtitle + action). */
export function ListHeaderSkeleton({
  titleWidth = 'w-20',
  subtitleWidth = 'w-52',
  actionWidth = 'w-24',
  pulsing,
}: {
  titleWidth?: string;
  subtitleWidth?: string;
  actionWidth?: string | null;
  pulsing?: boolean;
}) {
  return (
    <div className={cn('flex items-center justify-between gap-4', pulsing && 'animate-pulse')}>
      <div className="space-y-1.5">
        <div className={cn('h-4 bg-slate-100 rounded', titleWidth)} />
        <div className={cn('h-3 bg-slate-100 rounded', subtitleWidth)} />
      </div>
      {actionWidth && <div className={cn('h-8 bg-slate-100 rounded-md shrink-0', actionWidth)} />}
    </div>
  );
}

// ── Shared class tokens ─────────────────────────────────────────────────────

const CELL = 'px-4 py-2.5 align-middle';
const HEAD_CELL = 'px-4 py-2.5 text-[10px] font-bold uppercase tracking-[0.08em] text-slate-400 leading-4 whitespace-nowrap';
const ALIGN: Record<'left' | 'right' | 'center', string> = {
  left: 'text-left',
  right: 'text-right',
  center: 'text-center',
};

/** Default skeleton reserve for an actions column: [VIEW][⋮]-sized pair. */
const DEFAULT_ACTION_RESERVE = (
  <div className="flex flex-nowrap items-center gap-1">
    <div className="h-7 w-14 bg-slate-100 rounded-md" />
    <div className="h-7 w-7 bg-slate-100 rounded-md" />
  </div>
);

// ── DataTable ───────────────────────────────────────────────────────────────

export interface DataTableProps<T> {
  columns: Array<DataTableColumn<T>>;
  rows: T[];
  rowKey: (row: T) => string;
  /** Shows the geometry-matched skeleton instead of rows. */
  loading?: boolean;
  /** Skeleton row count while loading. Default 7. */
  skeletonRows?: number;
  /** Rendered when not loading and rows is empty. */
  emptyMessage?: ReactNode;
  /** Toolbar band above the table (search + filters). */
  toolbar?: ReactNode;
  /** Full-width region below the table (count line, notice band). */
  footer?: ReactNode;
  /** Extra `<tr>` rows appended inside the tbody after data rows. */
  footerRows?: ReactNode;
  /** Tailwind min-width class for the desktop scroll area (e.g. 'min-w-[880px]'). */
  minWidth?: string;
  /** Use fixed column layout (all columns should carry explicit widths). */
  fixed?: boolean;
  /** Per-row extra classes (e.g. cancelled-row dimming). */
  rowClassName?: (row: T) => string | undefined;
  /** Skeleton reserve for the actions column. Default: [VIEW][⋮]-sized pair. */
  actionReserve?: ReactNode;
  /** Classes on the outer shell. */
  className?: string;
  /**
   * The list-page architecture: the card fills its parent's height and
   * ONLY the rows scroll. The toolbar band and the (sticky) column
   * header stay fixed; the rows viewport (with its prefetch sentinel,
   * status tail, adaptive bottom edge and scroll restoration) is the
   * single scroll container. Default false — the card sizes to its
   * content and the page scrolls (modals, bounded lists).
   */
  fill?: boolean;
  /** Scroll-to-load / full-dataset pagination state (the shared contract). */
  pagination?: ListPagination;
  /** Sibling-viewport discriminator for scroll restoration (multi-list pages). */
  scrollRestore?: string;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  loading = false,
  skeletonRows = 7,
  emptyMessage = 'No records found.',
  toolbar,
  footer,
  footerRows,
  minWidth,
  fixed = false,
  rowClassName,
  actionReserve = DEFAULT_ACTION_RESERVE,
  className,
  fill = false,
  pagination,
  scrollRestore,
}: DataTableProps<T>) {
  // Skeleton motion is gated by the loading threshold: geometry renders
  // immediately, shimmer only starts if the wait becomes noticeable.
  const pulsing = useSkeletonDelay(loading);

  // A failed first load is its own state — never reported as an empty
  // list (an empty list is a successful query with zero records).
  const initialFailed = pagination?.initialFailed === true && !loading;
  const isEmpty = !loading && !initialFailed && rows.length === 0;

  const { mobileIdentity, mobileSecondary, mobileAmounts, mobileMeta, mobileActions } = useMemo(() => {
    const visible = columns.filter(c => c.mobile);
    return {
      mobileIdentity: visible.find(c => c.mobile === 'identity'),
      mobileSecondary: visible.filter(c => c.mobile === 'secondary'),
      mobileAmounts: visible.filter(c => c.mobile === 'amount'),
      mobileMeta: visible.filter(c => c.mobile === 'meta'),
      mobileActions: visible.find(c => c.mobile === 'actions'),
    };
  }, [columns]);

  const headerRow = (
    <tr>
      {columns.map(col => (
        <th
          key={col.id}
          scope="col"
          className={cn(HEAD_CELL, ALIGN[col.align ?? 'left'], col.width)}
        >
          {col.header}
        </th>
      ))}
    </tr>
  );

  const skeletonBody = [...Array(skeletonRows)].map((_, i) => (
    <tr key={i}>
      {columns.map(col => (
        <td key={col.id} className={CELL}>
          {col.mobile === 'actions' ? (
            <div className="flex justify-end">{actionReserve}</div>
          ) : col.skeletonLines === 2 ? (
            <div className="space-y-1.5">
              <div className="h-3 bg-slate-100 rounded" />
              <div className="h-2.5 w-2/3 bg-slate-100 rounded" />
            </div>
          ) : (
            <div className="h-3.5 max-w-[90%] bg-slate-100 rounded" />
          )}
        </td>
      ))}
    </tr>
  ));

  const dataBody = (
    <>
      {rows.map(row => (
        <tr key={rowKey(row)} className={cn('hover:bg-slate-50/60 transition-colors', rowClassName?.(row))}>
          {columns.map(col => (
            <td key={col.id} className={cn(CELL, col.cellClassName)}>
              {col.render(row)}
            </td>
          ))}
        </tr>
      ))}
      {isEmpty && !fill && (
        <tr>
          <td colSpan={columns.length} className="px-4 py-10 text-center text-xs text-slate-400">
            {emptyMessage}
          </td>
        </tr>
      )}
      {footerRows}
    </>
  );

  const mobileCards = (list: T[]) => (
    <>
      {loading
        ? [...Array(Math.min(skeletonRows, 6))].map((_, i) => (
            <div key={i} className="px-4 py-3 flex items-start justify-between gap-4">
              <div className="flex-1 space-y-1.5">
                <div className="h-3.5 w-2/3 bg-slate-100 rounded" />
                <div className="h-2.5 w-1/2 bg-slate-100 rounded" />
              </div>
              <div className="h-3.5 w-20 bg-slate-100 rounded" />
            </div>
          ))
        : list.map(row => (
            <div key={rowKey(row)} className={cn('px-4 py-3', rowClassName?.(row))}>
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  {mobileIdentity && <div className="min-w-0">{mobileIdentity.render(row)}</div>}
                  {mobileSecondary.map(col => (
                    <div key={col.id} className="min-w-0 mt-1">
                      {col.render(row)}
                    </div>
                  ))}
                </div>
                {mobileAmounts.length > 0 && (
                  <div className="shrink-0 flex flex-col items-end gap-1">
                    {mobileAmounts.map(col => (
                      <div key={col.id} className="flex items-baseline justify-end gap-1.5">
                        {col.mobileLabel && (
                          <span className="text-[9px] font-bold uppercase tracking-wider text-slate-400">
                            {col.mobileLabel}
                          </span>
                        )}
                        {col.render(row)}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {(mobileMeta.length > 0 || mobileActions) && (
                <div className="mt-2.5 flex items-center justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 min-w-0">
                    {mobileMeta.map(col => (
                      <span key={col.id} className="min-w-0">
                        {col.render(row)}
                      </span>
                    ))}
                  </div>
                  {mobileActions && <div className="shrink-0">{mobileActions.render(row)}</div>}
                </div>
              )}
            </div>
          ))}
    </>
  );

  return (
    <div
      className={cn(
        'bg-white rounded-xl border border-slate-200 overflow-hidden',
        fill && 'flex min-h-0 flex-1 flex-col',
        className,
      )}
    >
      {/* Toolbar band — reserved during loading (skeleton bar) so the real
          toolbar lands without any layout shift. */}
      {toolbar && (
        <div
          className={cn(
            'p-3 border-b border-slate-100 flex flex-col sm:flex-row gap-3 shrink-0',
            loading && pulsing && 'animate-pulse',
          )}
        >
          {loading ? <div className="h-8 w-56 bg-slate-100 rounded-md" /> : toolbar}
        </div>
      )}

      {fill ? (
        /* ── List-page architecture: ONLY the rows scroll. The column
            header is pinned to the top of the viewport; the status tail
            (prefetch sentinel · Loading more… · retry) and the card
            footer live at the end of the content. */
        <ListViewport restoreKey={scrollRestore}>
          <div className="flex min-h-full flex-col">
            {/* Desktop table — sticky header inside the viewport */}
            <div className="hidden md:block">
              <table className={cn('w-full text-left', fixed && 'table-fixed', minWidth)}>
                <thead className={cn('bg-slate-50 border-b border-slate-100', 'sticky top-0 z-10')}>
                  {headerRow}
                </thead>
                <tbody className={cn('divide-y divide-slate-50', loading && pulsing && 'animate-pulse')}>
                  {loading ? skeletonBody : dataBody}
                </tbody>
              </table>
            </div>

            {/* Mobile cards — same cell renders, re-laid-out */}
            <div className={cn('md:hidden divide-y divide-slate-50', loading && pulsing && 'animate-pulse')}>
              {mobileCards(rows)}
            </div>

            {/* Empty state — centered in the viewport, clearly distinct
                from loading (skeletons) and from a failed first load. */}
            {isEmpty && (
              <div className="flex flex-1 items-center justify-center px-4 py-10 text-center text-xs text-slate-400">
                {emptyMessage}
              </div>
            )}

            {/* First-load failure — its own recoverable state. */}
            {initialFailed && pagination && <ListFirstLoadError onRetry={pagination.retryInitial} />}

            {/* Scroll-to-load status tail (silent pagination + retry;
                an exhausted list renders nothing — it simply ends) */}
            {pagination && (
              <ListStatusTail pagination={pagination} hasRows={rows.length > 0} />
            )}

            {footer && !loading && <div>{footer}</div>}
          </div>
        </ListViewport>
      ) : (
        <>
          {/* ── Desktop table ─────────────────────────────────────────────── */}
          <div className={cn('hidden md:block overflow-x-auto')}>
            <table className={cn('w-full text-left', fixed && 'table-fixed', minWidth)}>
              <thead className="bg-slate-50 border-b border-slate-100">{headerRow}</thead>
              <tbody className={cn('divide-y divide-slate-50', loading && pulsing && 'animate-pulse')}>
                {loading ? skeletonBody : dataBody}
              </tbody>
            </table>
          </div>

          {/* ── Mobile cards — same cell renders, re-laid-out ──────────────── */}
          <div className={cn('md:hidden divide-y divide-slate-50', loading && pulsing && 'animate-pulse')}>
            {mobileCards(rows)}
            {isEmpty && <div className="px-4 py-10 text-center text-xs text-slate-400">{emptyMessage}</div>}
          </div>

          {footer && !loading && <div>{footer}</div>}
        </>
      )}
    </div>
  );
}
