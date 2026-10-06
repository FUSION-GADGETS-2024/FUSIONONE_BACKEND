/**
 * Purchase mutations — transactional RPCs (atomic counter + purchase +
 * inventory + payments; payPurchase updates three tables atomically).
 */
import { supabase } from '@/platform/supabase/client'
import type { FinancialYear } from '@/features/types'

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
  if (error) throw error
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
