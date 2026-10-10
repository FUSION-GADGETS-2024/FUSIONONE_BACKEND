'use client';

/**
 * use-list-pagination.ts — the ONE consolidated scroll-to-load state.
 *
 * Every list that can grow progressively (TanStack infinite queries) and
 * every full-dataset list (one request = the whole list) derives the SAME
 * state contract here, and every sentinel/append/footer behavior in the
 * app consumes it:
 *
 *   idle → (sentinel approaches the viewport edge) → request next page
 *        → append results (existing rows never move) → idle
 *
 *   - request locking: loadMore is a no-op while a request is in flight,
 *     after a failure (use retry), during the first load, or at the end —
 *     rapid scrolling / repeated sentinel intersections can never
 *     duplicate a page request;
 *   - end detection: pagination is exhausted exactly when the data source
 *     has no further pages (never merely because a request is pending);
 *   - first-load failures are distinct from empty lists.
 */
import { useCallback, useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { useLocation, useNavigationType } from 'react-router';
import { rememberScroll, consumeScroll } from './scroll-memory';

// ── The state contract ──────────────────────────────────────────────────────

/** The consolidated scroll-to-load state every list shares. */
export interface ListPagination {
  /** The first page is still loading (no rows rendered yet). */
  isLoadingFirst: boolean;
  /** The next page is being fetched — silent: every loaded row stays put. */
  isFetchingNext: boolean;
  /** The next page's request failed — recoverable; rows are preserved. */
  loadFailed: boolean;
  /** The data source has no further pages. */
  exhausted: boolean;
  /** The initial load itself failed (no rows on screen). */
  initialFailed: boolean;
  /**
   * Ask for the next page. Guarded: ignored while a request is in flight,
   * after a failure (use retry), during the first load, or at the end.
   */
  loadMore: () => void;
  /** Retry a failed next-page fetch (the failed page is re-requested;
   *  loaded rows and the cursor state are untouched). */
  retry: () => void;
  /** Re-run the initial load after initialFailed. */
  retryInitial: () => void;
}

/** The subset of an infinite query result the state derivation needs. */
export interface InfiniteQueryLike {
  readonly isLoading: boolean;
  readonly isError: boolean;
  readonly isFetchingNextPage: boolean;
  readonly hasNextPage: boolean;
  /** Defined only after the first page succeeded. */
  readonly data?: unknown;
  readonly fetchNextPage: () => unknown;
  readonly refetch: () => unknown;
}

/** The subset of a plain (full-dataset) query result the derivation needs. */
export interface StaticQueryLike {
  readonly isLoading: boolean;
  readonly isError: boolean;
  readonly refetch: () => unknown;
}

// ── Infinite (scroll-to-load) derivation ────────────────────────────────────

/**
 * Derive the shared state from a TanStack infinite query. The query key
 * (search text, filters, financial year, …) already owns reset semantics —
 * a changed key is a fresh query that starts at the first page, so results
 * from an old query can never be appended to a new one.
 */
export function useInfiniteListPagination(query: InfiniteQueryLike): ListPagination {
  const hasData = query.data !== undefined;
  const isLoadingFirst = query.isLoading;
  const isFetchingNext = query.isFetchingNextPage;
  const initialFailed = query.isError && !hasData;
  const loadFailed = query.isError && hasData;
  const exhausted = hasData && !query.hasNextPage;

  const fetchNextPage = query.fetchNextPage;
  const refetch = query.refetch;
  const hasNextPage = query.hasNextPage;

  // Request locking — the ONE guard every trigger path goes through.
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNext && !loadFailed && !isLoadingFirst) {
      void fetchNextPage();
    }
  }, [hasNextPage, isFetchingNext, loadFailed, isLoadingFirst, fetchNextPage]);

  // Retry re-requests the SAME next page (TanStack keeps the cursor), so a
  // failed request can never corrupt the pagination sequence.
  const retry = useCallback(() => {
    if (hasNextPage && !isFetchingNext && loadFailed) void fetchNextPage();
  }, [hasNextPage, isFetchingNext, loadFailed, fetchNextPage]);

  const retryInitial = useCallback(() => {
    if (initialFailed) void refetch();
  }, [initialFailed, refetch]);

  return {
    isLoadingFirst,
    isFetchingNext,
    loadFailed,
    exhausted,
    initialFailed,
    loadMore,
    retry,
    retryInitial,
  };
}

// ── Static (full-dataset) derivation ────────────────────────────────────────

/**
 * The full-dataset counterpart: the whole list arrives in one request, so
 * after it lands there are definitively no more records. `exhausted` can
 * be suppressed by callers whose display window can legitimately hide
 * matches (e.g. a search capped at its result limit — "more may exist").
 *
 * A plain function (no hooks): the derived guards are all no-ops.
 */
export function staticPagination(
  query: StaticQueryLike,
  options?: { exhausted?: boolean },
): ListPagination {
  const noop = () => undefined;
  return {
    isLoadingFirst: query.isLoading,
    isFetchingNext: false,
    loadFailed: false,
    exhausted: !query.isLoading && !query.isError && (options?.exhausted ?? true),
    initialFailed: query.isError,
    loadMore: noop,
    retry: noop,
    retryInitial: () => void query.refetch(),
  };
}

// ── Early-prefetch sentinel ─────────────────────────────────────────────────

/** How far from the viewport's bottom edge prefetching begins, as a share
 *  of the viewport's own height (~1.5 viewports of look-ahead) with a
 *  generous floor — chosen against the app's page sizes (10–20 rows) and
 *  observed response times so the next page is normally appended before
 *  the user reaches the end of the loaded content. */
export const DEFAULT_PREFETCH_MARGIN_RATIO = 1.5;
const MIN_PREFETCH_MARGIN = 480;

/** The sentinel's rootMargin for a given viewport height. */
export function prefetchMarginFor(viewportHeight: number | null): string {
  const margin =
    viewportHeight != null
      ? Math.max(MIN_PREFETCH_MARGIN, Math.round(viewportHeight * DEFAULT_PREFETCH_MARGIN_RATIO))
      : MIN_PREFETCH_MARGIN;
  return `${margin}px 0px`;
}

/**
 * The early-prefetch sentinel — ONE IntersectionObserver rooted at the
 * list's own scroll viewport (not the window). The sentinel element sits
 * after the last loaded row; the observer asks for the next page while
 * the end is still comfortably away (the margin is derived from the
 * viewport's own height at arm time, so every list gets an appropriate
 * look-ahead instead of one arbitrary constant).
 *
 * The observer is (re)created whenever `active` flips — in particular
 * after a page append, when the still-intersecting sentinel must be
 * re-examined so buffered pages keep arriving until the look-ahead is
 * satisfied. While inactive (in flight / failed / exhausted) it is fully
 * disconnected: no further requests can fire.
 */
export function usePrefetchSentinel(
  viewportRef: RefObject<HTMLElement | null> | null,
  onLoadMore: () => void,
  active: boolean,
): RefObject<HTMLDivElement | null> {
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !active) return;
    const root = viewportRef?.current ?? null;
    const observer = new IntersectionObserver(
      entries => {
        if (entries.some(entry => entry.isIntersecting)) onLoadMore();
      },
      { root, rootMargin: prefetchMarginFor(root?.clientHeight ?? null) },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [active, onLoadMore, viewportRef]);

  return sentinelRef;
}

// ── Viewport scroll restoration ─────────────────────────────────────────────

/**
 * The list-viewport counterpart of the shell's <main> restoration.
 *
 * Tracks the viewport's offset continuously (the DOM swap on navigation
 * would clamp the element before a late read could recover it), remembers
 * it under `restoreKey` when the viewport unmounts, and on a Back (POP)
 * return restores it after the cached rows have rendered — the same
 * in-memory policy as the shell, no storage, no URL state. A restore is
 * only attempted into content tall enough to hold the remembered offset;
 * a still-loading page simply starts at the top.
 *
 * `discriminator` separates sibling viewports on one page (a page's
 * tabbed lists); keys are always pathname-scoped.
 */
export function useViewportScrollRestore(
  viewportRef: RefObject<HTMLElement | null>,
  discriminator?: string,
): void {
  const location = useLocation();
  const navigationType = useNavigationType();
  const key = discriminator ? `${location.pathname}::${discriminator}` : location.pathname;

  // Continuous tracking + remember-on-unmount (also covers a key change:
  // the leaving viewport's offset is saved under the old key).
  const offsetRef = useRef(0);
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onScroll = () => {
      offsetRef.current = el.scrollTop;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      rememberScroll(key, offsetRef.current);
    };
  }, [viewportRef, key]);

  // Restore once per key, on a Back/Forward (POP) arrival only — fresh
  // navigations start at the top.
  const restoredKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (restoredKeyRef.current === key) return;
    restoredKeyRef.current = key;
    if (navigationType !== 'POP') return;
    const restoreTo = consumeScroll(key);
    if (restoreTo == null || restoreTo <= 0) return;
    // Cached infinite batches render synchronously; the rAF lands after
    // that paint with the final content height.
    requestAnimationFrame(() => {
      const el = viewportRef.current;
      if (!el) return;
      const maxScroll = el.scrollHeight - el.clientHeight;
      if (restoreTo <= maxScroll) el.scrollTop = restoreTo;
    });
  }, [key, navigationType, viewportRef]);
}
