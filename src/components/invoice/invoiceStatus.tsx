'use client';

/**
 * Invoice status presentation — the shared pill rendered as the Invoice View
 * page header's badge (beside the invoice number — the status is
 * intentionally shown in ONE place only), plus the derivation that turns a
 * row's raw status + payment fields into the display status.
 */
import { AlertCircle, Ban, CheckCircle2, Clock, FileText } from 'lucide-react';
import { cn } from '@/components/ui/utils';

export type InvoiceStatusKey = 'cancelled' | 'converted' | 'void' | 'paid' | 'partial' | 'unpaid' | 'active';

/**
 * Derive the display status from the invoice row. Payment states only apply
 * where the record carries paid/due amounts (sales & purchases); quotations
 * settle on 'active' until converted or voided.
 */
export function deriveInvoiceStatus(
  status: string | null | undefined,
  paid: number,
  due: number,
): InvoiceStatusKey {
  if (status === 'cancelled') return 'cancelled';
  if (status === 'converted') return 'converted';
  if (status === 'void') return 'void';
  if (due > 0 && paid > 0) return 'partial';
  if (due > 0 && paid <= 0) return 'unpaid';
  if (due <= 0 && paid > 0) return 'paid';
  return 'active';
}

const STATUS_CONFIG: Record<InvoiceStatusKey, {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  cls: string;
}> = {
  cancelled: { icon: Ban, label: 'Cancelled', cls: 'bg-rose-50 text-rose-700 border-rose-200' },
  converted: { icon: CheckCircle2, label: 'Converted', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  void: { icon: Ban, label: 'Voided', cls: 'bg-rose-50 text-rose-700 border-rose-200' },
  paid: { icon: CheckCircle2, label: 'Paid', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  partial: { icon: Clock, label: 'Partial', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  unpaid: { icon: AlertCircle, label: 'Unpaid', cls: 'bg-rose-50 text-rose-700 border-rose-200' },
  active: { icon: FileText, label: 'Active', cls: 'bg-indigo-50 text-indigo-700 border-indigo-200' },
};

export function InvoiceStatusPill({
  status,
  className,
}: {
  status: InvoiceStatusKey | null | undefined;
  className?: string;
}) {
  if (!status) return null;
  const cfg = STATUS_CONFIG[status];
  if (!cfg) return null;
  const Icon = cfg.icon;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[10px] font-bold whitespace-nowrap',
        cfg.cls,
        className,
      )}
    >
      <Icon className="h-3 w-3" />
      {cfg.label}
    </span>
  );
}
