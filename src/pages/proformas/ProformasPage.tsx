'use client';

import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useFinancialYear } from '@/components/providers/FinancialYearProvider';
import { useInvoiceQuickActions } from '@/features/invoice/useInvoiceQuickActions';
import { Button } from '@/components/ui/Button';
import { ActionMenu } from '@/components/ui/ActionMenu';
import { Plus, FileDown, Share2, Printer, Pencil } from 'lucide-react';
import { cn } from '@/components/ui/utils';
import { ViewButton } from '@/components/ui/ViewButton';
import { useSkeletonDelay } from '@/components/ui/Skeleton';
import { DataTable, TableSearchInput, RowActions, ListHeaderSkeleton } from '@/components/ui/tables';
import type { DataTableColumn } from '@/components/ui/tables';
import { ListPage } from '@/components/list-page/ListPage';
import { staticPagination } from '@/components/list-page/use-list-pagination';
import { useProformasPageData } from '@/features/proformas/api';

export default function ProformasPage() {
  const navigate = useNavigate();
  const { selectedYear, isReadOnly, isLoading: fyLoading } = useFinancialYear();
  const [searchQuery, setSearchQuery] = useState('');

  const proformasQuery = useProformasPageData(selectedYear, fyLoading);
  const proformas = proformasQuery.data || [];
  const pLoading  = proformasQuery.isLoading;

  // Loading threshold: the skeleton geometry renders immediately, its
  // shimmer only starts if the wait becomes noticeable. Never delays data.
  const skeletonPulsing = useSkeletonDelay(fyLoading || pLoading);

  const filteredPs = proformas.filter(p => {
    const s = searchQuery.toLowerCase();
    return p.bill_number.toLowerCase().includes(s) || (p.parties?.name || '').toLowerCase().includes(s);
  });

  // Direct row quick actions — one shared behavior layer for every list.
  // They execute directly against the row's invoice and never route through
  // the detail page.
  const quickActions = useInvoiceQuickActions();

  const handleSavePdf = (proforma: any) => {
    void quickActions.savePdf({ invoiceId: proforma.id, invoiceType: 'proforma', billNumber: proforma.bill_number });
  };

  const handleShare = (proforma: any) => {
    void quickActions.share({ invoiceId: proforma.id, invoiceType: 'proforma', billNumber: proforma.bill_number });
  };

  const handlePrint = (proforma: any) => {
    void quickActions.print({ invoiceId: proforma.id, invoiceType: 'proforma', billNumber: proforma.bill_number });
  };

  // Table columns — one definition drives the desktop table and the mobile
  // cards (same renders, re-laid-out). Each render keeps the exact cell
  // typography the hand-rolled table had.
  const columns: DataTableColumn<any>[] = [
    {
      id: 'date',
      header: 'Date',
      mobile: 'meta',
      render: (p: any) => <span className="text-xs text-slate-500 tabular-nums whitespace-nowrap">{p.date}</span>,
    },
    {
      id: 'bill',
      header: 'Proforma No',
      mobile: 'identity',
      render: (p: any) => <span className="text-xs font-semibold text-indigo-700 tabular-nums">{p.bill_number}</span>,
    },
    {
      id: 'customer',
      header: 'Customer',
      mobile: 'secondary',
      cellClassName: 'max-w-[220px]',
      render: (p: any) => <span className="block truncate text-xs font-medium text-slate-800">{p.parties?.name || '—'}</span>,
    },
    {
      id: 'status',
      header: 'Status',
      mobile: 'meta',
      render: (p: any) => (
        <span className={cn('px-2 py-0.5 rounded text-[10px] uppercase font-bold tracking-wider',
          p.status === 'converted' ? 'bg-emerald-100 text-emerald-800' :
          p.status === 'void' ? 'bg-rose-100 text-rose-800' : 'bg-slate-100 text-slate-700')}>
          {p.status}
        </span>
      ),
    },
    {
      id: 'total',
      header: 'Total',
      align: 'right',
      mobile: 'amount',
      mobileLabel: 'Total',
      cellClassName: 'text-right',
      render: (p: any) => <span className="text-xs font-semibold text-slate-900 tabular-nums">{Number(p.final_total).toLocaleString('en-IN', { minimumFractionDigits: 2 })} Rs.</span>,
    },
    {
      id: 'actions',
      header: '',
      align: 'right',
      mobile: 'actions',
      render: (p: any) => {
        // Stable action area — fixed, non-shrinking, at the row's
        // right edge: [VIEW][⋮]. VIEW is the only detail
        // navigation. Proformas are not payable, so the menu
        // holds only the actions that genuinely apply.
        return (
          <RowActions>
            <ViewButton onClick={() => navigate(`/proformas/${p.id}`)} />
            <ActionMenu items={[
              ...(p.status === 'active' && !isReadOnly
                ? [{ icon: Pencil, label: 'Edit', onClick: () => navigate(`/proformas/${p.id}/edit`) }]
                : []),
              { icon: FileDown, label: 'Save PDF', onClick: () => handleSavePdf(p) },
              { icon: Share2, label: 'Share', onClick: () => handleShare(p) },
              { icon: Printer, label: 'Print', onClick: () => handlePrint(p) },
            ]} />
          </RowActions>
        );
      },
    },
  ];

  if (fyLoading || pLoading) {
    return (
      <ListPage header={<ListHeaderSkeleton pulsing={skeletonPulsing} titleWidth="w-16" subtitleWidth="w-44" actionWidth="w-24" />}>
        <DataTable
          columns={columns}
          rows={[]}
          rowKey={p => p.id}
          loading
          fill
          toolbar={<TableSearchInput value={searchQuery} onChange={setSearchQuery} placeholder="Search proformas or customers…" />}
        />
      </ListPage>
    );
  }

  return (
    <ListPage
      header={
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-sm font-semibold text-slate-900 tracking-tight leading-none">Proforma Invoices</h1>
            <p className="text-[11px] text-slate-400 mt-1">Proforma invoices and estimates for this FY</p>
          </div>
          {!isReadOnly && (
            <Button size="sm" onClick={() => navigate('/proformas/new')} className="gap-1.5 text-xs h-8 bg-indigo-600 hover:bg-indigo-700">
              <Plus className="h-3.5 w-3.5" /> New Proforma
            </Button>
          )}
        </div>
      }
    >
      <DataTable
        columns={columns}
        rows={filteredPs}
        rowKey={p => p.id}
        emptyMessage="No proformas found for the selected year."
        toolbar={<TableSearchInput value={searchQuery} onChange={setSearchQuery} placeholder="Search proformas or customers…" />}
        fill
        pagination={staticPagination(proformasQuery)}
      />
    </ListPage>
  );
}
