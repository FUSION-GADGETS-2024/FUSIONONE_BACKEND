'use client';

/**
 * InvoiceViewSkeleton — the Invoice View loading state.
 *
 * Reuses the real InvoiceViewLayout (same header row, same workspace grid,
 * same scroll context) so the skeleton reserves the finished page's exact
 * geometry and the load transition causes no layout shift.
 *
 * GEOMETRY PARITY: the skeleton mirrors the FINAL page structure —
 *   - header: title (bill number) + STATUS PILL (the status is a
 *     document-level badge in the page header) + subtitle + back button;
 *   - sidebar: metadata section (customer/date — no status), Export
 *     controls, WhatsApp section, then the page's OWN module sections
 *     (`variant`: sale → Payment + Invoice actions; purchase → Payment;
 *     proforma → Quotation; bare → none, for read-only financial years).
 *
 * Motion rules:
 *   - ONE subtle pulse per logical region (the whole header bar, the whole
 *     sidebar card) — never per bar. The pulse is additionally gated by the
 *     loading threshold, so a fast query never flashes animated shimmer at
 *     all (the static geometry still establishes the structure instantly).
 *   - The document area is a clean neutral A4 sheet — static, no fake
 *     invoice content, no shimmering large surface. The PDF pipeline has
 *     not even started at this stage; the viewer's own tiny local indicator
 *     takes over once the document is being opened.
 */
import { InvoiceViewLayout } from './InvoiceViewLayout';
import { cn } from '@/components/ui/utils';
import { Skeleton, useSkeletonDelay } from '@/components/ui/Skeleton';

/** Which page's sidebar sections the skeleton must reserve. */
export type InvoiceViewSkeletonVariant = 'sale' | 'purchase' | 'proforma' | 'bare';

/** One module section of button-height blocks under a section label. */
function SkeletonSection({ labelWidth, buttons }: { labelWidth: string; buttons: number }) {
  return (
    <div className="p-3 pt-0 space-y-2">
      <Skeleton className={cn('h-2.5', labelWidth)} />
      {[...Array(buttons)].map((_, i) => (
        <Skeleton key={i} className="h-9 rounded-md" />
      ))}
    </div>
  );
}

/** The module sections each detail page renders below Export / WhatsApp. */
function SkeletonModuleSections({ variant }: { variant: InvoiceViewSkeletonVariant }) {
  switch (variant) {
    // Sale: Payment (Receive Payment · Payments · Payment Reminders) +
    // Invoice (Edit Invoice · Cancel Invoice).
    case 'sale':
      return (
        <>
          <SkeletonSection labelWidth="w-14" buttons={3} />
          <SkeletonSection labelWidth="w-12" buttons={2} />
        </>
      );
    // Purchase: Payment (Pay · Payments).
    case 'purchase':
      return <SkeletonSection labelWidth="w-14" buttons={2} />;
    // Proforma: Quotation (Convert to Sale).
    case 'proforma':
      return <SkeletonSection labelWidth="w-16" buttons={1} />;
    // Read-only financial year: no module sections at all.
    default:
      return null;
  }
}

export function InvoiceViewSkeleton({ variant = 'sale' }: { variant?: InvoiceViewSkeletonVariant }) {
  // The component is only mounted while the page is loading — the threshold
  // starts on mount. A fast load unmounts it before the pulse ever shows.
  const pulsing = useSkeletonDelay(true);

  return (
    <InvoiceViewLayout
      /* Header skeleton — the shared PageHeader shape: title + status pill
         on one line, subtitle below, back button right. The pill block
         reserves the status badge's geometry (the status moved from the
         sidebar into this header). */
      header={
        <div className={cn(pulsing && 'animate-pulse')}>
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2.5">
                <Skeleton className="h-4 w-36 bg-slate-200/70" />
                <Skeleton className="h-[22px] w-16 rounded-full bg-slate-200/70" />
              </div>
              <Skeleton className="mt-1.5 h-3 w-56" />
            </div>
            <Skeleton className="h-8 w-28 shrink-0 rounded-md bg-slate-200/70" />
          </div>
        </div>
      }
      /* Sidebar skeleton — one card matching the finished panel: metadata
         section (customer · date), Export controls, WhatsApp section, then
         the page's own module sections in the same button rhythm. */
      sidebar={
        <div
          className={cn(
            'rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden',
            pulsing && 'animate-pulse',
          )}
        >
          {/* Metadata — section label + customer/date rows */}
          <div className="p-4 border-b border-slate-100 space-y-2.5">
            <Skeleton className="h-2.5 w-14" />
            <Skeleton className="h-3.5 w-28" />
            <Skeleton className="h-3.5 w-24" />
          </div>
          {/* Export — label + Save PDF + Print */}
          <div className="p-3 space-y-2">
            <Skeleton className="h-2.5 w-12" />
            <Skeleton className="h-9 rounded-md bg-slate-200/70" />
            <Skeleton className="h-9 rounded-md" />
          </div>
          {/* WhatsApp — label + the share action */}
          <div className="p-3 pt-0 space-y-2">
            <Skeleton className="h-2.5 w-16" />
            <Skeleton className="h-9 rounded-md" />
          </div>
          {/* Module sections — the page variant's real actions */}
          <SkeletonModuleSections variant={variant} />
        </div>
      }
    >
      {/* Document area skeleton — the same frame and full-width A4 sheet the
          viewer shows, kept as a clean neutral surface. Static on purpose:
          no fake invoice content and no shimmer across a large sheet. */}
      <div className="h-full min-h-0 overflow-y-auto overscroll-contain">
        <div className="rounded-xl border border-slate-200/90 bg-slate-100/70 p-3 sm:p-5 lg:p-6">
          <div
            className="w-full rounded-sm bg-white ring-1 ring-slate-900/5 shadow-md shadow-slate-900/10"
            style={{ aspectRatio: '595.28 / 841.89' }}
          />
        </div>
      </div>
    </InvoiceViewLayout>
  );
}
