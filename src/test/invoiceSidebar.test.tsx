/**
 * InvoiceSidebar — the Invoice View action panel.
 *
 * These tests pin the Export action surface added by the native-share
 * architecture:
 *   - Export exposes Save PDF · Share · Print in that order when the Share
 *     handler is wired (all consuming the ONE PDF artifact);
 *   - without a Share handler the panel degrades to the previous Save PDF ·
 *     Print surface (Share is optional wiring);
 *   - the Share button's loading label mirrors the established pattern
 *     ('Preparing…');
 *   - the WhatsApp section keeps its OWN action — "Send via WhatsApp" —
 *     clearly separate from the native Share action.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { InvoiceSidebar } from '@/components/invoice/InvoiceSidebar'

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/components/invoice/InvoiceWhatsAppShare', () => ({
  InvoiceWhatsAppShare: () => <div data-testid="whatsapp-share-action">Send via WhatsApp</div>,
}))

function renderSidebar(overrides: Partial<React.ComponentProps<typeof InvoiceSidebar>> = {}) {
  const onDownloadPdf = vi.fn()
  const onSharePdf = vi.fn()
  const onPrintPdf = vi.fn()
  render(
    <InvoiceSidebar
      invoiceId="sale-1"
      invoiceType="sale"
      invoiceNumber="SAL-2027-28-0004"
      customer="Aditya Singh"
      date="2026-10-05"
      onDownloadPdf={onDownloadPdf}
      onSharePdf={onSharePdf}
      onPrintPdf={onPrintPdf}
      {...overrides}
    />,
  )
  return { onDownloadPdf, onSharePdf, onPrintPdf }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('InvoiceSidebar — Export section', () => {
  it('exposes Save PDF, Share and Print in that order when the share handler is wired', () => {
    renderSidebar()

    const buttons = screen.getAllByRole('button').map((b) => b.textContent ?? '')
    const exportIndex = buttons.indexOf('Save PDF')
    expect(exportIndex).toBeGreaterThanOrEqual(0)
    expect(buttons[exportIndex + 1]).toBe('Share')
    expect(buttons[exportIndex + 2]).toBe('Print')
  })

  it('the Share button invokes the wired share handler (the page delegates to shareInvoicePdf)', () => {
    const { onSharePdf, onDownloadPdf, onPrintPdf } = renderSidebar()

    fireEvent.click(screen.getByRole('button', { name: 'Share' }))
    expect(onSharePdf).toHaveBeenCalledTimes(1)
    expect(onDownloadPdf).not.toHaveBeenCalled()
    expect(onPrintPdf).not.toHaveBeenCalled()
  })

  it('without a share handler the panel degrades to Save PDF · Print (no Share button)', () => {
    const { onSharePdf } = renderSidebar({ onSharePdf: undefined })

    expect(screen.queryByRole('button', { name: 'Share' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Save PDF' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Print' })).toBeTruthy()
    expect(onSharePdf).not.toHaveBeenCalled()
  })

  it("the Share button's loading state follows the established 'Preparing…' pattern", () => {
    renderSidebar({ isShareLoading: true })

    const share = screen.getByRole('button', { name: 'Preparing…' })
    expect(share).toBeTruthy()
    // Loading disables the button (the SidebarButton contract).
    expect((share as HTMLButtonElement).disabled).toBe(true)
  })

  it('the WhatsApp action stays its OWN action — Send via WhatsApp, separate from Share', () => {
    renderSidebar()

    // The WhatsApp section renders its dedicated action (mocked here to its
    // label) — distinct from the native Share button.
    expect(screen.getByTestId('whatsapp-share-action').textContent).toBe('Send via WhatsApp')
    expect(screen.getByRole('button', { name: 'Share' }).textContent).toBe('Share')
  })
})
