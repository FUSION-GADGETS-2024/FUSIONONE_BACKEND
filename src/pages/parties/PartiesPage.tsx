'use client';

import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router';
import { useFinancialYear } from '@/components/providers/FinancialYearProvider';
import { Button } from '@/components/ui/Button';
import { PartyFormModal } from '@/components/parties/PartyFormModal';
import type { Party } from '@/features/types';
import { Plus } from 'lucide-react';
import { ViewButton } from '@/components/ui/ViewButton';
import { EditIconButton } from '@/components/ui/EditIconButton';
import { useSkeletonDelay } from '@/components/ui/Skeleton';
import { useDebouncedValue } from '@/components/ui/use-debounced-value';
import {
  CellLines,
  DataTable,
  type DataTableColumn,
  ListHeaderSkeleton,
  RowActions,
  TableSearchInput,
} from '@/components/ui/tables';
import { ListPage } from '@/components/list-page/ListPage';
import { staticPagination } from '@/components/list-page/use-list-pagination';
import { useParties, usePartiesLedger, usePartyDirectorySearch, type PartyDirectoryRow } from '@/features/parties/api';
import { formatPhoneDisplay } from '@/features/validation/fields';
import { invalidateParties } from '@/features/invalidate';

interface PartyLedger { partyId: string; salesTotal: number; salesDue: number; purchasesTotal: number; purchasesDue: number; }

const fmt = (n: number) => `${n.toLocaleString('en-IN', { minimumFractionDigits: 2 })} Rs.`;

export default function PartiesPage() {
  const navigate = useNavigate();
  const { selectedYear, isReadOnly, isLoading: fyLoading } = useFinancialYear();
  const [searchQuery, setSearchQuery] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingParty, setEditingParty] = useState<Party | null>(null);
  const partiesQuery = useParties();
  const ledgerQuery = usePartiesLedger(selectedYear, fyLoading);
  const parties = partiesQuery.data ?? [];
  const { sales = [], purchases = [] } = ledgerQuery.data || {};

  // The search box — debounced before it drives the ranked server search.
  const debouncedSearch = useDebouncedValue(searchQuery, 250);
  const directorySearch = usePartyDirectorySearch(debouncedSearch);

  // Loading threshold: the skeleton geometry renders immediately, its
  // shimmer only starts if the wait becomes noticeable. Never delays data.
  const skeletonPulsing = useSkeletonDelay(fyLoading || partiesQuery.isLoading || ledgerQuery.isLoading);

  const ledgers = useMemo(() => {
    const map = new Map<string, PartyLedger>();
    parties.forEach(p => map.set(p.id, { partyId: p.id, salesTotal: 0, salesDue: 0, purchasesTotal: 0, purchasesDue: 0 }));
    sales.forEach(s => { const l = map.get(s.party_id); if (l) { l.salesTotal += Number(s.final_total || 0); l.salesDue += Number(s.due || 0); } });
    purchases.forEach(pu => { const l = map.get(pu.party_id); if (l) { l.purchasesTotal += Number(pu.total || 0); l.purchasesDue += Number(pu.due || 0); } });
    return map;
  }, [parties, sales, purchases]);

  const filteredParties = useMemo(() => {
    // Search mode — the ONE canonical ranked directory search (the
    // search_parties RPC, debounced 250ms before it hits the database).
    // While the first search is in flight the table keeps showing the full
    // directory (never a false "No parties found").
    const searchActive = searchQuery.trim() !== '';
    const toParty = (r: PartyDirectoryRow): Party => ({
      id: r.id,
      name: r.name,
      number: r.number ?? undefined,
      address: r.address ?? undefined,
    });
    if (!searchActive) return parties;
    return directorySearch.isSuccess ? (directorySearch.data ?? []).map(toParty) : parties;
  }, [parties, searchQuery, directorySearch.isSuccess, directorySearch.data]);

  const atSearchLimit = searchQuery.trim() !== '' && directorySearch.isSuccess && (directorySearch.data?.length ?? 0) === 50;

  const columns: DataTableColumn<Party>[] = [
    {
      id: 'party',
      header: 'Party',
      render: party => (
        <div className="flex items-center gap-2.5">
          <div className="h-7 w-7 rounded-full bg-indigo-50 text-indigo-600 flex items-center justify-center text-[11px] font-bold shrink-0">{party.name.charAt(0).toUpperCase()}</div>
          <CellLines primary={party.name} secondary={formatPhoneDisplay(party.number)} />
        </div>
      ),
      mobile: 'identity',
      skeletonLines: 2,
    },
    {
      id: 'sales-biz',
      header: 'Sales Biz',
      align: 'right',
      cellClassName: 'text-right',
      render: party => <span className="text-xs font-medium text-slate-700 tabular-nums">{fmt(ledgers.get(party.id)?.salesTotal || 0)}</span>,
      mobile: 'amount',
      mobileLabel: 'Sales',
    },
    {
      id: 'sales-due',
      header: 'Sales Due',
      align: 'right',
      cellClassName: 'text-right',
      render: party => {
        const l = ledgers.get(party.id);
        return <span className="text-xs font-semibold tabular-nums">{(l?.salesDue || 0) > 0 ? <span className="text-rose-600">{fmt(l!.salesDue)}</span> : <span className="text-slate-300">{fmt(0)}</span>}</span>;
      },
      mobile: 'amount',
      mobileLabel: 'Due',
    },
    {
      id: 'purchase-biz',
      header: 'Purchase Biz',
      align: 'right',
      cellClassName: 'text-right',
      render: party => <span className="text-xs font-medium text-slate-700 tabular-nums">{fmt(ledgers.get(party.id)?.purchasesTotal || 0)}</span>,
      mobile: 'amount',
      mobileLabel: 'Purch.',
    },
    {
      id: 'purchase-due',
      header: 'Purchase Due',
      align: 'right',
      cellClassName: 'text-right',
      render: party => {
        const l = ledgers.get(party.id);
        return <span className="text-xs font-semibold tabular-nums">{(l?.purchasesDue || 0) > 0 ? <span className="text-rose-600">{fmt(l!.purchasesDue)}</span> : <span className="text-slate-300">{fmt(0)}</span>}</span>;
      },
      mobile: 'amount',
      mobileLabel: 'Due',
    },
    {
      id: 'actions',
      header: '',
      align: 'center',
      // Stable action group — [VIEW][pencil], matching the Inventory
      // row-action language. VIEW is the only detail navigation; the row
      // content itself never navigates.
      render: party => (
        <RowActions align="center">
          <ViewButton onClick={() => navigate(`/parties/${party.id}`)} />
          {!isReadOnly && (
            <EditIconButton onClick={() => { setEditingParty(party); setIsModalOpen(true); }} />
          )}
        </RowActions>
      ),
      mobile: 'actions',
    },
  ];

  const toolbar = <TableSearchInput value={searchQuery} onChange={setSearchQuery} placeholder="Search by name or number…" />;

  if (fyLoading || partiesQuery.isLoading || ledgerQuery.isLoading) {
    return (
      <ListPage header={<ListHeaderSkeleton pulsing={skeletonPulsing} titleWidth="w-16" subtitleWidth="w-56" actionWidth="w-24" />}>
        <DataTable columns={columns} rows={[]} rowKey={party => party.id} loading skeletonRows={6} fill toolbar={toolbar} emptyMessage="No parties found." />
      </ListPage>
    );
  }

  return (
    <ListPage
      header={
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-sm font-semibold text-slate-900 tracking-tight leading-none">Parties</h1>
            <p className="text-[11px] text-slate-400 mt-1">Customers and suppliers — single shared directory</p>
          </div>
          {!isReadOnly && (
            <Button size="sm" onClick={() => { setEditingParty(null); setIsModalOpen(true); }} className="gap-1.5 text-xs h-8 bg-indigo-600 hover:bg-indigo-700">
              <Plus className="h-3.5 w-3.5" /> Add Party
            </Button>
          )}
        </div>
      }
    >
      <DataTable
        columns={columns}
        rows={filteredParties}
        rowKey={party => party.id}
        toolbar={toolbar}
        emptyMessage="No parties found."
        fill
        pagination={staticPagination(partiesQuery, { exhausted: !atSearchLimit })}
        footer={atSearchLimit ? (
          <div className="border-t border-slate-100 bg-slate-50/50 px-4 py-2.5">
            <p className="text-xs text-slate-400">Showing top 50 matches — refine your search to narrow results.</p>
          </div>
        ) : undefined}
      />

      <PartyFormModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onSuccess={() => {
          void invalidateParties();
        }}
        initialData={editingParty}
      />
    </ListPage>
  );
}
