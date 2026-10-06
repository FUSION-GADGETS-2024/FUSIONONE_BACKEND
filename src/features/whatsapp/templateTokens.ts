/**
 * WhatsApp message-template tokens — the shared vocabulary for the
 * Settings → WhatsApp message-template editor and preview.
 *
 * The STORED format is raw template syntax (`{{customer_name}}`). The backend
 * renderer (backend/src/messages/templates.ts) is the single authority for
 * which placeholders exist and how they are replaced in REAL WhatsApp sends.
 * This module mirrors that contract for the frontend editing UI — it never
 * changes what is stored or how real messages render:
 *
 *   - WHATSAPP_TEMPLATE_VARIABLES — every variable the backend supports, in
 *     display order, with the human-readable label used in the editor UI.
 *   - TOKENS_BY_TEMPLATE — the token subset each template card offers
 *     (invoice templates, receipt templates, the reminder template).
 *   - TEMPLATE_TOKEN_PATTERN — the SAME placeholder regex as the backend
 *     (`{{variable_name}}`, lowercase snake_case, optional inner whitespace,
 *     unknown placeholders render as '').
 *   - templateToPreview — renders a stored template against representative
 *     sample data using the backend's replacement semantics. Settings
 *     preview only; real sends are resolved by the backend.
 */
import type { SendableInvoiceType } from '@/features/messages/settings'

/** The placeholder pattern — identical to the backend renderer. */
export const TEMPLATE_TOKEN_PATTERN = /\{\{\s*([a-z_]+)\s*\}\}/g

export interface TemplateVariableInfo {
  /** Placeholder name as stored (`customer_name`). */
  name: string
  /** Human-readable label shown in the editing UI. */
  label: string
}

/** Every variable the backend renderer supports — display order matters. */
export const WHATSAPP_TEMPLATE_VARIABLES: readonly TemplateVariableInfo[] = [
  { name: 'customer_name', label: 'Customer name' },
  { name: 'invoice_number', label: 'Invoice number' },
  { name: 'invoice_date', label: 'Invoice date' },
  { name: 'company_name', label: 'Company name' },
  { name: 'grand_total', label: 'Grand total' },
  { name: 'due_date', label: 'Due date' },
  { name: 'payment_status', label: 'Payment status' },
  { name: 'company_phone', label: 'Company phone' },
  { name: 'company_address', label: 'Company address' },
  { name: 'payment_amount', label: 'Payment amount' },
  { name: 'payment_date', label: 'Payment date' },
  { name: 'balance_due', label: 'Balance due' },
  { name: 'total_paid', label: 'Total paid' },
  { name: 'payment_count', label: 'Number of payments' },
]

const LABELS: ReadonlyMap<string, string> = new Map(
  WHATSAPP_TEMPLATE_VARIABLES.map((variable) => [variable.name, variable.label]),
)

/**
 * Human-readable label for a token name. Unknown token names (stale data the
 * backend no longer substitutes) keep their raw name so they still round-trip
 * through the editor unchanged.
 */
export function tokenLabel(name: string): string {
  return LABELS.get(name) ?? name
}

/** Every template card in Settings → WhatsApp templates. */
export type TemplateCardType =
  | SendableInvoiceType
  | 'payment_in'
  | 'payment_out'
  | 'statement_in'
  | 'statement_out'
  | 'reminder'

/** The token subset each template card offers in its editor. */
export const TOKENS_BY_TEMPLATE: Readonly<Record<TemplateCardType, readonly string[]>> = {
  sale: ['customer_name', 'invoice_number', 'invoice_date', 'company_name', 'grand_total', 'due_date', 'payment_status', 'company_phone', 'company_address'],
  purchase: ['customer_name', 'invoice_number', 'invoice_date', 'company_name', 'grand_total', 'due_date', 'payment_status', 'company_phone', 'company_address'],
  proforma: ['customer_name', 'invoice_number', 'invoice_date', 'company_name', 'grand_total', 'due_date', 'payment_status', 'company_phone', 'company_address'],
  payment_in: ['customer_name', 'payment_amount', 'payment_date', 'invoice_number', 'balance_due', 'company_name', 'company_phone', 'company_address'],
  payment_out: ['customer_name', 'payment_amount', 'payment_date', 'invoice_number', 'balance_due', 'company_name', 'company_phone', 'company_address'],
  statement_in: ['customer_name', 'invoice_number', 'invoice_date', 'grand_total', 'total_paid', 'balance_due', 'payment_count', 'company_name', 'company_phone', 'company_address'],
  statement_out: ['customer_name', 'invoice_number', 'invoice_date', 'grand_total', 'total_paid', 'balance_due', 'payment_count', 'company_name', 'company_phone', 'company_address'],
  reminder: ['customer_name', 'invoice_number', 'invoice_date', 'grand_total', 'balance_due', 'payment_status', 'company_name', 'company_phone', 'company_address'],
}

/**
 * Styling for an inline token chip, shared by every place a token is rendered
 * inside the editor (imperatively-created DOM, hence the class string instead
 * of JSX). Subtle and professional — matches the app's indigo accent pills.
 */
export const TOKEN_CHIP_CLASS =
  'inline-flex select-all items-center whitespace-nowrap rounded bg-indigo-50 px-1.5 py-px mx-px text-[11px] font-medium leading-relaxed text-indigo-700'

// ─── Settings preview (representative sample data) ──────────────────────────
//
// The view-mode preview renders the template with plausible values so the
// owner sees the customer-facing message shape. Values mirror how the backend
// formats them (amounts: en-IN with two decimals; payment_status: the
// backend's own per-type derivation).

const SAMPLE_BASE: Readonly<Record<string, string>> = {
  customer_name: 'Rahul',
  invoice_date: '15 Jan 2025',
  company_name: 'FUSION GADGETS',
  grand_total: '12,499.00',
  due_date: '30 Jan 2025',
  company_phone: '+91 98765 43210',
  company_address: 'Shop 12, MG Road, Bengaluru',
  payment_amount: '5,000.00',
  payment_date: '20 Jan 2025',
  balance_due: '7,499.00',
  total_paid: '5,000.00',
  payment_count: '2',
}

const SAMPLE_BY_TYPE: Readonly<Record<TemplateCardType, Record<string, string>>> = {
  sale: { invoice_number: 'INV-1042', payment_status: 'Balance due' },
  purchase: { invoice_number: 'BILL-2087', payment_status: 'Balance due' },
  proforma: { invoice_number: 'QTN-0315', payment_status: 'Quotation' },
  payment_in: { invoice_number: 'INV-1042' },
  payment_out: { invoice_number: 'BILL-2087' },
  statement_in: { invoice_number: 'INV-1042' },
  statement_out: { invoice_number: 'BILL-2087' },
  reminder: { invoice_number: 'INV-1042', payment_status: 'Balance due' },
}

/**
 * Render a stored template against representative sample data for the given
 * template card type — the same replacement semantics as the backend (unknown
 * placeholders become ''). Settings preview only.
 */
export function templateToPreview(template: string, type: TemplateCardType): string {
  const values = { ...SAMPLE_BASE, ...SAMPLE_BY_TYPE[type] }
  return template.replace(TEMPLATE_TOKEN_PATTERN, (_, name: string) => values[name] ?? '')
}
