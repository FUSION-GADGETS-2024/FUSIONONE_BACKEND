/**
 * Proforma mutations — the create/update/void flows run as transactional
 * RPCs (counter + invoice + items + proposed trade-ins; update replaces
 * lines wholesale; void is status-only). Totals are computed server-side.
 */
import { supabase } from '@/platform/supabase/client'
import type { FinancialYear } from '@/features/types'

/** A quoted line: a real in-stock Inventory Item + the quoted price
 *  (the snapshot the proforma preserves). */
export interface ProformaQuoteItem {
  inventory_item_id: string
  rate: number
}

/** A PROPOSED trade-in: a free-text commercial proposal. No inventory
 *  identity exists until the device is actually received at conversion. */
export interface ProformaProposedTradeIn {
  description: string
  qty: number | null
  rate: number
}

export interface CreateProformaParams {
  partyId: string
  date: string
  discount: number
  financialYear: FinancialYear
  items: ProformaQuoteItem[]
  tradeIns: ProformaProposedTradeIn[]
}

export interface CreateProformaResult {
  proformaId: string
  billNumber: string
}

export async function createProforma(params: CreateProformaParams): Promise<CreateProformaResult> {
  const { partyId, date, discount, financialYear, items, tradeIns } = params
  const { data, error } = await supabase.rpc('create_proforma', {
    payload: {
      party_id: partyId,
      date,
      discount,
      financial_year_id: financialYear.id,
      items,
      trade_ins: tradeIns,
    },
  })
  if (error) throw error
  return { proformaId: data.proforma_id, billNumber: data.bill_number }
}

// ── Edit an ACTIVE quotation (same invariants as create; the bill number
//    and the FY counter are preserved — a revision, not a new document) ─────

export interface UpdateProformaParams {
  proformaId: string
  partyId: string
  date: string
  discount: number
  items: ProformaQuoteItem[]
  tradeIns: ProformaProposedTradeIn[]
}

export async function updateProforma(params: UpdateProformaParams): Promise<void> {
  const { proformaId, partyId, date, discount, items, tradeIns } = params
  const { error } = await supabase.rpc('update_proforma', {
    payload: {
      proforma_id: proformaId,
      party_id: partyId,
      date,
      discount,
      items,
      trade_ins: tradeIns,
    },
  })
  if (error) throw error
}

// ── Void an ACTIVE quotation (no inventory / payment / accounting effects) ──

export async function voidProforma(proformaId: string): Promise<void> {
  const { error } = await supabase.rpc('void_proforma', { p_proforma_id: proformaId })
  if (error) throw error
}
