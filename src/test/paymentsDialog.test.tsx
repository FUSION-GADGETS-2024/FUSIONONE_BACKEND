/**
 * PaymentsDialog — the invoice/bill payment-history dialog (per-payment
 * manual Send Receipt + manual Send Payment Statement).
 *
 * These tests pin the dialog's contract:
 *   - it lists EVERY payment of the invoice (including the initial payment),
 *     showing date, amount, and payment mode where available;
 *   - each payment row carries its own Send Receipt action that identifies
 *     THAT payment (never the latest, never a total);
 *   - the aggregate state (invoice amount / total paid / balance due) comes
 *     from the AUTHORITATIVE invoice row passed in — never recomputed from
 *     the payment list;
 *   - the one Send Payment Statement action addresses the WHOLE history;
 *   - an unpaymented invoice disables the statement action but still shows
 *     the empty state.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { PaymentsDialog } from '@/components/payments/PaymentsDialog'

// ── Provider / feature mocks ────────────────────────────────────────────────

const paymentsMock = vi.hoisted(() => ({ data: null as unknown }))

const httpMock = vi.hoisted(() => ({
  postSendReceipt: vi.fn(),
  postSendStatement: vi.fn(),
}))

vi.mock('@/components/ui/Toast', () => ({
  useToast: () => ({
    toast: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    remove: vi.fn(),
  }),
}))

vi.mock('@/features/payments/api', () => ({
  useInvoicePayments: () => ({ data: paymentsMock.data ?? [], isLoading: false }),
  invoicePaymentsKeys: { list: (t: string, id: string) => ['invoice-payments', t, id] },
}))

vi.mock('@/platform/whatsapp/http', () => httpMock)

vi.mock('@/features/messages/jobs', () => ({
  messageJobsKeys: { jobs: (refType: string, refId: string) => ['message-jobs', refType, refId] },
}))

const INVOICE = {
  id: 'sale-1',
  billNumber: 'SAL-2026-27-0042',
  partyName: 'Rahul Sharma',
  total: 10000,
  paid: 6000,
  due: 4000,
}

const PAYMENTS = [
  { id: 'pay-1', amount: '4000.00', date: '2026-10-01', payment_modes: { name: 'UPI' }, bank_accounts: { name: 'HDFC Current' } },
  { id: 'pay-2', amount: '2000.00', date: '2026-10-05', payment_modes: null, bank_accounts: { name: 'Cash Box' } },
]

function renderDialog(open = true, invoice = INVOICE, invoiceType: 'sale' | 'purchase' = 'sale') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <PaymentsDialog open={open} onClose={() => {}} invoiceType={invoiceType} invoice={invoice} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  paymentsMock.data = PAYMENTS
  httpMock.postSendReceipt.mockReset()
  httpMock.postSendStatement.mockReset()
})

// ── Tests ───────────────────────────────────────────────────────────────────

describe('PaymentsDialog — payment history', () => {
  it('lists every payment with date, amount, and payment mode where available', () => {
    renderDialog()

    // BOTH payments render (the initial payment included), with amounts…
    expect(screen.getByText('₹2,000.00')).toBeTruthy() // unique to payment row 2
    // …dates in the app's short format…
    expect(screen.getByText('01 Oct 2026')).toBeTruthy()
    expect(screen.getByText('05 Oct 2026')).toBeTruthy()
    // …the mode where available ('UPI') and the account as metadata.
    expect(screen.getByText('UPI · HDFC Current')).toBeTruthy()
  })

  it('shows the AUTHORITATIVE aggregate state from the invoice row (not recomputed)', () => {
    renderDialog()

    expect(screen.getByText('₹10,000.00')).toBeTruthy() // invoice amount
    expect(screen.getByText('₹6,000.00')).toBeTruthy() // total paid
    // Balance due ₹4,000.00 — the SAME string as the first payment's amount;
    // both occurrences are present and correct (row + aggregate).
    expect(screen.getAllByText('₹4,000.00').length).toBe(2)
  })

  it('marks a fully-paid invoice as Paid in full', () => {
    renderDialog(true, { ...INVOICE, paid: 10000, due: 0 })
    expect(screen.getByText('Paid in full')).toBeTruthy()
  })
})

describe('PaymentsDialog — per-payment Send Receipt', () => {
  it('sends the receipt for the CLICKED payment only (identifies that exact payment)', async () => {
    httpMock.postSendReceipt.mockResolvedValue({ success: true, status: 'succeeded', jobId: 'j1' })
    renderDialog()

    // Two rows → two receipt actions; click the SECOND payment's action.
    const buttons = screen.getAllByRole('button', { name: /send receipt for the payment of/i })
    expect(buttons.length).toBe(2)
    fireEvent.click(buttons[1])

    await waitFor(() => {
      expect(httpMock.postSendReceipt).toHaveBeenCalledWith({ paymentId: 'pay-2', direction: 'in' })
    })
    expect(httpMock.postSendReceipt).toHaveBeenCalledTimes(1)
  })

  it('uses direction out for purchase bills', async () => {
    httpMock.postSendReceipt.mockResolvedValue({ success: true, status: 'succeeded', jobId: 'j1' })
    renderDialog(true, INVOICE, 'purchase')

    fireEvent.click(screen.getAllByRole('button', { name: /send receipt for the payment of/i })[0])
    await waitFor(() => {
      expect(httpMock.postSendReceipt).toHaveBeenCalledWith({ paymentId: 'pay-1', direction: 'out' })
    })
  })

  it('disables the other send actions while one is in flight (double-click guard)', async () => {
    let resolveSend: (v: unknown) => void = () => {}
    httpMock.postSendReceipt.mockImplementation(
      () => new Promise((resolve) => { resolveSend = resolve }),
    )
    renderDialog()

    const buttons = screen
      .getAllByRole('button', { name: /send receipt for the payment of/i })
      .map((b) => b as HTMLButtonElement)
    fireEvent.click(buttons[0])
    await waitFor(() => expect(buttons[1].disabled).toBe(true))
    resolveSend({ success: true, status: 'succeeded', jobId: 'j1' })
    await waitFor(() => expect(buttons[1].disabled).toBe(false))
  })
})

describe('PaymentsDialog — Send Payment Statement', () => {
  it('sends ONE statement for the whole invoice (identifies the invoice, not a payment)', async () => {
    httpMock.postSendStatement.mockResolvedValue({ success: true, status: 'succeeded', jobId: 'j2' })
    renderDialog()

    fireEvent.click(screen.getByRole('button', { name: /send payment statement/i }))
    await waitFor(() => {
      expect(httpMock.postSendStatement).toHaveBeenCalledWith({ invoiceId: 'sale-1', invoiceType: 'sale' })
    })
    expect(httpMock.postSendStatement).toHaveBeenCalledTimes(1)
  })

  it('is disabled when the invoice has no payments', () => {
    paymentsMock.data = []
    renderDialog()
    const statement = screen.getByRole('button', { name: /send payment statement/i }) as HTMLButtonElement
    expect(statement.disabled).toBe(true)
    expect(screen.getByText(/no payments recorded yet/i)).toBeTruthy()
  })
})
