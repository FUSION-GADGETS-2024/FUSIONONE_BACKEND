/**
 * List pagination — the shared scroll-to-load contract used by every list
 * page: request locking (no duplicate page fetches), exhaustion detection,
 * first-load failure as its own state (never "empty"), recoverable retries,
 * the early-prefetch sentinel (arm/disarm/intersection) and the in-memory
 * scroll store behind viewport restoration. DOM-level states of the shared
 * tail ("Loading more…", retry, the silent natural end) are covered in
 * listStatusTail.test.tsx.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { useRef } from 'react';
import {
  useInfiniteListPagination,
  usePrefetchSentinel,
  prefetchMarginFor,
  staticPagination,
  type InfiniteQueryLike,
  type ListPagination,
} from '@/components/list-page/use-list-pagination';
import { rememberScroll, consumeScroll } from '@/components/list-page/scroll-memory';

// ── Harnesses ───────────────────────────────────────────────────────────────

/** Probe that exposes a hook's latest result for assertions. */
function useProbe<T>(fn: () => T): { current: T } {
  const ref = useRef<T>(undefined as unknown as T);
  ref.current = fn();
  return ref;
}

function InfiniteProbe({ query }: { query: InfiniteQueryLike }) {
  const probe = useProbe(() => useInfiniteListPagination(query));
  return (
    <div>
      <button onClick={() => probe.current.loadMore()}>loadMore</button>
      <button onClick={() => probe.current.retry()}>retry</button>
      <button onClick={() => probe.current.retryInitial()}>retryInitial</button>
      <span data-testid="state">
        {[
          probe.current.isLoadingFirst ? 'loadingFirst' : '',
          probe.current.isFetchingNext ? 'fetchingNext' : '',
          probe.current.loadFailed ? 'loadFailed' : '',
          probe.current.exhausted ? 'exhausted' : '',
          probe.current.initialFailed ? 'initialFailed' : '',
        ]
          .filter(Boolean)
          .join(' ')}
      </span>
    </div>
  );
}

function makeQuery(overrides: Partial<InfiniteQueryLike> = {}): InfiniteQueryLike {
  return {
    isLoading: false,
    isError: false,
    isFetchingNextPage: false,
    hasNextPage: true,
    data: { pages: [{ rows: [1] }] },
    fetchNextPage: vi.fn() as unknown as () => unknown,
    refetch: vi.fn() as unknown as () => unknown,
    ...overrides,
  };
}

// ── Infinite pagination state ───────────────────────────────────────────────

describe('useInfiniteListPagination — the one scroll-to-load state', () => {
  it('derives the four states from the query', () => {
    const q = makeQuery();
    const { rerender } = render(<InfiniteProbe query={q} />);
    expect(document.querySelector('[data-testid="state"]')?.textContent).toBe('');

    rerender(<InfiniteProbe query={makeQuery({ isLoading: true, data: undefined, hasNextPage: false })} />);
    expect(document.querySelector('[data-testid="state"]')?.textContent).toBe('loadingFirst');

    rerender(<InfiniteProbe query={makeQuery({ isFetchingNextPage: true })} />);
    expect(document.querySelector('[data-testid="state"]')?.textContent).toBe('fetchingNext');

    rerender(<InfiniteProbe query={makeQuery({ hasNextPage: false })} />);
    expect(document.querySelector('[data-testid="state"]')?.textContent).toBe('exhausted');
  });

  it('a first-page failure is initialFailed, never loadFailed or exhausted', () => {
    render(<InfiniteProbe query={makeQuery({ isError: true, data: undefined })} />);
    expect(document.querySelector('[data-testid="state"]')?.textContent).toBe('initialFailed');
  });

  it('a later-page failure keeps the loaded rows recoverable (loadFailed)', () => {
    render(<InfiniteProbe query={makeQuery({ isError: true })} />);
    expect(document.querySelector('[data-testid="state"]')?.textContent).toBe('loadFailed');
  });

  it('request locking — loadMore is ignored while a request is in flight', () => {
    const q = makeQuery({ isFetchingNextPage: true });
    render(<InfiniteProbe query={q} />);
    (document.querySelector('button') as HTMLButtonElement).click();
    expect(q.fetchNextPage).not.toHaveBeenCalled();
  });

  it('request locking — loadMore is ignored after a failure (retry owns it)', () => {
    const q = makeQuery({ isError: true });
    render(<InfiniteProbe query={q} />);
    (document.querySelector('button') as HTMLButtonElement).click();
    expect(q.fetchNextPage).not.toHaveBeenCalled();
  });

  it('request locking — loadMore is ignored at the end of the data', () => {
    const q = makeQuery({ hasNextPage: false });
    render(<InfiniteProbe query={q} />);
    (document.querySelector('button') as HTMLButtonElement).click();
    expect(q.fetchNextPage).not.toHaveBeenCalled();
  });

  it('a healthy idle state requests the next page exactly once per call', () => {
    const q = makeQuery();
    render(<InfiniteProbe query={q} />);
    const loadMore = document.querySelectorAll('button')[0] as HTMLButtonElement;
    loadMore.click();
    loadMore.click();
    expect(q.fetchNextPage).toHaveBeenCalledTimes(2);
  });

  it('retry re-requests the failed page once, and only after a failure', () => {
    const healthy = makeQuery();
    const { rerender } = render(<InfiniteProbe query={healthy} />);
    (document.querySelectorAll('button')[1] as HTMLButtonElement).click();
    expect(healthy.fetchNextPage).not.toHaveBeenCalled();

    const failed = makeQuery({ isError: true });
    rerender(<InfiniteProbe query={failed} />);
    (document.querySelectorAll('button')[1] as HTMLButtonElement).click();
    expect(failed.fetchNextPage).toHaveBeenCalledTimes(1);
  });

  it('retryInitial re-runs the initial load after a first-page failure', () => {
    const q = makeQuery({ isError: true, data: undefined });
    render(<InfiniteProbe query={q} />);
    (document.querySelectorAll('button')[2] as HTMLButtonElement).click();
    expect(q.refetch).toHaveBeenCalledTimes(1);
  });
});

// ── Static (full-dataset) pagination ────────────────────────────────────────

describe('staticPagination — the full-dataset counterpart', () => {
  it('the whole list arriving means the list is definitively exhausted', () => {
    const p = staticPagination({ isLoading: false, isError: false, refetch: vi.fn() });
    expect(p.exhausted).toBe(true);
    expect(p.isLoadingFirst).toBe(false);
    expect(p.isFetchingNext).toBe(false);
  });

  it('exhausted is suppressed when the display window can hide matches', () => {
    const p = staticPagination({ isLoading: false, isError: false, refetch: vi.fn() }, { exhausted: false });
    expect(p.exhausted).toBe(false);
  });

  it('while loading, nothing is claimed; an error is a first-load failure', () => {
    const loading = staticPagination({ isLoading: true, isError: false, refetch: vi.fn() });
    expect(loading.exhausted).toBe(false);
    expect(loading.isLoadingFirst).toBe(true);

    const failed = staticPagination({ isLoading: false, isError: true, refetch: vi.fn() });
    expect(failed.initialFailed).toBe(true);
    expect(failed.exhausted).toBe(false);
  });

  it('loadMore is always a no-op (there is no next page to request)', () => {
    const p = staticPagination({ isLoading: false, isError: false, refetch: vi.fn() });
    expect(() => p.loadMore()).not.toThrow();
  });
});

// ── Early-prefetch sentinel ─────────────────────────────────────────────────

/** Minimal IntersectionObserver stand-in (jsdom has none). A
 *  disconnected observer never reports — like the real one. */
class MockIntersectionObserver {
  static instances: MockIntersectionObserver[] = [];
  callback: IntersectionObserverCallback;
  observed: Element[] = [];
  disconnected = false;
  constructor(cb: IntersectionObserverCallback, _init?: IntersectionObserverInit) {
    this.callback = cb;
    MockIntersectionObserver.instances.push(this);
  }
  observe(el: Element) {
    this.observed.push(el);
  }
  disconnect() {
    this.disconnected = true;
    this.observed = [];
  }
  unobserve() {}
  fire(isIntersecting: boolean) {
    if (this.disconnected) return;
    this.callback(
      [{ isIntersecting } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
}

function SentinelProbe({ onLoadMore, active }: { onLoadMore: () => void; active: boolean }) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = usePrefetchSentinel(viewportRef, onLoadMore, active);
  return (
    <div ref={viewportRef}>
      <div ref={sentinelRef} data-testid="sentinel" />
    </div>
  );
}

describe('usePrefetchSentinel — early prefetch, armed only when useful', () => {
  beforeEach(() => {
    MockIntersectionObserver.instances = [];
    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('observes while active and requests the page on intersection', () => {
    const onLoadMore = vi.fn();
    render(<SentinelProbe onLoadMore={onLoadMore} active />);
    expect(MockIntersectionObserver.instances).toHaveLength(1);
    const observer = MockIntersectionObserver.instances[0];
    expect(observer.observed).toHaveLength(1);

    observer.fire(true);
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it('an inactive sentinel never subscribes (in flight / failed / exhausted)', () => {
    const onLoadMore = vi.fn();
    render(<SentinelProbe onLoadMore={onLoadMore} active={false} />);
    expect(MockIntersectionObserver.instances).toHaveLength(0);
    expect(onLoadMore).not.toHaveBeenCalled();
  });

  it('re-arms after activity flips back (a fresh observer re-examines the sentinel)', () => {
    const onLoadMore = vi.fn();
    const { rerender } = render(<SentinelProbe onLoadMore={onLoadMore} active />);
    const first = MockIntersectionObserver.instances[0];
    rerender(<SentinelProbe onLoadMore={onLoadMore} active={false} />);
    // Disconnected — a late callback from the old observer must not fire.
    first.fire(true);
    expect(onLoadMore).not.toHaveBeenCalled();

    rerender(<SentinelProbe onLoadMore={onLoadMore} active />);
    expect(MockIntersectionObserver.instances).toHaveLength(2);
    // Still-intersecting sentinel: the fresh observer reports immediately —
    // this is what keeps buffered pages coming after an append.
    MockIntersectionObserver.instances[1].fire(true);
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });
});

// ── Prefetch margin ─────────────────────────────────────────────────────────

describe('prefetchMarginFor — look-ahead derived from the viewport', () => {
  it('scales with the viewport height and never drops below the floor', () => {
    expect(prefetchMarginFor(null)).toBe('480px 0px');
    expect(prefetchMarginFor(200)).toBe('480px 0px');
    expect(prefetchMarginFor(800)).toBe('1200px 0px');
    expect(prefetchMarginFor(1000)).toBe('1500px 0px');
  });
});

// ── Scroll memory ───────────────────────────────────────────────────────────

describe('scroll-memory — in-memory offsets, consumed on restore', () => {
  it('round-trips an offset and consumes it (a second read is empty)', () => {
    rememberScroll('/sales', 321.6);
    expect(consumeScroll('/sales')).toBe(322);
    expect(consumeScroll('/sales')).toBeNull();
  });

  it('negative offsets never enter the store', () => {
    rememberScroll('/parties', -10);
    expect(consumeScroll('/parties')).toBe(0);
  });

  it('evicts the oldest entry beyond the cap', () => {
    for (let i = 0; i < 70; i++) rememberScroll(`/p/${i}`, i);
    // The first ten were evicted; the newest survive.
    expect(consumeScroll('/p/0')).toBeNull();
    expect(consumeScroll('/p/69')).toBe(69);
  });
});

// ── ListPagination contract ─────────────────────────────────────────────────

describe('ListPagination — the shape every list consumes', () => {
  it('exposes exactly the consolidated contract', () => {
    const p: ListPagination = staticPagination({ isLoading: false, isError: false, refetch: vi.fn() });
    for (const key of [
      'isLoadingFirst',
      'isFetchingNext',
      'loadFailed',
      'exhausted',
      'initialFailed',
      'loadMore',
      'retry',
      'retryInitial',
    ] as const) {
      expect(p).toHaveProperty(key);
    }
  });
});
