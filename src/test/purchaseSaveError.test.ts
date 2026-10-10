/**
 * Purchase save error translation — the mutation-layer mapping that keeps
 * KNOWN business validation specific and everything else generic.
 *
 * create_purchase raises its validations as PL/pgSQL RAISE EXCEPTION
 * (Postgres code P0001) with plain-business-language messages. The mapping
 * (features/purchases/mutations.ts, same pattern as display-name.ts):
 *
 *   P0001 business validation  → its message, verbatim (user-facing)
 *   network-ish failure        → a clean reachability message
 *   anything else (internal DB
 *   error, constraint jargon)  → 'Failed to save purchase.'
 *
 * This pins the historical finding where the page's
 * `err instanceof Error ? err.message : 'Failed to save purchase.'` guard
 * collapsed the RPC's plain-object error (supabase-js returns HTTP errors
 * as plain objects, NOT Error instances) into the generic message even for
 * clean business rejections like a duplicate IMEI.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const rpcMock = vi.hoisted(() => vi.fn())

vi.mock('@/platform/supabase/client', () => ({
  supabase: { rpc: rpcMock },
}))

import { createPurchase } from '@/features/purchases/mutations'

const PARAMS = {
  partyId: 'party-1',
  date: '2027-04-05',
  items: [
    { brand: 'Apple', model: 'iPhone 15', imei: '123456789012345', ram_rom: '8/128', color: 'Blue', purchase_price: '50000', base_selling_price: '55000' },
  ],
  total: 50000,
  paid: 1000,
  due: 49000,
  bankAccountId: 'bank-1',
  paymentModeId: 'mode-1',
  financialYear: { id: 'fy-1', start_date: '2027-04-01', end_date: '2028-03-31', status: 'active' },
} as Parameters<typeof createPurchase>[0]

beforeEach(() => {
  rpcMock.mockReset()
})

describe('createPurchase — error translation', () => {
  it('passes a P0001 business validation message through verbatim', async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: {
        message: 'IMEI 123456789012345 is already in stock in the database.',
        details: null,
        hint: null,
        code: 'P0001',
      },
    })

    await expect(createPurchase(PARAMS)).rejects.toThrow(
      'IMEI 123456789012345 is already in stock in the database.',
    )
  })

  it('passes every RPC business validation through (RAM/ROM, date, paid>total)', async () => {
    const cases = [
      'RAM/ROM is required on item 1',
      'Date must be within the financial year (2027-04-01 to 2028-03-31)',
      'Paid amount cannot exceed the purchase total',
      'IMEI on item 1 is invalid: it must be exactly 15 digits',
    ]
    for (const message of cases) {
      rpcMock.mockResolvedValue({ data: null, error: { message, code: 'P0001' } })
      await expect(createPurchase(PARAMS)).rejects.toThrow(message)
    }
  })

  it('collapses an internal database error (constraint jargon) to the generic save failure', async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: {
        message: 'duplicate key value violates unique constraint "idx_unique_imei_in_stock"',
        details: 'Key (imei)=(123456789012345) already exists.',
        hint: null,
        code: '23505',
      },
    })

    await expect(createPurchase(PARAMS)).rejects.toThrow('Failed to save purchase.')
  })

  it('maps a network-style failure to the reachability message', async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { message: 'Failed to fetch', details: null, hint: null, code: null },
    })

    await expect(createPurchase(PARAMS)).rejects.toThrow(
      'Could not reach the server. Check your connection and try again.',
    )
  })

  it('succeeds untouched when the RPC succeeds', async () => {
    rpcMock.mockResolvedValue({
      data: { purchase_id: 'purp-1', bill_number: 'PUR-2027-28-0001' },
      error: null,
    })

    await expect(createPurchase(PARAMS)).resolves.toEqual({
      purchaseId: 'purp-1',
      billNumber: 'PUR-2027-28-0001',
    })
    expect(rpcMock).toHaveBeenCalledWith('create_purchase', expect.objectContaining({
      payload: expect.objectContaining({ party_id: 'party-1' }),
    }))
  })
})
