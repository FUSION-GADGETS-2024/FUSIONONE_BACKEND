'use client';

/**
 * ReminderDialog — the per-invoice payment-reminder configuration dialog
 * (sale invoice detail context). The dialog ONLY changes persistent
 * configuration and triggers backend-owned message actions — it never
 * schedules anything with client-side timers:
 *
 *   - Save → PUT /api/sales/:id/reminder-settings (the backend creates or
 *     cancels the durable next job atomically with the configuration).
 *   - Send Reminder Now → POST /api/whatsapp/sendReminder (the backend
 *     pulls the scheduled job forward or creates a one-off and executes it
 *     through the SAME message pipeline as scheduled reminders).
 *
 * The dialog makes the current state explicit: fully paid / cancelled
 * invoices, disabled reminders, reached limits, and the next scheduled
 * reminder — all read from the persistent reminder_settings + message_jobs
 * rows (RLS).
 */
import { useEffect, useState } from 'react';
import { BellRing } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { MoneyInput } from '@/components/ui/MoneyInput';
import { useToast } from '@/components/ui/Toast';
import { postSendReminder, putReminderSettings } from '@/platform/whatsapp/http';
import { useQueryClient } from '@tanstack/react-query';
import { messageJobsKeys, useMessageJobs, useReminderSettings, type ReminderSummary, summarizeReminderState } from '@/features/messages/jobs';
import { useFieldErrors, focusFirstInvalid } from '@/features/validation/use-field-errors';

export interface ReminderDialogProps {
  open: boolean;
  onClose: () => void;
  saleId: string;
  billNumber?: string;
  sale: { status?: string | null; due?: string | number | null } | null;
}

export function ReminderDialog({ open, onClose, saleId, billNumber, sale }: ReminderDialogProps) {
  const { success, error, toast } = useToast();
  const queryClient = useQueryClient();

  const configQuery = useReminderSettings(saleId);
  const jobsQuery = useMessageJobs('sale', saleId);

  const config = configQuery.data ?? null;
  const summary: ReminderSummary = summarizeReminderState(config, jobsQuery.data ?? [], sale);

  // Draft form state — initialized once from the persisted configuration
  // each time the dialog opens (or the config first loads while open).
  const [enabled, setEnabled] = useState(true);
  const [frequencyDays, setFrequencyDays] = useState('7');
  const [maxReminders, setMaxReminders] = useState('3');
  const [appliedFor, setAppliedFor] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isSending, setIsSending] = useState(false);

  // Inline field errors — the app-wide interaction model (untouched →
  // quiet, blurred → validate, Save → validate all + focus first invalid).
  const fieldErrors = useFieldErrors<'frequency' | 'max'>();

  useEffect(() => {
    if (!open) return;
    const key = `${saleId}:${config ? 'loaded' : 'none'}`;
    if (appliedFor === key) return;
    setAppliedFor(key);
    fieldErrors.reset();
    if (config) {
      setEnabled(config.enabled);
      setFrequencyDays(String(config.frequency_days));
      setMaxReminders(String(config.max_reminders));
    }
  }, [open, saleId, config, appliedFor]);

  if (!open) return null;

  const ineligible = summary.fullyPaid || summary.cancelled;
  const canSendNow = !ineligible;

  const handleSave = async () => {
    const freq = Number(frequencyDays);
    const max = Number(maxReminders);
    const freqError = !Number.isInteger(freq) || freq < 1 || freq > 365
      ? 'Frequency must be a whole number of days between 1 and 365.'
      : null;
    const maxError = !Number.isInteger(max) || max < 1 || max > 50
      ? 'Maximum reminders must be between 1 and 50.'
      : null;
    // Validate the complete form: show every error inline, focus the first
    // invalid field — no validation toast.
    fieldErrors.beginSubmit();
    if (freqError || maxError) { focusFirstInvalid(); return; }
    setIsSaving(true);
    try {
      const result = await putReminderSettings({ saleId, enabled, frequencyDays: freq, maxReminders: max });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: messageJobsKeys.reminderSettings(saleId) }),
        queryClient.invalidateQueries({ queryKey: messageJobsKeys.jobs('sale', saleId) }),
      ]);
      success(
        'Reminders saved',
        enabled && !ineligible && !summary.limitReached
          ? `Up to ${max} reminder${max > 1 ? 's' : ''}, every ${freq} day${freq > 1 ? 's' : ''}.`
          : 'Reminder configuration saved.',
      );
      void result;
    } catch (cause) {
      error('Save failed', cause instanceof Error ? cause.message : 'Unable to save the reminder configuration.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleSendNow = async () => {
    if (!canSendNow) return;
    setIsSending(true);
    try {
      const result = await postSendReminder({ saleId });
      if (result.success) {
        success('Reminder sent', `A payment reminder for ${billNumber ?? 'this invoice'} was sent on WhatsApp.`);
      } else if (result.status === 'pending') {
        toast({
          type: 'warning',
          title: 'Reminder retrying',
          message: 'WhatsApp is unavailable right now — the reminder will be retried automatically.',
        });
      } else if (result.status === 'processing') {
        toast({ type: 'info', title: 'Already sending', message: 'A reminder for this invoice is being delivered.' });
      } else {
        error('Reminder failed', result.error || 'The reminder could not be sent.');
      }
      await queryClient.invalidateQueries({ queryKey: messageJobsKeys.jobs('sale', saleId) });
      await queryClient.invalidateQueries({ queryKey: messageJobsKeys.reminderSettings(saleId) });
    } catch (cause) {
      error('Reminder failed', cause instanceof Error ? cause.message : 'Unable to send the reminder.');
    } finally {
      setIsSending(false);
    }
  };

  const fmtDateTime = (value: string | null) =>
    value
      ? new Date(value).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })
      : null;

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4 dialog-fade-in" role="dialog" aria-modal="true" aria-label="Payment reminders">
      {/* The responsive dialog shell: header and footer stay fixed while ONLY
          the body region scrolls (inside the dialog — the page behind never
          moves). On narrow widths the field grid stacks and the action row
          wraps; on short viewports the body region scrolls within max-h. */}
      <div className="flex flex-col w-full max-w-md max-h-[90vh] overflow-hidden bg-white rounded-xl border border-slate-200 shadow-xl dialog-fade-in">
        {/* ── Header (fixed) ── */}
        <div className="flex-none flex items-start gap-4 px-6 pt-5 pb-4 border-b border-slate-100">
          <div className="h-10 w-10 rounded-full bg-indigo-50 flex items-center justify-center shrink-0">
            <BellRing className="h-5 w-5 text-indigo-600" />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-bold text-slate-900">Payment Reminders</h3>
            <p className="text-xs text-slate-500 mt-0.5 break-words">
              {billNumber ? `WhatsApp reminders for ${billNumber}` : 'WhatsApp payment reminders for this invoice'}
            </p>
          </div>
        </div>

        {/* ── Body — the ONLY scrolling region ── */}
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-6 py-5">
        {/* ── Current state ── */}
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 mb-5 space-y-2">
          {summary.cancelled ? (
            <p className="text-xs font-semibold text-rose-700">This invoice is cancelled — reminders are stopped.</p>
          ) : summary.fullyPaid ? (
            <p className="text-xs font-semibold text-emerald-700">This invoice is fully paid — no reminders will be sent.</p>
          ) : !summary.configured ? (
            <p className="text-xs text-slate-500">No reminder configuration yet. Configure and enable below.</p>
          ) : (
            <>
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-500">Delivered reminders</span>
                <span className="font-semibold text-slate-800">
                  {config?.reminders_sent ?? 0} of {config?.max_reminders ?? '—'}
                  {summary.limitReached && <span className="ml-1.5 text-amber-600 font-semibold">(limit reached)</span>}
                </span>
              </div>
              {summary.enabled && summary.nextRunAt && !ineligible && !summary.limitReached && (
                <div className="flex items-center justify-between text-xs">
                  <span className="text-slate-500">Next reminder</span>
                  <span className="font-semibold text-slate-800">{fmtDateTime(summary.nextRunAt)}</span>
                </div>
              )}
              {config?.last_reminder_at && (
                <div className="flex items-center justify-between text-xs">
                  <span className="text-slate-500">Last reminder</span>
                  <span className="text-slate-600">{fmtDateTime(config.last_reminder_at)}</span>
                </div>
              )}
              {!summary.enabled && (
                <p className="text-xs text-slate-500">Reminders are currently disabled.</p>
              )}
              {summary.pendingJob?.status === 'processing' && (
                <p className="text-xs text-slate-500">A reminder is being delivered right now…</p>
              )}
              {summary.pendingJob?.status === 'pending' && summary.pendingJob.attempts > 1 && (
                <p className="text-xs text-amber-700">
                  Last attempt failed — retrying automatically ({summary.pendingJob.attempts} attempts).
                </p>
              )}
              {summary.failedJob && !summary.pendingJob && (
                <p className="text-xs text-rose-600">The last reminder attempt failed: {summary.failedJob.last_error ?? 'message error'}</p>
              )}
            </>
          )}
        </div>

        {/* ── Configuration ── */}
        <div className="space-y-4 mb-5">
          <label className="flex items-center justify-between gap-3 text-xs font-medium text-slate-700">
            Enable reminders
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="h-4 w-4 accent-indigo-600"
            />
          </label>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-semibold text-slate-500 mb-1" htmlFor="reminder-frequency">
                Every (days)
              </label>
              <MoneyInput
                id="reminder-frequency"
                decimals={0}
                value={frequencyDays}
                onBlur={() => fieldErrors.touch('frequency')}
                onChange={setFrequencyDays}
                disabled={!enabled}
                aria-label="Reminder frequency in days"
                className="w-full h-9 text-xs"
              />
              {fieldErrors.show('frequency', !Number.isInteger(Number(frequencyDays)) || Number(frequencyDays) < 1 || Number(frequencyDays) > 365 ? 'Frequency must be a whole number of days between 1 and 365.' : null) && (
                <p role="alert" className="text-[10px] font-medium text-rose-600 mt-1">Frequency must be a whole number of days between 1 and 365.</p>
              )}
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-slate-500 mb-1" htmlFor="reminder-max">
                Max reminders
              </label>
              <MoneyInput
                id="reminder-max"
                decimals={0}
                value={maxReminders}
                onBlur={() => fieldErrors.touch('max')}
                onChange={setMaxReminders}
                disabled={!enabled}
                aria-label="Maximum reminders"
                className="w-full h-9 text-xs"
              />
              {fieldErrors.show('max', !Number.isInteger(Number(maxReminders)) || Number(maxReminders) < 1 || Number(maxReminders) > 50 ? 'Maximum reminders must be between 1 and 50.' : null) && (
                <p role="alert" className="text-[10px] font-medium text-rose-600 mt-1">Maximum reminders must be between 1 and 50.</p>
              )}
            </div>
          </div>
          <p className="text-[11px] text-slate-400 leading-relaxed">
            When enabled and the invoice still has a balance, the first reminder is scheduled one
            interval from now. Each successful reminder uses the invoice's CURRENT balance and stops
            automatically once it is fully paid or cancelled.
          </p>
        </div>
        </div>

        {/* ── Actions (fixed footer — its own non-scrolling region, always
            reachable while only the body above scrolls). The three actions
            reflow as ONE responsive group instead of carrying fixed desktop
            widths: on narrow viewports "Send Reminder Now" takes its own
            full-width row and Close / Save Configuration sit beside each
            other at their natural sizes (never forced into equal columns
            that squeeze the longer label); from `sm` up all three share a
            single row, with flex-wrap as the structural safety net so the
            pair simply wraps instead of clipping if the labels ever need
            more room than the row has. ── */}
        <div className="flex-none px-6 py-4 border-t border-slate-100 bg-slate-50/50">
          <div className="flex flex-col gap-2.5 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
            <Button
              size="sm"
              variant="outline"
              onClick={handleSendNow}
              disabled={!canSendNow || isSending}
              isLoading={isSending}
              className="text-xs h-9 gap-1.5 w-full sm:w-auto"
            >
              {/* Icon always mounted — the Button's loading overlay keeps the
                  reserved footprint identical in every state. */}
              <BellRing className="h-3.5 w-3.5" />
              Send Reminder Now
            </Button>
            <div className="flex items-center justify-between gap-2 sm:justify-end">
              <button
                onClick={onClose}
                disabled={isSaving}
                className="h-9 px-4 text-xs font-semibold rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 transition-colors disabled:opacity-50"
              >
                Close
              </button>
              {/* The shared Button's loading state never changes a button's
                  width (the spinner overlays the stable label footprint), so
                  this footer's action row can never reflow mid-action. */}
              <Button onClick={handleSave} isLoading={isSaving} className="bg-indigo-600 hover:bg-indigo-700 text-xs h-9 px-4">
                Save Configuration
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
