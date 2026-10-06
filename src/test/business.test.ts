/**
 * Business-logic tests (spec §37 BUSINESS/INVOICE coverage):
 *   - invoice builders (sale/purchase/proforma derivations)
 *   - view-model formatting (en-IN currency, Indian amount-in-words)
 *   - inventory validation, balance fold, FY date clamp
 */
import { describe, it, expect } from 'vitest'
import { buildSaleInvoiceData, buildPurchaseInvoiceData, buildProformaInvoiceData } from '@/features/invoice/builders'
import { buildInvoiceViewModel, amountInWords, formatCurrency } from '@/features/invoice/view-model'
import { validateInventoryForm, isInventoryFormValid } from '@/features/inventory/api'
import { computeBalances, clampToFinancialYear } from '@/features/accounts/api'

describe('buildSaleInvoiceData — sale derivations (reference semantics)', () => {
  const store = { name: 'FUSION GADGETS' }
  const sale = { bill_number: 'SAL-2026-27-0007', date: '2026-04-11', discount: 500, trade_in_credit: 2000, final_total: 50000, paid: 40000, due: 10000, parties: { name: 'Rahul Sharma' } }
  const items = [
    { sold_price: 38000, inventory_items: { brand: 'Samsung', model: 'A54', imei: '123', ram_rom: '8/128', color: 'Blue', base_selling_price: 40000 } },
    { sold_price: 15500, inventory_items: { brand: 'Vivo', model: 'Y56', imei: '456', ram_rom: '6/128', color: 'Red', base_selling_price: 15500 } },
  ]
  // Trade-in rows carry the transactional facts; the device identity is
  // resolved through the embedded Inventory relationship (single source
  // of truth).
  const tradeIns = [
    { credit_value: 2000, mrp: 12000, inventory_items: { brand: 'Redmi', model: 'Note 11', imei: '789', ram_rom: '6/64', color: 'Blue' } },
  ]

  const data = buildSaleInvoiceData({ sale, items, tradeIns, store })

  it('derives per-item discount as base price minus sold price', () => {
    expect(data.items[0].discount).toBe(2000)
    expect(data.items[1].discount).toBe(0)
  })

  it('computes item_discount as the sum of per-item discounts', () => {
    expect(data.item_discount).toBe(2000)
  })

  it('subtotal is the sum of BASE prices (not sold prices)', () => {
    expect(data.subtotal).toBe(55500)
  })

  it('discount is item + additional discount', () => {
    expect(data.discount).toBe(2500)
  })

  it('maps trade-ins with qty 1 and credit as rate', () => {
    expect(data.trade_ins?.[0]).toMatchObject({ brand: 'Redmi', qty: 1, rate: 2000, credit_value: 2000, mrp: 12000 })
  })
})

describe('buildPurchaseInvoiceData', () => {
  it('uses inventory purchase_price as rate and value', () => {
    const data = buildPurchaseInvoiceData({
      purchase: { bill_number: 'PUR-2026-27-0005', date: '2026-04-05', total: 30000, paid: 30000, due: 0, parties: { name: 'MobileHub' } },
      items: [{ inventory_items: { brand: 'Vivo', model: 'V27', imei: '1', purchase_price: 30000 } }],
      store: null,
    })
    expect(data.items[0]).toMatchObject({ rate: 30000, value: 30000 })
    expect(data.final_total).toBe(30000)
  })
})

describe('buildProformaInvoiceData', () => {
  it('maps legacy free-text items and proposed trade-ins verbatim', () => {
    const data = buildProformaInvoiceData({
      proforma: { bill_number: 'PI-2026-27-0004', date: '2026-06-20', total: 70000, discount: 1500, trade_in_credit: 10000, final_total: 58500, parties: { name: 'Rahul' } },
      items: [{ description: 'iPhone 14', qty: 1, rate: 70000, discount: 0, value: 70000, inventory_item_id: null, inventory_items: null }],
      tradeIns: [{ description: 'Old phone', qty: 1, rate: 10000, value: 10000 }],
      store: null,
    })
    expect(data.items[0].description).toBe('iPhone 14')
    expect(data.trade_ins?.[0].value).toBe(10000)
    expect(data.due).toBe(58500) // proformas report the full total as due
  })

  it('maps inventory-backed quoted lines with the device identity from Inventory', () => {
    const data = buildProformaInvoiceData({
      proforma: { bill_number: 'PI-2026-27-0005', date: '2026-06-21', total: 25000, discount: 0, trade_in_credit: 0, final_total: 25000, parties: { name: 'Rahul' } },
      items: [{
        description: null, qty: 1, rate: 25000, discount: 0, value: 25000,
        inventory_item_id: 'inv-1',
        inventory_items: { brand: 'Apple', model: 'iPhone 15', imei: '111', ram_rom: '8/256', color: 'Black' },
      }],
      tradeIns: [],
      store: null,
    })
    expect(data.items[0]).toMatchObject({ brand: 'Apple', model: 'iPhone 15', imei: '111', rate: 25000, value: 25000 })
    expect(data.items[0].description).toBeUndefined()
  })
})

describe('view-model formatting (product language)', () => {
  it('formats currency in en-IN with Rs. suffix', () => {
    expect(formatCurrency(69998)).toBe('69,998.00 Rs.')
    expect(formatCurrency(0)).toBe('0.00 Rs.')
  })

  it('renders Indian amount-in-words (Lakh/Crore system)', () => {
    expect(amountInWords(0)).toBe('Zero Rupees Only')
    expect(amountInWords(5)).toBe('Five Rupees Only')
    expect(amountInWords(101)).toBe('One Hundred One Rupees Only')
    expect(amountInWords(100000)).toBe('One Lakh Rupees Only')
    expect(amountInWords(10000000)).toBe('One Crore Rupees Only')
    expect(amountInWords(12345678)).toBe('One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight Rupees Only')
  })

  it('builds the invoice view model with formatted cells', () => {
    const vm = buildInvoiceViewModel({
      type: 'sale', store: null, bill_number: 'SAL-1', date: '2026-04-11', party: { name: 'X' },
      items: [{ brand: 'B', model: 'M', imei: '1', qty: 1, rate: 100, discount: 10, value: 90 }],
      subtotal: 100, item_discount: 10, additional_discount: 0, discount: 10, final_total: 90, paid: 90, due: 0,
    })
    expect(vm.title).toBe('TAX INVOICE')
    expect(vm.items[0].discountText).toBe('− 10.00 Rs.') // formatted discount with the minus sign
    expect(vm.amountWords).toBe('Ninety Rupees Only')
  })
})

describe('inventory validation (per-field error map)', () => {
  const base = { brand: 'B', model: 'M', imei: '123456789012345', ram_rom: '8/128', color: 'Black', purchase_price: '100', base_selling_price: '120' }
  it('accepts a valid form', () => expect(isInventoryFormValid(validateInventoryForm(base))).toBe(true))
  it('rejects IMEI shorter than 15 digits', () => expect(validateInventoryForm({ ...base, imei: '123' }).imei).toBe('IMEI must be 15 digits.'))
  it('rejects non-numeric IMEI', () => expect(validateInventoryForm({ ...base, imei: 'abcdefghijklmno' }).imei).toBe('IMEI must be 15 digits.'))
  it('rejects negative purchase price', () => expect(validateInventoryForm({ ...base, purchase_price: '-5' }).purchase_price).toBe('Enter a valid purchase price.'))
  it('rejects missing brand', () => expect(validateInventoryForm({ ...base, brand: ' ' }).brand).toBe('Brand is required.'))
  it('reports every field error at once (not first-only)', () => {
    const errors = validateInventoryForm({ ...base, imei: '123', ram_rom: '12 GB', color: '' })
    expect(errors.imei).toBe('IMEI must be 15 digits.')
    expect(errors.ram_rom).toBe('Enter RAM and storage like 12/256.')
    expect(errors.color).toBe('Color is required.')
  })
})

describe('account balance fold (single implementation)', () => {
  it('credits add, debits subtract, zero-initialised per account', () => {
    const balances = computeBalances(
      [
        { id: 'cash', name: 'Cash', is_cash: true },
        { id: 'bank', name: 'Bank', is_cash: false },
      ],
      [
        { bank_account_id: 'cash', type: 'credit', amount: 500 },
        { bank_account_id: 'cash', type: 'debit', amount: 200 },
        { bank_account_id: 'bank', type: 'credit', amount: 1000 },
      ],
    )
    expect(balances).toEqual({ cash: 300, bank: 1000 })
  })
})

describe('FY date clamp (forms)', () => {
  it('clamps today into the FY range', () => {
    const fy = { start_date: '2026-04-01', end_date: '2027-03-31' }
    const today = new Date().toISOString().split('T')[0]
    const clamped = clampToFinancialYear(fy)
    expect(clamped >= fy.start_date).toBe(true)
    expect(clamped <= fy.end_date).toBe(true)
    if (today >= fy.start_date && today <= fy.end_date) expect(clamped).toBe(today)
  })
})
