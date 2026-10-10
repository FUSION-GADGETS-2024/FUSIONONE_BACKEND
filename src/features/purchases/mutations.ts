/**
 * Purchase mutations — transactional RPCs (atomic counter + purchase +
 * inventory + payments; payPurchase updates three tables atomically).
 */
import { supabase } from '@/platform/supabase/client'
import type { FinancialYear } from '@/features/types'

/**
 * Map a failed purchase save to the message the user sees.
 *
 * The authoritative create_purchase RPC raises its business validations
 * as PL/pgSQL RAISE EXCEPTION (Postgres code P0001) with plain-business-
 * language messages by contract (migration 0012): "IMEI on item 1 is
 * invalid: it must be exactly 15 digits", "IMEI … is already in stock in
 * the database.", "Date must be within the financial year (…)" — those
 * pass through verbatim. Anything else (network, internal database
 * errors, constraint names) collapses to the generic save failure so
 * Postgres/PostgREST jargon never reaches the user. Same mapping pattern
 * as updateOwnDisplayName in features/profile/display-name.ts.
 */
function mapPurchaseSaveError(err: { code?: string | null; message?: string | null }): string {
  const message = err.message ?? ''
  if (err.code === 'P0001' && message) return message
  if (/network|fetch|timeout|Failed to fetch/i.test(message)) {
    return 'Could not reach the server. Check your connection and try again.'
  }
  return 'Failed to save purchase.'
}

export interface CreatePurchaseItem {
  brand: string
  model: string
  imei: string
  ram_rom: string
  color: string
  purchase_price: string
  base_selling_price: string
}

export interface CreatePurchaseParams {
  partyId: string
  date: string
  items: CreatePurchaseItem[]
  total: number
  paid: number
  due: number
  bankAccountId: string
  paymentModeId: string
  financialYear: FinancialYear
}

export interface CreatePurchaseResult {
  purchaseId: string
  billNumber: string
}

export async function createPurchase(params: CreatePurchaseParams): Promise<CreatePurchaseResult> {
  const {
    partyId, date, items, total, paid, due,
    bankAccountId, paymentModeId, financialYear,
  } = params

  const { data, error } = await supabase.rpc('create_purchase', {
    payload: {
      party_id: partyId,
      date,
      total,
      paid,
      due,
      bank_account_id: bankAccountId,
      payment_mode_id: paymentModeId || null,
      financial_year_id: financialYear.id,
      items: items.map((item) => ({
        brand: item.brand.trim(),
        model: item.model.trim(),
        imei: item.imei.trim(),
        ram_rom: item.ram_rom.trim(),
        color: item.color.trim(),
        purchase_price: Number(item.purchase_price),
        base_selling_price: Number(item.base_selling_price),
      })),
    },
  })
  if (error) throw new Error(mapPurchaseSaveError(error))
  return { purchaseId: data.purchase_id, billNumber: data.bill_number }
}

export interface PayPurchaseParams {
  purchaseId: string
  amount: number
  date: string
  bankAccountId: string
  paymentModeId: string | null
}

export async function payPurchase(params: PayPurchaseParams): Promise<void> {
  const { purchaseId, amount, date, bankAccountId, paymentModeId } = params
  const { error } = await supabase.rpc('pay_purchase', {
    p_purchase_id: purchaseId,
    p_amount: amount,
    p_date: date,
    p_bank_account_id: bankAccountId,
    p_payment_mode_id: paymentModeId || null,
  })
  if (error) throw error
}
