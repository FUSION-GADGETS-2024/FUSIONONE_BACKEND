/**
 * Authenticated HTTP client for the FUSION ONE backend.
 *
 * Every call carries `Authorization: Bearer <Supabase access token>` — the
 * backend verifies the JWT and derives the user identity from it (never from
 * the request body). This module is the ONLY place that knows the backend's
 * HTTP paths.
 */
import { supabase } from '@/platform/supabase/client'
import { waUrl } from './url'
import type { BackendStatusResponse } from './backend'

/** Get the current session's access token (throws when signed out). */
async function accessToken(): Promise<string> {
  const { data, error } = await supabase.auth.getSession()
  if (error) throw error
  const token = data.session?.access_token
  if (!token) throw new Error('Authentication required.')
  return token
}

async function parseError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } }
    if (body.error?.message) {
      return body.error.message
    }
  } catch {
    // not JSON
  }
  return `Backend returned HTTP ${res.status}: ${res.statusText}`
}

/** GET /api/status — current WhatsApp status snapshot. */
export async function fetchBackendStatus(): Promise<BackendStatusResponse> {
  const token = await accessToken()
  const res = await fetch(waUrl('/api/status'), {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    cache: 'no-store',
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) throw new Error(await parseError(res))
  return (await res.json()) as BackendStatusResponse
}

/**
 * POST /api/whatsapp/login — start (or refresh) a WhatsApp login attempt.
 * Idempotent; the backend owns the QR lifecycle (60-second rotation).
 */
export async function postLogin(): Promise<{ success: boolean; state: string; message: string }> {
  const token = await accessToken()
  const res = await fetch(waUrl('/api/whatsapp/login'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  if (!res.ok) throw new Error(await parseError(res))
  return res.json()
}

/** POST /api/whatsapp/logout — destroy the WhatsApp session. */
export async function postLogout(): Promise<{ success: boolean; state: string; message: string }> {
  const token = await accessToken()
  const res = await fetch(waUrl('/api/whatsapp/logout'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  if (!res.ok) throw new Error(await parseError(res))
  return res.json()
}

/**
 * POST /api/whatsapp/cancelPairing — cancel an ACTIVE pairing.
 *
 * The pairing dialog's explicit Close/Cancel action: stops the pairing
 * runtime, discards unvalidated pairing residue, converges the backend to
 * IDLE + NONE. Idempotent when no pairing is active, and NEVER a logout —
 * a validated session (already scanned/connected) is preserved.
 */
export async function postCancelPairing(): Promise<{
  success: boolean
  state: string
  session: string
  message: string
}> {
  const token = await accessToken()
  const res = await fetch(waUrl('/api/whatsapp/cancelPairing'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  if (!res.ok) throw new Error(await parseError(res))
  return res.json()
}

/** POST /api/messages/sendInvoice — send an invoice message by reference. */
export async function postSendInvoice(params: {
  invoiceId: string
  invoiceType: 'sale' | 'purchase' | 'proforma'
  requestId?: string
}): Promise<{ success: boolean; requestId: string; messageId: string }> {
  const token = await accessToken()
  const res = await fetch(waUrl('/api/messages/sendInvoice'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      invoiceId: params.invoiceId,
      invoiceType: params.invoiceType,
      requestId: params.requestId,
    }),
  })
  if (!res.ok) throw new Error(await parseError(res))
  return res.json()
}

/**
 * POST /api/messages/autoSend — arm the DURABLE server-side auto-send for a
 * freshly created invoice. The backend re-validates the auto_send flag and
 * executes the job server-side (browser-independent, restart-safe).
 */
export async function postAutoSend(params: {
  invoiceId: string
  invoiceType: 'sale' | 'purchase' | 'proforma'
}): Promise<{ success: boolean; created: boolean; reason?: string; jobId?: string }> {
  const token = await accessToken()
  const res = await fetch(waUrl('/api/messages/autoSend'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      invoiceId: params.invoiceId,
      invoiceType: params.invoiceType,
    }),
  })
  if (!res.ok) throw new Error(await parseError(res))
  return res.json()
}

/** The outcome shape of the manual receipt/statement/reminder message endpoints. */
export interface MessageSendOutcome {
  success: boolean
  status: 'succeeded' | 'pending' | 'processing' | 'failed' | 'cancelled' | 'superseded'
  jobId: string
  error?: string
}

/**
 * POST /api/messages/sendReceipt — manually send a payment receipt by
 * reference {paymentId, direction}. Receipts are never sent automatically;
 * this is the user-initiated proof-of-payment message.
 */
export async function postSendReceipt(params: {
  paymentId: string
  direction: 'in' | 'out'
}): Promise<MessageSendOutcome> {
  const token = await accessToken()
  const res = await fetch(waUrl('/api/messages/sendReceipt'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ paymentId: params.paymentId, direction: params.direction }),
  })
  if (!res.ok) throw new Error(await parseError(res))
  return res.json()
}

/**
 * POST /api/messages/sendStatement — manually send the Payment Statement
 * for an invoice/bill by reference {invoiceId, invoiceType}. A statement
 * represents ALL payments against the invoice (including the initial
 * creation-time payment); the backend composes it from CURRENT
 * authoritative data at send time. Statements are manual-only.
 */
export async function postSendStatement(params: {
  invoiceId: string
  invoiceType: 'sale' | 'purchase'
}): Promise<MessageSendOutcome> {
  const token = await accessToken()
  const res = await fetch(waUrl('/api/messages/sendStatement'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ invoiceId: params.invoiceId, invoiceType: params.invoiceType }),
  })
  if (!res.ok) throw new Error(await parseError(res))
  return res.json()
}

/**
 * POST /api/messages/sendReminder — manually trigger a payment reminder for
 * a sale invoice NOW. Uses the same backend message implementation as the
 * scheduled reminders.
 */
export async function postSendReminder(params: { saleId: string }): Promise<MessageSendOutcome> {
  const token = await accessToken()
  const res = await fetch(waUrl('/api/messages/sendReminder'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ saleId: params.saleId }),
  })
  if (!res.ok) throw new Error(await parseError(res))
  return res.json()
}

/** The persisted reminder configuration for one sale invoice. */
export interface ReminderSettingsPayload {
  sale_id: string
  enabled: boolean
  frequency_days: number
  max_reminders: number
  reminders_sent: number
  last_reminder_at: string | null
}

/**
 * PUT /api/messages/reminder-settings/:saleId — create/update the
 * per-invoice reminder configuration. The backend reconciles the durable
 * next job.
 */
export async function putReminderSettings(params: {
  saleId: string
  enabled: boolean
  frequencyDays: number
  maxReminders: number
}): Promise<{ success: boolean; config: ReminderSettingsPayload; jobCreated: boolean; jobsCancelled: number }> {
  const token = await accessToken()
  const res = await fetch(waUrl(`/api/messages/reminder-settings/${params.saleId}`), {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      enabled: params.enabled,
      frequencyDays: params.frequencyDays,
      maxReminders: params.maxReminders,
    }),
  })
  if (!res.ok) throw new Error(await parseError(res))
  return res.json()
}

