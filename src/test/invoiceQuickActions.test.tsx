/**
 * useInvoiceQuickActions — the ONE behavior layer shared by every invoice
 * list row menu.
 *
 * These tests pin the ACTION SEMANTICS — no action may accidentally invoke
 * another action's implementation:
 *
 *   savePdf          → downloadInvoicePdf (the PDF pipeline download)
 *   shareViaWhatsApp → postSendInvoice (the backend-owned WhatsApp delivery)
 *   share            → shareInvoicePdf (the native platform share of the
 *                      SAME PDF artifact — never the WhatsApp pipeline)
 *   print            → printInvoicePdf (the PDF pipeline + native print)
 *
 * plus the app's toast surfacing for each failure.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { useInvoiceQuickActions } from '@/features/invoice/useInvoiceQuickActions'

// ── Feature-implementation mocks (the real hook runs against them) ──────────

const downloadInvoicePdfMock = vi.hoisted(() => vi.fn())
const printInvoicePdfMock = vi.hoisted(() => vi.fn())
const shareInvoicePdfMock = vi.hoisted(() => vi.fn())
const postSendInvoiceMock = vi.hoisted(() => vi.fn())
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))

vi.mock('@/features/invoice/download', () => ({
  downloadInvoicePdf: downloadInvoicePdfMock,
}))
vi.mock('@/features/invoice/print', () => ({
  printInvoicePdf: printInvoicePdfMock,
}))
vi.mock('@/features/invoice/share', () => ({
  shareInvoicePdf: shareInvoicePdfMock,
}))
vi.mock('@/platform/whatsapp/http', () => ({
  postSendInvoice: postSendInvoiceMock,
}))
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

const TARGET = { invoiceId: 'sale-1', invoiceType: 'sale' as const, billNumber: 'SAL-2027-28-0004' }

/** Test host — captures the hook's actions for direct invocation. */
let actions: ReturnType<typeof useInvoiceQuickActions>
function HookHost() {
  actions = useInvoiceQuickActions()
  return null
}

beforeEach(() => {
  vi.clearAllMocks()
  downloadInvoicePdfMock.mockResolvedValue(undefined)
  printInvoicePdfMock.mockResolvedValue(undefined)
  shareInvoicePdfMock.mockResolvedValue(undefined)
  postSendInvoiceMock.mockResolvedValue(undefined)
  render(<HookHost />)
})

describe('useInvoiceQuickActions — action semantics', () => {
  it('savePdf invokes ONLY the PDF pipeline download', async () => {
    await actions.savePdf(TARGET)

    expect(downloadInvoicePdfMock).toHaveBeenCalledWith('sale-1', 'sale')
    expect(shareInvoicePdfMock).not.toHaveBeenCalled()
    expect(postSendInvoiceMock).not.toHaveBeenCalled()
    expect(printInvoicePdfMock).not.toHaveBeenCalled()
    // A successful save is a browser download — no toast.
    expect(toastMock.success).not.toHaveBeenCalled()
    expect(toastMock.error).not.toHaveBeenCalled()
  })

  it('shareViaWhatsApp invokes ONLY the existing WhatsApp delivery (by reference)', async () => {
    await actions.shareViaWhatsApp(TARGET)

    expect(postSendInvoiceMock).toHaveBeenCalledWith({ invoiceId: 'sale-1', invoiceType: 'sale' })
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

  it('share invokes ONLY the native platform share of the PDF artifact', async () => {
    await actions.share(TARGET)

    expect(shareInvoicePdfMock).toHaveBeenCalledWith('sale-1', 'sale')
    expect(postSendInvoiceMock).not.toHaveBeenCalled()
    expect(downloadInvoicePdfMock).not.toHaveBeenCalled()
    expect(printInvoicePdfMock).not.toHaveBeenCalled()
    // The native share sheet is the feedback — no application toast on success.
    expect(toastMock.success).not.toHaveBeenCalled()
    expect(toastMock.error).not.toHaveBeenCalled()
  })

  it('print invokes ONLY the PDF pipeline print', async () => {
    await actions.print(TARGET)

    expect(printInvoicePdfMock).toHaveBeenCalledWith('sale-1', 'sale')
    expect(downloadInvoicePdfMock).not.toHaveBeenCalled()
    expect(shareInvoicePdfMock).not.toHaveBeenCalled()
    expect(postSendInvoiceMock).not.toHaveBeenCalled()
  })

  it("surfaces each action's failure through the app's toast", async () => {
    downloadInvoicePdfMock.mockRejectedValue(new Error('Invoice data unavailable.'))
    shareInvoicePdfMock.mockRejectedValue(new Error('This browser cannot share files. Use Save PDF instead.'))
    printInvoicePdfMock.mockRejectedValue(new Error('The browser could not open the print preview.'))
    postSendInvoiceMock.mockRejectedValue(new Error('WhatsApp not connected'))

    await actions.savePdf(TARGET)
    await actions.share(TARGET)
    await actions.print(TARGET)
    await actions.shareViaWhatsApp(TARGET)

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith('PDF Failed', 'Invoice data unavailable.')
      expect(toastMock.error).toHaveBeenCalledWith(
        'Share Failed',
        'This browser cannot share files. Use Save PDF instead.',
      )
      expect(toastMock.error).toHaveBeenCalledWith('Print Failed', 'The browser could not open the print preview.')
      expect(toastMock.error).toHaveBeenCalledWith('WhatsApp send failed', 'WhatsApp not connected')
    })
  })
})
