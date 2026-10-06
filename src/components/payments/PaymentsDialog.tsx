'use client';

/**
 * PaymentsDialog — the payment history for ONE invoice/bill, opened from the
 * EXISTING invoice/purchase sidebar's Payments button. It lists every
 * payment recorded against the invoice (including the initial payment made
 * during invoice/bill creation), gives each payment its own manual Send
 * Receipt action, and offers the manual Send Payment Statement action for
 * the whole history. The aggregate Total Paid / Balance Due state comes from
 * the AUTHORITATIVE invoice row (sales.paid/due, purchases.paid/due) passed
 * in by the detail page — never recomputed here.
 *
 * LAYOUT — one STABLE SHELL whose regions have fixed roles:
 *
 *   PaymentsDialog (modal shell, bounded by max-h-[90vh])
 *   ├── Header                     flex-none — never moves
 *   ├── Summary / Stats            flex-none — never moves
 *   ├── Payment History            h-72 min-h-0 — the ONE region that varies,
 *   │                              internally scrolling
 *   └── Footer / Statement action  flex-none — never moves
 *
 * The history viewport carries a fixed base height (h-72, the panel's
 * established rhythm) shared IDENTICALLY by the loaded list, the loading
 * skeleton, and the empty state — so the modal keeps ONE outer geometry
 * across the loading → content transition and across 0…N payments; the
 * list's intrinsic height can never push the modal larger. When the
 * viewport is short, the modal's max-h constraint cascades down the flex
 * column and ONLY the history region (min-h-0) shrinks, scrolling
 * internally while the header, summary, and footer stay visible.
 *
 * The scroll region carries its own inner insets (a padded content wrapper
 * inside the scroller), so rows never touch the scroll edge or look clipped
 * mid-scroll, and a stable scrollbar gutter keeps the horizontal position of
 * the content fixed whether the scrollbar is present or not.
 *
 * Send Payment Statement is a compact secondary document action in the
 * modal's fixed footer slot — always reachable, never a page-level banner.
 *
 * Message actions converge on the EXISTING durable message system: the
 * backend creates the job, claims it, and executes it inline under the
 * caller's identity; a message failure NEVER affects the recorded payment.
 */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Receipt, ScrollText } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/components/ui/utils';
import { Skeleton, useSkeletonDelay } from '@/components/ui/Skeleton';
import { useInvoicePayments } from '@/features/payments/api';
import { postSendReceipt, postSendStatement } from '@/platform/whatsapp/http';
import { messageJobsKeys } from '@/features/messages/jobs';

/** The invoice/bill context the dialog needs (authoritative aggregate state). */
export interface PaymentsDialogInvoice {
  id: string;
  billNumber: string;
  partyName: string | null;
  total: number;
  paid: number;
  due: number;
}

export interface PaymentsDialogProps {
  open: boolean;
  onClose: () => void;
  /** 'sale' → payments received (In) · 'purchase' → payments made (Out). */
  invoiceType: 'sale' | 'purchase';
  invoice: PaymentsDialogInvoice | null;
}

const money = (n: number | string) =>
  Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** The payment date in the app's standard short format ("04 Oct 2026"). */
function formatPaymentDate(value: string): string {
  const d = new Date(`${value}T00:00:00`);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

/** The history VIEWPORT — one stable region shared by the loaded list, the
 *  loading skeleton, AND the empty state, so the modal's outer geometry is
 *  identical in every state. Its fixed base height (h-72) only ever
 *  SHRINKS: as the flexible child (min-h-0) of the dialog's flex column it
 *  absorbs the reduction when the modal is bounded by a short viewport,
 *  scrolling internally instead of pushing the modal larger. The region is
 *  a framed, tinted PANEL so the scroll boundary reads as the panel's own
 *  edge — a contained list, never a clipped viewport. */
const HISTORY_VIEWPORT =
  'h-72 min-h-0 overflow-y-auto overscroll-contain [scrollbar-gutter:stable] rounded-xl border border-slate-200 bg-slate-50/40';
/** The padded content wrapper INSIDE the viewport — this is what gives every
 *  side of the list its inset (padding → rows → padding), so the last card
 *  never appears cut off by the overflow boundary. */
const HISTORY_INSETS = 'p-1.5 space-y-1.5';

/** One payment row's shared chrome (also used by its skeleton counterpart). */
const ROW_CHROME =
  'flex items-center gap-3 rounded-lg border border-slate-200 bg-white px-3.5 py-2.5';

export function PaymentsDialog({ open, onClose, invoiceType, invoice }: PaymentsDialogProps) {
  const isIn = invoiceType === 'sale';
  const direction = isIn ? 'in' : 'out';
  const { success, error, toast } = useToast();
  const queryClient = useQueryClient();

  const invoiceId = invoice?.id ?? '';
  const paymentsQuery = useInvoicePayments(invoiceType, invoiceId, open && !!invoice);
  const payments = paymentsQuery.data ?? [];
  const historyPulsing = useSkeletonDelay(paymentsQuery.isLoading);

  // Row-level loading states; the backend's one-job-per-payment guard makes
  // double-clicks harmless, and one in-flight send disables the others.
  const [sendingReceiptId, setSendingReceiptId] = useState<string | null>(null);
  const [sendingStatement, setSendingStatement] = useState(false);

  const handleSendReceipt = async (paymentId: string) => {
    if (sendingReceiptId || sendingStatement) return;
    setSendingReceiptId(paymentId);
    try {
      const result = await postSendReceipt({ paymentId, direction });
      if (result.success) {
        success('Receipt sent', 'The payment receipt was sent on WhatsApp.');
      } else if (result.status === 'pending') {
        toast({
          type: 'warning',
          title: 'Receipt retrying',
          message: 'WhatsApp is unavailable right now — the receipt will be retried automatically.',
        });
      } else if (result.status === 'processing') {
        toast({ type: 'info', title: 'Already sending', message: 'A receipt for this payment is already being delivered.' });
      } else {
        error('Receipt failed', result.error || 'The receipt could not be sent.');
      }
      await queryClient.invalidateQueries({ queryKey: messageJobsKeys.jobs(isIn ? 'payment_in' : 'payment_out', paymentId) });
    } catch (cause) {
      error('Receipt failed', cause instanceof Error ? cause.message : 'Unable to send the receipt.');
    } finally {
      setSendingReceiptId(null);
    }
  };

  const handleSendStatement = async () => {
    if (!invoice || sendingReceiptId || sendingStatement) return;
    setSendingStatement(true);
    try {
      const result = await postSendStatement({ invoiceId: invoice.id, invoiceType });
      if (result.success) {
        success('Statement sent', 'The payment statement was sent on WhatsApp.');
      } else if (result.status === 'pending') {
        toast({
          type: 'warning',
          title: 'Statement retrying',
          message: 'WhatsApp is unavailable right now — the statement will be retried automatically.',
        });
      } else if (result.status === 'processing') {
        toast({ type: 'info', title: 'Already sending', message: 'A payment statement for this invoice is already being delivered.' });
      } else {
        error('Statement failed', result.error || 'The payment statement could not be sent.');
      }
      await queryClient.invalidateQueries({ queryKey: messageJobsKeys.jobs(isIn ? 'sale' : 'purchase', invoice.id) });
    } catch (cause) {
      error('Statement failed', cause instanceof Error ? cause.message : 'Unable to send the payment statement.');
    } finally {
      setSendingStatement(false);
    }
  };

  if (!invoice) return null;

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      title="Payments"
      description={
        isIn
          ? `Tax invoice ${invoice.billNumber}${invoice.partyName ? ` · ${invoice.partyName}` : ''}`
          : `Purchase bill ${invoice.billNumber}${invoice.partyName ? ` · ${invoice.partyName}` : ''}`
      }
      className="max-w-xl"
      /* Stable shell: the body region itself never scrolls — the summary and
         history heading are fixed flex items, and ONLY the history viewport
         scrolls inside its own stable-height region. This keeps the modal's
         outer geometry constant across loading → loaded and 0…N payments. */
      bodyClassName="flex flex-col overflow-hidden"
      /* The statement action lives in the Modal's fixed footer slot — always
         reachable, even on short viewports. */
      footer={
        <div className="flex w-full flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[11px] text-slate-400">
            The statement covers all {payments.length} payment{payments.length === 1 ? '' : 's'} on this {isIn ? 'invoice' : 'bill'}.
          </p>
          <Button
            onClick={handleSendStatement}
            disabled={payments.length === 0 || sendingStatement || sendingReceiptId !== null}
            isLoading={sendingStatement}
            className="shrink-0 gap-1.5 text-xs h-8 bg-indigo-600 hover:bg-indigo-700"
          >
            {/* Icon always mounted — the Button's loading overlay keeps the
                reserved footprint identical in every state. */}
            <ScrollText className="h-3.5 w-3.5" />
            Send Payment Statement
          </Button>
        </div>
      }
    >
      {/* Direct children of the body's flex column — summary and history
          section are the two fixed-role regions above the footer. */}
      {/* ── Summary — the authoritative aggregate state, directly after the
          header so the invoice's financial position is understood BEFORE
          the payment history (values from the invoice row, never summed
          here). Three columns on wider viewports; on narrow viewports the
          same strip recomposes into stacked label/value rows so every
          label stays fully readable. flex-none — it never moves. ── */}
      <div
        className="flex-none grid grid-cols-1 divide-y divide-slate-200 rounded-xl border border-slate-200 bg-slate-50/60 overflow-hidden sm:grid-cols-3 sm:divide-x sm:divide-y-0"
        data-testid="payments-summary"
      >
        <div className="flex items-baseline justify-between gap-3 px-4 py-2.5 sm:block sm:px-3.5 min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-[0.08em] text-slate-400 truncate">
            {isIn ? 'Invoice amount' : 'Bill amount'}
          </p>
          <p className="text-[13px] font-bold text-slate-800 tabular-nums sm:mt-1 truncate">₹{money(invoice.total)}</p>
        </div>
        <div className="flex items-baseline justify-between gap-3 px-4 py-2.5 sm:block sm:px-3.5 min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-[0.08em] text-slate-400 truncate">Total paid</p>
          <p className="text-[13px] font-bold text-emerald-700 tabular-nums sm:mt-1 truncate">₹{money(invoice.paid)}</p>
        </div>
        <div className="flex items-baseline justify-between gap-3 px-4 py-2.5 sm:block sm:px-3.5 min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-[0.08em] text-slate-400 truncate">Balance due</p>
          <p
            className={cn(
              'text-[13px] font-bold tabular-nums sm:mt-1 truncate',
              invoice.due > 0 ? 'text-rose-600' : 'text-emerald-700',
            )}
          >
            {invoice.due > 0 ? `₹${money(invoice.due)}` : 'Paid in full'}
          </p>
        </div>
      </div>

      {/* ── Payment history — the dialog's ONE flexible region: the heading
          is fixed (flex-none) and every state below renders into the SAME
          stable h-72 viewport, so switching between skeleton, empty, and
          loaded content can never move the modal's outer geometry. The
          section participates in the body's flex column (min-h-0) so that on
          short viewports only this region yields, never the summary or
          footer. ── */}
      <div className="mt-4 flex min-h-0 flex-col">
        <p className="flex-none text-[10px] font-bold uppercase tracking-[0.08em] text-slate-400 mb-2">
          {isIn ? 'Payment history — received' : 'Payment history — made'}
        </p>

        {paymentsQuery.isLoading ? (
          /* Structural skeleton — the SAME viewport and row chrome as the
             loaded list, so the rows swap in place without moving the
             dialog. Only the history region pulses. */
          <div
            className={cn(HISTORY_VIEWPORT, historyPulsing && 'animate-pulse')}
            role="status"
            aria-live="polite"
          >
            <span className="sr-only">Loading payments…</span>
            <div className={HISTORY_INSETS}>
              {[...Array(4)].map((_, i) => (
                <div key={i} className={ROW_CHROME}>
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="flex items-baseline gap-2">
                      <Skeleton className="h-3.5 w-20" />
                      <Skeleton className="h-2.5 w-14" />
                    </div>
                    <Skeleton className="h-2.5 w-28" />
                  </div>
                  <Skeleton className="h-7 w-[92px] shrink-0 rounded-md bg-slate-200/70" />
                </div>
              ))}
            </div>
          </div>
        ) : payments.length === 0 ? (
          /* Empty state — rendered INSIDE the same stable viewport geometry
             (dashed panel, message centered) so an unpaid invoice keeps the
             identical modal shell. */
          <div className="h-72 min-h-0 rounded-xl border border-dashed border-slate-200 bg-slate-50/40 flex items-center justify-center px-6">
            <p className="text-xs text-slate-400 text-center">
              No payments recorded yet{isIn ? ' — this invoice is fully unpaid.' : ' — this bill is fully unpaid.'}
            </p>
          </div>
        ) : (
          <div className={HISTORY_VIEWPORT}>
            <div className={HISTORY_INSETS}>
              {payments.map((p) => (
                <div key={p.id} className={cn(ROW_CHROME, 'min-h-[50px]')}>
                  {/* Amount is primary; date and account/mode secondary. */}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2 min-w-0">
                      <p className="text-[13px] font-bold text-slate-900 tabular-nums shrink-0">
                        ₹{money(p.amount)}
                      </p>
                      <p className="text-[10px] text-slate-400 tabular-nums shrink-0">{formatPaymentDate(p.date)}</p>
                    </div>
                    <p
                      className="mt-0.5 text-[11px] text-slate-400 truncate"
                      title={[p.payment_modes?.name, p.bank_accounts?.name].filter(Boolean).join(' · ') || undefined}
                    >
                      {[p.payment_modes?.name, p.bank_accounts?.name].filter(Boolean).join(' · ') || 'Payment'}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleSendReceipt(p.id)}
                    disabled={sendingReceiptId !== null || sendingStatement}
                    title="Send this payment's receipt on WhatsApp"
                    aria-label={`Send receipt for the payment of ₹${money(p.amount)} on ${formatPaymentDate(p.date)}`}
                    className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md border border-slate-300 bg-white text-[10px] font-semibold text-slate-600 hover:bg-slate-50 hover:text-slate-800 transition-colors disabled:cursor-not-allowed disabled:opacity-50 shrink-0"
                  >
                    {sendingReceiptId === p.id
                      ? <span className="h-3 w-3 shrink-0 rounded-full border-[1.5px] border-slate-500 border-t-transparent animate-spin" aria-hidden />
                      : <Receipt className="h-3 w-3 shrink-0" />}
                    Send Receipt
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
