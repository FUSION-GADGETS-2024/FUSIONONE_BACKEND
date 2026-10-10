/**
 * shareInvoicePdf — the native platform share action over the ONE invoice
 * PDF artifact.
 *
 * These tests pin the share contract:
 *   - unsupported platforms reject with a clear, actionable message BEFORE
 *     any PDF work (no artifact is built it cannot hand over);
 *   - the artifact comes from the ONE pipeline — buildInvoicePdf — exactly
 *     once, with the same cache-aware call the other actions make;
 *   - the shared payload is ONLY the PDF File: canonical filename
 *     (invoicePdfFilename — the same rule as Save PDF), PDF mime type, no
 *     text/title/url fields, no thumbnail, no second generation path;
 *   - the user dismissing the native share sheet (AbortError) resolves
 *     silently — a dismissal is not a failure;
 *   - genuine share failures propagate.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  isNativeFileShareSupported,
  shareInvoicePdf,
} from '@/features/invoice/share'
import { invoicePdfFilename } from '@/features/invoice/download'

// ── The ONE pipeline, mocked at its seam ────────────────────────────────────

const buildInvoicePdfMock = vi.hoisted(() => vi.fn())
// Partial mock: the REAL download module stays loaded (the canonical
// filename rule and module contract come from the real source); only the
// pipeline's compose step is replaced at its seam so no invoice data,
// rendering or cache is touched.
vi.mock('@/features/invoice/download', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/invoice/download')>()
  return { ...actual, buildInvoicePdf: buildInvoicePdfMock }
})

const BILL_NUMBER = 'SAL-2027-28-0004'
const INVOICE_ID = 'sale-1'

// ── Web Share API control (jsdom ships none of it) ─────────────────────────

type ShareFn = (data?: ShareData) => Promise<void>
type CanShareFn = (data?: ShareData) => boolean

const shareMock = vi.fn<ShareFn>()
const canShareMock = vi.fn<CanShareFn>()

function installWebShare({ share, canShare }: { share?: boolean; canShare?: boolean }) {
  const nav = navigator as unknown as Record<string, unknown>
  if (share) nav.share = shareMock
  else delete nav.share
  if (canShare) nav.canShare = canShareMock
  else delete nav.canShare
}

beforeEach(() => {
  vi.clearAllMocks()
  buildInvoicePdfMock.mockResolvedValue({
    blob: new Blob(['%PDF-1.4 invoice'], { type: 'application/pdf' }),
    billNumber: BILL_NUMBER,
    cached: false,
  })
  shareMock.mockResolvedValue(undefined)
  canShareMock.mockReturnValue(true)
})

afterEach(() => {
  installWebShare({ share: false, canShare: false })
})

describe('isNativeFileShareSupported', () => {
  it('is false without the Web Share API (desktop browsers without support)', () => {
    installWebShare({ share: false, canShare: false })
    expect(isNativeFileShareSupported()).toBe(false)
  })

  it('is false with navigator.share but without canShare (files cannot be probed)', () => {
    installWebShare({ share: true, canShare: false })
    expect(isNativeFileShareSupported()).toBe(false)
  })

  it('is true with both share and canShare', () => {
    installWebShare({ share: true, canShare: true })
    expect(isNativeFileShareSupported()).toBe(true)
  })
})

describe('shareInvoicePdf', () => {
  it('rejects with a clear message and builds NO artifact when file sharing is unsupported', async () => {
    installWebShare({ share: false, canShare: false })

    await expect(shareInvoicePdf(INVOICE_ID, 'sale')).rejects.toThrow(
      'This browser cannot share files. Use Save PDF instead.',
    )
    // The capability gate runs BEFORE the pipeline — no PDF work happened.
    expect(buildInvoicePdfMock).not.toHaveBeenCalled()
    expect(shareMock).not.toHaveBeenCalled()
  })

  it('shares the ONE artifact: buildInvoicePdf called once, payload is ONLY the PDF file', async () => {
    installWebShare({ share: true, canShare: true })

    await shareInvoicePdf(INVOICE_ID, 'sale')

    // The artifact came from the one pipeline, exactly once, with the exact
    // arguments the other actions use.
    expect(buildInvoicePdfMock).toHaveBeenCalledTimes(1)
    expect(buildInvoicePdfMock).toHaveBeenCalledWith(INVOICE_ID, 'sale')

    // The native share was invoked with the PDF file only.
    expect(shareMock).toHaveBeenCalledTimes(1)
    const payload = shareMock.mock.calls[0][0] as ShareData
    expect(Object.keys(payload).sort()).toEqual(['files'])
    const [file] = payload.files as File[]

    // Canonical filename — the SAME rule Save PDF uses.
    expect(file.name).toBe(invoicePdfFilename(BILL_NUMBER))
    expect(file.name).toBe('SAL-2027-28-0004.pdf')
    expect(file.type).toBe('application/pdf')
    // The file carries the artifact's bytes.
    expect(file.size).toBe('%PDF-1.4 invoice'.length)

    // No text, no title, no url — no thumbnail, no share card.
    expect(payload.text).toBeUndefined()
    expect(payload.title).toBeUndefined()
    expect(payload.url).toBeUndefined()
    expect((payload.files as File[]).length).toBe(1)
  })

  it('rejects (still clearly) when this platform cannot share PDF files specifically', async () => {
    installWebShare({ share: true, canShare: true })
    canShareMock.mockReturnValue(false)

    await expect(shareInvoicePdf(INVOICE_ID, 'purchase')).rejects.toThrow(
      'This browser cannot share PDF files. Use Save PDF instead.',
    )
    expect(shareMock).not.toHaveBeenCalled()
  })

  it('resolves silently when the user dismisses the share sheet (AbortError)', async () => {
    installWebShare({ share: true, canShare: true })
    shareMock.mockRejectedValue(
      Object.assign(new DOMException('The user aborted the share', 'AbortError')),
    )

    await expect(shareInvoicePdf(INVOICE_ID, 'proforma')).resolves.toBeUndefined()
  })

  it('resolves silently when the engine reports a lower-cased aborterror', async () => {
    installWebShare({ share: true, canShare: true })
    shareMock.mockRejectedValue(
      Object.assign(new DOMException('cancelled', 'aborterror')),
    )

    await expect(shareInvoicePdf(INVOICE_ID, 'sale')).resolves.toBeUndefined()
  })

  it('propagates genuine share failures (permission denied)', async () => {
    installWebShare({ share: true, canShare: true })
    shareMock.mockRejectedValue(
      Object.assign(new DOMException('Permission denied', 'NotAllowedError')),
    )

    await expect(shareInvoicePdf(INVOICE_ID, 'sale')).rejects.toThrow('Permission denied')
  })

  it('propagates artifact failures from the pipeline (one pipeline, its errors too)', async () => {
    installWebShare({ share: true, canShare: true })
    buildInvoicePdfMock.mockRejectedValue(new Error('Invoice data unavailable.'))

    await expect(shareInvoicePdf(INVOICE_ID, 'sale')).rejects.toThrow(
      'Invoice data unavailable.',
    )
    expect(shareMock).not.toHaveBeenCalled()
  })
})
