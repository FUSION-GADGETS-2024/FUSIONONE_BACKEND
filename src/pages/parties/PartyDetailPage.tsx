'use client';

import { useCallback, useMemo } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { ViewButton } from '@/components/ui/ViewButton';
import { cn } from '@/components/ui/utils';
import { useAppBack } from '@/components/useAppBack';
import { useSkeletonDelay } from '@/components/ui/Skeleton';
import { DataTable, RowActions } from '@/components/ui/tables';
import type { DataTableColumn } from '@/components/ui/tables';
import { ListPage } from '@/components/list-page/ListPage';
import { useInfiniteListPagination } from '@/components/list-page/use-list-pagination';
import { useFinancialYear } from '@/components/providers/FinancialYearProvider';
import {
  usePartyDetail,
  usePartyInvoices,
  usePartiesLedger,
} from '@/features/parties/api';
import type { PartyPurchaseRow, PartySaleRow } from '@/features/parties/api';

/**
 * Party Detail — /parties/:id
 *
 * A compact read/navigation layer over the existing business data:
 *   - the party's profile + FY ledger summary (existing cached queries),
 *   - its sales/purchase invoices for the working financial year as
 *     scroll-to-load-more lists — one bounded database batch per request,
 *     accumulated with early silent prefetch (never the full table, no
 *     pagination controls),
 *   - each row's explicit VIEW button navigates to the EXISTING invoice
 *     detail pages (the row content itself never navigates).
 *
 * The page renders the fixed ListPage layout: the header, the party block
 * and the tabs stay fixed while ONLY the invoice rows viewport scrolls.
 *
 * Tab state lives in the ?tab= URL parameter (the Payments page pattern),
 * so following an invoice and coming back with browser Back restores the
 * selected tab alongside the loaded batches (and the rows viewport
 * restores its exact scroll position).
 *
 * The two tabs are fully independent queries (separate cache keys, separate
 * accumulated batches, separate viewport restoration keys) — switching
 * tabs never mixes or refetches the other list.
 */
type Tab = 'sales' | 'purchases';

const fmt = (n: number) => `${n.toLocaleString('en-IN', { minimumFractionDigits: 2 })} Rs.`;

export default function PartyDetailPage() {
  const { id } = useParams() as { id: string };
  const { selectedYear, isLoading: fyLoading } = useFinancialYear();

  // Selected tab in the URL (?tab=) — Back returns to the tab the user left.
  const [searchParams] = useSearchParams();
  const tab: Tab = searchParams.get('tab') === 'purchases' ? 'purchases' : 'sales';
  const navigate = useNavigate();
  const selectTab = useCallback(
    (next: Tab) => {
      const params = new URLSearchParams(searchParams);
      params.set('tab', next);
      navigate(`?${params.toString()}`, { replace: true });
    },
    [navigate, searchParams],
  );

  const partyQuery = usePartyDetail(id);
  const ledgerQuery = usePartiesLedger(selectedYear, fyLoading);

  // Loading threshold: the skeleton geometry renders immediately, its
  // shimmer only starts if the wait becomes noticeable. Never delays data.
  const skeletonPulsing = useSkeletonDelay(partyQuery.isLoading || fyLoading);
  const salesQuery = usePartyInvoices('sales', id, selectedYear, fyLoading, tab === 'sales');
  const purchasesQuery = usePartyInvoices('purchases', id, selectedYear, fyLoading, tab === 'purchases');

  const party = partyQuery.data ?? null;

  // FY ledger summary for this party — the same fold the Parties page shows,
  // from the same cached query (no additional request when coming from there).
  const summary = useMemo(() => {
    const sales = (ledgerQuery.data?.sales ?? []).filter((r) => r.party_id === id);
    const purchases = (ledgerQuery.data?.purchases ?? []).filter((r) => r.party_id === id);
    return {
      salesTotal: sales.reduce((a, r) => a + Number(r.final_total || 0), 0),
      salesDue: sales.reduce((a, r) => a + Number(r.due || 0), 0),
      purchasesTotal: purchases.reduce((a, r) => a + Number(r.total || 0), 0),
      purchasesDue: purchases.reduce((a, r) => a + Number(r.due || 0), 0),
    };
  }, [ledgerQuery.data, id]);

  // ── Loading / not-found / error (party block) ────────────────────────────
  if (partyQuery.isLoading || fyLoading) {
    return (
      <ListPage>
        <div className={cn('space-y-5', skeletonPulsing && 'animate-pulse')}>
          <div className="flex items-center justify-between">
            <div className="space-y-1.5"><div className="h-4 w-28 bg-slate-100 rounded" /><div className="h-3 w-56 bg-slate-100 rounded" /></div>
            <div className="h-8 w-28 bg-slate-100 rounded-md" />
          </div>
          <div className="bg-white rounded-xl border border-slate-200 p-4 flex items-center gap-3">
            <div className="h-10 w-10 bg-slate-100 rounded-full" />
            <div className="space-y-1.5"><div className="h-3 w-32 bg-slate-100 rounded" /><div className="h-2.5 w-48 bg-slate-100 rounded" /></div>
          </div>
          <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
            <div className="px-4 py-3 bg-slate-50 border-b border-slate-100 flex gap-6">{[...Array(4)].map((_, i) => <div key={i} className="h-2.5 w-14 bg-slate-100 rounded" />)}</div>
            {[...Array(6)].map((_, i) => <div key={i} className="flex items-center gap-6 px-4 py-3 border-b border-slate-50">{[...Array(4)].map((_, j) => <div key={j} className="h-3 bg-slate-100 rounded" style={{ width: `${[24, 30, 18, 14][j]}%` }} />)}</div>)}
          </div>
        </div>
      </ListPage>
    );
  }

  if (partyQuery.isError) {
    return (
      <ListPage>
        <div className="bg-white rounded-xl border border-slate-200 px-4 py-10 text-center text-xs text-rose-500">
          Failed to load party.
        </div>
      </ListPage>
    );
  }

  if (!party) {
    return (
      <ListPage>
        <div className="bg-white rounded-xl border border-slate-200 px-4 py-10 text-center text-xs text-slate-400">
          Party not found.
        </div>
      </ListPage>
    );
  }

  return (
    <ListPage
      header={
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-sm font-semibold text-slate-900 tracking-tight leading-none">{party.name}</h1>
            <p className="text-[11px] text-slate-400 mt-1">Party profile and invoice history</p>
          </div>
          <BackButton to="/parties" />
        </div>
      }
    >
      {/* Compact party block — profile + existing FY ledger summary */}
      <div className="shrink-0 bg-white rounded-xl border border-slate-200 p-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <div className="flex items-center gap-3 min-w-0">
            <div className="h-10 w-10 rounded-full bg-indigo-50 text-indigo-600 flex items-center justify-center text-sm font-bold shrink-0">
              {party.name.charAt(0).toUpperCase()}
            </div>
            <div className="min-w-0">
              <p className="text-xs font-semibold text-slate-900">{party.name}</p>
              <p className="text-[11px] text-slate-400 truncate">
                {[party.number, party.address].filter(Boolean).join(' · ') || '—'}
              </p>
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:ml-auto sm:w-auto w-full">
            {([
              ['Sales', summary.salesTotal, 'text-slate-700'],
              ['Sales Due', summary.salesDue, summary.salesDue > 0 ? 'text-rose-600' : 'text-slate-300'],
              ['Purchases', summary.purchasesTotal, 'text-slate-700'],
              ['Purchase Due', summary.purchasesDue, summary.purchasesDue > 0 ? 'text-rose-600' : 'text-slate-300'],
            ] as const).map(([title, value, tone]) => (
              <div key={title} className="bg-slate-50 rounded-lg p-2.5 text-center min-w-[88px]">
                <p className="text-[10px] text-slate-400 mb-1">{title}</p>
                <p className={cn('text-xs font-semibold tabular-nums', tone)}>
                  {ledgerQuery.isLoading ? '…' : fmt(value)}
                </p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Sales / Purchases tabs — independent accumulated lists per tab */}
      <div className="flex shrink-0 items-center justify-between gap-4">
        <div className="inline-flex items-center rounded-lg bg-slate-100 p-0.5" role="tablist">
          {(['sales', 'purchases'] as const).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              onClick={() => selectTab(t)}
              className={cn(
                'h-7 px-3.5 rounded-md text-xs font-semibold transition-colors',
                tab === t ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700',
              )}
            >
              {t === 'sales' ? 'Sales' : 'Purchases'}
            </button>
          ))}
        </div>
        <p className="text-[11px] text-slate-400">
          {selectedYear
            ? `FY ${new Date(selectedYear.start_date).getFullYear()}–${new Date(selectedYear.end_date).getFullYear()}`
            : ''}
        </p>
      </div>

      {/* Invoice list — the active tab's accumulated batches (the page's
          single scroll container: rows scroll, everything above is fixed) */}
      {tab === 'sales' ? (
        <PartyInvoiceList
          kind="sales"
          query={salesQuery}
        />
      ) : (
        <PartyInvoiceList
          kind="purchases"
          query={purchasesQuery}
        />
      )}
    </ListPage>
  );
}

// ── The scroll-to-load-more invoice list ─────────────────────────────────────

interface PartyInvoiceListProps {
  kind: 'sales' | 'purchases';
  query: ReturnType<typeof usePartyInvoices>;
}

/**
 * One tab's invoice table with scroll-to-load-more:
 *
 *   - the first batch renders in the table's rows viewport; the shared
 *     prefetch sentinel asks for the next database batch while the end of
 *     the loaded content is still comfortably away;
 *   - loading more is silent — every loaded row stays exactly where it is
 *     and the next batch is simply appended (a quiet "Loading more…"
 *     fallback appears only if the user outruns the prefetch);
 *   - a failed batch keeps the loaded rows and offers a retry of the same
 *     next batch (the cursor is untouched);
 *   - at the end of the data the tail simply disappears (no terminal
 *     message) and the sentinel disconnects (no further requests).
 */
function PartyInvoiceList({ kind, query }: PartyInvoiceListProps) {
  const navigate = useNavigate();
  const isSales = kind === 'sales';

  const rows = useMemo(
    () => (query.data?.pages ?? []).flatMap((page) => page.rows) as Array<PartySaleRow | PartyPurchaseRow>,
    [query.data],
  );

  // The ONE consolidated scroll-to-load state (guards, exhaustion, retry).
  const pagination = useInfiniteListPagination(query);

  const columns: Array<DataTableColumn<PartySaleRow | PartyPurchaseRow>> = [
    {
      id: 'date',
      header: 'Date',
      mobile: 'meta',
      render: row => <span className="text-xs text-slate-500 tabular-nums whitespace-nowrap">{row.date}</span>,
    },
    {
      id: 'bill',
      header: isSales ? 'Invoice No' : 'Bill No',
      mobile: 'identity',
      render: row => {
        const isCancelled = row.status === 'cancelled';
        return (
          <div className="flex items-center gap-1.5">
            <span className={cn('text-xs font-semibold tabular-nums',
              isSales
                ? isCancelled ? 'text-slate-400 line-through' : 'text-emerald-700'
                : 'text-indigo-700',
            )}>{row.bill_number}</span>
            {isCancelled && (
              <span className="text-[9px] font-bold uppercase tracking-widest bg-rose-100 text-rose-700 px-1.5 py-0.5 rounded">CANCELLED</span>
            )}
          </div>
        );
      },
    },
    {
      id: 'total',
      header: 'Total',
      align: 'right',
      cellClassName: 'text-right',
      mobile: 'amount',
      mobileLabel: 'Total',
      render: row => {
        const amount = 'final_total' in row ? row.final_total : row.total;
        return <span className="text-xs font-semibold text-slate-900 tabular-nums">{amount.toLocaleString('en-IN', { minimumFractionDigits: 2 })} Rs.</span>;
      },
    },
    {
      id: 'due',
      header: 'Due',
      align: 'right',
      cellClassName: 'text-right',
      mobile: 'amount',
      mobileLabel: 'Due',
      render: row => Number(row.due) > 0
        ? <span className="text-xs font-semibold tabular-nums text-rose-600">{Number(row.due).toLocaleString('en-IN', { minimumFractionDigits: 2 })} Rs.</span>
        : <span className="text-xs font-semibold tabular-nums text-slate-300">0.00 Rs.</span>,
    },
    {
      id: 'actions',
      align: 'right',
      mobile: 'actions',
      // VIEW is the only detail navigation — the row content itself never
      // navigates.
      render: row => (
        <RowActions>
          <ViewButton onClick={() => navigate(isSales ? `/sales/${row.id}` : `/purchases/${row.id}`)} />
        </RowActions>
      ),
    },
  ];

  return (
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={row => row.id}
      loading={pagination.isLoadingFirst}
      skeletonRows={6}
      emptyMessage={`No ${isSales ? 'sales' : 'purchases'} found for this party in the selected financial year.`}
      rowClassName={row => (row.status === 'cancelled' ? 'opacity-50' : undefined)}
      actionReserve={<div className="h-7 w-14 bg-slate-100 rounded-md" />}
      fill
      pagination={pagination}
      scrollRestore={kind}
    />
  );
}

/** Shared back control — browser history first (Editor pattern), safe
 *  fallback for direct entry. */
function BackButton({ to }: { to: string }) {
  const goBack = useAppBack(to);
  return (
    <Button size="sm" variant="outline" onClick={goBack} className="gap-1.5 text-xs h-8">
      <ArrowLeft className="h-3.5 w-3.5" /> Back to Parties
    </Button>
  );
}
