/**
 * Message job state queries (browser, RLS-enforced, read-only).
 *
 * message_jobs and reminder_settings are readable by authorized app users
 * (SELECT-only policies) so the UI can display message/reminder status
 * directly from the database — the persistent truth. Writes happen ONLY
 * through the backend API (system-owned job state).
 */
import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/platform/supabase/client'

/** Mirror of the backend message_jobs row (the columns the UI consumes). */
export interface MessageJob {
  id: string
  job_type: 'invoice_send' | 'reminder' | 'receipt' | 'statement'
  status: 'pending' | 'processing' | 'succeeded' | 'failed' | 'cancelled'
  sale_id: string | null
  purchase_id: string | null
  proforma_id: string | null
  payment_in_id: string | null
  payment_out_id: string | null
  run_at: string
  attempts: number
  max_attempts: number
  finished_at: string | null
  last_error: string | null
  created_at: string
}

/** Mirror of the reminder_settings row. */
export interface ReminderSettings {
  sale_id: string
  enabled: boolean
  frequency_days: number
  max_reminders: number
  reminders_sent: number
  last_reminder_at: string | null
}

export const messageJobsKeys = {
  jobs: (refType: 'sale' | 'purchase' | 'proforma' | 'payment_in' | 'payment_out', refId: string) =>
    ['message-jobs', refType, refId] as const,
  reminderSettings: (saleId: string) => ['reminder-settings', saleId] as const,
}

/** The message jobs for one business object, newest first. */
export function useMessageJobs(
  refType: 'sale' | 'purchase' | 'proforma' | 'payment_in' | 'payment_out',
  refId: string,
) {
  return useQuery({
    queryKey: messageJobsKeys.jobs(refType, refId),
    queryFn: async (): Promise<MessageJob[]> => {
      const { data, error } = await supabase
        .from('message_jobs')
        .select(
          'id, job_type, status, sale_id, purchase_id, proforma_id, payment_in_id, payment_out_id, run_at, attempts, max_attempts, finished_at, last_error, created_at',
        )
        .eq(`${refType}_id`, refId)
        .order('created_at', { ascending: false })
        .limit(10)
      if (error) throw error
      return (data as MessageJob[]) ?? []
    },
    staleTime: 15_000,
  })
}

/** The reminder configuration for one sale invoice (null when unconfigured). */
export function useReminderSettings(saleId: string) {
  return useQuery({
    queryKey: messageJobsKeys.reminderSettings(saleId),
    queryFn: async (): Promise<ReminderSettings | null> => {
      const { data, error } = await supabase
        .from('reminder_settings')
        .select('sale_id, enabled, frequency_days, max_reminders, reminders_sent, last_reminder_at')
        .eq('sale_id', saleId)
        .maybeSingle()
      if (error) throw error
      return (data as ReminderSettings | null) ?? null
    },
    staleTime: 15_000,
  })
}

/** Derive the user-facing summary of an invoice's reminder state. */
export interface ReminderSummary {
  configured: boolean
  enabled: boolean
  fullyPaid: boolean
  cancelled: boolean
  limitReached: boolean
  nextRunAt: string | null
  pendingJob: MessageJob | null
  lastFinished: MessageJob | null
  failedJob: MessageJob | null
}

export function summarizeReminderState(
  config: ReminderSettings | null,
  jobs: MessageJob[],
  sale: { status?: string | null; due?: string | number | null } | null | undefined,
): ReminderSummary {
  const reminderJobs = jobs.filter((j) => j.job_type === 'reminder')
  const pendingJob =
    reminderJobs.find((j) => j.status === 'pending' || j.status === 'processing') ?? null
  const finished = reminderJobs.filter((j) => j.finished_at)
  const lastFinished =
    finished.sort((a, b) => (a.finished_at! < b.finished_at! ? 1 : -1))[0] ?? null
  const failedJob = reminderJobs.find((j) => j.status === 'failed') ?? null
  const fullyPaid = Number(sale?.due ?? 0) <= 0
  const cancelled = sale?.status === 'cancelled'
  return {
    configured: config !== null,
    enabled: config?.enabled === true,
    fullyPaid,
    cancelled,
    limitReached: config ? config.reminders_sent >= config.max_reminders : false,
    nextRunAt: pendingJob?.run_at ?? null,
    pendingJob,
    lastFinished,
    failedJob,
  }
}
