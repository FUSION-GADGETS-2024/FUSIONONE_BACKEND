/**
 * FinancialYearPage — Close Financial Year confirmation UX.
 *
 * Pins the historical finding's fix: closing an FY must be confirmed
 * through the app's modal pattern, NEVER the native browser confirm().
 *   - clicking "Close Year" opens the application dialog (title
 *     "Close Financial Year") and does NOT call window.confirm;
 *   - Cancel leaves the FY untouched and the RPC uncalled;
 *   - confirming calls closeFinancialYear with the EXACT row (the same
 *     business call the old native-confirm path made — behavior change
 *     is presentation only).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import FinancialYearPage from '@/pages/financial-year/FinancialYearPage'

// ── Provider / feature mocks ────────────────────────────────────────────────

const fyStateMock = vi.hoisted(() => ({
  years: [] as Array<{ id: string; start_date: string; end_date: string; status: 'active' | 'closed' }>,
}))
const refreshMock = vi.hoisted(() => vi.fn())
const closeFinancialYearMock = vi.hoisted(() => vi.fn())

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
    financialYears: fyStateMock.years,
    selectedYear: fyStateMock.years[0] ?? null,
    setSelectedYearId: vi.fn(),
    isReadOnly: false,
    refresh: refreshMock,
  }),
}))

vi.mock('@/components/providers/SessionProvider', () => ({
  useSession: () => ({ isOwner: true }),
}))

vi.mock('@/features/settings/api', () => ({
  useStore: () => ({ data: { id: 'store-1', active_financial_year_id: 'fy-1' } }),
}))

vi.mock('@/features/financial-year/mutations', () => ({
  createFinancialYear: vi.fn(),
  setActiveFinancialYear: vi.fn(),
  closeFinancialYear: closeFinancialYearMock,
}))

const ACTIVE_FY = { id: 'fy-1', start_date: '2027-04-01', end_date: '2028-03-31', status: 'active' as const }

beforeEach(() => {
  fyStateMock.years = [ACTIVE_FY]
  refreshMock.mockReset()
  closeFinancialYearMock.mockReset()
})

// ── Tests ───────────────────────────────────────────────────────────────────

describe('FinancialYearPage — close confirmation UX', () => {
  it('uses the application modal, never native window.confirm()', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockImplementation(() => true)
    render(<FinancialYearPage />)

    // DataTable renders the row actions for both the desktop table and the
    // mobile card view — the close action appears twice; click the first.
    fireEvent.click(screen.getAllByRole('button', { name: /close year/i })[0])

    // The app dialog opened…
    expect(screen.getByRole('dialog', { name: 'Close Financial Year' })).toBeTruthy()
    // …and the native confirm was never invoked.
    expect(confirmSpy).not.toHaveBeenCalled()
    confirmSpy.mockRestore()
  })

  it('states the real effects (read-only freeze, carry-forward, new FY, irreversibility)', () => {
    render(<FinancialYearPage />)
    fireEvent.click(screen.getAllByRole('button', { name: /close year/i })[0])

    const dialog = screen.getByRole('dialog', { name: 'Close Financial Year' })
    const text = dialog.textContent ?? ''
    expect(text).toContain('2027-04-01 → 2028-03-31')
    expect(text).toContain('read-only')
    expect(text).toContain('Unsold stock will carry forward')
    expect(text).toContain('opening balances')
    expect(text).toContain('cannot be reversed')
  })

  it('Cancel leaves the FY untouched (RPC never called)', () => {
    render(<FinancialYearPage />)
    fireEvent.click(screen.getAllByRole('button', { name: /close year/i })[0])

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(closeFinancialYearMock).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog', { name: 'Close Financial Year' })).toBeNull()
    // The row is still closable (still active).
    expect(screen.getAllByRole('button', { name: /close year/i }).length).toBeGreaterThan(0)
  })

  it('confirming calls the close RPC with the exact FY row (unchanged business call)', async () => {
    closeFinancialYearMock.mockResolvedValue({ items_carried: 0, accounts_carried: 0 })
    render(<FinancialYearPage />)
    fireEvent.click(screen.getAllByRole('button', { name: /close year/i })[0])

    fireEvent.click(screen.getByRole('button', { name: /close financial year/i }))

    await waitFor(() => {
      expect(closeFinancialYearMock).toHaveBeenCalledWith(ACTIVE_FY)
    })
    expect(refreshMock).toHaveBeenCalled()
  })

  it('offers no close action for an already-closed FY (existing guard)', () => {
    fyStateMock.years = [{ ...ACTIVE_FY, status: 'closed' }]
    render(<FinancialYearPage />)
    expect(screen.queryByRole('button', { name: /close year/i })).toBeNull()
  })
})
