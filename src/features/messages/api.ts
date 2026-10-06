/**
 * Messages read model — the data layer for the user-facing Messages page
 * (/messages): recent WhatsApp message activity + scheduled reminders, as
 * a lightweight VIEW over the EXISTING durable message system.
 *
 * Principles (the page must stay a cheap, read-only window):
 *   - Everything reads through the SAME browser → Supabase RLS SELECT
 *     path the message system already exposes (message_jobs,
 *     reminder_settings). No new tables, no writes, no backend surface.
 *   - The ONLY aggregate is messages_overview() (migration 0008) — the
 *     summary strip's three counts (Pending / Sent today / Needs
 *     attention) in ONE database call instead of several count queries.
 *   - Both lists are KEYSET-paginated (cursor on a timestamp + unique id
 *     tie-breaker): each request fetches exactly one small page, and
 *     pages stay stable while new jobs arrive at the top.
 *   - Tabs are lazy: the Scheduled Reminders query is disabled until the
 *     user actually opens that tab; TanStack Query caches both lists
 *     afterwards (switching tabs never refetches fresh data).
 *   - Live updates arrive on the EXISTING SSE MESSAGE_JOB_RESULT event:
 *     useMessageJobEvents calls refreshRecentMessageAfterEvent() below —
 *     a by-id fetch + precise cache patch that NEVER refetches the whole
 *     loaded history.
 */
import { useInfiniteQuery, useQuery, type QueryClient, type InfiniteData } from '@tanstack/react-query'
import { supabase } from '@/platform/supabase/client'

// ─── Types ───────────────────────────────────────────────────────────────────

export type MessageJobType = 'invoice_send' | 'reminder' | 'receipt' | 'statement'
export type MessageJobStatus = 'pending' | 'processing' | 'succeeded' | 'failed' | 'cancelled'

/** One recent-message row: a message job enriched with the embedded
 *  business-object reference (bill number / amount + party name) resolved
 *  by the foreign-key joins — everything the row and its details surface
 *  display, in ONE read. */
export interface MessageJobRow {
  id: string
  job_type: MessageJobType
  status: MessageJobStatus
  run_at: string
  attempts: number
  max_attempts: number
  finished_at: string | null
  last_error: string | null
  message_id: string | null
  created_at: string
  sales?: { bill_number: string; parties?: { name: string } | null } | null
  purchases?: { bill_number: string; parties?: { name: string } | null } | null
  proforma_invoices?: { bill_number: string; parties?: { name: string } | null } | null
  payments_in?: { amount: string | number; parties?: { name: string } | null } | null
  payments_out?: { amount: string | number; parties?: { name: string } | null } | null
}

/** Reminder-chain progress (reverse embed from sales → reminder_settings). */
interface ReminderProgress {
  reminders_sent: number
  max_reminders: number
}

/** One scheduled-reminder row: the PENDING reminder job (the durable
 *  schedule — the database IS the schedule) with its invoice context.
 *  A reminder chain that is enabled and eligible always has exactly one
 *  pending/processing job (enforced by the partial unique index), so this
 *  IS the "what is scheduled" list. */
export interface ScheduledReminderRow {
  id: string
  status: MessageJobStatus
  run_at: string
  created_at: string
  sales: {
    bill_number: string
    status: string
    due: string | number
    parties?: { name: string } | null
    reminder_settings?: ReminderProgress | null
  } | null
}

/** The overview summary counts (migration 0008 — one aggregate call). */
export interface MessagesOverview {
  pending: number
  sentToday: number
  needsAttention: number
}

/** Keyset cursor for the recent-messages list (created_at DESC, id DESC). */
interface RecentCursor {
  createdAt: string
  id: string
}

/** Keyset cursor for the scheduled-reminders list (run_at ASC, id ASC). */
interface ScheduledCursor {
  runAt: string
  id: string
}

interface MessageJobPage {
  rows: MessageJobRow[]
}

interface ScheduledReminderPage {
  rows: ScheduledReminderRow[]
}

// ─── Query keys ──────────────────────────────────────────────────────────────

export const messagesKeys = {
  all: ['messages'] as const,
  overview: ['messages', 'overview'] as const,
  recent: ['messages', 'recent'] as const,
  scheduled: ['messages', 'scheduled'] as const,
}

export const RECENT_PAGE_SIZE = 20
export const SCHEDULED_PAGE_SIZE = 10

// The message system's read queries use a 15s stale window (fresh enough
// for a live activity surface, cached enough that tab switches and
// back-navigation do not refetch).
const STALE_TIME = 15_000

// ─── Shared helpers ──────────────────────────────────────────────────────────

/** PostgREST returns each to-one FK embed as a one-element array — the
 *  typed client models it as such; the runtime shape for these references
 *  is the object (or null). Normalize defensively (same treatment as the
 *  previous monitor queries). */
function firstOrNull<T>(value: T[] | T | null | undefined): T | null {
  if (Array.isArray(value)) return (value[0] as T | undefined) ?? null
  return (value as T | null | undefined) ?? null
}

/** The message-job columns + business-object embeds the messages rows
 *  display (the FK id columns are deliberately not selected — the joined
 *  labels carry everything the UI shows). */
const MESSAGE_JOB_SELECT =
  'id, job_type, status, run_at, attempts, max_attempts, finished_at, last_error, message_id, created_at, ' +
  'sales(bill_number, parties(name)), purchases(bill_number, parties(name)), ' +
  'proforma_invoices(bill_number, parties(name)), ' +
  'payments_in(amount, parties(name)), payments_out(amount, parties(name))'

type RawJobRow = Record<string, unknown>

/** Normalize one fetched job row's to-one embeds into MessageJobRow. */
function toMessageJobRow(row: RawJobRow): MessageJobRow {
  return {
    ...row,
    sales: firstOrNull(row.sales as MessageJobRow['sales']),
    purchases: firstOrNull(row.purchases as MessageJobRow['purchases']),
    proforma_invoices: firstOrNull(row.proforma_invoices as MessageJobRow['proforma_invoices']),
    payments_in: firstOrNull(row.payments_in as MessageJobRow['payments_in']),
    payments_out: firstOrNull(row.payments_out as MessageJobRow['payments_out']),
  } as MessageJobRow
}

/** Normalize one raw scheduled-reminder row (sale embed + the reverse
 *  reminder_settings embed both arrive as arrays). */
function toScheduledReminderRow(row: RawJobRow): ScheduledReminderRow {
  const sale = firstOrNull(row.sales as ScheduledReminderRow['sales'])
  const progress = sale ? firstOrNull(sale.reminder_settings as ReminderProgress) : null
  return {
    ...row,
    sales: sale ? { ...sale, reminder_settings: progress } : null,
  } as ScheduledReminderRow
}

/** Keyset comparison: is row `a` NEWER than row `b` (created_at DESC, id DESC)? */
function isNewerMessage(a: MessageJobRow, b: MessageJobRow): boolean {
  if (a.created_at !== b.created_at) return a.created_at > b.created_at
  return a.id > b.id
}

// ─── Overview (summary strip) ────────────────────────────────────────────────

/** The Messages summary counts (Pending / Sent today / Needs attention) —
 *  ONE aggregate database call (messages_overview, migration 0008). */
export function useMessagesOverview(enabled: boolean) {
  return useQuery({
    queryKey: messagesKeys.overview,
    enabled,
    queryFn: async (): Promise<MessagesOverview> => {
      const { data, error } = await supabase.rpc('messages_overview')
      if (error) throw error
      const result = Array.isArray(data) ? data[0] : data
      return {
        pending: Number(result?.pending ?? 0),
        sentToday: Number(result?.sentToday ?? 0),
        needsAttention: Number(result?.needsAttention ?? 0),
      }
    },
    staleTime: STALE_TIME,
  })
}

// ─── Recent messages (keyset-paginated activity list) ────────────────────────

/** The Recent Messages list: delivery jobs newest-first, one small
 *  keyset-paginated page at a time (cursor on created_at + id, so pages
 *  stay stable while new jobs arrive). The first page has no cursor —
 *  it is always "the newest RECENT_PAGE_SIZE rows". */
export function useRecentMessages() {
  return useInfiniteQuery({
    queryKey: messagesKeys.recent,
    initialPageParam: null as RecentCursor | null,
    queryFn: async ({ pageParam }): Promise<MessageJobPage> => {
      let request = supabase
        .from('message_jobs')
        .select(MESSAGE_JOB_SELECT)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(RECENT_PAGE_SIZE)
      if (pageParam) {
        // Keyset: strictly older than the cursor (created_at, id) pair.
        request = request.or(
          `created_at.lt.${pageParam.createdAt},and(created_at.eq.${pageParam.createdAt},id.lt.${pageParam.id})`,
        )
      }
      const { data, error } = await request
      if (error) throw error
      return { rows: ((data as unknown as RawJobRow[]) ?? []).map(toMessageJobRow) }
    },
    getNextPageParam: (lastPage) => {
      if (lastPage.rows.length < RECENT_PAGE_SIZE) return undefined
      const last = lastPage.rows[lastPage.rows.length - 1]
      return { createdAt: last.created_at, id: last.id }
    },
    staleTime: STALE_TIME,
  })
}

// ─── Scheduled reminders (keyset-paginated, lazy) ────────────────────────────

/** The Scheduled Reminders list: the pending/processing reminder jobs
 *  (soonest first) with their invoice context. `enabled` implements the
 *  lazy tab — nothing is fetched until the user opens the tab; after the
 *  first load the pages are cached (no refetch on tab switches). */
export function useScheduledReminders(enabled: boolean) {
  return useInfiniteQuery({
    queryKey: messagesKeys.scheduled,
    enabled,
    initialPageParam: null as ScheduledCursor | null,
    queryFn: async ({ pageParam }): Promise<ScheduledReminderPage> => {
      let request = supabase
        .from('message_jobs')
        .select(
          'id, status, run_at, created_at, ' +
            'sales(bill_number, status, due, parties(name), reminder_settings(reminders_sent, max_reminders))',
        )
        .eq('job_type', 'reminder')
        .in('status', ['pending', 'processing'])
        .order('run_at', { ascending: true })
        .order('id', { ascending: true })
        .limit(SCHEDULED_PAGE_SIZE)
      if (pageParam) {
        // Keyset: strictly later than the cursor (run_at, id) pair.
        request = request.or(
          `run_at.gt.${pageParam.runAt},and(run_at.eq.${pageParam.runAt},id.gt.${pageParam.id})`,
        )
      }
      const { data, error } = await request
      if (error) throw error
      return { rows: ((data as unknown as RawJobRow[]) ?? []).map(toScheduledReminderRow) }
    },
    getNextPageParam: (lastPage) => {
      if (lastPage.rows.length < SCHEDULED_PAGE_SIZE) return undefined
      const last = lastPage.rows[lastPage.rows.length - 1]
      return { runAt: last.run_at, id: last.id }
    },
    staleTime: STALE_TIME,
  })
}

// ─── SSE live update (existing MESSAGE_JOB_RESULT events) ──────────────────

/** Fetch ONE delivery job row by id (same read path/shape as the recent
 *  pages) — used by the SSE reaction to apply a settled job's new state
 *  to the already-loaded list without refetching any page. */
async function fetchMessageJobById(jobId: string): Promise<MessageJobRow | null> {
  const { data, error } = await supabase
    .from('message_jobs')
    .select(MESSAGE_JOB_SELECT)
    .eq('id', jobId)
    .maybeSingle()
  if (error) throw error
  return data ? toMessageJobRow(data as unknown as RawJobRow) : null
}

/**
 * Apply a settled message job (SSE MESSAGE_JOB_RESULT) to the cached
 * Recent Messages list — the SMALLEST appropriate cache update:
 *
 *   - a row already loaded is updated in place (status/attempts/
 *     timestamps/refs);
 *   - a NEW row newer than the newest loaded row is prepended to the
 *     first page;
 *   - nothing else refetches — older loaded pages are never re-requested.
 *
 * The by-id fetch runs only when a cached list EXISTS (the user has
 * opened Messages this session — the patch then keeps it fresh even while
 * another tab of the page is showing); a user who never opened Messages
 * costs nothing. Never throws into the SSE stream.
 */
export async function refreshRecentMessageAfterEvent(
  queryClient: QueryClient,
  jobId: string,
): Promise<void> {
  try {
    const cached = queryClient.getQueryData(messagesKeys.recent) !== undefined
    if (!cached) return
    const row = await fetchMessageJobById(jobId)
    if (!row) return
    queryClient.setQueryData<InfiniteData<MessageJobPage>>(messagesKeys.recent, (data) => {
      if (!data || data.pages.length === 0 || data.pages[0].rows.length === 0) return data
      // Update in place when the row is already loaded.
      let found = false
      const pages = data.pages.map((page) => ({
        ...page,
        rows: page.rows.map((r) => {
          if (r.id !== row.id) return r
          found = true
          return row
        }),
      }))
      if (found) return { ...data, pages }
      // New row: prepend only when it belongs at the top (newer than the
      // newest loaded row). Otherwise it is history the user has not
      // loaded — the regular refetch will place it.
      if (isNewerMessage(row, data.pages[0].rows[0])) {
        const [first, ...rest] = pages
        return { ...data, pages: [{ ...first, rows: [row, ...first.rows] }, ...rest] }
      }
      return data
    })
  } catch {
    // A failed live patch must never disturb the SSE stream — the list
    // simply stays as-is until its next natural refetch.
  }
}
