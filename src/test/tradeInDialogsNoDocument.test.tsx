/**
 * Trade-In dialogs contain NO document field (final architecture).
 *
 * Documents belong exclusively to parties; the trade-in dialogs (New Sale's
 * "Add Trade-In Device" modal and the Proforma Conversion dialog's received
 * trade-in rows) must contain ONLY the device/transaction fields:
 * Brand / Model / IMEI / RAM-ROM / Color / Credit Value / Original MRP.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import NewSalePage from '@/pages/sales/NewSalePage'
import { ConvertProformaDialog } from '@/components/proformas/ConvertProformaDialog'
import type { ProformaDetail } from '@/features/proformas/api'

// ── Shared mocks ─────────────────────────────────────────────────────────────

const toastMock = vi.hoisted(() => ({
  toast: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), remove: vi.fn(),
}))
const fy = { id: 'fy-1', start_date: '2026-04-01', end_date: '2027-03-31', status: 'active' }
const singleMock = vi.hoisted(() => vi.fn())

vi.mock('@/components/providers/FinancialYearProvider', () => ({
  useFinancialYear: () => ({ selectedYear: fy, isReadOnly: false, isLoading: false }),
}))
vi.mock('@/features/whatsapp/useWhatsAppMessageSettings', () => ({
  useWhatsAppMessageSettings: () => ({ settings: { sale: { autoSend: false } } }),
}))
vi.mock('@/features/accounts/api', () => ({
  useBankAccounts: () => ({
    data: [{ id: 'bank-1', name: 'Cash', is_cash: true, bank_account_id: 'bank-1' }],
    isLoading: false,
  }),
  usePaymentModes: () => ({ data: [], isLoading: false }),
}))
vi.mock('@/components/ui/Toast', () => ({ useToast: () => toastMock }))
vi.mock('@/platform/supabase/client', () => ({
  supabase: {
    rpc: vi.fn(),
    from: () => ({ select: () => ({ eq: () => ({ single: singleMock }) }) }),
  },
}))
vi.mock('@/components/inventory/StockSearchField', () => ({
  StockSearchField: () => <input aria-label="Stock search" placeholder="stock-search" readOnly />,
}))
vi.mock('@/components/parties/PartyCombobox', () => ({
  PartyCombobox: ({ onChange }: { onChange: (v: string) => void }) => (
    <button type="button" onClick={() => onChange('party-1')}>New Party</button>
  ),
}))

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
const wrap = (ui: React.ReactElement) => (
  <QueryClientProvider client={queryClient}>
    <MemoryRouter>{ui}</MemoryRouter>
  </QueryClientProvider>
)

beforeEach(() => {
  vi.clearAllMocks()
  singleMock.mockResolvedValue({ data: fy, error: null })
})

describe('New Sale — Trade-In dialog has no document field', () => {
  it('shows only the device/transaction fields (no document UI)', () => {
    render(wrap(<NewSalePage />))

    // Open the Add Trade-In Device modal from the Trade-Ins section.
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    // The dialog title + the full device/transaction field set.
    expect(screen.getByText('Add Trade-In Device')).toBeTruthy()
    expect(screen.getByText('Brand')).toBeTruthy()
    expect(screen.getByText('Model')).toBeTruthy()
    expect(screen.getByText(/IMEI \(15 digits\)/i)).toBeTruthy()
    expect(screen.getByText('RAM / ROM')).toBeTruthy()
    expect(screen.getByText('Color')).toBeTruthy()
    expect(screen.getByText('Credit Value')).toBeTruthy()
    expect(screen.getByText('Original MRP')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Add Trade-In' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy()

    // NO document terminology or behavior remains.
    expect(screen.queryByText(/Identity \/ Declaration Doc/i)).toBeNull()
    expect(screen.queryByText(/Select Document/i)).toBeNull()
    expect(screen.queryByText(/No document/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /Upload New/i })).toBeNull()
    expect(document.querySelector('input[type="file"]')).toBeNull()
  })
})

describe('Proforma Conversion — trade-in rows have no document field', () => {
  const detail = {
    proforma: {
      id: 'proforma-1',
      bill_number: 'PRO-2026-27-0001',
      date: '2026-06-15',
      financial_year_id: 'fy-1',
      party_id: 'party-1',
      parties: { name: 'Acme', number: '919876543210', address: null },
      total: 50000,
      discount: 0,
      trade_in_credit: 5000,
      final_total: 45000,
      status: 'active',
    },
    items: [
      {
        id: 'pi-1', description: 'iPhone 15', qty: 1, rate: 50000, discount: 0, value: 50000,
        inventory_item_id: 'inv-1',
        inventory_items: { id: 'inv-1', brand: 'Apple', model: 'iPhone 15', imei: '123456789012345', ram_rom: '8/256', color: 'Black', base_selling_price: 50000, status: 'in_stock' },
      },
    ],
    tradeIns: [
      { id: 'pti-1', description: 'Old Samsung', qty: 1, rate: 5000, value: 5000 },
    ],
    store: null,
  } as unknown as ProformaDetail

  it('received trade-in rows show only device/transaction fields', () => {
    render(wrap(<ConvertProformaDialog open onClose={vi.fn()} detail={detail} />))

    // The prefilled trade-in row renders the device field set.
    expect(screen.getAllByText('Brand').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Credit Value').length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: /Add Received Trade-In/i })).toBeTruthy()

    // NO document field, picker or upload remains anywhere in the dialog.
    expect(screen.queryByText(/Identity \/ Declaration Doc/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /Upload New/i })).toBeNull()
    expect(document.querySelector('input[type="file"]')).toBeNull()

    // Adding ANOTHER trade-in row introduces no document UI either.
    fireEvent.click(screen.getByRole('button', { name: /Add Received Trade-In/i }))
    expect(screen.queryByText(/Identity \/ Declaration Doc/i)).toBeNull()
    expect(document.querySelector('input[type="file"]')).toBeNull()
  })
})
