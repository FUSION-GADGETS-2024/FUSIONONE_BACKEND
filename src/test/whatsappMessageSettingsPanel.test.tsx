/**
 * WhatsApp templates section (the dedicated Templates page content) —
 * loading geometry parity + view-mode structure.
 *
 * The template cards show (view mode) ONLY the document title, description,
 * a FIXED trigger descriptor (Auto Send for the invoice cards; Automatic
 * sending for the payment-receipt cards; Manual send for the statement
 * cards; Per invoice for the reminder card), the rendered message preview,
 * and an Edit action — the textarea editor exists exclusively INSIDE a
 * card's edit mode (the preview transforms in place). The automatic-sending
 * SWITCHES are configuration and live on the Settings → WhatsApp page —
 * no toggle control is rendered here. There is NO page-level save action:
 * each template saves independently.
 *
 * These tests pin:
 *   - the loading skeleton mirrors the REAL card structure (header row,
 *     template label, preview block, action footer) so the page does not
 *     resize when the saved settings arrive;
 *   - all EIGHT real cards render — three invoice cards, the payment-receipt
 *     (In/Out) cards, the payment-statement (In/Out) cards and the reminder
 *     card, each with its fixed trigger descriptor and an Edit action;
 *   - no switch controls exist on the templates surface (and no page-level
 *     "Save Delivery Settings" action exists in ANY state — pinned
 *     NEGATIVE: the panel saves per card, so no global save action may exist).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { WhatsAppMessageSettingsPanel } from '@/components/settings/WhatsAppMessageSettingsPanel'

// ── Provider / feature mocks ────────────────────────────────────────────────

const settingsMock = vi.hoisted(() => ({
  isReady: false,
  settings: {
    sale: { autoSend: false, template: '' },
    purchase: { autoSend: false, template: '' },
    proforma: { autoSend: false, template: '' },
    paymentIn: { autoSend: false, template: '' },
    paymentOut: { autoSend: false, template: '' },
    statementIn: { template: '' },
    statementOut: { template: '' },
    reminder: { template: '' },
  },
}))

vi.mock('@/components/providers/SessionProvider', () => ({
  useSession: () => ({
    user: { id: 'u1', email: 'owner@test' },
    appUser: { id: 'u1', email: 'owner@test', userType: 'owner' },
    isOwner: true,
    signOut: vi.fn(),
  }),
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

vi.mock('@/features/whatsapp/useWhatsAppMessageSettings', () => ({
  useWhatsAppMessageSettings: () => settingsMock,
}))

vi.mock('@/platform/supabase/client', () => ({
  supabase: { from: vi.fn(), storage: { from: vi.fn() } },
}))

vi.mock('@/features/invalidate', () => ({
  invalidateWhatsAppState: vi.fn(),
}))

beforeEach(() => {
  settingsMock.isReady = false
})

// ── Tests ───────────────────────────────────────────────────────────────────

describe('WhatsAppMessageSettingsPanel — loading geometry parity', () => {
  it('loading renders ONE skeleton card per template type, mirroring the real card structure', () => {
    render(<WhatsAppMessageSettingsPanel />)

    // Eight skeleton cards — one per template type (sale/purchase/proforma
    // invoices, payment receipts In/Out, payment statements In/Out,
    // reminder), each mirroring the real card: header (title + subtitle +
    // trigger placeholder), template label, preview block, action footer.
    const cards = document.querySelectorAll('.rounded-xl.border.border-slate-200.bg-white')
    const skeletons = Array.from(cards).filter((c) => c.querySelector('.h-\\[120px\\]'))
    expect(skeletons.length).toBe(8)

    // There is NO page-level save action anymore — in any state.
    expect(screen.queryByRole('button', { name: /save delivery settings/i })).toBeNull()
  })

  it('loaded renders the eight real template cards in view mode (preview + Edit, no editor, no switches)', () => {
    settingsMock.isReady = true

    render(<WhatsAppMessageSettingsPanel />)

    // The real cards: three invoice cards…
    for (const label of ['Sales Invoice', 'Purchase Bill', 'Quotation / Proforma']) {
      expect(screen.getByText(label)).toBeTruthy()
    }

    // …the payment-receipt (In/Out) cards…
    for (const label of ['Payment Receipt (In)', 'Payment Receipt (Out)']) {
      expect(screen.getByText(label)).toBeTruthy()
    }

    // …plus the statement and reminder card titles.
    for (const label of ['Payment Statement (In)', 'Payment Statement (Out)', 'Payment Reminder']) {
      expect(screen.getByText(label)).toBeTruthy()
    }

    // Each card carries its FIXED trigger descriptor — the trigger POLICY,
    // never a control (the automatic-sending switches live on the Settings →
    // WhatsApp page; this surface contains NO switch at all).
    expect(screen.getAllByText('Auto Send').length).toBe(3)
    expect(screen.getAllByText('Automatic sending').length).toBe(2)
    expect(screen.getAllByText('Manual send').length).toBe(2)
    expect(screen.getAllByText('Per invoice').length).toBe(1)
    expect(document.querySelectorAll('input[type="checkbox"]').length).toBe(0)

    // Every card: the template block + the Edit action.
    expect(screen.getAllByText('Message template').length).toBe(8)
    expect(screen.getAllByRole('button', { name: /edit/i }).length).toBe(8)

    // View mode shows the rendered PREVIEW — never a textarea editor (the
    // editor exists only inside a card's edit mode) and never a page-level
    // save action.
    expect(document.querySelector('textarea')).toBeNull()
    expect(screen.queryByRole('button', { name: /save delivery settings/i })).toBeNull()
  })
})
