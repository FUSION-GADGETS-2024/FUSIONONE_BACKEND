/**
 * PaymentDialog — the record-payment dialog (Receive Payment / Pay Party).
 *
 * These tests pin the empty-Payment-Mode contract:
 *   - when the selected NON-CASH account has no configured payment modes,
 *     the required mode dropdown would otherwise have nothing to select —
 *     the dialog explains it inline ("Add a payment mode to this account
 *     first."), and that guidance is ALSO the submit error (never a
 *     misleading "Select a payment mode." over an empty list);
 *   - an account WITH modes keeps the ordinary behavior ("Select a payment
 *     mode." until one is chosen; the RPC fires once it is);
 *   - a cash account never shows the mode field (existing semantics).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { PaymentDialog } from '@/components/payments/PaymentDialog'

// ── Provider / feature mocks ────────────────────────────────────────────────

const accountsMock = vi.hoisted(() => ({ data: null as unknown }))
const modesMock = vi.hoisted(() => ({ data: null as unknown }))
const receivePaymentMock = vi.hoisted(() => vi.fn())
const payPurchaseMock = vi.hoisted(() => vi.fn())

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

vi.mock('@/components/providers/FinancialYearProvider', () => ({
  useFinancialYear: () => ({
    selectedYear: { id: 'fy-1', start_date: '2027-04-01', end_date: '2028-03-31' },
  }),
}))

vi.mock('@/features/accounts/api', () => ({
  useBankAccounts: () => ({ data: accountsMock.data ?? [] }),
  usePaymentModes: () => ({ data: modesMock.data ?? [] }),
}))

vi.mock('@/features/sales/mutations', () => ({
  receivePayment: receivePaymentMock,
}))

vi.mock('@/features/purchases/mutations', () => ({
  payPurchase: payPurchaseMock,
}))

vi.mock('@/features/invalidate', () => ({
  invalidateSales: vi.fn(),
  invalidatePurchases: vi.fn(),
}))

const ACCOUNTS = [
  { id: 'bank-zero', name: 'Zero Mode Bank', is_cash: false },
  { id: 'bank-hdfc', name: 'HDFC Current', is_cash: false },
  { id: 'bank-cash', name: 'Cash', is_cash: true },
]
const MODES = [
  { id: 'mode-1', bank_account_id: 'bank-hdfc', name: 'UPI' },
  { id: 'mode-2', bank_account_id: 'bank-hdfc', name: 'IMPS' },
]

const INVOICE = {
  id: 'sale-1',
  billNumber: 'SAL-2027-28-0001',
  partyName: 'Rahul Sharma',
  total: 10000,
  paid: 6000,
  due: 4000,
}

function renderDialog() {
  // Mount the dialog CLOSED first, then open it — the real lifecycle (the
  // dialog initializes its fields when the target invoice CHANGES, which
  // every real parent exercises by rendering closed before opening).
  const utils = render(
    <PaymentDialog open={false} onClose={() => {}} invoiceType="sale" invoice={INVOICE} />,
  )
  utils.rerender(<PaymentDialog open onClose={() => {}} invoiceType="sale" invoice={INVOICE} />)
  return utils
}

/** Open the account dropdown and pick an account by label. */
function pickAccount(label: string) {
  fireEvent.click(screen.getByRole('button', { name: /select account/i }))
  fireEvent.click(screen.getByRole('button', { name: new RegExp(label, 'i') }))
}

beforeEach(() => {
  accountsMock.data = ACCOUNTS
  modesMock.data = MODES
  receivePaymentMock.mockReset()
  payPurchaseMock.mockReset()
})

// ── Tests ───────────────────────────────────────────────────────────────────

describe('PaymentDialog — account with no payment modes', () => {
  it('shows inline guidance instead of a silent empty dropdown', () => {
    renderDialog()
    pickAccount('Zero Mode Bank')

    // The mode field renders (non-cash account) with the guidance hint…
    expect(screen.getByText('Add a payment mode to this account first.')).toBeTruthy()
    // …and the dropdown offers nothing beyond its placeholder (no modes).
    fireEvent.click(screen.getByRole('button', { name: /select mode/i }))
    expect(screen.getAllByText('Select mode').length).toBe(2) // trigger + its only option
  })

  it('makes the guidance the submit error — never "Select a payment mode." over an empty list', () => {
    renderDialog()
    pickAccount('Zero Mode Bank')

    // Amount/date are prefilled from the invoice; submit validates all.
    fireEvent.click(screen.getByRole('button', { name: /receive payment/i }))

    const alerts = screen.getAllByRole('alert')
    const texts = alerts.map((a) => a.textContent)
    expect(texts).toContain('Add a payment mode to this account first.')
    expect(texts).not.toContain('Select a payment mode.')
    expect(receivePaymentMock).not.toHaveBeenCalled()
  })
})

describe('PaymentDialog — account with payment modes (existing behavior)', () => {
  it('asks for a mode until one is selected, then calls the RPC', async () => {
    renderDialog()
    pickAccount('HDFC Current')

    // No empty-list guidance for an account that HAS modes.
    expect(screen.queryByText('Add a payment mode to this account first.')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /receive payment/i }))
    expect(screen.getByText('Select a payment mode.')).toBeTruthy()
    expect(receivePaymentMock).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /select mode/i }))
    fireEvent.click(screen.getByRole('button', { name: 'UPI' }))
    fireEvent.click(screen.getByRole('button', { name: /receive payment/i }))

    await waitFor(() => {
      expect(receivePaymentMock).toHaveBeenCalledWith({
        saleId: 'sale-1',
        amount: 4000,
        date: '2027-04-01',
        bankAccountId: 'bank-hdfc',
        paymentModeId: 'mode-1',
      })
    })
  })
})

describe('PaymentDialog — cash account (existing behavior)', () => {
  it('never shows the payment mode field', () => {
    renderDialog()
    pickAccount('Cash')
    expect(screen.queryByText('Payment Mode')).toBeNull()
    expect(screen.queryByText('Add a payment mode to this account first.')).toBeNull()
  })
})
