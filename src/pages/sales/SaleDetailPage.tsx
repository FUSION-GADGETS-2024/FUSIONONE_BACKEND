'use client';

import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSaleDetail, salesKeys } from '@/features/sales/api';
import { supabase } from '@/platform/supabase/client';
import { cancelSale as cancelSaleRpc, deleteSale as deleteSaleRpc, createTradeInPurchaseBill } from '@/features/sales/mutations';
import { invalidateSales, invalidateInventory, invalidatePurchases } from '@/features/invalidate';
import {
  Pencil, Ban, Trash2, AlertTriangle, X, CheckCircle2, Wallet, BellRing, ClipboardList, FileText,
} from 'lucide-react';
import { downloadInvoicePdf } from '@/features/invoice/download';
import { printInvoicePdf } from '@/features/invoice/print';
import { shareInvoicePdf } from '@/features/invoice/share';
import { useInvoicePdf } from '@/features/invoice/useInvoicePdf';
import { perfTraceMount } from '@/platform/perf';
import { InvoicePdfViewer } from '@/components/invoice/InvoicePdfViewer';
import { InvoiceViewLayout } from '@/components/invoice/InvoiceViewLayout';
import { InvoiceViewSkeleton } from '@/components/invoice/InvoiceViewSkeleton';
import { InvoiceViewError } from '@/components/invoice/InvoiceViewError';
import { InvoiceSidebar, SidebarButton, SidebarSectionLabel } from '@/components/invoice/InvoiceSidebar';
import { deriveInvoiceStatus, InvoiceStatusPill } from '@/components/invoice/invoiceStatus';
import { PageHeader } from '@/components/PageHeader';
import { useFinancialYear } from '@/components/providers/FinancialYearProvider';
import { useToast } from '@/components/ui/Toast';
import { Button } from '@/components/ui/Button';
import { PaymentDialog } from '@/components/payments/PaymentDialog';
import type { PaymentDialogInvoice } from '@/components/payments/PaymentDialog';
import { PaymentsDialog } from '@/components/payments/PaymentsDialog';
import { ReminderDialog } from '@/components/invoice/ReminderDialog';

export default function SaleViewPage() {
  const navigate = useNavigate();
  const { id } = useParams() as { id: string };
  const { isReadOnly, selectedYear } = useFinancialYear();
  const { error: toastError, success: toastSuccess } = useToast();
  const queryClient = useQueryClient();

  // The sale detail — ONE cached query (shared with the list page's lazy ⋮
  // fetch and the edit page; refetched after mutations via invalidation).
  const detailQuery = useSaleDetail(id)
  const sale = detailQuery.data?.sale ?? null
  const items = detailQuery.data?.items ?? []
  const tradeIns = detailQuery.data?.tradeIns ?? []
  const isLoading = detailQuery.isLoading
  const allInStock = tradeIns.every((ti: any) => ti.inventory_items?.status === 'in_stock')
  const canDelete = !!sale && Number(sale.paid) === 0 && allInStock

  // The invoice PDF — the EXISTING pipeline, presented in the viewer. The
  // document regenerates (background, current PDF kept visible) whenever the
  // invoice data changes, and on manual Refresh.
  const pdf = useInvoicePdf(id, 'sale', detailQuery.dataUpdatedAt || 0);

  // The originating quotation, when this sale was converted from a proforma
  // (durable database state — the link survives every browser).
  const proformaId = (sale as any)?.proforma_id ?? null;
  const originProformaQuery = useQuery({
    queryKey: ['proforma-origin', proformaId],
    enabled: !!proformaId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('proforma_invoices')
        .select('id, bill_number, status')
        .eq('id', proformaId!)
        .maybeSingle();
      if (error) throw error;
      return data as { id: string; bill_number: string; status: string } | null;
    },
  });

  // Dev-only trace point (no-op in production).
  useEffect(() => { perfTraceMount('mount'); }, []);

  useEffect(() => {
    if (pdf.error) toastError('Refresh Failed', pdf.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdf.error]);

  const [isPdfLoading, setIsPdfLoading] = useState(false);
  const [isShareLoading, setIsShareLoading] = useState(false);
  const [isPrintLoading, setIsPrintLoading] = useState(false);

  // Dialogs
  const [showCancelDialog, setShowCancelDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  // Receive Payment — the SAME shared payment dialog the sales list uses.
  const [isPayOpen, setIsPayOpen] = useState(false);
  const [payTarget, setPayTarget] = useState<PaymentDialogInvoice | null>(null);

  // Payment reminders — the per-invoice reminder configuration dialog.
  const [isRemindersOpen, setIsRemindersOpen] = useState(false);

  // Payments — the invoice's payment history dialog (per-payment Send
  // Receipt + Send Payment Statement).
  const [isPaymentsOpen, setIsPaymentsOpen] = useState(false);

  const openReceivePayment = () => {
    if (!sale) return;
    setPayTarget({
      id: sale.id,
      billNumber: sale.bill_number,
      partyName: sale.parties?.name ?? null,
      total: Number(sale.final_total),
      paid: Number(sale.paid),
      due: Number(sale.due),
    });
    setIsPayOpen(true);
  };

  // Post-cancel resold trade-in warning
  const [resoldTradeIns, setResoldTradeIns] = useState<any[]>([]);
  const [showResoldWarning, setShowResoldWarning] = useState(false);
  const [isCreatingPurchase, setIsCreatingPurchase] = useState<string | null>(null);

  const reload = async () => {
    await queryClient.invalidateQueries({ queryKey: salesKeys.detail(id) })
  }

  const handleDownloadPdf = async () => {
    if (!sale) return;
    setIsPdfLoading(true);
    try { await downloadInvoicePdf(id, 'sale'); }
    catch (e: any) { toastError('PDF Failed', e.message); }
    finally { setIsPdfLoading(false); }
  };

  // Native platform share of the SAME PDF artifact (share.ts — the one
  // pipeline, cache included; a user dismissal of the share sheet is not
  // an error).
  const handleSharePdf = async () => {
    if (!sale) return;
    setIsShareLoading(true);
    try { await shareInvoicePdf(id, 'sale'); }
    catch (e: any) { toastError('Share Failed', e.message); }
    finally { setIsShareLoading(false); }
  };

  const handlePrintPdf = async () => {
    if (!sale) return;
    setIsPrintLoading(true);
    try { await printInvoicePdf(id, 'sale'); }
    catch (e: any) { toastError('Print Failed', e.message); }
    finally { setIsPrintLoading(false); }
  };

  // ── Cancel ────────────────────────────────────────────────────────────────

  const handleCancel = async () => {
    if (!sale || !selectedYear) return;
    setIsCancelling(true);
    try {
      // One atomic RPC (restock + payment reversal + trade-in handling),
      // returning the resold list for the Action Required warning.
      const result = await cancelSaleRpc(id);
      const resold: any[] = result.resold;
      setShowCancelDialog(false);
      toastSuccess('Cancelled', `${sale.bill_number} has been cancelled.`);
      if (resold.length > 0) { setResoldTradeIns(resold); setShowResoldWarning(true); }
      await Promise.all([
        invalidateSales(selectedYear.id),
        invalidateInventory(selectedYear.id),
        reload(),
      ]);
    } catch (err: any) {
      toastError('Error', err.message || 'Failed to cancel sale.');
    } finally {
      setIsCancelling(false);
    }
  };

  // ── Delete ────────────────────────────────────────────────────────────────

  const handleDelete = async () => {
    if (!sale || !selectedYear) return;
    setIsDeleting(true);
    try {
      // Guarded hard delete — one atomic RPC with the exact guard messages.
      await deleteSaleRpc(id);
      await Promise.all([
        invalidateSales(selectedYear.id),
        invalidateInventory(selectedYear.id),
      ]);
      toastSuccess('Deleted', `${sale.bill_number} has been permanently deleted.`);
      navigate('/sales');
    } catch (err: any) {
      toastError('Cannot Delete', err.message || 'Failed to delete sale.');
      setShowDeleteDialog(false);
    } finally {
      setIsDeleting(false);
    }
  };

  // ── Create replacement purchase for resold trade-in ───────────────────────

  const handleCreatePurchaseBill = async (ti: any) => {
    if (!selectedYear || !sale) return;
    setIsCreatingPurchase(ti.id);
    try {
      // Atomic counter + purchase + mapping (same PUR-26-27 bill format).
      const billNo = await createTradeInPurchaseBill(id, ti.id);
      setResoldTradeIns(prev => prev.filter(r => r.id !== ti.id));
      if (resoldTradeIns.length <= 1) setShowResoldWarning(false);
      toastSuccess('Created', `Purchase bill ${billNo} created.`);
      await Promise.all([invalidatePurchases(selectedYear.id), reload()]);
    } catch (err: any) {
      toastError('Error', err.message || 'Failed to create purchase bill.');
    } finally {
      setIsCreatingPurchase(null);
    }
  };

  const isCancelled = sale?.status === 'cancelled';
  // Same rule as the list row's PAY action: active FY, not cancelled, due > 0.
  const canReceivePayment = !isReadOnly && !isCancelled && Number(sale?.due ?? 0) > 0;
  const statusKey = deriveInvoiceStatus(sale?.status, Number(sale?.paid ?? 0), Number(sale?.due ?? 0));
  const f = (n: number) => `${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2 })} Rs.`;

  if (detailQuery.isError) {
    return (
      <InvoiceViewLayout
        header={
          <PageHeader
            title="Invoice"
            subtitle="Tax invoice"
            backTo="/sales"
            backLabel="Back to Sales"
          />
        }
      >
        <div className="h-full min-h-0 flex items-center justify-center p-4 sm:p-6">
          <InvoiceViewError
            message="The invoice could not be loaded. Please try again."
            onRetry={() => detailQuery.refetch()}
          />
        </div>
      </InvoiceViewLayout>
    );
  }

  if (isLoading) return <InvoiceViewSkeleton variant={isReadOnly ? 'bare' : 'sale'} />;

  const hasBanners = isCancelled || (showResoldWarning && resoldTradeIns.length > 0);

  return (
    <>
    <InvoiceViewLayout
      /* ── Page header — the shared PageHeader pattern (Party Detail): the
          invoice number is the title with the payment status as its inline
          badge; kind + customer form the subtitle. ── */
      header={
        <PageHeader
          title={<span className="font-mono">{sale?.bill_number ?? 'Invoice'}</span>}
          badge={<InvoiceStatusPill status={statusKey} />}
          subtitle={
            sale?.parties?.name
              ? `Tax invoice · ${sale.parties.name}`
              : 'Tax invoice'
          }
          backTo="/sales"
          backLabel="Back to Sales"
        />
      }
      /* ── Stable banners above the workspace ── */
      banners={hasBanners ? (
        <>
          {isCancelled && (
            <div className="flex-none flex items-center gap-3 bg-rose-50 border border-rose-200 rounded-xl px-5 py-3.5">
              <Ban className="h-5 w-5 text-rose-600 shrink-0" />
              <div>
                <p className="text-sm font-bold text-rose-800">This invoice has been cancelled</p>
                <p className="text-xs text-rose-600 mt-0.5">All sold items returned to stock. Cash payments reversed in ledger.</p>
              </div>
            </div>
          )}

          {showResoldWarning && resoldTradeIns.length > 0 && (
            <div className="flex-none bg-amber-50 border border-amber-200 rounded-xl p-4 space-y-3">
              <div className="flex items-start gap-3">
                <AlertTriangle className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
                <div>
                  <p className="text-xs font-bold text-amber-800">Action Required — Trade-In Device Already Sold</p>
                  <p className="text-[11px] text-amber-700 mt-0.5">These trade-in devices were already resold. Their auto-purchase bills have been cancelled. Create proper purchase records.</p>
                </div>
                <button onClick={() => setShowResoldWarning(false)} className="ml-auto text-amber-500 hover:text-amber-700">
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="space-y-2">
                {resoldTradeIns.map(ti => (
                  <div key={ti.id} className="flex items-center justify-between bg-white border border-amber-200 rounded-lg px-3 py-2.5 text-xs">
                    <div>
                      <p className="font-semibold text-slate-800">{ti.brand} {ti.model}</p>
                      <p className="text-[10px] text-slate-400 font-mono">{ti.imei} · Credit: {f(ti.credit_value)}</p>
                    </div>
                    <Button size="sm" onClick={() => handleCreatePurchaseBill(ti)} isLoading={isCreatingPurchase === ti.id} className="text-xs h-7 ml-4 shrink-0">
                      Create Purchase Bill
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      ) : undefined}
      /* ── Action sidebar — stationary beside the document ── */
      sidebar={
        <InvoiceSidebar
          invoiceId={id}
          invoiceType="sale"
          invoiceNumber={sale?.bill_number}
          customer={sale?.parties?.name ?? null}
          date={sale?.date}
          onDownloadPdf={handleDownloadPdf}
          isPdfLoading={isPdfLoading}
          onSharePdf={handleSharePdf}
          isShareLoading={isShareLoading}
          onPrintPdf={handlePrintPdf}
          isPrintLoading={isPrintLoading}
        >
          {!isReadOnly && (
            <>
              {proformaId && originProformaQuery.data && (
                <>
                  <SidebarSectionLabel>Origin</SidebarSectionLabel>
                  <Link
                    to={`/proformas/${proformaId}`}
                    className="w-full flex items-center gap-2.5 px-3.5 py-2 text-xs font-medium rounded-md bg-slate-50 text-slate-600 border border-slate-200 hover:bg-slate-100 hover:text-slate-800 transition-colors"
                  >
                    <FileText className="h-3.5 w-3.5 shrink-0" />
                    <span className="font-mono truncate">{originProformaQuery.data.bill_number}</span>
                  </Link>
                </>
              )}
              <SidebarSectionLabel>Payment</SidebarSectionLabel>
              {canReceivePayment && (
                <SidebarButton icon={Wallet} label="Receive Payment" onClick={openReceivePayment} />
              )}
              {/* The invoice's payment history: every payment (including the
                  initial one) + per-payment Send Receipt + Send Payment
                  Statement. Available for any active invoice. */}
              <SidebarButton icon={ClipboardList} label="Payments" onClick={() => setIsPaymentsOpen(true)} />
              {/* Reminders stay reachable for fully-paid / cancelled invoices —
                  the dialog explains why the chain is stopped (§35 states). */}
              <SidebarButton icon={BellRing} label="Payment Reminders" onClick={() => setIsRemindersOpen(true)} />
              {!isCancelled && (
                <>
                  <SidebarSectionLabel>Invoice</SidebarSectionLabel>
                  <SidebarButton icon={Pencil} label="Edit Invoice" onClick={() => navigate(`/sales/${id}/edit`)} />
                  <SidebarButton icon={Ban} label="Cancel Invoice" onClick={() => setShowCancelDialog(true)} />
                  {canDelete && (
                    <SidebarButton icon={Trash2} label="Delete Permanently" onClick={() => setShowDeleteDialog(true)} />
                  )}
                </>
              )}
            </>
          )}
        </InvoiceSidebar>
      }
    >
      {/* The PDF is the invoice — the workspace's only scrollable area. The
          regenerate action lives in the preview controls (invoice-specific,
          never a page-level Refresh). */}
      <InvoicePdfViewer
        blob={pdf.blob}
        status={pdf.status}
        error={pdf.error}
        onRetry={pdf.refresh}
        isRefreshing={pdf.isRefreshing}
        onRegenerate={pdf.refresh}
      />
    </InvoiceViewLayout>

      {/* ── Receive Payment (shared with the sales list) ── */}
      <PaymentDialog open={isPayOpen} onClose={() => setIsPayOpen(false)} invoiceType="sale" invoice={payTarget} />

      {/* ── Payment Reminders (per-invoice configuration) ── */}
      <ReminderDialog
        open={isRemindersOpen}
        onClose={() => setIsRemindersOpen(false)}
        saleId={id}
        billNumber={sale?.bill_number}
        sale={sale ? { status: sale.status, due: sale.due } : null}
      />

      {/* ── Payments (the invoice's payment history + receipt/statement
          message actions) ── */}
      <PaymentsDialog
        open={isPaymentsOpen}
        onClose={() => setIsPaymentsOpen(false)}
        invoiceType="sale"
        invoice={sale ? {
          id: sale.id,
          billNumber: sale.bill_number,
          partyName: sale.parties?.name ?? null,
          total: Number(sale.final_total),
          paid: Number(sale.paid),
          due: Number(sale.due),
        } : null}
      />

      {/* ── Cancel Dialog ── */}
      {showCancelDialog && sale && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4 dialog-fade-in">
          <div className="bg-white rounded-xl border border-slate-200 shadow-xl w-full max-w-md p-6 dialog-fade-in">
            <div className="flex items-start gap-4 mb-5">
              <div className="h-10 w-10 rounded-full bg-amber-100 flex items-center justify-center shrink-0">
                <Ban className="h-5 w-5 text-amber-700" />
              </div>
              <div>
                <h3 className="text-sm font-bold text-slate-900">Cancel Invoice {sale.bill_number}?</h3>
                <p className="text-xs text-slate-500 mt-1">This will mark the invoice as cancelled. The following will happen immediately:</p>
              </div>
            </div>
            <ul className="space-y-1.5 mb-6 pl-2">
              {items.length > 0 && (
                <li className="text-xs text-slate-600 flex items-center gap-2">
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                  {items.length} phone{items.length > 1 ? 's' : ''} returned to stock
                </li>
              )}
              {Number(sale.paid) > 0 && (
                <li className="text-xs text-slate-600 flex items-center gap-2">
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                  {f(sale.paid)} in received payments reversed in ledger
                </li>
              )}
              {tradeIns.length > 0 && (
                <li className="text-xs text-slate-600 flex items-center gap-2">
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                  {tradeIns.length} trade-in device{tradeIns.length > 1 ? 's' : ''} handled
                </li>
              )}
              <li className="text-xs text-slate-600 flex items-center gap-2">
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                Bill number {sale.bill_number} preserved as cancellation record
              </li>
            </ul>
            <div className="flex gap-3 justify-end">
              <button onClick={() => setShowCancelDialog(false)} disabled={isCancelling} className="px-4 py-2 text-xs font-semibold rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 transition-colors disabled:opacity-50">
                Keep Invoice
              </button>
              <Button onClick={handleCancel} isLoading={isCancelling} className="bg-amber-600 hover:bg-amber-700 text-xs h-9 px-5">
                Cancel Invoice
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ── Delete Dialog ── */}
      {showDeleteDialog && sale && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4 dialog-fade-in">
          <div className="bg-white rounded-xl border border-slate-200 shadow-xl w-full max-w-md p-6 dialog-fade-in">
            <div className="flex items-start gap-4 mb-5">
              <div className="h-10 w-10 rounded-full bg-rose-100 flex items-center justify-center shrink-0">
                <Trash2 className="h-5 w-5 text-rose-700" />
              </div>
              <div>
                <h3 className="text-sm font-bold text-slate-900">Delete {sale.bill_number} Permanently?</h3>
                <p className="text-xs text-slate-500 mt-1">This will completely erase this invoice and all associated records.</p>
              </div>
            </div>
            <div className="bg-slate-50 rounded-xl border border-slate-200 p-3 mb-5 space-y-1.5">
              <p className="text-[10px] font-bold uppercase text-slate-400 tracking-wider mb-2">Will be removed</p>
              <p className="text-xs text-slate-600">• This invoice and all {items.length} line item{items.length !== 1 ? 's' : ''}</p>
              {tradeIns.length > 0 && <p className="text-xs text-slate-600">• {tradeIns.length} trade-in device{tradeIns.length > 1 ? 's' : ''} and their purchase records</p>}
              <p className="text-xs text-emerald-700 font-medium mt-2">✓ No payments were received — nothing else is affected</p>
            </div>
            <div className="bg-rose-50 border border-rose-200 rounded-lg px-3 py-2 mb-5">
              <p className="text-xs font-semibold text-rose-800">This action is permanent and cannot be undone.</p>
            </div>
            <div className="flex gap-3 justify-end">
              <button onClick={() => setShowDeleteDialog(false)} disabled={isDeleting} className="px-4 py-2 text-xs font-semibold rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 transition-colors disabled:opacity-50">
                Cancel
              </button>
              <Button onClick={handleDelete} isLoading={isDeleting} className="bg-rose-600 hover:bg-rose-700 text-xs h-9 px-5">
                Delete Permanently
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
