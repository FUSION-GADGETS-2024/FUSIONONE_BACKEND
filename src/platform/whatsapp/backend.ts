/**
 * Backend-facing wire types (internal to the transport layer).
 * Extracted verbatim from the old server-side client contract.
 */

/** The backend's WhatsApp RUNTIME state model (9 states). */
export type BackendState =
  | 'STARTING'
  | 'IDLE'
  | 'PAIRING'
  | 'CONNECTING'
  | 'CONNECTED'
  | 'RECONNECTING'
  | 'LOGGING_OUT'
  | 'SECURITY_INVALIDATED'
  | 'STOPPING'

/** The backend's SESSION dimension (separate axis from the runtime state). */
export type BackendSessionState = 'NONE' | 'PRESENT' | 'RESTORING'

/** GET /api/status response shape. */
export interface BackendStatusResponse {
  server: { state: string; timestamp: string }
  whatsapp: {
    state: BackendState
    session: BackendSessionState
    connected: boolean
    jid: string | null
    qrAvailable: boolean
    qr: string | null
    /** Seconds remaining on the current pairing QR (null when no QR). */
    qrExpiresInSeconds: number | null
    /** ISO timestamp when the current pairing QR expires (null when no QR). */
    qrExpiresAt: string | null
  }
}

/** Backend SSE event envelope shape (unnamed events: data: {type,...}). */
export interface BackendEventEnvelope {
  type: string
  timestamp: string
  data: Record<string, unknown>
}

/** A settled durable message job (auto-send / reminder / receipt /
 *  statement). `trigger` separates scheduler-picked executions
 *  ('automatic' — fire-and-forget; the SSE event is the user-feedback
 *  channel) from user-awaiting manual inline executions ('manual' — the
 *  HTTP responses carry the UI feedback). */
export interface MessageJobResultEvent {
  jobId: string
  jobType: 'invoice_send' | 'reminder' | 'receipt' | 'statement'
  refType: 'sale' | 'purchase' | 'proforma' | 'payment_in' | 'payment_out'
  refId: string
  trigger?: 'automatic' | 'manual'
  result: 'succeeded' | 'failed' | 'cancelled' | 'retrying'
  errorCode?: string
}

/**
 * Map a backend SSE event envelope into the application's business event
 * type:
 *   WHATSAPP_STATE_CHANGED → state-changed
 *   WHATSAPP_QR_AVAILABLE  → qr-available
 *   WHATSAPP_QR_COUNTDOWN  → qr-countdown
 *   MESSAGE_SEND_RESULT    → send-result
 *   MESSAGE_JOB_RESULT     → job-result
 *   SECURITY_EVENT         → security-event
 * SERVER_STATE_CHANGED is NOT forwarded (backend server lifecycle, not the
 * WhatsApp connection — forwarding it caused a spurious disconnect flash).
 */
export type MappedBackendEvent = {
  type: 'state-changed' | 'qr-available' | 'qr-countdown' | 'send-result' | 'job-result' | 'security-event'
  timestamp: string
  data: Record<string, unknown>
}

export function mapBackendEvent(envelope: BackendEventEnvelope): MappedBackendEvent | null {
  const { type, timestamp, data } = envelope
  switch (type) {
    case 'WHATSAPP_STATE_CHANGED':
      return { type: 'state-changed', timestamp, data }
    case 'WHATSAPP_QR_AVAILABLE':
      return { type: 'qr-available', timestamp, data }
    case 'WHATSAPP_QR_COUNTDOWN':
      return { type: 'qr-countdown', timestamp, data }
    case 'MESSAGE_SEND_RESULT':
      return { type: 'send-result', timestamp, data }
    case 'MESSAGE_JOB_RESULT':
      return { type: 'job-result', timestamp, data }
    case 'SECURITY_EVENT':
      return { type: 'security-event', timestamp, data }
    default:
      return null
  }
}
