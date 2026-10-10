/**
 * Sales mutations — transactional RPCs (atomic multi-table writes).
 *
 * All monetary totals (total / trade-in credit / final total / due) are
 * computed SERVER-SIDE inside create_sale / update_sale; the client sends
 * only the commercial facts (items with prices, trade-in devices,
 * discount, payment) and displays its own live math for UX.
 */
import { supabase } from '@/platform/supabase/client'
import type { FinancialYear } from '@/features/types'

// ── Create sale (normal mode) ───────────────────────────────────────────────

export interface CreateSaleItem {
  id: string
  sold_price: string
}

export interface CreateTradeIn {
  id: string
  brand: string
  model: string
  imei: string
  ram_rom: string
  color: string
  credit_value: string
  mrp: string
}

export interface CreateSaleParams {
  partyId: string
  date: string
  selectedItems: CreateSaleItem[]
  tradeIns: CreateTradeIn[]
  discount: number
  paid: number
  bankAccountId: string
  paymentModeId: string
  financialYear: FinancialYear
}

export interface CreateSaleResult {
  saleId: string
  billNumber: string
}

/** Build the trade-in RPC payload — device/transaction facts only.
 *  Documents are NOT part of trade-ins; they belong exclusively to
 *  parties (see features/party-documents). */
function buildTradeInPayload(tradeIns: CreateTradeIn[]) {
  return tradeIns.map((ti) => ({
    brand: ti.brand,
    model: ti.model,
    imei: ti.imei,
    ram_rom: ti.ram_rom,
    color: ti.color,
    credit_value: Number(ti.credit_value),
    mrp: ti.mrp === '' ? null : Number(ti.mrp),
  }))
}

export async function createSale(params: CreateSaleParams): Promise<CreateSaleResult> {
  const {
    partyId,
    date,
    selectedItems,
    tradeIns,
    discount,
    paid,
    bankAccountId,
    paymentModeId,
    financialYear,
  } = params

  const { data, error } = await supabase.rpc('create_sale', {
    payload: {
      party_id: partyId,
      date,
      discount,
      paid,
      bank_account_id: bankAccountId,
      payment_mode_id: paymentModeId || null,
      financial_year_id: financialYear.id,
      items: selectedItems.map((item) => ({
        inventory_item_id: item.id,
        sold_price: Number(item.sold_price),
      })),
      trade_ins: buildTradeInPayload(tradeIns),
    },
  })
  if (error) throw error
  return { saleId: data.sale_id, billNumber: data.bill_number }
}

// ── Convert a proforma into a sale (the ONE canonical path, proforma mode) ──
//
// The commercial content (party, quoted items, quoted prices, discount)
// comes from the DATABASE — the client supplies only the conversion-time
// decisions: the fulfillment mapping for legacy free-text lines, the
// ACTUAL trade-in devices received, and the payment. Everything happens
// in one atomic RPC (lock → validate → create sale → link → convert).

export interface ConvertProformaFulfillment {
  proformaItemId: string
  inventoryItemId: string | null
}

export interface ConvertProformaParams {
  proformaId: string
  date: string
  items: ConvertProformaFulfillment[]
  tradeIns: CreateTradeIn[]
  paid: number
  bankAccountId: string
  paymentModeId: string | null
}

export async function convertProforma(params: ConvertProformaParams): Promise<CreateSaleResult> {
  const { proformaId, date, items, tradeIns, paid, bankAccountId, paymentModeId } = params
  const { data, error } = await supabase.rpc('create_sale', {
    payload: {
      proforma_id: proformaId,
      date,
      items: items.map((f) => ({
        proforma_item_id: f.proformaItemId,
        inventory_item_id: f.inventoryItemId,
      })),
      trade_ins: buildTradeInPayload(tradeIns),
      paid,
      bank_account_id: bankAccountId,
      payment_mode_id: paymentModeId,
    },
  })
  if (error) throw error
  return { saleId: data.sale_id, billNumber: data.bill_number }
}

// ── Receive payment ─────────────────────────────────────────────────────────

export interface ReceivePaymentParams {
  saleId: string
  amount: number
  date: string
  bankAccountId: string
  paymentModeId: string | null
}

export async function receivePayment(params: ReceivePaymentParams): Promise<void> {
  const { saleId, amount, date, bankAccountId, paymentModeId } = params
  const { error } = await supabase.rpc('receive_payment', {
    p_sale_id: saleId,
    p_amount: amount,
    p_date: date,
    p_bank_account_id: bankAccountId,
    p_payment_mode_id: paymentModeId || null,
  })
  if (error) throw error
}

// ── Cancel sale ─────────────────────────────────────────────────────────────

/** A resold trade-in reported by cancel_sale — device identity is read
 *  through Inventory by the RPC (single source of truth). */
export interface ResoldTradeIn {
  id: string
  sale_id: string
  inventory_item_id: string
  brand: string
  model: string
  imei: string
  ram_rom: string | null
  color: string | null
  credit_value: number
  mrp: number | null
  purchase_id: string | null
  status: string
}

export interface CancelSaleResult {
  resold: ResoldTradeIn[]
}

export async function cancelSale(saleId: string): Promise<CancelSaleResult> {
  const { data, error } = await supabase.rpc('cancel_sale', { p_sale_id: saleId })
  if (error) throw error
  return { resold: (data?.resold ?? []) as ResoldTradeIn[] }
}

// ── Delete sale ─────────────────────────────────────────────────────────────

export async function deleteSale(saleId: string): Promise<void> {
  const { error } = await supabase.rpc('delete_sale', { p_sale_id: saleId })
  if (error) throw error
}

// ── Create purchase bill for a resold trade-in (recovery) ───────────────────

export async function createTradeInPurchaseBill(
  saleId: string,
  tradeInId: string,
): Promise<string> {
  const { data, error } = await supabase.rpc('create_trade_in_purchase_bill', {
    p_sale_id: saleId,
    p_trade_in_id: tradeInId,
  })
  if (error) throw error
  return data as string
}

// ── Update sale (canonical atomic edit — prices, date, discount) ────────────

export interface UpdateSaleParams {
  saleId: string
  date: string
  discount: number
  items: Array<{ sale_item_id: string; sold_price: number }>
}

export async function updateSale(params: UpdateSaleParams): Promise<void> {
  const { saleId, date, discount, items } = params
  const { error } = await supabase.rpc('update_sale', {
    payload: {
      sale_id: saleId,
      date,
      discount,
      items: items.map((i) => ({ sale_item_id: i.sale_item_id, sold_price: i.sold_price })),
    },
  })
  if (error) throw error
}
