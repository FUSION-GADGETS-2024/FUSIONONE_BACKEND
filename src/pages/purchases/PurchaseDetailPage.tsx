'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { usePurchaseDetail } from '@/features/purchases/api';
import { Wallet, ClipboardList } from 'lucide-react';
import { downloadInvoicePdf } from '@/features/invoice/download';
import { printInvoicePdf } from '@/features/invoice/print';
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
import { PaymentDialog } from '@/components/payments/PaymentDialog';
import type { PaymentDialogInvoice } from '@/components/payments/PaymentDialog';
import { PaymentsDialog } from '@/components/payments/PaymentsDialog';

export default function PurchaseViewPage() {
  const { id } = useParams() as { id: string };
  const { isReadOnly } = useFinancialYear();
  const { error: toastError } = useToast();

  // The purchase detail — ONE cached query (fixes audit D5).
  const detailQuery = usePurchaseDetail(id);
  const purchase = detailQuery.data?.purchase ?? null;
  const isLoading = detailQuery.isLoading;

  // The invoice PDF — the EXISTING pipeline, presented in the viewer.
  const pdf = useInvoicePdf(id, 'purchase', detailQuery.dataUpdatedAt || 0);

  // Dev-only trace point (no-op in production).
  useEffect(() => { perfTraceMount('mount'); }, []);

  useEffect(() => {
    if (pdf.error) toastError('Refresh Failed', pdf.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdf.error]);

  const [isPdfLoading, setIsPdfLoading] = useState(false);
  const [isPrintLoading, setIsPrintLoading] = useState(false);

  // Pay — the SAME shared payment dialog the purchases list uses.
  // Same rule as the list row's PAY action: active FY and due > 0.
  const canPay = !isReadOnly && Number(purchase?.due ?? 0) > 0;
  const [isPayOpen, setIsPayOpen] = useState(false);
  const [payTarget, setPayTarget] = useState<PaymentDialogInvoice | null>(null);

  // Payments — the bill's payment history dialog (per-payment Send Receipt
  // + Send Payment Statement). Available for any bill in the active FY.
  const [isPaymentsOpen, setIsPaymentsOpen] = useState(false);

  const openPay = () => {
    if (!purchase) return;
    setPayTarget({
      id: purchase.id,
      billNumber: purchase.bill_number,
      partyName: purchase.parties?.name ?? null,
      total: Number(purchase.total),
      paid: Number(purchase.paid),
      due: Number(purchase.due),
    });
    setIsPayOpen(true);
  };

  const handleDownloadPdf = async () => {
    if (!purchase) return;
    setIsPdfLoading(true);
    try { await downloadInvoicePdf(id, 'purchase'); }
    catch (e: any) { toastError('PDF Failed', e.message); }
    finally { setIsPdfLoading(false); }
  };

  const handlePrintPdf = async () => {
    if (!purchase) return;
    setIsPrintLoading(true);
    try { await printInvoicePdf(id, 'purchase'); }
    catch (e: any) { toastError('Print Failed', e.message); }
    finally { setIsPrintLoading(false); }
  };

  const statusKey = deriveInvoiceStatus(
    purchase?.status,
    Number(purchase?.paid ?? 0),
    Number(purchase?.due ?? 0),
  );

  if (detailQuery.isError) {
    return (
      <InvoiceViewLayout
        header={
          <PageHeader
            title="Bill"
            subtitle="Purchase bill"
            backTo="/purchases"
            backLabel="Back to Purchases"
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

  if (isLoading) return <InvoiceViewSkeleton variant={isReadOnly ? 'bare' : 'purchase'} />;

  return (
    <>
    <InvoiceViewLayout
      /* ── Page header — the shared PageHeader pattern (Party Detail): the
          bill number is the title with the payment status as its inline
          badge; kind + supplier form the subtitle. ── */
      header={
        <PageHeader
          title={<span className="font-mono">{purchase?.bill_number ?? 'Bill'}</span>}
          badge={<InvoiceStatusPill status={statusKey} />}
          subtitle={
            purchase?.parties?.name
              ? `Purchase bill · ${purchase.parties.name}`
              : 'Purchase bill'
          }
          backTo="/purchases"
          backLabel="Back to Purchases"
        />
      }
      /* ── Action sidebar — stationary beside the document ── */
      sidebar={
        <InvoiceSidebar
          invoiceId={id}
          invoiceType="purchase"
          invoiceNumber={purchase?.bill_number}
          customer={purchase?.parties?.name ?? null}
          date={purchase?.date}
          onDownloadPdf={handleDownloadPdf}
          isPdfLoading={isPdfLoading}
          onPrintPdf={handlePrintPdf}
          isPrintLoading={isPrintLoading}
        >
          {!isReadOnly && (
            <>
              <SidebarSectionLabel>Payment</SidebarSectionLabel>
              {canPay && (
                <SidebarButton icon={Wallet} label="Pay Party" onClick={openPay} />
              )}
              {/* The bill's payment history: every payment (including the
                  initial one) + per-payment Send Receipt + Send Payment
                  Statement. */}
              <SidebarButton icon={ClipboardList} label="Payments" onClick={() => setIsPaymentsOpen(true)} />
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

      {/* ── Pay (shared with the purchases list) ── */}
      <PaymentDialog open={isPayOpen} onClose={() => setIsPayOpen(false)} invoiceType="purchase" invoice={payTarget} />

      {/* ── Payments (the bill's payment history + receipt/statement
          message actions) ── */}
      <PaymentsDialog
        open={isPaymentsOpen}
        onClose={() => setIsPaymentsOpen(false)}
        invoiceType="purchase"
        invoice={purchase ? {
          id: purchase.id,
          billNumber: purchase.bill_number,
          partyName: purchase.parties?.name ?? null,
          total: Number(purchase.total),
          paid: Number(purchase.paid),
          due: Number(purchase.due),
        } : null}
      />
    </>
  );
}
