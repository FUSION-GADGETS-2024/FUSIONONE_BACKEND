'use client';

/**
 * InvoiceViewError — the Invoice View inline error state.
 *
 * Shown when the invoice cannot be loaded (detail fetch failed, or the PDF
 * pipeline failed before any document was displayed). Inline and recoverable:
 * the Retry button re-runs the EXISTING recovery path (query refetch /
 * pipeline regeneration) — no new backend flow.
 */
import { FileWarning, RefreshCw } from 'lucide-react';

export function InvoiceViewError({
  message,
  onRetry,
}: {
  message?: string | null;
  onRetry: () => void;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-8 sm:p-12 flex flex-col items-center text-center shadow-sm">
      <div className="h-11 w-11 rounded-full bg-rose-50 border border-rose-100 flex items-center justify-center">
        <FileWarning className="h-5 w-5 text-rose-600" />
      </div>
      <p className="mt-4 text-sm font-bold text-slate-900">Unable to load invoice</p>
      <p className="mt-1 text-xs text-slate-500 max-w-xs leading-relaxed">
        {message ?? 'The invoice could not be opened. Please try again.'}
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-5 inline-flex items-center gap-2 rounded-md bg-indigo-600 px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-indigo-700 transition-colors"
      >
        <RefreshCw className="h-3.5 w-3.5" />
        Retry
      </button>
    </div>
  );
}
