/**
 * The notice system — derived state, deterministic identity, deduplication
 * and lifecycle (spec §§22–28, §40).
 *
 * Every end-to-end notice scenario from the specification is pinned here
 * at the detector level: an invoice becoming overdue (notice appears), the
 * invoice being paid (notice clears), inventory crossing the ageing
 * threshold (one logical notice per item), repeated builds (no duplicate
 * logical notices), WhatsApp disconnect/reconnect, failed deliveries, old
 * proformas and financial-year state.
 */
import { describe, it, expect } from 'vitest'
import { buildNotices } from '@/features/notices/detectors'
import { NOTICE_THRESHOLDS } from '@/features/notices/types'
import type { NoticesData, NoticeSaleRow, NoticeStockRow } from '@/features/notices/data'
import type { NoticeDetectorInput } from '@/features/notices/detectors'

const TODAY = '2026-12-06'

function noticeSale(partial: Partial<NoticeSaleRow>): NoticeSaleRow {
  return {
    id: 's1',
    bill_number: 'SAL-2026-27-0001',
    date: '2026-10-07',
    due: 5000,
    status: 'active',
    party_id: 'p1',
    party_name: 'Aditya Singh',
    ...partial,
  }
}

function noticeStock(partial: Partial<NoticeStockRow>): NoticeStockRow {
  return {
    id: 'i1',
    brand: 'Samsung',
    model: 'Galaxy S22',
    imei: '111',
    source: 'purchase',
    status: 'in_stock',
    created_at: '2026-10-07T00:00:00Z',
    origin_inventory_item_id: null,
    purchase_price: 20000,
    ...partial,
  }
}

function baseInput(overrides: Partial<NoticeDetectorInput> = {}): NoticeDetectorInput {
  const data: NoticesData = {
    sales: [],
    purchases: [],
    stock: [noticeStock({})],
    proformas: [],
    failedJobs: [],
  }
  return {
    data,
    timeline: new Map(),
    financialYears: [{ id: 'fy1', start_date: '2026-04-01', end_date: '2027-03-31', status: 'active' }],
    whatsapp: { state: 'connected', session: 'PRESENT', connected: true },
    today: TODAY,
    ...overrides,
  }
}

describe('overdue receivable lifecycle', () => {
  it('appears when the invoice crosses the overdue threshold', () => {
    // 90 days old → critical.
    const notices = buildNotices(baseInput({ data: { ...baseInput().data, sales: [noticeSale({ date: '2026-09-07' })] } }))
    const overdue = notices.find((n) => n.type === 'overdue-receivable')
    expect(overdue).toBeDefined()
    expect(overdue!.id).toBe('overdue-receivable:s1')
    expect(overdue!.severity).toBe('critical')
    expect(overdue!.action!.to).toBe('/sales/s1')
    expect(overdue!.amount).toBe(5000)
  })

  it('is a warning (not critical) between 30 and 90 days', () => {
    const notices = buildNotices(baseInput({ data: { ...baseInput().data, sales: [noticeSale({ date: '2026-11-06' })] } }))
    expect(notices.find((n) => n.type === 'overdue-receivable')!.severity).toBe('warning')
  })

  it('does NOT fire before the threshold', () => {
    const notices = buildNotices(baseInput({ data: { ...baseInput().data, sales: [noticeSale({ date: '2026-12-01' })] } }))
    expect(notices.find((n) => n.type === 'overdue-receivable')).toBeUndefined()
  })

  it('clears when the invoice is paid (state-based resolution)', () => {
    const notices = buildNotices(baseInput({ data: { ...baseInput().data, sales: [noticeSale({ date: '2026-09-07', due: 0 })] } }))
    expect(notices.find((n) => n.type === 'overdue-receivable')).toBeUndefined()
  })

  it('never fires for cancelled invoices', () => {
    const notices = buildNotices(baseInput({ data: { ...baseInput().data, sales: [noticeSale({ date: '2026-09-07', status: 'cancelled' })] } }))
    expect(notices.find((n) => n.type === 'overdue-receivable')).toBeUndefined()
  })
})

describe('overdue payables', () => {
  it('fires for long-outstanding supplier bills and navigates to the bill', () => {
    const notices = buildNotices(
      baseInput({
        data: {
          ...baseInput().data,
          purchases: [
            { id: 'pu1', bill_number: 'PUR-2026-27-0002', date: '2026-08-01', due: 15000, status: 'active', party_id: 'p2', party_name: 'Shree Balaji Mobiles' },
          ],
        },
      }),
    )
    const payable = notices.find((n) => n.type === 'overdue-payable')!
    expect(payable.id).toBe('overdue-payable:pu1')
    expect(payable.severity).toBe('critical')
    expect(payable.action!.to).toBe('/purchases/pu1')
  })
})

describe('aggregate balances', () => {
  it('summarizes outstanding receivables and payables when non-zero', () => {
    const notices = buildNotices(
      baseInput({
        data: {
          ...baseInput().data,
          sales: [noticeSale({ due: 5000 })],
          purchases: [
            { id: 'pu1', bill_number: 'PUR-2026-27-0002', date: '2026-10-01', due: 2000, status: 'active', party_id: 'p2', party_name: 'S' },
          ],
        },
      }),
    )
    expect(notices.find((n) => n.id === 'receivables-outstanding:all')).toMatchObject({ severity: 'info', amount: 5000 })
    expect(notices.find((n) => n.id === 'payables-outstanding:all')).toMatchObject({ severity: 'info', amount: 2000 })
  })

  it('omits the summaries when nothing is outstanding', () => {
    const notices = buildNotices(baseInput())
    expect(notices.find((n) => n.type === 'receivables-outstanding')).toBeUndefined()
    expect(notices.find((n) => n.type === 'payables-outstanding')).toBeUndefined()
  })
})

describe('inventory ageing notices', () => {
  it('fires ONE logical notice per item crossing 90 days (regular stock)', () => {
    const notices = buildNotices(baseInput({ data: { ...baseInput().data, stock: [noticeStock({ created_at: '2026-09-01T00:00:00Z' })] } }))
    const old = notices.find((n) => n.type === 'old-inventory')!
    expect(old.id).toBe('old-inventory:i1')
    expect(old.action!.to).toBe('/inventory')
    // Exactly one per item — no duplicates.
    expect(notices.filter((n) => n.type === 'old-inventory')).toHaveLength(1)
  })

  it('fires the trade-in-specific notice at 60 days (not 90)', () => {
    // 61 days old trade-in stock.
    const notices = buildNotices(
      baseInput({ data: { ...baseInput().data, stock: [noticeStock({ source: 'trade_in', created_at: '2026-10-06T00:00:00Z' })] } }),
    )
    expect(notices.find((n) => n.type === 'aging-trade-in-stock')).toBeDefined()
    expect(notices.find((n) => n.type === 'old-inventory')).toBeUndefined()
  })

  it('resolves when the item is sold', () => {
    const notices = buildNotices(baseInput({ data: { ...baseInput().data, stock: [noticeStock({ created_at: '2026-09-01T00:00:00Z', status: 'sold' })] } }))
    expect(notices.find((n) => n.type === 'old-inventory')).toBeUndefined()
  })

  it('zero stock is its own warning', () => {
    const notices = buildNotices(baseInput({ data: { ...baseInput().data, stock: [] } }))
    expect(notices.find((n) => n.id === 'zero-stock:all')).toBeDefined()
  })
})

describe('workflow + financial-year notices', () => {
  it('flags unconverted proformas once they go stale', () => {
    const notices = buildNotices(
      baseInput({
        data: {
          ...baseInput().data,
          proformas: [
            { id: 'pf1', bill_number: 'PI-2026-27-0001', date: '2026-10-01', status: 'active', final_total: 20000, party_id: 'p1', party_name: 'Aditya' },
          ],
        },
      }),
    )
    const proforma = notices.find((n) => n.type === 'old-proforma')!
    expect(proforma.id).toBe('old-proforma:pf1')
    expect(proforma.action!.to).toBe('/proformas/pf1')
    // Converted / void proformas never nag.
    const quiet = buildNotices(
      baseInput({
        data: {
          ...baseInput().data,
          proformas: [
            { id: 'pf1', bill_number: 'PI-2026-27-0001', date: '2026-10-01', status: 'converted', final_total: 20000, party_id: 'p1', party_name: 'Aditya' },
          ],
        },
      }),
    )
    expect(quiet.find((n) => n.type === 'old-proforma')).toBeUndefined()
  })

  it('flags an active financial year whose end date has passed', () => {
    const notices = buildNotices(
      baseInput({
        financialYears: [{ id: 'fy1', start_date: '2025-04-01', end_date: '2026-03-31', status: 'active' }],
      }),
    )
    const ended = notices.find((n) => n.type === 'fy-ended')!
    expect(ended.id).toBe('fy-ended:fy1')
    expect(ended.action!.to).toBe('/financial-year')
    // Closed FYs are resolved.
    const quiet = buildNotices(
      baseInput({
        financialYears: [{ id: 'fy1', start_date: '2025-04-01', end_date: '2026-03-31', status: 'closed' }],
      }),
    )
    expect(quiet.find((n) => n.type === 'fy-ended')).toBeUndefined()
  })
})

describe('WhatsApp notices', () => {
  it('warns when disconnected (not paired) and recovers when connected', () => {
    const disconnected = buildNotices(baseInput({ whatsapp: { state: 'disconnected', session: 'NONE', connected: false } }))
    const wa = disconnected.find((n) => n.type === 'whatsapp-not-connected')!
    expect(wa.id).toBe('whatsapp-not-connected:global')
    expect(wa.severity).toBe('warning')
    expect(wa.action!.to).toBe('/settings#whatsapp')

    const connected = buildNotices(baseInput({ whatsapp: { state: 'connected', session: 'PRESENT', connected: true } }))
    expect(connected.find((n) => n.type === 'whatsapp-not-connected')).toBeUndefined()
  })

  it('escalates security-invalidated sessions to critical', () => {
    const notices = buildNotices(baseInput({ whatsapp: { state: 'error', session: 'NONE', connected: false } }))
    expect(notices.find((n) => n.type === 'whatsapp-not-connected')!.severity).toBe('critical')
  })

  it('stays silent for in-progress states and the auto-wakeable idle session', () => {
    for (const state of ['connecting', 'pairing', 'reconnecting', 'restoring', 'idle']) {
      const notices = buildNotices(baseInput({ whatsapp: { state, session: 'PRESENT', connected: false } }))
      expect(notices.find((n) => n.type === 'whatsapp-not-connected'), state).toBeUndefined()
    }
    // And while the status snapshot has not loaded yet.
    expect(buildNotices(baseInput({ whatsapp: null })).find((n) => n.type === 'whatsapp-not-connected')).toBeUndefined()
  })
})

describe('failed message deliveries', () => {
  it('flags each failed job with a delivery label and the Messages destination', () => {
    const notices = buildNotices(
      baseInput({
        data: {
          ...baseInput().data,
          failedJobs: [
            { id: 'j1', job_type: 'invoice_send', status: 'failed', run_at: '2026-12-05T10:00:00Z', attempts: 3, last_error: 'boom', sales: { bill_number: 'SAL-1' }, purchases: null, proforma_invoices: null },
            { id: 'j2', job_type: 'receipt', status: 'failed', run_at: '2026-12-05T11:00:00Z', attempts: 5, last_error: 'x', sales: null, purchases: null, proforma_invoices: null },
          ],
        },
      }),
    )
    const failed = notices.filter((n) => n.type === 'message-job-failed')
    expect(failed).toHaveLength(2)
    expect(failed.find((n) => n.id === 'message-job-failed:j1')!.title).toBe('Invoice Delivery Failed')
    expect(failed.find((n) => n.id === 'message-job-failed:j2')!.title).toBe('Payment Receipt Delivery Failed')
    expect(failed[0].action!.to).toBe('/messages')
  })
})

describe('deterministic identity + deduplication', () => {
  it('produces the identical notice set on repeated builds (no duplicates on refresh)', () => {
    const input = baseInput({
      data: {
        ...baseInput().data,
        sales: [noticeSale({ date: '2026-09-07' }), noticeSale({ id: 's2', bill_number: 'B', date: '2026-08-07', due: 1000 })],
        stock: [noticeStock({ created_at: '2026-09-01T00:00:00Z' })],
      },
      whatsapp: { state: 'disconnected', session: 'NONE', connected: false },
    })
    const first = buildNotices(input)
    const second = buildNotices(input)
    const third = buildNotices({ ...input, data: { ...input.data } })

    expect(first.map((n) => n.id)).toEqual(second.map((n) => n.id))
    expect(first.map((n) => n.id)).toEqual(third.map((n) => n.id))
    expect(new Set(first.map((n) => n.id)).size).toBe(first.length) // unique ids
  })

  it('orders by severity, then business area, with a stable tiebreak', () => {
    const notices = buildNotices(
      baseInput({
        data: {
          ...baseInput().data,
          sales: [noticeSale({ date: '2026-08-07' })], // critical overdue
          stock: [noticeStock({ created_at: '2026-09-01T00:00:00Z' })], // warning inventory
        },
      }),
    )
    expect(notices[0].severity).toBe('critical')
    expect(notices[0].type).toBe('overdue-receivable')
  })
})

describe('thresholds are the shared canon', () => {
  it('keeps the documented business thresholds in ONE place', () => {
    expect(NOTICE_THRESHOLDS.overdueDays).toBe(30)
    expect(NOTICE_THRESHOLDS.criticalOverdueDays).toBe(90)
    expect(NOTICE_THRESHOLDS.oldInventoryDays).toBe(90)
    expect(NOTICE_THRESHOLDS.tradeInAgingDays).toBe(60)
    expect(NOTICE_THRESHOLDS.oldProformaDays).toBe(30)
  })
})
