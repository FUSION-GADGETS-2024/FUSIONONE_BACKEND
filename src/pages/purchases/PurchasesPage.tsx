'use client';

import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useFinancialYear } from '@/components/providers/FinancialYearProvider';
import { useInvoiceQuickActions } from '@/features/invoice/useInvoiceQuickActions';
import { Button } from '@/components/ui/Button';
import { ActionMenu } from '@/components/ui/ActionMenu';
import type { ActionMenuItem } from '@/components/ui/ActionMenu';
import { PaymentDialog } from '@/components/payments/PaymentDialog';
import type { PaymentDialogInvoice } from '@/components/payments/PaymentDialog';
import { Plus, FileDown, Share2, Printer, Wallet } from 'lucide-react';
import { ViewButton } from '@/components/ui/ViewButton';
import { useSkeletonDelay } from '@/components/ui/Skeleton';
import { DataTable, TableSearchInput, RowActions, ListHeaderSkeleton } from '@/components/ui/tables';
import type { DataTableColumn } from '@/components/ui/tables';
import { ListPage } from '@/components/list-page/ListPage';
import { staticPagination } from '@/components/list-page/use-list-pagination';
import { usePurchasesPageData } from '@/features/purchases/api';

export default function PurchasesPage() {
  const navigate = useNavigate();
  const { selectedYear, isReadOnly, isLoading: fyLoading } = useFinancialYear();

  const [searchQuery, setSearchQuery] = useState('');

  // Pay Party — the shared payment dialog (also used by the detail page);
  // opened from the row's ⋮ menu.
  const [payTarget, setPayTarget] = useState<PaymentDialogInvoice | null>(null);
  const [isPayOpen, setIsPayOpen] = useState(false);

  const openPay = (purchase: any) => {
    setPayTarget({ id: purchase.id, billNumber: purchase.bill_number, partyName: purchase.parties?.name ?? null, total: Number(purchase.total), paid: Number(purchase.paid), due: Number(purchase.due) });
    setIsPayOpen(true);
  };

  const purchasesQuery = usePurchasesPageData(selectedYear, fyLoading);
  const purchases = purchasesQuery.data ?? [];

  // Loading threshold: the skeleton geometry renders immediately, its
  // shimmer only starts if the wait becomes noticeable. Never delays data.
  const skeletonPulsing = useSkeletonDelay(fyLoading || purchasesQuery.isLoading);

  // Direct row quick actions — one shared behavior layer for every list.
  // They execute directly against the row's invoice and never route through
  // the detail page.
  const quickActions = useInvoiceQuickActions();

  const handleSavePdf = (purchase: any) => {
    void quickActions.savePdf({ invoiceId: purchase.id, invoiceType: 'purchase', billNumber: purchase.bill_number });
  };

  const handleShare = (purchase: any) => {
    void quickActions.share({ invoiceId: purchase.id, invoiceType: 'purchase', billNumber: purchase.bill_number });
  };

  const handlePrint = (purchase: any) => {
    void quickActions.print({ invoiceId: purchase.id, invoiceType: 'purchase', billNumber: purchase.bill_number });
  };

  const filteredPurchases = purchases.filter(p => {
    const q = searchQuery.toLowerCase();
    return p.bill_number.toLowerCase().includes(q) || (p.parties?.name || '').toLowerCase().includes(q);
  });

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
      header: 'Bill No',
      mobile: 'identity',
      render: (p: any) => <span className="text-xs font-semibold text-indigo-700 tabular-nums">{p.bill_number}</span>,
    },
    {
      id: 'party',
      header: 'Party',
      mobile: 'secondary',
      cellClassName: 'max-w-[220px]',
      render: (p: any) => <span className="block truncate text-xs font-medium text-slate-800">{p.parties?.name || '—'}</span>,
    },
    {
      id: 'total',
      header: 'Total',
      align: 'right',
      mobile: 'amount',
      mobileLabel: 'Total',
      cellClassName: 'text-right',
      render: (p: any) => <span className="text-xs font-semibold text-slate-900 tabular-nums">{Number(p.total).toLocaleString('en-IN', { minimumFractionDigits: 2 })} Rs.</span>,
    },
    {
      id: 'due',
      header: 'Due',
      align: 'right',
      mobile: 'amount',
      mobileLabel: 'Due',
      cellClassName: 'text-right',
      render: (p: any) => Number(p.due) > 0
        ? <span className="text-xs font-semibold tabular-nums text-rose-600">{Number(p.due).toLocaleString('en-IN', { minimumFractionDigits: 2 })} Rs.</span>
        : <span className="text-xs font-semibold tabular-nums text-slate-300">0.00 Rs.</span>,
    },
    {
      id: 'actions',
      header: '',
      align: 'right',
      mobile: 'actions',
      render: (p: any) => {
        const canPay = !isReadOnly && Number(p.due) > 0;
        // One menu per row — items execute directly against the row's
        // invoice. VIEW is the only detail navigation; the payment
        // action lives here, not on the row.
        const menuItems: ActionMenuItem[] = [];
        if (canPay) {
          menuItems.push({ icon: Wallet, label: 'Pay Party', onClick: () => openPay(p) });
        }
        menuItems.push(
          { icon: FileDown, label: 'Save PDF', onClick: () => handleSavePdf(p) },
          { icon: Share2, label: 'Share', onClick: () => handleShare(p) },
          { icon: Printer, label: 'Print', onClick: () => handlePrint(p) },
        );
        // Stable action area — a fixed, non-shrinking group at the row's
        // right edge: [VIEW][⋮]. VIEW is the only detail navigation;
        // invoice content never navigates and always yields space first.
        return (
          <RowActions>
            <ViewButton onClick={() => navigate(`/purchases/${p.id}`)} />
            <ActionMenu items={menuItems} />
          </RowActions>
        );
      },
    },
  ];

  if (fyLoading || purchasesQuery.isLoading) {
    return (
      <ListPage header={<ListHeaderSkeleton pulsing={skeletonPulsing} titleWidth="w-20" subtitleWidth="w-44" actionWidth="w-28" />}>
        <DataTable
          columns={columns}
          rows={[]}
          rowKey={p => p.id}
          loading
          fill
          toolbar={<TableSearchInput value={searchQuery} onChange={setSearchQuery} placeholder="Search bills or parties…" />}
        />
      </ListPage>
    );
  }

  return (
    <ListPage
      header={
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-sm font-semibold text-slate-900 tracking-tight leading-none">Purchases</h1>
            <p className="text-[11px] text-slate-400 mt-1">Purchase bills and supplier payments for this FY</p>
          </div>
          {!isReadOnly && (
            <Button size="sm" onClick={() => navigate('/purchases/new')} className="gap-1.5 text-xs h-8 bg-indigo-600 hover:bg-indigo-700">
              <Plus className="h-3.5 w-3.5" /> New Purchase
            </Button>
          )}
        </div>
      }
    >
      <DataTable
        columns={columns}
        rows={filteredPurchases}
        rowKey={p => p.id}
        emptyMessage="No purchases found."
        toolbar={<TableSearchInput value={searchQuery} onChange={setSearchQuery} placeholder="Search bills or parties…" />}
        fill
        pagination={staticPagination(purchasesQuery)}
      />

      {/* Pay Party — the shared payment dialog (same one the detail page uses) */}
      <PaymentDialog open={isPayOpen} onClose={() => setIsPayOpen(false)} invoiceType="purchase" invoice={payTarget} />
    </ListPage>
  );
}
