/**
 * ListStatusTail + DataTable fill mode — the DOM contract of the shared
 * list-page states. The states must remain clearly distinct and silent:
 *
 *   initial loading      → skeleton rows (never a terminal state)
 *   first-load failure   → its own recoverable error block (never "empty")
 *   empty                → the empty state (never a terminal / loading state)
 *   records + fetching   → existing rows stay + a quiet "Loading more…"
 *                          band — no spinner anywhere
 *   records + failed     → rows stay + "Couldn't load more." + Try again
 *   records + exhausted  → NOTHING — the list simply ends (no terminal
 *                          footer message of any kind)
 *   records + idle       → nothing (the prefetch sentinel works quietly)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { DataTable } from '@/components/ui/tables';
import type { DataTableColumn } from '@/components/ui/tables';
import { ListStatusTail } from '@/components/list-page/ListStatusTail';
import { staticPagination, type ListPagination } from '@/components/list-page/use-list-pagination';

// jsdom has no IntersectionObserver — the quiet sentinel path needs one.
beforeEach(() => {
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** A working pagination state the tests can tweak per case. */
function paginationState(overrides: Partial<ListPagination> = {}): ListPagination {
  return {
    isLoadingFirst: false,
    isFetchingNext: false,
    loadFailed: false,
    exhausted: false,
    initialFailed: false,
    loadMore: vi.fn(),
    retry: vi.fn(),
    retryInitial: vi.fn(),
    ...overrides,
  };
}

interface Row {
  id: string;
  name: string;
}

const columns: Array<DataTableColumn<Row>> = [
  { id: 'name', header: 'Name', render: r => <span>{r.name}</span> },
];
const rows: Row[] = [
  { id: '1', name: 'One' },
  { id: '2', name: 'Two' },
];

function renderTable(props: Record<string, unknown> = {}) {
  return render(
    <MemoryRouter>
      <div className="flex h-[300px] flex-col">
        <DataTable<Row>
          columns={columns}
          rows={rows}
          rowKey={r => r.id}
          fill
          {...(props as object)}
        />
      </div>
    </MemoryRouter>,
  );
}

// ── ListStatusTail (standalone, outside DataTable) ──────────────────────────

describe('ListStatusTail — one fixed-height status row per state', () => {
  it('shows the quiet Loading more… band while the next page is fetched', () => {
    render(
      <div>
        <ListStatusTail pagination={paginationState({ isFetchingNext: true })} hasRows />
      </div>,
    );
    expect(screen.getByText('Loading more…')).toBeTruthy();
    // No spinner element is rendered for pagination loading.
    expect(document.querySelector('.animate-spin')).toBeNull();
  });

  it('a failed page keeps rows and offers Try again', () => {
    const retry = vi.fn();
    render(
      <div>
        <ListStatusTail pagination={paginationState({ loadFailed: true, retry })} hasRows />
      </div>,
    );
    expect(screen.getByText("Couldn't load more.")).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('exhaustion renders nothing visible — the list simply ends', () => {
    const { container } = render(
      <div>
        <ListStatusTail pagination={paginationState({ exhausted: true })} hasRows />
      </div>,
    );
    // No terminal footer message of any kind — the natural end.
    expect(container.textContent).toBe('');
    expect(screen.queryByText('End of list')).toBeNull();
    expect(screen.queryByText('End of results')).toBeNull();
  });

  it('idle with more pages renders no status (only the quiet sentinel)', () => {
    render(
      <div>
        <ListStatusTail pagination={paginationState()} hasRows />
      </div>,
    );
    expect(screen.queryByText('Loading more…')).toBeNull();
    expect(screen.queryByText('End of list')).toBeNull();
    expect(screen.queryByText("Couldn't load more.")).toBeNull();
  });

  it('renders nothing for an empty list (the empty state owns that case)', () => {
    const { container } = render(
      <div>
        <ListStatusTail pagination={paginationState({ exhausted: true })} hasRows={false} />
      </div>,
    );
    expect(container.textContent).toBe('');
  });

  it('renders nothing while the first page or its retry owns the surface', () => {
    const { container } = render(
      <div>
        <ListStatusTail pagination={paginationState({ isLoadingFirst: true })} hasRows />
      </div>,
    );
    expect(container.textContent).toBe('');
  });
});

// ── DataTable fill mode ─────────────────────────────────────────────────────

describe('DataTable fill — the rows viewport is the single scroll container', () => {
  it('pins a sticky table header above the scrolling rows', () => {
    renderTable();
    const thead = document.querySelector('thead');
    expect(thead).toBeTruthy();
    expect(thead?.className).toContain('sticky');
    expect(thead?.className).toContain('top-0');
    // The scroll viewport exists and contains the rows.
    const viewport = thead?.closest('div[class*="overflow-auto"]');
    expect(viewport).toBeTruthy();
    expect(viewport?.textContent).toContain('One');
  });

  it('initial loading renders skeleton rows, never a terminal state', () => {
    renderTable({
      rows: [],
      loading: true,
      pagination: paginationState({ isLoadingFirst: true }),
    });
    expect(document.querySelectorAll('tbody tr').length).toBeGreaterThan(0);
    expect(screen.queryByText(/end of/i)).toBeNull();
    expect(screen.queryByText(/no records/i)).toBeNull();
  });

  it('an empty successful query renders the empty state, never a terminal state', () => {
    renderTable({
      rows: [],
      emptyMessage: 'No sales found',
      pagination: paginationState({ exhausted: true }),
    });
    expect(screen.getByText('No sales found')).toBeTruthy();
    expect(screen.queryByText(/end of/i)).toBeNull();
  });

  it('a first-load failure renders the recoverable error block, never the empty state', () => {
    renderTable({
      rows: [],
      emptyMessage: 'No sales found',
      pagination: paginationState({ initialFailed: true }),
    });
    expect(screen.getByText("Couldn't load the list.")).toBeTruthy();
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
    expect(screen.queryByText('No sales found')).toBeNull();
  });

  it('exhausted records end with NO terminal message — the rows are the end', () => {
    renderTable({ pagination: paginationState({ exhausted: true }) });
    expect(screen.queryByText('End of list')).toBeNull();
    expect(screen.queryByText('End of results')).toBeNull();
    // The rows remain the last visible content inside the viewport.
    expect(screen.getByText('One')).toBeTruthy();
    expect(screen.getByText('Two')).toBeTruthy();
    const viewport = document.querySelector('div[class*="overflow-auto"]');
    expect(within(viewport as HTMLElement).queryByText(/end of/i)).toBeNull();
  });

  it('records with more pages render the quiet sentinel, no status row', () => {
    renderTable({ pagination: paginationState() });
    expect(screen.queryByText(/end of/i)).toBeNull();
    expect(screen.queryByText('Loading more…')).toBeNull();
    // The zero-height sentinel exists inside the viewport.
    const viewport = document.querySelector('div[class*="overflow-auto"]');
    const sentinel = (viewport as HTMLElement).querySelector('div[class*="h-0"]');
    expect(sentinel).toBeTruthy();
  });

  it('keeps every row visible while the next page is fetched (no reset)', () => {
    renderTable({ pagination: paginationState({ isFetchingNext: true }) });
    expect(screen.getByText('One')).toBeTruthy();
    expect(screen.getByText('Two')).toBeTruthy();
    expect(screen.getByText('Loading more…')).toBeTruthy();
  });

  it('the soft bottom edge overlay exists and never intercepts clicks', () => {
    renderTable({ pagination: staticPagination({ isLoading: false, isError: false, refetch: vi.fn() }) });
    const fade = document.querySelector('div[class*="pointer-events-none"][class*="bg-gradient-to-t"]');
    expect(fade).toBeTruthy();
  });
});
