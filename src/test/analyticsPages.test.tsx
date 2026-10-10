/**
 * Analytics frontend — navigation (the five tabs), filters, KPI rendering,
 * tables, loading/empty/error states, notice rendering/navigation, the
 * Purchase tab and the shared export dialog flows.
 *
 * Follows the established test conventions: feature-module mocks
 * (vi.mock of the data layer), a fresh QueryClient per render, and
 * MemoryRouter for routing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// ── Feature-module mocks (the data layer is covered by unit suites) ─────────

const foldFixture = {
  fyId: 'fy1',
  sales: [
    { id: 's1', bill_number: 'SAL-2026-27-0001', date: '2026-10-07', party_id: 'pa', party_name: 'Aditya Singh', total: 35000, discount: 0, trade_in_credit: 0, final_total: 35000, paid: 35000, due: 0, status: 'active', created_at: '2026-10-07T09:00:00Z', proforma_id: null },
    { id: 's2', bill_number: 'SAL-2026-27-0002', date: '2026-11-02', party_id: 'pb', party_name: 'Priya Verma', total: 20000, discount: 500, trade_in_credit: 3000, final_total: 19500, paid: 5000, due: 14500, status: 'active', created_at: '2026-11-02T09:00:00Z', proforma_id: null },
  ],
  purchases: [
    { id: 'p1', bill_number: 'PUR-2026-27-0001', date: '2026-10-05', party_id: 'ps', party_name: 'Shree Balaji Mobiles', total: 100000, paid: 100000, due: 0, status: 'active', created_at: '', is_virtual: false },
    { id: 'p2', bill_number: 'PUR-2026-27-0002', date: '2026-11-05', party_id: 'ps', party_name: 'Shree Balaji Mobiles', total: 91000, paid: 40000, due: 51000, status: 'active', created_at: '', is_virtual: false },
    { id: 'p4', bill_number: 'PUR-2026-27-0004', date: '2026-12-01', party_id: 'ps', party_name: 'Gupta Electronics', total: 24000, paid: 0, due: 24000, status: 'active', created_at: '', is_virtual: false },
    { id: 'v1', bill_number: 'PUR-TRD-2026-27-0003', date: '2026-10-07', party_id: 'pb', party_name: 'Priya Verma', total: 3000, paid: 3000, due: 0, status: 'active', created_at: '', is_virtual: true },
    // A CANCELLED internal acquisition record dated in the period: excluded
    // from the ordinary totals (cancelled AND internal) but still counted
    // by the footer's internal-acquisition count.
    { id: 'v2', bill_number: 'PUR-TRD-2026-27-0005', date: '2026-11-20', party_id: 'pb', party_name: 'Priya Verma', total: 2500, paid: 2500, due: 0, status: 'cancelled', created_at: '', is_virtual: true },
  ],
  saleItems: [
    { sale_id: 's1', sold_price: 35000, inventory_items: { id: 'i1', brand: 'Samsung', model: 'Galaxy S22', imei: 'A1', ram_rom: null, color: null, base_selling_price: 35000, purchase_price: 30000, status: 'sold', source: 'purchase' } },
    { sale_id: 's2', sold_price: 19500, inventory_items: { id: 'i2', brand: 'Apple', model: 'iPhone 13', imei: 'A2', ram_rom: null, color: null, base_selling_price: 19500, purchase_price: 16000, status: 'sold', source: 'purchase' } },
  ],
  purchaseItems: [
    { purchase_id: 'p1', inventory_items: { id: 'x1', brand: 'Samsung', model: 'Galaxy S22', imei: 'X1', ram_rom: '8/128', color: 'Phantom Black', purchase_price: 30000, source: 'purchase' } },
    { purchase_id: 'p1', inventory_items: { id: 'x2', brand: 'Apple', model: 'iPhone 13', imei: 'X2', ram_rom: null, color: null, purchase_price: 28500, source: 'purchase' } },
    { purchase_id: 'p2', inventory_items: { id: 'x3', brand: 'Google', model: 'Pixel 8', imei: 'X3', ram_rom: null, color: null, purchase_price: 28500, source: 'purchase' } },
    { purchase_id: 'p4', inventory_items: { id: 'x4', brand: 'Poco', model: 'X6 5G', imei: 'X4', ram_rom: '8/256', color: 'Black', purchase_price: 9500, source: 'purchase' } },
    { purchase_id: 'p4', inventory_items: { id: 'x5', brand: 'Samsung', model: 'Galaxy M14', imei: 'X5', ram_rom: '6/128', color: 'Arctic Blue', purchase_price: 14500, source: 'purchase' } },
    { purchase_id: 'v1', inventory_items: { id: 'i4', brand: 'Vivo', model: 'V25', imei: 'B2', ram_rom: null, color: null, purchase_price: 3000, source: 'trade_in' } },
  ],
  paymentsIn: [
    { id: 'pi1', sale_id: 's1', party_id: 'pa', party_name: 'Aditya Singh', amount: 35000, date: '2026-10-07', created_at: '', bank_account_id: 'b1', payment_mode_id: 'm1', sale_bill_number: 'SAL-2026-27-0001', bank_name: 'HDFC Current Account', bank_is_cash: false, mode_name: 'UPI' },
    { id: 'pi2', sale_id: 's2', party_id: 'pb', party_name: 'Priya Verma', amount: 5000, date: '2026-11-03', created_at: '', bank_account_id: 'b2', payment_mode_id: null, sale_bill_number: 'SAL-2026-27-0002', bank_name: 'Cash', bank_is_cash: true, mode_name: null },
  ],
  paymentsOut: [
    { id: 'po1', purchase_id: 'p1', party_id: 'ps', party_name: 'Shree Balaji Mobiles', amount: 100000, date: '2026-10-05', created_at: '', bank_account_id: 'b1', payment_mode_id: 'm1', purchase_bill_number: 'PUR-2026-27-0001', bank_name: 'HDFC Current Account', bank_is_cash: false, mode_name: 'UPI' },
  ],
  accountTransactions: [
    { id: 't1', bank_account_id: 'b1', payment_mode_id: 'm1', type: 'credit', amount: 35000, date: '2026-10-07', reference_type: 'payment_in', reference_id: 'pi1', notes: null, transfer_group_id: null, created_at: '' },
    { id: 't2', bank_account_id: 'b1', payment_mode_id: 'm1', type: 'debit', amount: 100000, date: '2026-10-05', reference_type: 'payment_out', reference_id: 'po1', notes: null, transfer_group_id: null, created_at: '' },
  ],
  inventory: [
    { id: 'i3', brand: 'Samsung', model: 'Galaxy S23', imei: 'B1', ram_rom: null, color: null, purchase_price: 20000, base_selling_price: 25000, status: 'in_stock', source: 'purchase', created_at: '2026-09-01T00:00:00Z', origin_inventory_item_id: null, opening_entry_type: 'direct' },
    { id: 'i4', brand: 'Vivo', model: 'V25', imei: 'B2', ram_rom: null, color: null, purchase_price: 3000, base_selling_price: 3000, status: 'in_stock', source: 'trade_in', created_at: '2026-10-07T00:00:00Z', origin_inventory_item_id: null, opening_entry_type: 'direct' },
  ],
  tradeIns: [
    { id: 't1', sale_id: 's2', inventory_item_id: 'i4', credit_value: 3000, mrp: 8000, inventory_items: { brand: 'Vivo', model: 'V25', imei: 'B2', status: 'in_stock', source: 'trade_in' } },
  ],
  proformas: [
    { id: 'pf1', bill_number: 'PI-2026-27-0001', date: '2026-10-01', status: 'active', final_total: 20000, party_id: 'pa', party_name: 'Aditya Singh' },
  ],
  timeline: [
    { id: 'i3', created_at: '2026-09-01T00:00:00Z', origin_inventory_item_id: null },
    { id: 'i4', created_at: '2026-10-07T00:00:00Z', origin_inventory_item_id: null },
  ],
  bankAccounts: [
    { id: 'b1', name: 'HDFC Current Account', is_cash: false },
    { id: 'b2', name: 'Cash', is_cash: true },
  ],
  paymentModes: [{ id: 'm1', name: 'UPI', bank_account_id: 'b1' }],
  parties: [
    { id: 'pa', name: 'Aditya Singh', number: '+919876543210' },
    { id: 'pb', name: 'Priya Verma', number: '+919876543211' },
    { id: 'ps', name: 'Shree Balaji Mobiles', number: '+919876543212' },
  ],
}

const foldState = vi.hoisted(() => ({
  data: undefined as unknown,
  isLoading: false,
  isFetching: false,
  isError: false,
  error: null as unknown,
  refetch: vi.fn(),
}))

vi.mock('@/features/analytics/fold', () => ({
  useAnalyticsFold: () => foldState,
  useInventoryTimeline: () => ({ data: foldState.data ? (foldState.data as { timeline: unknown[] }).timeline : [], isLoading: false, isError: false }),
  analyticsKeys: { all: ['analytics'], fold: (fyId: string) => ['analytics', 'fold', fyId], timeline: ['analytics', 'inventory-timeline'] },
  fetchAnalyticsFold: vi.fn(),
  fetchInventoryTimeline: vi.fn(),
}))

vi.mock('@/features/settings/api', () => ({
  useStore: () => ({ data: { name: 'Fusion Gadgets E2E', address: 'Shop 14, Civil Lines Market', phone: '+919876543210', active_financial_year_id: 'fy1' } }),
}))

const fyFixture = { id: 'fy1', start_date: '2026-04-01', end_date: '2027-03-31', status: 'active' as const }

vi.mock('@/components/providers/FinancialYearProvider', () => ({
  useFinancialYear: () => ({
    financialYears: [fyFixture],
    selectedYear: fyFixture,
    setSelectedYearId: vi.fn(),
    isReadOnly: false,
    isLoading: false,
    refresh: vi.fn(),
  }),
}))

const noticesState = vi.hoisted(() => ({
  notices: [] as Array<Record<string, unknown>>,
  isLoading: false,
  isError: false,
  error: null,
  refetch: vi.fn(),
}))

vi.mock('@/features/notices/useNotices', () => ({
  useNotices: () => noticesState,
}))

const waState = vi.hoisted(() => ({ status: { state: 'idle', session: 'PRESENT', connected: false } }))

vi.mock('@/features/whatsapp/WhatsAppPlatformContext', () => ({
  useWhatsAppPlatformContext: () => waState,
}))

const exportMocks = vi.hoisted(() => ({
  exportReport: vi.fn().mockResolvedValue('Sales_Register_FY2026-2027.xlsx'),
}))

vi.mock('@/features/reports/export', () => exportMocks)

vi.mock('@/components/ui/Toast', () => ({
  useToast: () => ({
    toast: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    remove: vi.fn(),
  }),
}))

// ── Pages under test ──────────────────────────────────────────────────────────

import AnalyticsLayout from '@/pages/analytics/AnalyticsLayout'
import AnalyticsOverviewPage from '@/pages/analytics/AnalyticsOverviewPage'
import AnalyticsSalesPage from '@/pages/analytics/AnalyticsSalesPage'
import AnalyticsMoneyPage from '@/pages/analytics/AnalyticsMoneyPage'
import AnalyticsInventoryPage from '@/pages/analytics/AnalyticsInventoryPage'
import AnalyticsPurchasePage from '@/pages/analytics/AnalyticsPurchasePage'
import Header from '@/components/Header'

function renderAt(path: string): ReturnType<typeof render> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="analytics" element={<AnalyticsLayout />}>
            <Route index element={<AnalyticsOverviewPage />} />
            <Route path="sales" element={<AnalyticsSalesPage />} />
            <Route path="money" element={<AnalyticsMoneyPage />} />
            <Route path="inventory" element={<AnalyticsInventoryPage />} />
            <Route path="purchase" element={<AnalyticsPurchasePage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  foldState.data = foldFixture as unknown
  foldState.isLoading = false
  foldState.isError = false
  foldState.refetch.mockClear()
  exportMocks.exportReport.mockClear()
})

// ── Navigation ────────────────────────────────────────────────────────────────

describe('analytics navigation', () => {
  it('renders exactly the five tabs — no Reports tab, no nested report navigation', () => {
    renderAt('/analytics')
    const nav = screen.getByRole('tablist', { name: 'Analytics sections' })
    expect(nav).toBeTruthy()
    for (const label of ['Overview', 'Sales', 'Money', 'Inventory', 'Purchase']) {
      expect(screen.getByRole('tab', { name: label })).toBeTruthy()
    }
    expect(screen.queryByRole('tab', { name: 'Reports' })).toBeNull()
  })

  it('navigates between tabs and keeps the shared period state', async () => {
    renderAt('/analytics?period=month')
    await userEvent.click(screen.getByRole('tab', { name: 'Sales' }))
    await waitFor(() => expect(screen.getByText('Sales Register')).toBeTruthy())
    // The period survives the tab switch (URL-carried filter model).
    expect(screen.getByText('This Month')).toBeTruthy()
  })

  it('carries the active tab\u2019s identity and its Export action in the header', async () => {
    renderAt('/analytics/purchase')
    expect(screen.getByRole('heading', { name: 'Purchase' })).toBeTruthy()
    expect(screen.getByText('Understand supplier purchases, purchase costs, and outstanding amounts.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Export Purchase Register' })).toBeTruthy()
  })
})

// ── Filters ───────────────────────────────────────────────────────────────────

describe('shared filter behavior', () => {
  it('offers the four presets and shows custom date inputs only for Custom', async () => {
    renderAt('/analytics')
    const presetList = screen.getByRole('tablist', { name: 'Analytics period preset' })
    expect(presetList).toBeTruthy()
    expect(screen.queryByLabelText('From')).toBeNull()
    await userEvent.click(screen.getByRole('tab', { name: 'Custom' }))
    expect(screen.getByLabelText('From')).toBeTruthy()
    expect(screen.getByLabelText('To')).toBeTruthy()
  })

  it('switching presets changes the resolved period shown on the page', async () => {
    renderAt('/analytics')
    // Default: the full-FY summary.
    expect(screen.getAllByText(/2026-04-01 → 2027-03-31/).length).toBeGreaterThan(0)
    await userEvent.click(screen.getByRole('tab', { name: 'This Month' }))
    await waitFor(() => {
      expect(screen.getAllByText(/2026-\d{2}-\d{2} → 2026-\d{2}-\d{2}/).length).toBeGreaterThan(0)
    })
  })
})

// ── KPI rendering + tables ───────────────────────────────────────────────────

describe('KPI and table rendering', () => {
  it('Overview renders the KPI cards and trend from the fold', async () => {
    renderAt('/analytics')
    // KPI value: 35000 + 19500 = 54,500.00 — the Amount primitive renders
    // the whole part as its own span (tabular typographic split).
    expect((await screen.findAllByText('54,500')).length).toBeGreaterThan(0)
    expect(screen.getAllByText('Trade-In Value').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Business Trend').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Top Products').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Top Customers').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Attention').length).toBeGreaterThan(0)
  })

  it('Sales renders KPIs, the register rows and the trade-in sub-section', async () => {
    renderAt('/analytics/sales')
    expect((await screen.findAllByText('Sales Register')).length).toBeGreaterThan(0)
    // Registers render on desktop AND mobile card layouts from one row set.
    expect(screen.getAllByText('SAL-2026-27-0001').length).toBeGreaterThan(0)
    expect(screen.getAllByText('SAL-2026-27-0002').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Trade-In Performance').length).toBeGreaterThan(0)
    expect(screen.getAllByText(/19,500\.00/).length).toBeGreaterThan(0) // s2 total
    // Cancelled-exclusion footnote.
    expect(screen.getAllByText(/Cancelled invoices are excluded from analytics/).length).toBeGreaterThan(0)
  })

  it('Money renders the payment method breakdown with the cash fallback label', async () => {
    renderAt('/analytics/money')
    expect((await screen.findAllByText('Payment Methods')).length).toBeGreaterThan(0)
    expect(screen.getAllByText('UPI').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Cash').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Payment Register').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Outstanding Customers').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Receivables Ageing').length).toBeGreaterThan(0)
  })

  it('Inventory renders the current stock KPIs and the register', async () => {
    renderAt('/analytics/inventory')
    expect((await screen.findAllByText('Inventory Register')).length).toBeGreaterThan(0)
    expect(screen.getAllByText('Samsung Galaxy S23').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Vivo V25').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Stock Composition').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Brand Distribution').length).toBeGreaterThan(0)
  })
})

// ── The Purchase tab ─────────────────────────────────────────────────────────

describe('the Purchase analytics tab', () => {
  it('renders the three summary cards with the agreed financial semantics', async () => {
    renderAt('/analytics/purchase')
    expect((await screen.findAllByText('Purchase Value')).length).toBeGreaterThan(0)
    expect(screen.getAllByText('Paid').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Outstanding').length).toBeGreaterThan(0)
    // Purchase Value: 100000 + 91000 + 24000 = 215,000 (virtual bill excluded).
    expect((await screen.findAllByText('2,15,000')).length).toBeGreaterThan(0)
    // Paid describes the CURRENT state of the included bills — never
    // "money paid during the period".
    expect(screen.getAllByText(/already paid on these bills/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/still owed on these bills/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/supplier bills dated in period/).length).toBeGreaterThan(0)
  })

  it('renders the one purchase trend chart', async () => {
    renderAt('/analytics/purchase')
    expect((await screen.findAllByText('Purchase Trend')).length).toBeGreaterThan(0)
    // No decorative extra charts.
    expect(screen.queryByText('Supplier Trend')).toBeNull()
  })

  it('renders the Purchase Register with the eight columns and real rows', async () => {
    renderAt('/analytics/purchase')
    expect((await screen.findAllByText('Purchase Register')).length).toBeGreaterThan(0)
    for (const header of ['Purchase Bill No.', 'Date', 'Supplier', 'Items', 'Total Amount', 'Paid', 'Balance', 'Status']) {
      expect(screen.getAllByText(header).length).toBeGreaterThan(0)
    }
    // The register's rows: three real bills (newest first).
    expect(screen.getAllByText('PUR-2026-27-0004').length).toBeGreaterThan(0)
    expect(screen.getAllByText('PUR-2026-27-0002').length).toBeGreaterThan(0)
    expect(screen.getAllByText('PUR-2026-27-0001').length).toBeGreaterThan(0)
    // Multi-device item names are joined readably.
    expect(screen.getAllByText(/Poco X6 5G, Samsung Galaxy M14|Samsung Galaxy M14, Poco X6 5G/).length).toBeGreaterThan(0)
    // The virtual trade-in bill never appears.
    expect(screen.queryByText('PUR-TRD-2026-27-0003')).toBeNull()
    expect(screen.queryByText('PUR-TRD-2026-27-0005')).toBeNull()
    // Exclusion footnote: counts EVERY internal acquisition record dated
    // in the period — the active PUR-TRD AND the cancelled one — with
    // grammatically correct plural wording.
    expect(screen.getAllByText(/trade-in acquisition and recovery bills are excluded/).length).toBeGreaterThan(0)
    expect(screen.getByText(/2 internal acquisition records in this period/)).toBeTruthy()
    expect(screen.queryByText(/2 internal acquisition record in this period/)).toBeNull()
  })

  it('words the footer in the singular for exactly one excluded internal acquisition record', async () => {
    // Variant fold: only ONE in-period internal acquisition record (the
    // cancelled one is out of period → not counted; the active one is).
    const variant = {
      ...(foldFixture as { purchases: unknown[] }),
      purchases: (foldFixture as { purchases: Array<Record<string, unknown>> }).purchases.map((p) =>
        p.id === 'v2' ? { ...p, date: '2027-04-02' } : p,
      ),
    }
    foldState.data = variant
    renderAt('/analytics/purchase')
    await screen.findAllByText('PUR-2026-27-0001')
    expect(screen.getByText(/1 internal acquisition record in this period/)).toBeTruthy()
    expect(screen.queryByText(/1 internal acquisition records in this period/)).toBeNull()
  })

  it('links each record to the existing purchase-detail workflow', async () => {
    renderAt('/analytics/purchase')
    await screen.findAllByText('PUR-2026-27-0001')
    const link = screen.getAllByRole('link', { name: /PUR-2026-27-0001/ })[0]
    expect(link.getAttribute('href')).toBe('/purchases/p1')
  })

  it('searches and filters the register by supplier and payment status', async () => {
    renderAt('/analytics/purchase')
    await screen.findAllByText('PUR-2026-27-0001')
    // Search narrows by bill number.
    const search = screen.getByPlaceholderText('Search bill no., supplier or item…')
    await userEvent.type(search, '0002')
    await waitFor(() => expect(screen.queryByText('PUR-2026-27-0001')).toBeNull())
    expect(screen.getAllByText('PUR-2026-27-0002').length).toBeGreaterThan(0)
    await userEvent.clear(search)
    await waitFor(() => expect(screen.getAllByText('PUR-2026-27-0001').length).toBeGreaterThan(0))

    // The supplier filter narrows to that supplier's bills (custom dropdown:
    // open the trigger, then pick the option from the portal list).
    await userEvent.click(screen.getByRole('button', { name: /All suppliers/ }))
    await userEvent.click(await screen.findByRole('button', { name: 'Gupta Electronics' }))
    await waitFor(() => expect(screen.queryByText('PUR-2026-27-0001')).toBeNull())
    expect(screen.getAllByText('PUR-2026-27-0004').length).toBeGreaterThan(0)
    // Reset the supplier filter.
    await userEvent.click(screen.getByRole('button', { name: /Gupta Electronics/ }))
    await userEvent.click(await screen.findByRole('button', { name: 'All suppliers' }))
    await waitFor(() => expect(screen.getAllByText('PUR-2026-27-0001').length).toBeGreaterThan(0))

    // The status filter narrows by payment state.
    await userEvent.click(screen.getByRole('button', { name: /All statuses/ }))
    await userEvent.click(await screen.findByRole('button', { name: 'Unpaid' }))
    await waitFor(() => expect(screen.queryByText('PUR-2026-27-0001')).toBeNull())
    expect(screen.getAllByText('PUR-2026-27-0004').length).toBeGreaterThan(0)
  })
})

// ── Loading / empty / error states ────────────────────────────────────────────

describe('loading, empty and error states', () => {
  it('shows the skeleton while the fold loads (no KPI text yet)', () => {
    foldState.data = undefined
    foldState.isLoading = true
    const { container } = renderAt('/analytics')
    // Skeleton geometry renders immediately (the shimmer is threshold-gated).
    expect(container.querySelectorAll('.bg-slate-100').length).toBeGreaterThan(0)
    expect(screen.queryByText('Trade-In Value')).toBeNull()
  })

  it('shows the actionable error state with retry on failure', async () => {
    foldState.data = undefined
    foldState.isError = true
    renderAt('/analytics')
    expect(screen.getByText("Couldn't load analytics")).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(foldState.refetch).toHaveBeenCalled()
  })

  it('explains when the period has no business data', async () => {
    renderAt('/analytics?period=custom&from=2026-04-01&to=2026-04-02')
    expect(await screen.findAllByText('Top Products')).not.toHaveProperty('length', 0)
    expect(screen.getAllByText('No products sold in this period.').length).toBeGreaterThan(0)
    expect(screen.getAllByText('No customers with sales in this period.').length).toBeGreaterThan(0)
  })

  it('explains the empty register state on the Purchase tab', async () => {
    renderAt('/analytics/purchase?period=custom&from=2026-04-01&to=2026-04-02')
    expect((await screen.findAllByText(/No qualifying supplier purchase bills in this period/)).length).toBeGreaterThan(0)
  })
})

// ── Notices in the header ─────────────────────────────────────────────────────

describe('header notifications (the notice feed)', () => {
  function renderHeader(): ReturnType<typeof render> {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <Header />
        </MemoryRouter>
      </QueryClientProvider>,
    )
  }

  it('shows All clear when nothing needs attention', async () => {
    noticesState.notices = []
    renderHeader()
    fireEvent.click(screen.getByRole('button', { name: 'Notifications' }))
    expect(await screen.findByText('All clear')).toBeTruthy()
  })

  it('renders notices with severity and navigates to the entity on click', async () => {
    noticesState.notices = [
      {
        id: 'overdue-receivable:s1',
        type: 'overdue-receivable',
        category: 'financial',
        severity: 'warning',
        title: 'Overdue Receivable',
        message: 'SAL-2026-27-0002 (Priya Verma) — 14,500.00 Rs. outstanding for 45 days.',
        amount: 14500,
        action: { label: 'View invoice', to: '/sales/s1' },
      },
    ]
    renderHeader()
    const bell = screen.getByRole('button', { name: 'Notifications, 1 active' })
    expect(bell.querySelector('.bg-amber-100')).toBeTruthy()
    fireEvent.click(bell)
    expect(await screen.findByText('Overdue Receivable')).toBeTruthy()
    expect(screen.getByText(/14,500.00 Rs\. outstanding/)).toBeTruthy()
    expect(screen.getByText('View invoice →')).toBeTruthy()
    const link = screen.getByRole('link', { name: /Overdue Receivable/ })
    expect(link.getAttribute('href')).toBe('/sales/s1')
  })

  it('badges critical notices in rose', () => {
    noticesState.notices = [
      { id: 'x:1', type: 'whatsapp-not-connected', category: 'whatsapp', severity: 'critical', title: 'WhatsApp Session Invalid', message: 'x' },
    ]
    renderHeader()
    const bell = screen.getByRole('button', { name: 'Notifications, 1 active' })
    expect(bell.querySelector('.bg-rose-100')).toBeTruthy()
  })

  it('Overview Attention card renders the same feed', async () => {
    noticesState.notices = [
      { id: 'overdue-receivable:s1', type: 'overdue-receivable', category: 'financial', severity: 'warning', title: 'Overdue Receivable', message: 'SAL-2026-27-0002 — 14,500.00 Rs. outstanding.', action: { label: 'View invoice', to: '/sales/s1' } },
    ]
    renderAt('/analytics')
    expect(await screen.findByText('Attention')).toBeTruthy()
    expect(screen.getAllByText('Overdue Receivable').length).toBeGreaterThan(0)
  })
})

// ── The ONE shared export dialog ─────────────────────────────────────────────

describe('the shared export dialog', () => {
  it('every tab exposes its Export action opening the same dialog with the right report', async () => {
    for (const [path, title] of [
      ['/analytics', 'Export Business Summary'],
      ['/analytics/sales', 'Export Sales Register'],
      ['/analytics/money', 'Export Money Register'],
      ['/analytics/inventory', 'Export Current Inventory Snapshot'],
      ['/analytics/purchase', 'Export Purchase Register'],
    ] as const) {
      const { unmount } = renderAt(path)
      await screen.findAllByText('Period')
      fireEvent.click(screen.getByRole('button', { name: /^Export/ }))
      expect(await screen.findByText(title)).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Export Excel' })).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy()
      unmount()
    }
  })

  it('offers the agreed period presets with From/To dates', async () => {
    renderAt('/analytics/sales')
    await screen.findAllByText('Sales Register')
    fireEvent.click(screen.getByRole('button', { name: 'Export Sales Register' }))
    const dialog = await screen.findByRole('dialog', { name: 'Export Sales Register' })
    const presets = within(dialog).getByRole('tablist', { name: 'Export period preset' })
    expect(presets).toBeTruthy()
    for (const label of ['This Month', 'Last Month', 'Financial Year', 'Custom Period']) {
      expect(within(dialog).getByRole('tab', { name: label })).toBeTruthy()
    }
    // The From/To dates are always visible.
    expect(within(dialog).getByLabelText('From date')).toBeTruthy()
    expect(within(dialog).getByLabelText('To date')).toBeTruthy()
  })

  it('defaults to the workspace\u2019s current period (Financial Year)', async () => {
    renderAt('/analytics/sales')
    await screen.findAllByText('Sales Register')
    fireEvent.click(screen.getByRole('button', { name: 'Export Sales Register' }))
    const dialog = await screen.findByRole('dialog', { name: 'Export Sales Register' })
    // The workspace default preset (fy) maps to the dialog's Financial Year.
    expect(within(dialog).getByRole('tab', { name: 'Financial Year' }).getAttribute('aria-selected')).toBe('true')
    // The resolved range matches the FY — shown explicitly in the dialog.
    expect(within(dialog).getByText(/1 Apr 2026 – 31 Mar 2027/)).toBeTruthy()
  })

  it('cancelling or closing the dialog never starts an export', async () => {
    renderAt('/analytics/sales')
    await screen.findAllByText('Sales Register')
    fireEvent.click(screen.getByRole('button', { name: 'Export Sales Register' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(exportMocks.exportReport).not.toHaveBeenCalled()
    // Re-open, then dismiss with Escape.
    fireEvent.click(screen.getByRole('button', { name: 'Export Sales Register' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(exportMocks.exportReport).not.toHaveBeenCalled())
  })

  it('exports through the shared architecture with the validated period and store', async () => {
    renderAt('/analytics/sales')
    await screen.findAllByText('Sales Register')
    fireEvent.click(screen.getByRole('button', { name: 'Export Sales Register' }))
    await userEvent.click(screen.getByRole('button', { name: 'Export Excel' }))
    await waitFor(() => expect(exportMocks.exportReport).toHaveBeenCalledTimes(1))
    const [id, input] = exportMocks.exportReport.mock.calls[0]
    expect(id).toBe('sales-register')
    expect(input.fold).toBe(foldFixture)
    expect(input.store.name).toBe('Fusion Gadgets E2E')
    expect(input.fy).toEqual({ start_date: '2026-04-01', end_date: '2027-03-31' })
    // The validated, inclusive FY period drives the export.
    expect(input.period).toEqual({ preset: 'custom', from: '2026-04-01', to: '2027-03-31' })
  })

  it('Inventory offers BOTH export scopes through the same dialog', async () => {
    renderAt('/analytics/inventory')
    await screen.findAllByText('Inventory Register')
    fireEvent.click(screen.getByRole('button', { name: 'Export Current Inventory Snapshot' }))
    expect(await screen.findByText('Export Current Inventory Snapshot')).toBeTruthy()

    // Snapshot scope: explicit As of date, no period presets.
    expect(screen.getByText(/as of/)).toBeTruthy()
    expect(screen.queryByRole('tablist', { name: 'Export period preset' })).toBeNull()

    // Switch to the Acquisitions scope — the period presets appear.
    await userEvent.click(screen.getByRole('tab', { name: 'Acquisitions' }))
    expect(await screen.findByText('Export Inventory Acquisitions')).toBeTruthy()
    expect(screen.getByRole('tablist', { name: 'Export period preset' })).toBeTruthy()

    // And export it.
    await userEvent.click(screen.getByRole('button', { name: 'Export Excel' }))
    await waitFor(() => expect(exportMocks.exportReport).toHaveBeenCalledWith('inventory-acquisitions', expect.anything()))
  })

  it('switching presets moves the date fields and stays exportable', async () => {
    renderAt('/analytics/sales?period=custom&from=2026-04-01&to=2026-04-02')
    await screen.findAllByText('Sales Register')
    fireEvent.click(screen.getByRole('button', { name: 'Export Sales Register' }))
    const dialog = await screen.findByRole('dialog', { name: 'Export Sales Register' })
    // Opens on the workspace's custom period (not a silently different range).
    expect(within(dialog).getByRole('tab', { name: 'Custom Period' }).getAttribute('aria-selected')).toBe('true')
    const from = within(dialog).getByLabelText('From date') as HTMLInputElement
    expect(from.value).toBe('2026-04-01')
    // Selecting This Month switches the preset and re-seeds the dates.
    await userEvent.click(within(dialog).getByRole('tab', { name: 'This Month' }))
    await waitFor(() => expect(within(dialog).getByRole('tab', { name: 'This Month' }).getAttribute('aria-selected')).toBe('true'))
    expect(within(dialog).getByRole('button', { name: 'Export Excel' }).hasAttribute('disabled')).toBe(false)
  })
})
