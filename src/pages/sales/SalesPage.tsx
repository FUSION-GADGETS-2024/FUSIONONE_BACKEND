'use client';

import { useState, useCallback } from 'react'
import { fetchSaleDetail } from '@/features/sales/api'
import { useNavigate } from 'react-router';
import { useFinancialYear } from '@/components/providers/FinancialYearProvider';
import { useToast } from '@/components/ui/Toast';
import { useInvoiceQuickActions } from '@/features/invoice/useInvoiceQuickActions';
import { Button } from '@/components/ui/Button';
import { ActionMenu } from '@/components/ui/ActionMenu';
import type { ActionMenuItem } from '@/components/ui/ActionMenu';
import { PaymentDialog } from '@/components/payments/PaymentDialog';
import type { PaymentDialogInvoice } from '@/components/payments/PaymentDialog';
import { Plus, FileDown, Share2, Printer, Ban, CheckCircle2, Wallet } from 'lucide-react';
import { ViewButton } from '@/components/ui/ViewButton';
import { useSkeletonDelay } from '@/components/ui/Skeleton';
import { DataTable, TableSearchInput, RowActions, ListHeaderSkeleton } from '@/components/ui/tables';
import type { DataTableColumn } from '@/components/ui/tables';
import { ListPage } from '@/components/list-page/ListPage';
import { staticPagination } from '@/components/list-page/use-list-pagination';
import { useSalesPageData, salesKeys } from '@/features/sales/api'
import { cancelSale as cancelSaleMutation } from '@/features/sales/mutations'
import { invalidateSales, invalidateInventory } from '@/features/invalidate'
import { useQueryClient } from '@tanstack/react-query'

export default function SalesPage() {
  const navigate = useNavigate();
  const { selectedYear, isReadOnly, isLoading: fyLoading } = useFinancialYear();
  const { error, success } = useToast();
  const queryClient = useQueryClient();

  const [searchQuery, setSearchQuery] = useState('');

  // Cancel dialog state
  const [cancelSale, setCancelSale] = useState<any | null>(null);
  const [cancelDetail, setCancelDetail] = useState<any | null>(null);
  const [isCancelling, setIsCancelling] = useState(false);

  // Receive Payment — the shared payment dialog (also used by the detail
  // page); opened from the row's ⋮ menu.
  const [payTarget, setPayTarget] = useState<PaymentDialogInvoice | null>(null);
  const [isPayOpen, setIsPayOpen] = useState(false);

  const openReceivePayment = (sale: any) => {
    setPayTarget({ id: sale.id, billNumber: sale.bill_number, partyName: sale.parties?.name ?? null, total: Number(sale.final_total), paid: Number(sale.paid), due: Number(sale.due) });
    setIsPayOpen(true);
  };

  const salesQuery = useSalesPageData(selectedYear, fyLoading);
  const sales = salesQuery.data ?? [];

  // Skeleton motion is gated by the loading threshold: the skeleton's
  // geometry is present immediately, its shimmer only starts if the wait
  // becomes noticeable. It never delays the data itself.
  const skeletonPulsing = useSkeletonDelay(fyLoading || salesQuery.isLoading);

  // Fetch full sale detail (lazy, cached — used by the cancel dialog only;
  // the ⋮ quick actions execute directly and never need it)
  const fetchDetail = useCallback(async (id: string) => {
    return queryClient.fetchQuery({ queryKey: salesKeys.detail(id), queryFn: () => fetchSaleDetail(id) })
  }, [queryClient])

  // Direct row quick actions — one shared behavior layer for every list
  const quickActions = useInvoiceQuickActions();

  // ⋮ actions execute directly against the row's invoice — they never route
  // through the detail page.
  const handleSavePdf = (sale: any) => {
    void quickActions.savePdf({ invoiceId: sale.id, invoiceType: 'sale', billNumber: sale.bill_number });
  };

  const handleShare = (sale: any) => {
    void quickActions.share({ invoiceId: sale.id, invoiceType: 'sale', billNumber: sale.bill_number });
  };

  const handlePrint = (sale: any) => {
    void quickActions.print({ invoiceId: sale.id, invoiceType: 'sale', billNumber: sale.bill_number });
  };

  const openCancelDialog = async (sale: any) => {
    try {
      const detail = await fetchDetail(sale.id);
      setCancelSale(sale);
      setCancelDetail(detail);
    } catch (err: any) {
      error('Error', err.message || 'Failed to load the invoice for cancellation.');
    }
  };

  const handleCancel = async () => {
    if (!cancelSale || !selectedYear) return;
    setIsCancelling(true);
    try {
      await cancelSaleMutation(cancelSale.id);
      queryClient.removeQueries({ queryKey: salesKeys.detail(cancelSale.id) });
      success('Cancelled', `${cancelSale.bill_number} has been cancelled.`);
      // Cancellation restocks devices and reverses trade-in acquisitions —
      // the inventory views must converge too (audit fix: was sales-only).
      await invalidateInventory(selectedYear.id);
      setCancelSale(null); setCancelDetail(null);
      await invalidateSales(selectedYear.id);
    } catch (err: any) { error('Error', err.message || 'Failed to cancel.'); }
    finally { setIsCancelling(false); }
  };

  const filteredSales = sales.filter(s => {
    const q = searchQuery.toLowerCase();
    return s.bill_number.toLowerCase().includes(q) || (s.parties?.name || '').toLowerCase().includes(q);
  });

  // Table columns — one definition drives the desktop table and the mobile
  // cards (same renders, re-laid-out). Each render keeps the exact cell
  // typography the hand-rolled table had.
  const columns: DataTableColumn<any>[] = [
    {
      id: 'date',
      header: 'Date',
      mobile: 'meta',
      render: (s: any) => <span className="text-xs text-slate-500 tabular-nums whitespace-nowrap">{s.date}</span>,
    },
    {
      id: 'bill',
      header: 'Invoice No',
      mobile: 'identity',
      cellClassName: 'tabular-nums',
      render: (s: any) => {
        const isCancelled = s.status === 'cancelled';
        return (
          <div className="flex items-center gap-1.5">
            <span className={`text-xs font-semibold ${isCancelled ? 'text-slate-400 line-through' : 'text-emerald-700'}`}>{s.bill_number}</span>
            {isCancelled && <span className="text-[9px] font-bold uppercase tracking-widest bg-rose-100 text-rose-700 px-1.5 py-0.5 rounded">CANCELLED</span>}
          </div>
        );
      },
    },
    {
      id: 'customer',
      header: 'Customer',
      mobile: 'secondary',
      cellClassName: 'max-w-[220px]',
      render: (s: any) => <span className="block truncate text-xs font-medium text-slate-800">{s.parties?.name || '—'}</span>,
    },
    {
      id: 'total',
      header: 'Total',
      align: 'right',
      mobile: 'amount',
      mobileLabel: 'Total',
      cellClassName: 'text-right',
      render: (s: any) => <span className="text-xs font-semibold text-slate-900 tabular-nums">{Number(s.final_total).toLocaleString('en-IN', { minimumFractionDigits: 2 })} Rs.</span>,
    },
    {
      id: 'due',
      header: 'Due',
      align: 'right',
      mobile: 'amount',
      mobileLabel: 'Due',
      cellClassName: 'text-right',
      render: (s: any) => Number(s.due) > 0
        ? <span className="text-xs font-semibold tabular-nums text-rose-600">{Number(s.due).toLocaleString('en-IN', { minimumFractionDigits: 2 })} Rs.</span>
        : <span className="text-xs font-semibold tabular-nums text-slate-300">0.00 Rs.</span>,
    },
    {
      id: 'actions',
      header: '',
      align: 'right',
      mobile: 'actions',
      render: (s: any) => {
        const isCancelled = s.status === 'cancelled';
        const canPay = !isReadOnly && !isCancelled && Number(s.due) > 0;
        // One menu per row — items execute directly against the row's
        // invoice. VIEW is the only detail navigation; the payment
        // action lives here, not on the row.
        const menuItems: ActionMenuItem[] = [];
        if (canPay) {
          menuItems.push({ icon: Wallet, label: 'Receive Payment', onClick: () => openReceivePayment(s) });
        }
        menuItems.push(
          { icon: FileDown, label: 'Save PDF', onClick: () => handleSavePdf(s) },
          { icon: Share2, label: 'Share', onClick: () => handleShare(s) },
          { icon: Printer, label: 'Print', onClick: () => handlePrint(s) },
        );
        if (!isReadOnly && !isCancelled) {
          menuItems.push({ icon: Ban, label: 'Cancel Invoice', tone: 'warning', onClick: () => openCancelDialog(s) });
        }
        // Stable action area — a fixed, non-shrinking group at the row's
        // right edge: [VIEW][⋮]. VIEW is the only detail navigation;
        // invoice content never navigates and always yields space first.
        return (
          <RowActions>
            <ViewButton onClick={() => navigate(`/sales/${s.id}`)} />
            <ActionMenu items={menuItems} />
          </RowActions>
        );
      },
    },
  ];

  if (fyLoading || salesQuery.isLoading) {
    return (
      <ListPage header={<ListHeaderSkeleton pulsing={skeletonPulsing} titleWidth="w-16" subtitleWidth="w-44" actionWidth="w-24" />}>
        <DataTable
          columns={columns}
          rows={[]}
          rowKey={s => s.id}
          loading
          fill
          toolbar={<TableSearchInput value={searchQuery} onChange={setSearchQuery} placeholder="Search invoices or customers…" />}
        />
      </ListPage>
    );
  }

  return (
    <ListPage
      header={
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-sm font-semibold text-slate-900 tracking-tight leading-none">Sales</h1>
            <p className="text-[11px] text-slate-400 mt-1">Invoices and received payments for this FY</p>
          </div>
          {!isReadOnly && (
            <Button size="sm" onClick={() => navigate('/sales/new')} className="gap-1.5 text-xs h-8 bg-indigo-600 hover:bg-indigo-700">
              <Plus className="h-3.5 w-3.5" /> New Sale
            </Button>
          )}
        </div>
      }
    >
      <DataTable
        columns={columns}
        rows={filteredSales}
        rowKey={s => s.id}
        rowClassName={s => (s.status === 'cancelled' ? 'opacity-50' : undefined)}
        emptyMessage="No sales found for the selected year."
        toolbar={<TableSearchInput value={searchQuery} onChange={setSearchQuery} placeholder="Search invoices or customers…" />}
        fill
        pagination={staticPagination(salesQuery)}
      />

      {/* Receive Payment — the shared payment dialog (same one the detail page uses) */}
      <PaymentDialog open={isPayOpen} onClose={() => setIsPayOpen(false)} invoiceType="sale" invoice={payTarget} />

      {/* Cancel Confirmation Dialog */}
      {cancelSale && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4 dialog-fade-in">
          <div className="bg-white rounded-xl border border-slate-200 shadow-xl w-full max-w-md p-6 dialog-fade-in">
            <div className="flex items-start gap-4 mb-5">
              <div className="h-10 w-10 rounded-full bg-amber-100 flex items-center justify-center shrink-0">
                <Ban className="h-5 w-5 text-amber-700" />
              </div>
              <div>
                <h3 className="text-sm font-bold text-slate-900">Cancel Invoice {cancelSale.bill_number}?</h3>
                <p className="text-xs text-slate-500 mt-1">This will mark the invoice as cancelled. The following will happen immediately:</p>
              </div>
            </div>
            <ul className="space-y-1.5 mb-6 pl-2">
              {cancelDetail?.items?.length > 0 && (
                <li className="text-xs text-slate-600 flex items-center gap-2">
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                  {cancelDetail.items.length} phone{cancelDetail.items.length > 1 ? 's' : ''} returned to stock
                </li>
              )}
              {Number(cancelSale.paid) > 0 && (
                <li className="text-xs text-slate-600 flex items-center gap-2">
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                  {Number(cancelSale.paid).toLocaleString('en-IN', { minimumFractionDigits: 2 })} Rs. in payments reversed in ledger
                </li>
              )}
              {cancelDetail?.tradeIns?.length > 0 && (
                <li className="text-xs text-slate-600 flex items-center gap-2">
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                  {cancelDetail.tradeIns.length} trade-in device{cancelDetail.tradeIns.length > 1 ? 's' : ''} handled
                </li>
              )}
              <li className="text-xs text-slate-600 flex items-center gap-2">
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                Bill number {cancelSale.bill_number} preserved as a cancellation record
              </li>
            </ul>
            <div className="flex gap-3 justify-end">
              <button onClick={() => { setCancelSale(null); setCancelDetail(null); }} disabled={isCancelling} className="px-4 py-2 text-xs font-semibold rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 transition-colors disabled:opacity-50">
                Keep Invoice
              </button>
              <Button onClick={handleCancel} isLoading={isCancelling} className="bg-amber-600 hover:bg-amber-700 text-xs h-9 px-5">
                Cancel Invoice
              </Button>
            </div>
          </div>
        </div>
      )}
    </ListPage>
  );
}
