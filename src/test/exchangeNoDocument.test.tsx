/**
 * Exchange page — NO document surface (final architecture).
 *
 * Exchange lists trade-in transactions with the transaction-related
 * columns only: Device / IMEI / Credit / MRP / Discount / Linked Sale /
 * Status. The DOC column, its View button and any document concept are
 * removed entirely — including from the underlying query projection.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import ExchangePage from '@/pages/exchange/ExchangePage'

// ── Mocks ────────────────────────────────────────────────────────────────────

const fy = { id: 'fy-1', start_date: '2026-04-01', end_date: '2027-03-31', status: 'active' }
const tradeInsMock = vi.hoisted(() => ({
  data: [
    {
      id: 'ti-1',
      sale_id: 'sale-1',
      inventory_item_id: 'inv-1',
      credit_value: 5000,
      mrp: 9000,
      sales: { id: 'sale-1', bill_number: 'SAL-2026-27-0001', financial_year_id: 'fy-1' },
      inventory_items: { id: 'inv-1', status: 'sold', brand: 'Samsung', model: 'Galaxy S21', imei: '123456789012345', ram_rom: '8/128', color: 'Gray' },
    },
  ],
  error: null,
}))
const selectCapture = vi.hoisted(() => ({ select: '' as string }))

vi.mock('@/components/providers/FinancialYearProvider', () => ({
  useFinancialYear: () => ({ selectedYear: fy, isLoading: false }),
}))
vi.mock('@/platform/supabase/client', () => ({
  supabase: {
    from: (table: string) => {
      if (table !== 'trade_ins') throw new Error(`unexpected table ${table}`)
      return {
        select: (projection: string) => {
          selectCapture.select = projection
          return {
            eq: () => ({
              order: () => Promise.resolve({ data: tradeInsMock.data, error: tradeInsMock.error }),
            }),
          }
        },
      }
    },
  },
}))

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

beforeEach(() => {
  vi.clearAllMocks()
  selectCapture.select = ''
})

describe('ExchangePage — no document column or document logic', () => {
  it('renders the transaction columns only', async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter><ExchangePage /></MemoryRouter>
      </QueryClientProvider>,
    )

    // Rows load.
    await waitFor(() => {
      expect(screen.getAllByText('SAL-2026-27-0001').length).toBeGreaterThan(0)
    })

    // The final transaction-related columns (desktop header + mobile label
    // may both render — at least one occurrence of each must exist).
    for (const header of ['Device', 'IMEI', 'Credit', 'MRP', 'Discount', 'Linked Sale', 'Status']) {
      expect(screen.getAllByText(header).length).toBeGreaterThan(0)
    }

    // The DOC column is GONE — not hidden: no header, no View button.
    expect(screen.queryByText('Doc')).toBeNull()
    expect(screen.queryByRole('button', { name: 'View' })).toBeNull()
    expect(screen.queryByTitle('View document')).toBeNull()
    expect(screen.queryByText('…')).toBeNull()
  })

  it('the underlying query projection carries no document field', async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter><ExchangePage /></MemoryRouter>
      </QueryClientProvider>,
    )

    await waitFor(() => {
      expect(screen.getAllByText('SAL-2026-27-0001').length).toBeGreaterThan(0)
    })

    // The Supabase select string is the cleaned projection.
    expect(selectCapture.select).not.toContain('document_id')
    expect(selectCapture.select).not.toContain('party_id')
    expect(selectCapture.select).toContain('inventory_items')
    expect(selectCapture.select).toContain('bill_number')
  })
})
