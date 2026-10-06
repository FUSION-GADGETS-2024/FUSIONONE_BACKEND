'use client';

/**
 * InvoiceSidebar — the Invoice View action panel.
 *
 * ONE coherent panel (a single card with section dividers — not a stack of
 * floating cards) exposing the invoice's existing actions:
 *
 *   Invoice   → customer, date (the invoice NUMBER is the page title and the
 *               payment STATUS is its inline badge — both live in the shared
 *               page header; this panel carries only the remaining metadata)
 *   Export    → Save PDF · Print (the existing download/print implementations)
 *   WhatsApp  → Send via WhatsApp (the existing share-by-reference action)
 *   …children → module sections (Payment, Invoice, Quotation …)
 *
 * The implementations are wired by the page — this component only presents
 * them. It renders no invoice data of its own.
 */
import type { ReactNode } from 'react';
import { FileDown, Printer } from 'lucide-react';
import { cn } from '@/components/ui/utils';
import type { InvoiceType } from '@/features/invoice/types';
import { InvoiceWhatsAppShare } from './InvoiceWhatsAppShare';
import { isSendableInvoice } from '@/features/messages/settings';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface InvoiceSidebarProps {
  invoiceId: string;
  invoiceType: InvoiceType;
  invoiceNumber?: string;
  /** Info section (all optional — omitted rows simply don't render).
   *  The payment status is NOT part of this panel — it is a document-level
   *  attribute rendered as the page header's badge. */
  customer?: string | null;
  date?: string | null;
  /** Export actions — the page's existing download / print handlers. */
  onDownloadPdf: () => void;
  isPdfLoading?: boolean;
  onPrintPdf?: () => void;
  isPrintLoading?: boolean;
  /** Module sections: Payment, Invoice, Quotation … */
  children?: ReactNode;
}

/** The document date in the app's standard short format ("12 Mar 2026"). */
function formatInvoiceDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const d = new Date(`${value}T00:00:00`);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

// ── Section label ────────────────────────────────────────────────────────────

export function SidebarSectionLabel({ children }: { children: ReactNode }) {
  return (
    <p className="text-[9px] font-black uppercase tracking-[0.15em] text-slate-400 px-0.5 mb-1">
      {children}
    </p>
  );
}

// ── Action button ────────────────────────────────────────────────────────────

export function SidebarButton({
  icon: Icon,
  label,
  onClick,
  disabled,
  variant = 'default',
  loading,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  variant?: 'default' | 'primary';
  loading?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || loading}
      className={cn(
        'w-full flex items-center gap-2.5 px-3.5 py-2 text-xs font-semibold rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
        variant === 'primary'
          ? 'bg-indigo-600 text-white hover:bg-indigo-700 shadow-sm'
          : 'bg-white border border-slate-300 text-slate-700 hover:bg-slate-50',
      )}
    >
      {loading
        ? <span className="h-3.5 w-3.5 shrink-0 rounded-full border-[1.5px] border-current border-t-transparent animate-spin" aria-hidden />
        : <Icon className="h-3.5 w-3.5 shrink-0" />}
      {label}
    </button>
  );
}

// ── Info row ─────────────────────────────────────────────────────────────────

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-[11px]">
      <span className="text-slate-400 shrink-0">{label}</span>
      <span className={cn('text-slate-700 text-right truncate', mono && 'font-mono')}>{value}</span>
    </div>
  );
}

// ── Main panel ───────────────────────────────────────────────────────────────

export function InvoiceSidebar({
  invoiceId,
  invoiceType,
  invoiceNumber,
  customer,
  date,
  onDownloadPdf,
  isPdfLoading = false,
  onPrintPdf,
  isPrintLoading = false,
  children,
}: InvoiceSidebarProps) {
  const formattedDate = formatInvoiceDate(date);
  return (
    <div className="w-full rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden print:hidden">
      {/* ── Invoice info — the metadata panel (customer · date). The invoice
          number is the page header's title and its status the header's badge;
          neither is repeated here. ── */}
      {(customer || formattedDate) && (
        <div className="p-4 border-b border-slate-100">
          <SidebarSectionLabel>Invoice</SidebarSectionLabel>
          <div className="mt-2 space-y-1.5">
            {customer && <InfoRow label="Customer" value={customer} />}
            {formattedDate && <InfoRow label="Date" value={formattedDate} />}
          </div>
        </div>
      )}

      {/* ── Export ── */}
      <div className="p-3 space-y-2">
        <SidebarSectionLabel>Export</SidebarSectionLabel>
        <SidebarButton
          icon={FileDown}
          label={isPdfLoading ? 'Generating…' : 'Save PDF'}
          onClick={onDownloadPdf}
          loading={isPdfLoading}
          variant="primary"
        />
        {onPrintPdf && (
          <SidebarButton
            icon={Printer}
            label={isPrintLoading ? 'Preparing…' : 'Print'}
            onClick={onPrintPdf}
            loading={isPrintLoading}
          />
        )}
      </div>

      {/* ── WhatsApp (the existing share action, by reference) ── */}
      {isSendableInvoice(invoiceType) && (
        <div className="p-3 pt-0">
          <SidebarSectionLabel>WhatsApp</SidebarSectionLabel>
          <InvoiceWhatsAppShare invoiceId={invoiceId} invoiceType={invoiceType} invoiceNumber={invoiceNumber} />
        </div>
      )}

      {/* ── Module sections (Payment · Invoice · Quotation …) ── */}
      {children && (
        <div className="p-3 pt-0 space-y-2">
          {children}
        </div>
      )}
    </div>
  );
}
