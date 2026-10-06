'use client';

/**
 * Quotation detail — the document view plus its lifecycle actions:
 * Convert (the atomic conversion dialog), Edit (active only) and Void
 * (active only). A CONVERTED quotation is immutable history, linked to
 * its resulting sale.
 */
import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/platform/supabase/client';
import { useProformaDetail } from '@/features/proformas/api';
import { voidProforma } from '@/features/proformas/mutations';
import { invalidateProformas } from '@/features/invalidate';
import { ConvertProformaDialog } from '@/components/proformas/ConvertProformaDialog';
import { ShoppingCart, Pencil, Ban, X, FileText, ExternalLink } from 'lucide-react';
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
import { Button } from '@/components/ui/Button';

export default function ProformaViewPage() {
  const navigate = useNavigate();
  const { id } = useParams() as { id: string };
  const { error: toastError, success: toastSuccess } = useToast();
  const { isReadOnly, selectedYear } = useFinancialYear();

  // Cached detail query (all four fetches parallel — fixes audit D15).
  const detailQuery = useProformaDetail(id);
  const pData = detailQuery.data?.proforma ?? null;
  const isLoading = detailQuery.isLoading;

  // The invoice PDF — the EXISTING pipeline, presented in the viewer.
  const pdf = useInvoicePdf(id, 'proforma', detailQuery.dataUpdatedAt || 0);

  // Dev-only trace point (no-op in production).
  useEffect(() => { perfTraceMount('mount'); }, []);

  useEffect(() => {
    if (pdf.error) toastError('Refresh Failed', pdf.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdf.error]);

  const [isPdfLoading, setIsPdfLoading] = useState(false);
  const [isPrintLoading, setIsPrintLoading] = useState(false);

  // Lifecycle dialogs / actions.
  const [isConvertOpen, setIsConvertOpen] = useState(false);
  const [showVoidDialog, setShowVoidDialog] = useState(false);
  const [isVoiding, setIsVoiding] = useState(false);

  // The resulting sale, when this quotation was converted (durable
  // database link — sales.proforma_id).
  const convertedSaleQuery = useQuery({
    queryKey: ['proforma-converted-sale', id],
    enabled: pData?.status === 'converted',
    queryFn: async () => {
      const { data, error } = await supabase
        .from('sales')
        .select('id, bill_number, status')
        .eq('proforma_id', id!)
        .maybeSingle();
      if (error) throw error;
      return data as { id: string; bill_number: string; status: string } | null;
    },
  });

  const handleDownloadPdf = async () => {
    if (!pData) return;
    setIsPdfLoading(true);
    try { await downloadInvoicePdf(id, 'proforma'); }
    catch (e: any) { toastError('PDF Failed', e.message); }
    finally { setIsPdfLoading(false); }
  };

  const handlePrintPdf = async () => {
    if (!pData) return;
    setIsPrintLoading(true);
    try { await printInvoicePdf(id, 'proforma'); }
    catch (e: any) { toastError('Print Failed', e.message); }
    finally { setIsPrintLoading(false); }
  };

  const handleVoid = async () => {
    setIsVoiding(true);
    try {
      await voidProforma(id);
      await invalidateProformas(selectedYear?.id);
      toastSuccess('Voided', `${pData?.bill_number} has been voided.`);
      setShowVoidDialog(false);
    } catch (err: any) {
      // Deterministic domain error from the RPC — surfaced, never swallowed.
      toastError('Cannot Void', err.message || 'Failed to void the quotation.');
    } finally {
      setIsVoiding(false);
    }
  };

  const statusKey = deriveInvoiceStatus(pData?.status, 0, 0);
  const isActive = pData?.status === 'active';
  const canManage = isActive && !isReadOnly;

  if (detailQuery.isError) {
    return (
      <InvoiceViewLayout
        header={
          <PageHeader
            title="Quotation"
            subtitle="Proforma quotation"
            backTo="/proformas"
            backLabel="Back to Proforma"
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

  if (isLoading) return <InvoiceViewSkeleton variant="proforma" />;

  return (
    <InvoiceViewLayout
      /* ── Page header — the shared PageHeader pattern (Party Detail): the
          quotation number is the title with its status as the inline badge;
          kind + customer form the subtitle. ── */
      header={
        <PageHeader
          title={<span className="font-mono">{pData?.bill_number ?? 'Quotation'}</span>}
          badge={<InvoiceStatusPill status={statusKey} />}
          subtitle={
            (pData?.parties as any)?.name
              ? `Quotation · ${(pData?.parties as any).name}`
              : 'Quotation'
          }
          backTo="/proformas"
          backLabel="Back to Proforma"
        />
      }
      /* ── Action sidebar — stationary beside the document ── */
      sidebar={
        <InvoiceSidebar
          invoiceId={id}
          invoiceType="proforma"
          invoiceNumber={pData?.bill_number}
          customer={pData?.parties?.name ?? null}
          date={pData?.date}
          onDownloadPdf={handleDownloadPdf}
          isPdfLoading={isPdfLoading}
          onPrintPdf={handlePrintPdf}
          isPrintLoading={isPrintLoading}
        >
          <SidebarSectionLabel>Quotation</SidebarSectionLabel>
          {isActive ? (
            canManage ? (
              <>
                <SidebarButton
                  icon={ShoppingCart}
                  label="Convert to Sale"
                  onClick={() => setIsConvertOpen(true)}
                  variant="primary"
                />
                <SidebarButton icon={Pencil} label="Edit Quotation" onClick={() => navigate(`/proformas/${id}/edit`)} />
                <SidebarButton icon={Ban} label="Void Quotation" onClick={() => setShowVoidDialog(true)} />
              </>
            ) : (
              <div className="w-full flex items-center gap-2.5 px-3.5 py-2 text-xs font-semibold rounded-md bg-slate-50 text-slate-500 border border-slate-200">
                <Ban className="h-3.5 w-3.5 shrink-0" />
                Read-only financial year
              </div>
            )
          ) : pData?.status === 'converted' ? (
            <div className="space-y-2 w-full">
              <div className="w-full flex items-center gap-2.5 px-3.5 py-2 text-xs font-semibold rounded-md bg-emerald-50 text-emerald-700 border border-emerald-100">
                <ShoppingCart className="h-3.5 w-3.5 shrink-0" />
                Converted to Sale
              </div>
              {convertedSaleQuery.data && (
                <Link
                  to={`/sales/${convertedSaleQuery.data.id}`}
                  className="w-full flex items-center gap-2.5 px-3.5 py-2 text-xs font-medium rounded-md bg-slate-50 text-slate-600 border border-slate-200 hover:bg-slate-100 hover:text-slate-800 transition-colors"
                >
                  <FileText className="h-3.5 w-3.5 shrink-0" />
                  <span className="font-mono truncate">{convertedSaleQuery.data.bill_number}</span>
                  <ExternalLink className="h-3 w-3 ml-auto shrink-0" />
                </Link>
              )}
            </div>
          ) : (
            <div className="w-full flex items-center gap-2.5 px-3.5 py-2 text-xs font-semibold rounded-md bg-rose-50 text-rose-700 border border-rose-100">
              <Ban className="h-3.5 w-3.5 shrink-0" />
              Voided Quotation
            </div>
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

      {/* ── Conversion (atomic, dialog-driven) ── */}
      {detailQuery.data && (
        <ConvertProformaDialog
          open={isConvertOpen}
          onClose={() => setIsConvertOpen(false)}
          detail={detailQuery.data}
        />
      )}

      {/* ── Void confirmation ── */}
      {showVoidDialog && pData && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4 dialog-fade-in">
          <div className="bg-white rounded-xl border border-slate-200 shadow-xl w-full max-w-md p-6 dialog-fade-in">
            <div className="flex items-start gap-4 mb-5">
              <div className="h-10 w-10 rounded-full bg-rose-100 flex items-center justify-center shrink-0">
                <Ban className="h-5 w-5 text-rose-700" />
              </div>
              <div>
                <h3 className="text-sm font-bold text-slate-900">Void {pData.bill_number}?</h3>
                <p className="text-xs text-slate-500 mt-1">
                  The quotation will be permanently marked void. It cannot be converted or edited afterwards.
                  No inventory, payment, or accounting records are affected — a quotation never had any.
                </p>
              </div>
              <button onClick={() => setShowVoidDialog(false)} className="ml-auto text-slate-400 hover:text-slate-600">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setShowVoidDialog(false)}
                disabled={isVoiding}
                className="px-4 py-2 text-xs font-semibold rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 transition-colors disabled:opacity-50"
              >
                Keep Quotation
              </button>
              <Button onClick={handleVoid} isLoading={isVoiding} className="bg-rose-600 hover:bg-rose-700 text-xs h-9 px-5">
                Void Quotation
              </Button>
            </div>
          </div>
        </div>
      )}
    </InvoiceViewLayout>
  );
}
