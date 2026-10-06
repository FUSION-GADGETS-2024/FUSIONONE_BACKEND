'use client';

import { useState } from 'react';
import { CheckCircle2, Loader2, MessageCircle, XCircle } from 'lucide-react';
import type { InvoiceType } from '@/features/invoice/types';
import { useToast } from '@/components/ui/Toast';
import { postSendInvoice } from '@/platform/whatsapp/http';
import { useMessageJobs } from '@/features/messages/jobs';
import { cn } from '@/components/ui/utils';

/**
 * Invoice WhatsApp share action (the app's ONE share implementation).
 *
 * Sends the invoice BY REFERENCE — {invoiceId, invoiceType} — to the FUSION
 * ONE backend with the user's Supabase access token as the Bearer
 * credential. The backend verifies the JWT, authorizes the invoice under
 * the caller's identity, and owns everything else: invoice data, recipient
 * (party.number), message template, PDF generation, and delivery (ONE
 * document message with caption).
 *
 * Beneath the button: the invoice's DURABLE message status — the latest
 * server-side message job (auto-send) and its live state, read from
 * message_jobs (RLS). Scheduled auto-sends no longer depend on this page
 * being open; the status line simply reports what the backend is doing.
 *
 * Renders only the action + status — the surrounding section card and label
 * belong to the InvoiceSidebar that hosts it.
 */
export function InvoiceWhatsAppShare({
  invoiceId,
  invoiceType,
  invoiceNumber,
}: {
  invoiceId: string;
  invoiceType: InvoiceType;
  invoiceNumber?: string;
}) {
  const { success, error } = useToast();
  const [isSending, setIsSending] = useState(false);

  const jobsQuery = useMessageJobs(invoiceType, invoiceId);
  const autoSendJob = (jobsQuery.data ?? []).find((job) => job.job_type === 'invoice_send');

  const send = async () => {
    setIsSending(true);
    try {
      await postSendInvoice({ invoiceId, invoiceType });
      success('Invoice sent', `Invoice ${invoiceNumber ?? ''} was sent on WhatsApp.`.trim());
    } catch (cause) {
      error('WhatsApp send failed', cause instanceof Error ? cause.message : 'Unable to send invoice');
    } finally {
      setIsSending(false);
    }
  };

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={send}
        disabled={isSending}
        className="w-full flex items-center gap-2.5 px-3.5 py-2 text-xs font-semibold rounded-md bg-white border border-slate-300 text-slate-700 hover:bg-slate-50 shadow-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isSending
          ? <span className="h-3.5 w-3.5 shrink-0 rounded-full border-[1.5px] border-slate-500 border-t-transparent animate-spin" aria-hidden />
          : <MessageCircle className="h-3.5 w-3.5 shrink-0" />}
        {isSending ? 'Sending…' : 'Send via WhatsApp'}
      </button>

      {/* Durable message status — the backend-owned auto-send pipeline. */}
      {autoSendJob && <AutoSendStatus status={autoSendJob.status} runAt={autoSendJob.run_at} lastError={autoSendJob.last_error} />}
    </div>
  );
}

function AutoSendStatus({
  status,
  runAt,
  lastError,
}: {
  status: 'pending' | 'processing' | 'succeeded' | 'failed' | 'cancelled';
  runAt: string;
  lastError: string | null;
}) {
  const label =
    status === 'pending'
      ? 'Auto-send scheduled'
      : status === 'processing'
        ? 'Auto-send in progress…'
        : status === 'succeeded'
          ? 'Sent automatically on WhatsApp'
          : status === 'failed'
            ? 'Auto-send failed'
            : null;
  if (label === null) return null; // cancelled (e.g. superseded by the manual send)

  const Icon =
    status === 'succeeded' ? CheckCircle2
      : status === 'failed' ? XCircle
        : Loader2;
  const tone =
    status === 'succeeded'
      ? 'text-emerald-600'
      : status === 'failed'
        ? 'text-rose-600'
        : 'text-slate-400';

  return (
    <div className="flex items-start gap-2 px-1 text-[11px] leading-relaxed" role="status">
      <Icon className={cn('h-3.5 w-3.5 shrink-0 mt-px', tone, (status === 'pending' || status === 'processing') && 'animate-spin')} aria-hidden />
      <div className="min-w-0">
        <p className={cn('font-medium', status === 'failed' ? 'text-rose-700' : 'text-slate-500')}>{label}</p>
        {status === 'pending' && (
          <p className="text-slate-400">
            {new Date(runAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}
          </p>
        )}
        {status === 'failed' && lastError && (
          <p className="text-slate-400 break-words">{lastError}</p>
        )}
      </div>
    </div>
  );
}
