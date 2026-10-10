/**
 * SalesPage row action menu — the final invoice action order and wiring.
 *
 * The row's ⋮ menu is the fullest expression of the shared invoice actions:
 *
 *   Receive Payment · Save PDF · Share via WhatsApp · Share · Print ·
 *   Cancel Invoice
 *
 * These tests pin, through the REAL shared behavior layer
 * (useInvoiceQuickActions over the real feature modules' mocks):
 *   - the exact action order and labels (Share via WhatsApp ≠ Share);
 *   - conditional visibility (Receive Payment only with due > 0 and an
 *     active invoice; Cancel Invoice only for an active invoice);
 *   - the wiring: generic Share invokes the native share of the PDF
 *     artifact, Share via WhatsApp invokes the existing WhatsApp delivery —
 *     neither ever invokes the other.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import SalesPage from '@/pages/sales/SalesPage'

// ── Mocks ────────────────────────────────────────────────────────────────────

const fy = { id: 'fy-1', start_date: '2026-04-01', end_date: '2027-03-31', status: 'active' }

const salesMock = vi.hoisted(() => ({ data: [] as any[], isLoading: false, isError: false, refetch: vi.fn() }))
const downloadInvoicePdfMock = vi.hoisted(() => vi.fn())
const printInvoicePdfMock = vi.hoisted(() => vi.fn())
const shareInvoicePdfMock = vi.hoisted(() => vi.fn())
const postSendInvoiceMock = vi.hoisted(() => vi.fn())
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))

vi.mock('@/components/providers/FinancialYearProvider', () => ({
  useFinancialYear: () => ({ selectedYear: fy, isReadOnly: false, isLoading: false }),
}))
vi.mock('@/features/sales/api', () => ({
  useSalesPageData: () => salesMock,
  salesKeys: { detail: (id: string) => ['sale-detail', id] },
  fetchSaleDetail: vi.fn(),
}))
vi.mock('@/features/sales/mutations', () => ({
  cancelSale: vi.fn(),
  deleteSale: vi.fn(),
  createTradeInPurchaseBill: vi.fn(),
}))
vi.mock('@/features/invoice/download', () => ({ downloadInvoicePdf: downloadInvoicePdfMock }))
vi.mock('@/features/invoice/print', () => ({ printInvoicePdf: printInvoicePdfMock }))
vi.mock('@/features/invoice/share', () => ({ shareInvoicePdf: shareInvoicePdfMock }))
vi.mock('@/platform/whatsapp/http', () => ({ postSendInvoice: postSendInvoiceMock }))
vi.mock('@/components/ui/Toast', () => ({
  useToast: () => ({
    toast: vi.fn(),
    success: toastMock.success,
    error: toastMock.error,
    warning: vi.fn(),
    info: vi.fn(),
    remove: vi.fn(),
  }),
}))
vi.mock('@/components/payments/PaymentDialog', () => ({
  PaymentDialog: () => null,
}))

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

const SALE_UNPAID = {
  id: 's-1',
  bill_number: 'SAL-2027-28-0004',
  date: '2026-10-05',
  parties: { name: 'Aditya Singh' },
  final_total: '53000',
  paid: '0',
  due: '53000',
  status: 'paid' as string,
}
const SALE_CANCELLED = {
  id: 's-2',
  bill_number: 'SAL-2027-28-0002',
  date: '2026-10-04',
  parties: { name: 'Rahul Sharma' },
  final_total: '12000',
  paid: '0',
  due: '12000',
  status: 'cancelled',
}

/** The open action menu's item labels, in DOM order. */
function menuItemLabels(): string[] {
  const menu = document.querySelector('.menu-fade-in')
  if (!menu) return []
  return [...menu.querySelectorAll('button')].map((b) => b.textContent ?? '')
}

function openRowMenu(rowIndex = 0) {
  fireEvent.click(screen.getAllByRole('button', { name: 'More actions' })[rowIndex])
}

beforeEach(() => {
  vi.clearAllMocks()
  salesMock.data = [SALE_UNPAID]
  downloadInvoicePdfMock.mockResolvedValue(undefined)
  printInvoicePdfMock.mockResolvedValue(undefined)
  shareInvoicePdfMock.mockResolvedValue(undefined)
  postSendInvoiceMock.mockResolvedValue(undefined)
})

describe('SalesPage — the row action menu', () => {
  it('offers the actions in the canonical order with the clarified share labels', async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter><SalesPage /></MemoryRouter>
      </QueryClientProvider>,
    )

    await waitFor(() => {
      expect(screen.getAllByText('SAL-2027-28-0004').length).toBeGreaterThan(0)
    })

    openRowMenu()
    await waitFor(() => expect(menuItemLabels().length).toBeGreaterThan(0))

    // The final order/semantics: Receive Payment · Save PDF ·
    // Share via WhatsApp · Share · Print · Cancel Invoice.
    expect(menuItemLabels()).toEqual([
      'Receive Payment',
      'Save PDF',
      'Share via WhatsApp',
      'Share',
      'Print',
      'Cancel Invoice',
    ])
  })

  it('generic Share invokes the native PDF share — never the WhatsApp pipeline', async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter><SalesPage /></MemoryRouter>
      </QueryClientProvider>,
    )
    await waitFor(() => {
      expect(screen.getAllByText('SAL-2027-28-0004').length).toBeGreaterThan(0)
    })

    openRowMenu()
    fireEvent.click(await screen.findByText('Share'))

    await waitFor(() => {
      expect(shareInvoicePdfMock).toHaveBeenCalledWith('s-1', 'sale')
    })
    expect(postSendInvoiceMock).not.toHaveBeenCalled()
    expect(downloadInvoicePdfMock).not.toHaveBeenCalled()
    expect(printInvoicePdfMock).not.toHaveBeenCalled()
  })

  it('Share via WhatsApp invokes the existing WhatsApp delivery — never the native share', async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter><SalesPage /></MemoryRouter>
      </QueryClientProvider>,
    )
    await waitFor(() => {
      expect(screen.getAllByText('SAL-2027-28-0004').length).toBeGreaterThan(0)
    })

    openRowMenu()
    fireEvent.click(await screen.findByText('Share via WhatsApp'))

    await waitFor(() => {
      expect(postSendInvoiceMock).toHaveBeenCalledWith({ invoiceId: 's-1', invoiceType: 'sale' })
    })
    expect(shareInvoicePdfMock).not.toHaveBeenCalled()
    expect(downloadInvoicePdfMock).not.toHaveBeenCalled()
    expect(printInvoicePdfMock).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(toastMock.success).toHaveBeenCalledWith(
        'Invoice sent',
        'Invoice SAL-2027-28-0004 was sent on WhatsApp.',
      )
    })
  })

  it('Save PDF invokes the PDF pipeline download; Print invokes the print', async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter><SalesPage /></MemoryRouter>
      </QueryClientProvider>,
    )
    await waitFor(() => {
      expect(screen.getAllByText('SAL-2027-28-0004').length).toBeGreaterThan(0)
    })

    openRowMenu()
    fireEvent.click(await screen.findByText('Save PDF'))
    await waitFor(() => {
      expect(downloadInvoicePdfMock).toHaveBeenCalledWith('s-1', 'sale')
    })

    openRowMenu()
    fireEvent.click(await screen.findByText('Print'))
    await waitFor(() => {
      expect(printInvoicePdfMock).toHaveBeenCalledWith('s-1', 'sale')
    })
    expect(shareInvoicePdfMock).not.toHaveBeenCalled()
    expect(postSendInvoiceMock).not.toHaveBeenCalled()
  })

  it('conditional visibility: a cancelled invoice offers neither Receive Payment nor Cancel Invoice', async () => {
    salesMock.data = [SALE_CANCELLED]
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter><SalesPage /></MemoryRouter>
      </QueryClientProvider>,
    )
    await waitFor(() => {
      expect(screen.getAllByText('SAL-2027-28-0002').length).toBeGreaterThan(0)
    })

    openRowMenu()
    await waitFor(() => expect(menuItemLabels().length).toBeGreaterThan(0))

    expect(menuItemLabels()).toEqual([
      'Save PDF',
      'Share via WhatsApp',
      'Share',
      'Print',
    ])
  })
})
