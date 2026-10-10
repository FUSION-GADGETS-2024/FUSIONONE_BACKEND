/**
 * The Notice model — FUSION ONE's operational attention system.
 *
 * A Notice means "this requires the user's attention" (spec §22). It is NOT
 * customer messaging: messages to customers/suppliers are the durable
 * message system (`message_jobs` + the Messages page). Notices are derived
 * from CURRENT BUSINESS STATE and carry no persistence of their own —
 * state-based conditions resolve the moment their underlying condition
 * disappears (paid invoice → overdue notice gone; reconnected WhatsApp →
 * connection notice gone). This keeps the system lightweight by design:
 * no notification database, no duplicate logical notices, deterministic
 * identity on every load (spec §§24–25).
 */

/** How urgently the condition deserves attention. */
export type NoticeSeverity = 'critical' | 'warning' | 'info'

/** The business area a notice belongs to. */
export type NoticeCategory = 'financial' | 'inventory' | 'whatsapp' | 'workflow' | 'financial-year'

/** Where a notice sends the user to act on it. */
export interface NoticeAction {
  label: string
  /** Router destination (e.g. '/sales/<id>'). */
  to: string
}

export interface Notice {
  /**
   * Deterministic identity: `"<type>:<entityId-or-scope>"`. Stable across
   * reloads and page navigation — the SAME condition always yields the
   * SAME id, so repeated loads never create duplicates (deduplication is
   * a Map keyed by id inside the builder).
   */
  id: string
  type: NoticeType
  category: NoticeCategory
  severity: NoticeSeverity
  /** Short headline. */
  title: string
  /** One or two sentences of business context. */
  message: string
  /** The money amount at stake, when applicable. */
  amount?: number
  /** The business date the condition stems from, when applicable. */
  date?: string
  action?: NoticeAction
}

export type NoticeType =
  | 'overdue-receivable'
  | 'overdue-payable'
  | 'receivables-outstanding'
  | 'payables-outstanding'
  | 'old-inventory'
  | 'aging-trade-in-stock'
  | 'zero-stock'
  | 'fy-ended'
  | 'old-proforma'
  | 'whatsapp-not-connected'
  | 'message-job-failed'

/** Detector thresholds — the shared business rules (single definition). */
export const NOTICE_THRESHOLDS = {
  /** A receivable becomes overdue this many days after the sale date. */
  overdueDays: 30,
  /** Overdue escalates to critical at this age. */
  criticalOverdueDays: 90,
  /** Regular stock becomes "old inventory" at this age. */
  oldInventoryDays: 90,
  /** Trade-in-sourced stock ages as a problem sooner. */
  tradeInAgingDays: 60,
  /** An unconverted (draft) proforma becomes stale at this age. */
  oldProformaDays: 30,
} as const

/** Display order: most urgent first, then by business area. */
export const SEVERITY_ORDER: Record<NoticeSeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
}

export const CATEGORY_ORDER: Record<NoticeCategory, number> = {
  financial: 0,
  inventory: 1,
  whatsapp: 2,
  workflow: 3,
  'financial-year': 4,
}
